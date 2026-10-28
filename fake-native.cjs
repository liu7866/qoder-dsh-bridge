// Qoder JSONL fixture. It never contacts a model or executes a tool.
const readline = require('node:readline')
const mode = process.env.FAKE_MODE || 'text'
let initializeId
let list = []
let pendingCalls = new Map()
let collected = []
const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
const failure = message => { process.stderr.write('FAKE PROTOCOL FAILURE: ' + message + '\n'); process.exit(3) }
function mcp(requestId, id, method, params) {
  emit({ type: 'control_request', request_id: requestId, request: {
    subtype: 'mcp_message', server_name: 'dsh', message: { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }
  } })
}
function result(text, extra = {}) {
  emit({ type: 'result', subtype: 'success', is_error: false, result: text,
    usage: { input_tokens: 24, output_tokens: 12 }, ...(mode === 'usage' ? { total_credits: 0 } : {}), ...extra })
}
function assistant(text) {
  const usage = mode === 'usage' ? { request_id: 'fixture-request', credits: 0.25, original_credits: 0.5, billable: false } : undefined
  const event = { type: 'assistant', uuid: 'fixture-message', message: { role: 'assistant', content: [{ type: 'text', text }], ...(usage ? { usage } : {}) } }
  emit(event)
  if (mode === 'usage') emit(event)
}
function delta(type, value) {
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0,
    delta: type === 'thinking_delta' ? { type, thinking: value } : { type, text: value } } })
}
function toolUse(name, index, args) {
  return { type: 'tool_use', id: 'native-tool-' + index, name, input: args }
}
function askTools(names) {
  const blocks = names.map((name, i) => toolUse(name === 'run_code' ? name : 'bridge_t_' + i, i + 1,
    mode === 'invalid-arguments' ? {} : name === 'run_code' ? { code: 'text("SAFE")', description: 'Synthetic test' } : { path: 'demo' + (i + 1) + '.txt' }))
  emit({ type: 'assistant', message: { role: 'assistant', content: blocks } })
  names.forEach((name, i) => {
    const id = 'mcp-call-' + (i + 1)
    pendingCalls.set(id, name)
    mcp(id, i + 3, 'tools/call', { name, arguments: blocks[i].input })
  })
}
function user() {
  if (pendingCalls.size) return failure('unexpected second user prompt while an MCP call is pending')
  if (mode === 'wait' || mode === 'timeout') return
  if (mode === 'null') { emit(null); emit({ type: 'assistant', message: { content: [null] } }); assistant('safe after malformed events'); return result('safe after malformed events') }
  if (mode === 'tool') return askTools(['read_file'])
  if (mode === 'run-code') return askTools(['run_code'])
  if (mode === 'invalid-arguments') return askTools(['read_file'])
  if (mode === 'parallel-tools') return askTools(['read_file', 'write_file'])
  if (mode === 'unknown-tool') return askTools(['not_declared'])
  if (mode === 'stream') {
    emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
    delta('text_delta', 'hello ')
    return setTimeout(() => {
      delta('text_delta', 'world')
      emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
      assistant('hello world'); result('hello world')
    }, 35)
  }
  if (mode === 'reasoning') {
    delta('thinking_delta', 'checking')
    delta('text_delta', 'done')
    emit({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'checking' }, { type: 'text', text: 'done' }
    ] } })
    return result('done')
  }
  if (mode === 'fragmented') {
    const value = { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好🌊' } } }
    const line = Buffer.from(JSON.stringify(value) + '\n')
    const first = line.indexOf(Buffer.from('你')) + 1
    const second = line.indexOf(Buffer.from('🌊')) + 2
    process.stdout.write(line.subarray(0, first))
    return setTimeout(() => {
      process.stdout.write(line.subarray(first, second))
      setTimeout(() => { process.stdout.write(line.subarray(second)); assistant('你好🌊'); result('你好🌊') }, 15)
    }, 15)
  }
  if (mode === 'upstream-error') return result('', { is_error: true, subtype: 'error', result: 'context window exceeded' })
  if (mode === 'length') {
    delta('text_delta', 'partial answer')
    emit({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'max_tokens' } } })
    return result('partial answer')
  }
  assistant('hello'); result('hello')
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { return failure('parent wrote invalid JSON') }
  if (message.type === 'control_request' && message.request?.subtype === 'initialize') {
    initializeId = message.request_id
    if (mode === 'startup-timeout') return
    if (mode === 'run-code' && message.request.sdkMcpToolOverrides?.dsh?.run_code?.exposedName !== 'run_code') return failure('run_code must be exposed by its DSH name')
    if (!message.request.sdkMcpServers?.length) return emit({ type: 'control_response', response: { subtype: 'success', request_id: initializeId, response: {} } })
    return mcp('mcp-init', 1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fake-qoder', version: '1' } })
  }
  if (message.type === 'control_request' && message.request?.subtype === 'get_usage_info') return emit({ type: 'control_response', response: {
    subtype: 'success', request_id: message.request_id, response: { usage: { userId: 'private-fixture', userType: 'fixture',
      userQuota: { total: 100, used: 20, remaining: 80, unit: 'Credits', detailUrl: 'https://private.invalid' }, isQuotaExceeded: false } }
  } })
  if (message.type === 'control_response') {
    const response = message.response
    const id = response?.request_id
    const rpc = response?.response?.mcp_response
    if (id === 'mcp-init') {
      if (!rpc?.result?.serverInfo || !rpc.result.capabilities?.tools) return failure('invalid MCP initialize response')
      return mcp('mcp-list', 2, 'tools/list', {})
    }
    if (id === 'mcp-list') {
      list = rpc?.result?.tools
      if (!Array.isArray(list) || !list.length || !list.every(t => t.name && t.inputSchema)) return failure('invalid tools/list response')
      emit({ type: 'control_response', response: { subtype: 'success', request_id: initializeId, response: {} } })
      return emit({ type: 'system', subtype: 'init', session_id: 'fake-session', tools: list.map(t => t.name) })
    }
    if (pendingCalls.has(id)) {
      if (rpc?.result?.isError || rpc?.error || response.subtype === 'error') {
        pendingCalls.delete(id)
        if (!pendingCalls.size) { assistant('tool denied'); result('tool denied') }
        return
      }
      const contents = rpc?.result?.content
      if (!Array.isArray(contents) || !contents.every(x => x.type === 'text' || x.type === 'image' && typeof x.data === 'string' && typeof x.mimeType === 'string')) return failure('invalid tools/call result')
      collected.push(contents.map(x => x.type === 'image' ? '[image:' + x.mimeType + ':' + x.data + ']' : x.text).join('\n'))
      pendingCalls.delete(id)
      if (!pendingCalls.size) {
        const text = 'result: ' + collected.join(' | ')
        assistant(text); result(text); collected = []
      }
      return
    }
    return
  }
  if (message.type === 'user') user()
})
