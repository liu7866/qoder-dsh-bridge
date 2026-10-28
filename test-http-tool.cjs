// Exercise tool-result reconciliation over HTTP, including pi-ai image wrapping.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), net = require('node:net')
const { spawn, spawnSync } = require('node:child_process'), { setTimeout: delay } = require('node:timers/promises')
const root = __dirname, temp = fs.mkdtempSync(path.join(root, '.tool-test-')), fake = path.join(root, 'fake-native.cjs')
const token = '8'.repeat(64), tokenFile = path.join(temp, 'token'); fs.writeFileSync(tokenFile, token)
fs.copyFileSync(path.join(root, 'qoder-cli-proxy.mjs'), path.join(temp, 'qoder-cli-proxy.mjs'))
fs.copyFileSync(path.join(root, 'bridge-support.mjs'), path.join(temp, 'bridge-support.mjs'))
const native = fs.readFileSync(path.join(root, 'native-worker.mjs'), 'utf8').replace('(this.spawnProcess || spawn)', `(this.spawnProcess || ((cli,args,opts)=>spawn(process.execPath,[${JSON.stringify(fake)},...args],opts)))`)
fs.writeFileSync(path.join(temp, 'native-worker.mjs'), native)
const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }]
const initial = [{ role: 'system', content: 'synthetic' }, { role: 'user', content: 'read fixture' }]
let server, output = '', base
async function post(messages, session) {
  const response = await fetch(base + '/v1/chat/completions', { method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'x-session-id': session },
    body: JSON.stringify({ model: 'deepseek-flash', reasoning_effort: 'off', max_tokens: 256, messages, tools }) })
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body.choices[0].message
}
async function main() {
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); base = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [path.join(temp, 'qoder-cli-proxy.mjs'), '--port', String(port)], { cwd: temp, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAKE_MODE: 'tool', QCP_CLI: process.execPath, QCP_TOKEN_FILE: tokenFile, QCP_PREWARM: '0', QCP_TIMEOUT: '5000' } })
  server.stdout.on('data', x => output += x); server.stderr.on('data', x => output += x)
  for (let i=0;i<100;i++) { try { if ((await fetch(base + '/healthz')).ok) break } catch {} await delay(100); if (i===99) throw Error('proxy did not start') }
  const first = await post(initial, 'tool-image'); assert.equal(first.tool_calls.length, 1)
  const result = { role: 'tool', tool_call_id: first.tool_calls[0].id, content: '(see attached image)' }
  const wrapper = { role: 'user', content: [{ type: 'text', text: 'Attached image(s) from tool result:' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }
  const second = await post([...initial, first, result, wrapper], 'tool-image')
  await delay(50)
  assert.match(second.content, /\[image:image\/png:aGVsbG8=\]/)
  assert.match(output, /mode=warm .*purpose=chat/)
  assert.doesNotMatch(output, /tool result mismatch/)
  const other = await post(initial, 'edited'); const tool = { role: 'tool', tool_call_id: other.tool_calls[0].id, content: 'done' }
  const changed = await post([...initial, other, tool, { role: 'user', content: 'a separate user request' }], 'edited')
  await delay(50)
  assert(changed.tool_calls?.length, 'unrelated user message triggers safe reconstruction, not reuse of pending tool call')
  assert.match(output, /tool result mismatch: pending=1 results=1 matched=1 extra_user=1/)
  console.log('PASS: pi-ai image result resumes the matching tool; unrelated new user text triggers safe reconstruction')
}
main().catch(error => { console.error(error); console.error(output.slice(-3000)); process.exitCode = 1 }).finally(() => {
  if (server?.pid && server.exitCode === null) spawnSync('taskkill', ['/pid', String(server.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
  const resolved = path.resolve(temp); if (resolved.startsWith(path.resolve(root) + path.sep) && path.basename(resolved).startsWith('.tool-test-')) try { fs.rmSync(resolved, { recursive: true, force: true }) } catch {}
})
