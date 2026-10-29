import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { NativeWorker, buildLaunchArgs } from './native-worker.mjs'

const fakePath = fileURLToPath(new URL('./fake-native.cjs', import.meta.url))
const defaultTools = [{ name: 'read_file', description: 'Read a text file', parameters: {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path']
} }]
function worker(t, mode = 'text', overrides = {}) {
  const instance = new NativeWorker({
    cli: 'fake-qoder', model: 'test-model', effort: 'off', maxTokens: 256,
    contextWindow: 200000, systemPrompt: 'Follow the caller instructions.', tools: defaultTools,
    timeout: 1500, ...overrides,
    spawnProcess(cli, args, options) {
      return spawn(process.execPath, [fakePath, ...args], {
        ...options, windowsHide: true,
        env: { ...process.env, ...options.env, FAKE_MODE: mode }
      })
    }
  })
  t.after(() => instance.destroy())
  return instance
}

test('MCP initialize and tools/list handshake precede a plain completion', { timeout: 5000 }, async t => {
  const native = worker(t)
  await native.start()
  const response = await native.turn({ prompt: 'hello' })
  assert.equal(response.content, 'hello')
  assert.deepEqual(response.calls, [])
  assert.equal(response.usage.input_tokens, 24)
})

test('quota control response and request usage callbacks are available', { timeout: 5000 }, async t => {
  const native = worker(t, 'usage')
  await native.start()
  const quota = await native.control('get_usage_info')
  assert.equal(quota.usage.userQuota.remaining, 80)
  const events = [], totals = []
  await native.turn({ prompt: 'usage fixture', onUsage: (usage, id) => events.push({ usage, id }), onSessionUsage: delta => totals.push(delta) })
  assert.equal(events.length, 2)
  assert.equal(events[0].usage.billable, false)
  assert.equal(events[0].usage.credits, 0.25)
  assert.deepEqual(totals, [0])
})

test('text deltas arrive before completion without duplicate assistant/result text', { timeout: 5000 }, async t => {
  const native = worker(t, 'stream')
  await native.start()
  let finished = false
  const chunks = []
  const promise = native.turn({ prompt: 'stream please', onText(text) {
    assert.equal(finished, false)
    chunks.push(text)
  } })
  const result = await promise
  finished = true
  assert.equal(chunks.join(''), 'hello world')
  assert.equal(result.content, 'hello world')
  assert(chunks.length >= 2)
})

test('reasoning deltas are separate from answer text', { timeout: 5000 }, async t => {
  const native = worker(t, 'reasoning')
  await native.start()
  const reasoning = [], text = []
  const response = await native.turn({ prompt: 'think', onText: s => text.push(s), onReasoning: s => reasoning.push(s) })
  assert.equal(reasoning.join(''), 'checking')
  assert.equal(text.join(''), 'done')
  assert.equal(response.content, 'done')
})

test('native tools/call pauses and resumes with the next turn toolResults', { timeout: 5000 }, async t => {
  const native = worker(t, 'tool')
  await native.start()
  const request = await native.turn({ prompt: 'read demo1.txt' })
  assert.equal(request.calls.length, 1)
  const call = request.calls[0]
  assert.equal(call.name, 'read_file')
  assert.deepEqual(call.arguments, { path: 'demo1.txt' })
  assert.equal(typeof call.id, 'string')
  const result = await native.turn({ toolResults: new Map([[call.id, 'FILE_TOKEN_42']]) })
  assert.equal(result.content, 'result: FILE_TOKEN_42')
  assert.deepEqual(result.calls, [])
})

test('DSH run_code keeps its name without enabling a standalone native CLI tool', { timeout: 5000 }, async t => {
  const tools = [{ name: 'run_code', description: 'Execute a host program', parameters: {
    type: 'object', properties: { code: { type: 'string' }, description: { type: 'string' } }, required: ['code', 'description']
  } }]
  const args = buildLaunchArgs({ model: 'test', tools })
  const allowed = args[args.indexOf('--allowed-tools') + 1].split(',')
  assert(allowed.includes('mcp__dsh__run_code'))
  assert(!allowed.includes('run_code'))
  const native = worker(t, 'run-code', { tools }); await native.start()
  const request = await native.turn({ prompt: 'call run_code' })
  assert.equal(request.calls[0].name, 'run_code')
  assert.equal(request.calls[0].arguments.code, 'text("SAFE")')
  const result = await native.turn({ toolResults: new Map([[request.calls[0].id, 'SAFE']]) })
  assert.equal(result.content, 'result: SAFE')
})

