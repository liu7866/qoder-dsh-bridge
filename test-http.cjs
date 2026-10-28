// Isolated HTTP regression test: no real Qoder process, account or tool execution.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { spawn, spawnSync } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')

const root = path.resolve(__dirname)
const temporary = fs.mkdtempSync(path.join(root, '.http-test-'))
const traceFile = path.join(temporary, 'fixture-inputs.jsonl')
const fakePath = path.join(root, 'fake-native.cjs')
const token = 'e'.repeat(64)
const tokenFile = path.join(temporary, 'token')
fs.writeFileSync(tokenFile, token)
fs.copyFileSync(path.join(root, 'qoder-cli-proxy.mjs'), path.join(temporary, 'qoder-cli-proxy.mjs'))
fs.copyFileSync(path.join(root, 'bridge-support.mjs'), path.join(temporary, 'bridge-support.mjs'))
const original = fs.readFileSync(path.join(root, 'native-worker.mjs'), 'utf8')
const needle = '(this.spawnProcess || spawn)'
assert.equal(original.split(needle).length, 2, 'NativeWorker spawn injection point must be unique')
const replacement = `(this.spawnProcess || ((cli, args, options) => {
  const child = spawn(process.execPath, [${JSON.stringify(fakePath)}, ...args], options)
  const originalWrite = child.stdin.write.bind(child.stdin)
  child.stdin.write = (data, ...rest) => {
    try {
      const value = JSON.parse(String(data))
      testFs.appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify({ pid: child.pid, value }) + '\\n')
    } catch {}
    return originalWrite(data, ...rest)
  }
  return child
}))`
fs.writeFileSync(path.join(temporary, 'native-worker.mjs'), "import * as testFs from 'node:fs'\n" + original.replace(needle, replacement))