test('generated aliases avoid actual tool names across launch and MCP routing', { timeout: 5000 }, async t => {
  const tools = [...defaultTools, { ...defaultTools[0], name: 'bridge_t_0' }]
  const args = buildLaunchArgs({ model: 'test', tools })
  const allowed = args[args.indexOf('--allowed-tools') + 1].split(',')
  assert.deepEqual(allowed, ['mcp__dsh__read_file', 'bridge_t_1', 'mcp__dsh__bridge_t_0', 'bridge_t_2'])
  const native = worker(t, 'alias-collision', { tools }); await native.start()
  const request = await native.turn({ prompt: 'read demo' })
  assert.equal(request.calls[0].name, 'read_file')
  assert.equal(native.aliases.get('bridge_t_0'), 'bridge_t_0')
  assert.equal(native.aliases.get('mcp__dsh__bridge_t_0'), 'bridge_t_0')
  const result = await native.turn({ toolResults: new Map([[request.calls[0].id, 'SAFE']]) })
  assert.equal(result.content, 'result: SAFE')
})

test('MCP-qualified tool names cannot collide with another actual name', () => {
  const tools = [{ name: 'read_file' }, { name: 'mcp__dsh__read_file' }]
  assert.throws(() => buildLaunchArgs({ model: 'test', tools }), /ambiguous/i)
  assert.throws(() => new NativeWorker({ tools }), /ambiguous/i)
})

test('tool result images are forwarded as MCP image content', { timeout: 5000 }, async t => {
  const native = worker(t, 'tool')
  await native.start()
  const request = await native.turn({ prompt: 'inspect image' })
  const call = request.calls[0]
  const result = await native.turn({ toolResults: new Map([[call.id, { text: 'image result', images: [
    { type: 'image', source: { media_type: 'image/png', data: 'aGVsbG8=' } }
  ] }]]) })
  assert.match(result.content, /image result/)
  assert.match(result.content, /\[image:image\/png:aGVsbG8=\]/)
})

test('parallel native tools aggregate before return and resume together', { timeout: 5000 }, async t => {
  const native = worker(t, 'parallel-tools', { tools: [...defaultTools, { name: 'write_file', description: 'Write file', parameters: {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path']
  } }] })
  await native.start()
  const request = await native.turn({ prompt: 'read and write' })
  assert.equal(request.calls.length, 2)
  assert.equal(new Set(request.calls.map(c => c.id)).size, 2)
  assert.deepEqual(new Set(request.calls.map(c => c.name)), new Set(['read_file', 'write_file']))
  const result = await native.turn({ toolResults: new Map(request.calls.map(c => [c.id, c.name + '_OK'])) })
  assert.match(result.content, /read_file_OK/)
  assert.match(result.content, /write_file_OK/)
  assert.deepEqual(result.calls, [])
})

test('unknown native tools are safely rejected', { timeout: 5000 }, async t => {
  const native = worker(t, 'unknown-tool')
  await native.start()
  await assert.rejects(native.turn({ prompt: 'unknown tool' }), /tool|unknown|undeclared|not allowed/i)
})

test('native tool arguments must satisfy the declared JSON schema', { timeout: 5000 }, async t => {
  const native = worker(t, 'invalid-arguments')
  await native.start()
  await assert.rejects(native.turn({ prompt: 'missing path' }), /argument|schema|invalid/i)
})

test('malformed null event and null content entries do not crash the host', { timeout: 5000 }, async t => {
  const native = worker(t, 'null')
  await native.start()
  const result = await native.turn({ prompt: 'ignore broken event' })
  assert.equal(result.content, 'safe after malformed events')
})

test('UTF-8 codepoints split between stdout chunks are preserved', { timeout: 5000 }, async t => {
  const native = worker(t, 'fragmented')
  await native.start()
  const chunks = []
  const result = await native.turn({ prompt: 'unicode', onText: s => chunks.push(s) })
  assert.equal(chunks.join(''), '你好🌊')
  assert.equal(result.content, '你好🌊')
  assert(!result.content.includes('\ufffd'))
})

test('cancellation settles an active request promptly', { timeout: 5000 }, async t => {
  const native = worker(t, 'wait')
  await native.start()
  const controller = new AbortController()
  const result = native.turn({ prompt: 'wait', signal: controller.signal })
  setTimeout(() => controller.abort(), 40)
  await assert.rejects(result, /abort|cancel|disconnected/i)
})

test('turn timeout rejects instead of leaving a pending promise', { timeout: 5000 }, async t => {
  const native = worker(t, 'timeout', { timeout: 450 })
  await native.start()
  await assert.rejects(native.turn({ prompt: 'never finish' }), /timeout|timed out/i)
})

test('initialization timeout rejects instead of leaving start pending', { timeout: 5000 }, async t => {
  const native = worker(t, 'startup-timeout', { timeout: 450 })
  await assert.rejects(native.start(), /timeout|timed out/i)
})

test('a max-token stop is reported as length rather than normal completion', { timeout: 5000 }, async t => {
  const native = worker(t, 'length')
  await native.start()
  const result = await native.turn({ prompt: 'long answer' })
  assert.equal(result.content, 'partial answer')
  assert.equal(result.finishReason, 'length')
})

test('upstream errors preserve useful context classification', { timeout: 5000 }, async t => {
  const native = worker(t, 'upstream-error')
  await native.start()
  await assert.rejects(native.turn({ prompt: 'too long' }), /context window exceeded/i)
})