let server
let serverError = ''
let base
const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
const tools = [{ type: 'function', function: { name: 'read_file', description: 'Synthetic fixture tool', parameters: {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path']
} } }]
const user = content => ({ role: 'user', content })
const payload = (messages, stream = false) => ({ model: 'deepseek-flash', messages, tools, stream, max_tokens: 256 })
const request = (body, session, signal) => fetch(base + '/v1/chat/completions', {
  method: 'POST', headers: { ...headers, 'x-session-id': session }, body: JSON.stringify(body),
  signal: signal || AbortSignal.timeout(12000)
})
async function completion(body, session) {
  const response = await request(body, session)
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  assert.equal(result.choices[0].message.content, 'hello world')
  assert.equal(result.choices[0].finish_reason, 'stop')
  assert.equal(result.choices[0].message.tool_calls, undefined)
  return result.choices[0].message
}
function trace() {
  try { return fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
  catch { return [] }
}
const userWrites = () => trace().filter(x => x.value.type === 'user')
const promptOf = entry => entry.value.message.content.find(x => x.type === 'text').text
async function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer()
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port
      socket.close(error => error ? reject(error) : resolve(port))
    })
  })
}
async function main() {
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [path.join(temporary, 'qoder-cli-proxy.mjs'), '--port', String(port)], {
    cwd: temporary, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, FAKE_MODE: 'stream', QCP_CLI: process.execPath, QCP_TOKEN_FILE: tokenFile,
      QCP_MAX_WORKERS: '1', QCP_TIMEOUT: '5000', QCP_IDLE: '900000', QCP_PREWARM: '0'
    }
  })
  server.stdout.on('data', () => {})
  server.stderr.on('data', value => { serverError += value })
  let started = false
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw Error('test proxy exited: ' + serverError)
    try {
      const response = await fetch(base + '/healthz', { signal: AbortSignal.timeout(300) })
      const health = await response.json()
      if (health.protocol === 'qcp-5') { started = true; break }
    } catch {}
    await delay(100)
  }
  assert(started, 'test proxy failed to start: ' + serverError)

  assert.equal((await fetch(base + '/v1/models')).status, 401)
  assert.equal((await fetch(base + '/healthz', { headers: { Origin: 'https://attacker.invalid' } })).status, 403)
  assert.equal((await fetch(base + '/v1/usage')).status, 401)
  const usage = await (await fetch(base + '/v1/usage', { headers })).json()
  assert.equal(usage.account.quota.userQuota.remaining, 80)
  assert(!JSON.stringify(usage).includes('private-fixture'))
  assert(!JSON.stringify(usage).includes('private.invalid'))
  assert.equal((await fetch(base + '/v1/models', { headers })).status, 200)

  const queued = await Promise.all(Array.from({ length: 4 }, (_, index) =>
    completion(payload([user('parallel-' + index)]), 'parallel-' + index)))
  assert.equal(queued.length, 4)
  const afterQueue = await (await fetch(base + '/healthz')).json()
  assert.equal(afterQueue.maxWorkers, 1)
  assert(afterQueue.workers <= 1)

  const stream = await request(payload([user('stream text')], true), 'stream')
  assert.equal(stream.status, 200)
  assert.match(stream.headers.get('content-type') || '', /text\/event-stream/)
  const reader = stream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = '', finished = false
  const events = []
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    for (;;) {
      const end = buffer.indexOf('\n\n')
      if (end < 0) break
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 2)
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6)
      if (data === '[DONE]') { finished = true; continue }
      assert(!finished, 'no event may appear after DONE')
      events.push(JSON.parse(data))
    }
  }
  assert(finished)
  assert.equal(events[0].choices[0].delta.role, 'assistant')
  const deltas = events.flatMap(event => event.choices || []).map(choice => choice.delta?.content).filter(x => typeof x === 'string' && x)
  assert(deltas.length >= 2, 'native text deltas must remain separate SSE events')
  assert.equal(deltas.join(''), 'hello world')
  assert.equal(events.filter(event => event.choices?.[0]?.finish_reason === 'stop').length, 1)

  const initial = [{ role: 'system', content: 'SYSTEM-ORIGINAL' }, user('HISTORY-FIRST')]
  const firstAnswer = await completion(payload(initial), 'history')
  let writes = userWrites()
  const firstWrite = writes.at(-1)
  assert.equal(promptOf(firstWrite), 'HISTORY-FIRST')
  const continued = [...initial, firstAnswer, user('HISTORY-SECOND')]
  const secondAnswer = await completion(payload(continued), 'history')
  writes = userWrites()
  const secondWrite = writes.at(-1)
  assert.equal(secondWrite.pid, firstWrite.pid, 'an exact continuation should retain its worker')
  assert.equal(promptOf(secondWrite), 'HISTORY-SECOND')

  const edited = [{ role: 'system', content: 'SYSTEM-ORIGINAL' }, user('HISTORY-FIRST-EDITED'), firstAnswer, user('HISTORY-SECOND')]
  const editedAnswer = await completion(payload(edited), 'history')
  const editedWrite = userWrites().at(-1)
  assert.notEqual(editedWrite.pid, secondWrite.pid, 'an edited prefix must recreate the native session')
  assert.match(promptOf(editedWrite), /HISTORY-FIRST-EDITED/)
  assert.match(promptOf(editedWrite), /HISTORY-SECOND/)

  await completion(payload([user('OTHER-SESSION')]), 'eviction')
  const recovered = [...edited, editedAnswer, user('HISTORY-THIRD')]
  await completion(payload(recovered), 'history')
  const recoveredWrite = userWrites().at(-1)
  assert.notEqual(recoveredWrite.pid, editedWrite.pid)
  assert.match(promptOf(recoveredWrite), /HISTORY-FIRST-EDITED/)
  assert.match(promptOf(recoveredWrite), /HISTORY-SECOND/)
  assert.match(promptOf(recoveredWrite), /HISTORY-THIRD/)

  const controller = new AbortController()
  const canceled = await request(payload([user('cancel while streaming')], true), 'cancel', controller.signal)
  const canceledReader = canceled.body.getReader()
  const partial = await canceledReader.read()
  assert.equal(partial.done, false)
  controller.abort()
  try { await canceledReader.cancel() } catch {}
  await completion(payload([user('after cancellation')]), 'after-cancel')
  assert.equal((await fetch(base + '/healthz')).status, 200)

  // A native completion carries no marker parsing or fabricated tool request.
  await completion(payload([user('Show the literal <<REQ>> example as text.')]), 'literal-marker')
  console.log('PASS: HTTP auth/origin, four queued requests with one worker, live SSE role/deltas, exact continuation, edited history, LRU recovery and cancellation recovery')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  if (server?.pid && server.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    else server.kill('SIGTERM')
  }
  const resolved = path.resolve(temporary)
  if (resolved.startsWith(root + path.sep) && path.basename(resolved).startsWith('.http-test-')) {
    try { fs.rmSync(resolved, { recursive: true, force: true }) } catch {}
  }
})
