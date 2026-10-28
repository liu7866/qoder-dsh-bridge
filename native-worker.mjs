import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import Ajv from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js'

let validators = [new Ajv({ strict: false, validateFormats: false }), new Ajv2020({ strict: false, validateFormats: false })]
const schemaCache = new Map()

export function buildLaunchArgs({ model, effort, maxTokens, contextWindow, tools = [] }) {
  const nativeNames = tools.flatMap((t, i) => ['mcp__dsh__' + t.name, 'bridge_t_' + i])
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages',
    '--no-session-persistence', '--permission-mode', 'dont_ask', '--tools', nativeNames.join(','),
    '--strict-mcp-config', '--setting-sources', '', '--model', model]
  if (nativeNames.length) args.push('--allowed-tools', nativeNames.join(','))
  if (effort === 'off') args.push('--thinking', 'disabled')
  else if (effort && effort !== 'default') args.push('--reasoning-effort', effort)
  if (maxTokens) args.push('--max-output-tokens', String(maxTokens))
  if (contextWindow) args.push('--context-window', String(contextWindow))
  return args
}
export class NativeWorker {
  constructor(options) {
    Object.assign(this, { timeout: 180000, tools: [], ...options })
    this.proc = null; this.pending = null; this.starting = null; this.waiting = new Map(); this.expected = 0
    this.controls = new Map()
    this.lastSessionCredits = 0
    this.aliases = new Map()
    this.checks = new Map()
    for (const [index, tool] of this.tools.entries()) {
      const alias = 'bridge_t_' + index
      this.aliases.set(alias, tool.name); this.aliases.set(tool.name, tool.name)
      this.aliases.set('mcp__dsh__' + tool.name, tool.name)
      const schema = tool.parameters || { type: 'object' }
      const version = String(schema.$schema || '').includes('2020') ? 1 : 0
      const key = version + ':' + JSON.stringify(schema)
      try {
        let check = schemaCache.get(key)
        if (!check) {
          if (schemaCache.size >= 512) {
            schemaCache.clear()
            validators = [new Ajv({ strict: false, validateFormats: false }), new Ajv2020({ strict: false, validateFormats: false })]
          }
          check = validators[version].compile(schema)
          schemaCache.set(key, check)
        }
        this.checks.set(tool.name, check)
      }
      catch { throw new Error('Invalid JSON schema for tool ' + tool.name) }
    }
  }
  write(value) {
    if (!this.proc?.stdin?.writable) throw new Error('Qoder worker is not writable')
    this.proc.stdin.write(JSON.stringify(value) + '\n')
  }
  start() {
    if (this.starting) return this.starting.promise
    const state = {}
    state.promise = new Promise((resolve, reject) => { state.resolve = resolve; state.reject = reject })
    this.starting = state
    const args = buildLaunchArgs(this)
    const prestarted = this.prestarted
    const proc = prestarted || (this.spawnProcess || spawn)(this.cli, args, { cwd: os.tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.prestarted = null
    this.proc = proc
    state.timer = setTimeout(() => this.abort(Error('Qoder initialization timed out')), this.timeout)
    const initialize = () => {
      try {
        // DSH's system instructions refer to run_code by name; preserve that
        // reserved host transport name while keeping other tools isolated.
        const overrides = Object.fromEntries(this.tools.map((t, i) => [t.name, { exposedName: t.name === 'run_code' ? t.name : 'bridge_t_' + i, alwaysLoad: true }]))
        this.write({ type: 'control_request', request_id: 'bridge_init', request: { subtype: 'initialize',
          systemPrompt: this.systemPrompt || 'You are a helpful assistant. Follow the client request.', includePartialMessages: this.includePartialMessages !== false,
          sdkMcpServers: this.tools.length ? ['dsh'] : [], sdkMcpToolOverrides: { dsh: overrides } } })
      } catch (e) { this.abort(e) }
    }
    if (prestarted?.__qcpSpawned) queueMicrotask(initialize)
    else proc.once('spawn', initialize)
    proc.on('error', e => { if (this.proc === proc) this.abort(e) })
    proc.on('close', code => { if (this.proc === proc) this.abort(Error('Qoder worker exited (code ' + code + ')')) })
    proc.stdin.on('error', e => { if (this.proc === proc) this.abort(e) })
    proc.stderr.on('data', () => {})
    const decoder = new StringDecoder('utf8'); let buffer = ''
    proc.stdout.on('data', chunk => {
      if (this.proc !== proc) return
      buffer += decoder.write(chunk)
      if (buffer.length > 8 * 1024 * 1024) return this.abort(Error('Qoder event exceeds size limit'))
      const lines = buffer.split('\n'); buffer = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        let event; try { event = JSON.parse(line) } catch { continue }
        try { if (event && typeof event === 'object') this.event(event) }
        catch (e) { this.abort(e); break }
      }
    })
    return state.promise
  }
  respond(control, result) {
    const m = control.request.message
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: control.request_id,
      response: { mcp_response: m.id == null ? null : { jsonrpc: '2.0', id: m.id, result } } } })
  }
  control(subtype, timeout = 15000) {
    if (!this.proc || this.starting) return Promise.reject(Error('Qoder worker is not initialized'))
    const requestId = 'bridge_control_' + randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.controls.delete(requestId); reject(Error('Qoder control request timed out')) }, timeout)
      this.controls.set(requestId, { resolve, reject, timer })
      try { this.write({ type: 'control_request', request_id: requestId, request: { subtype } }) }
      catch (error) { clearTimeout(timer); this.controls.delete(requestId); reject(error) }
    })
  }
  event(j) {
    if (j.type === 'control_response' && j.response?.request_id === 'bridge_init') {
      const state = this.starting
      if (!state) return
      this.starting = null; clearTimeout(state.timer)
      this.models = Array.isArray(j.response.response?.models) ? j.response.response.models : []
      if (j.response.subtype !== 'success') { state.reject(Error('Qoder initialization failed')); this.destroy() }
      else state.resolve()
      return
    }
    if (j.type === 'control_response') {
      const state = this.controls.get(j.response?.request_id)
      if (!state) return
      this.controls.delete(j.response.request_id); clearTimeout(state.timer)
      if (j.response.subtype === 'success') state.resolve(j.response.response || {})
      else state.reject(Error('Qoder control request failed'))
      return
    }
    if (j.type === 'control_request') {
      if (j.request?.subtype !== 'mcp_message' || j.request.server_name !== 'dsh')
        throw Error('Unexpected Qoder control request; no local operation was executed')
      const m = j.request.message
      if (!m || typeof m !== 'object') throw Error('Invalid MCP event')
      if (m.method === 'initialize') return this.respond(j, { protocolVersion: m.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'dsh-bridge', version: '3.0.0' } })
      if (m.method === 'ping') return this.respond(j, {})
      if (m.method?.startsWith('notifications/')) return this.respond(j, {})
      if (m.method === 'tools/list') return this.respond(j, { tools: this.tools.map(t => ({ name: t.name, description: t.description || '', inputSchema: t.parameters || { type: 'object' } })) })
      if (m.method === 'tools/call') {
        const name = this.aliases.get(m.params?.name)
        const check = name && this.checks.get(name)
        if (!check || !check(m.params?.arguments)) throw Error('Qoder returned unknown tool or invalid tool arguments')
        const id = 'call_' + randomUUID().replaceAll('-', '')
        this.waiting.set(id, { control: j, call: { id, name, arguments: m.params.arguments } })
        this.finishTools()
        return
      }
      throw Error('Unsupported MCP request: ' + m.method)
    }
    const p = this.pending
    if (!p) {
      if (j.type === 'result' && this.waiting.size) this.destroy()
      return
    }
    if (j.type === 'stream_event') {
      const delta = j.event?.delta
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') { p.content += delta.text; p.onText?.(delta.text) }
      if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') p.onReasoning?.(delta.thinking)
      if (j.event?.type === 'message_delta' && j.event.delta?.stop_reason) p.stop = j.event.delta.stop_reason
    }
    if (j.type === 'assistant' && Array.isArray(j.message?.content)) {
      const blocks = j.message.content.filter(x => x && typeof x === 'object')
      const text = blocks.filter(x => x.type === 'text' && typeof x.text === 'string').map(x => x.text).join('')
      if (text && !p.content) { p.content = text; p.onText?.(text) }
      if (j.message.usage) {
        p.usage = j.message.usage
        p.onUsage?.(j.message.usage, j.uuid || j.message.id)
      }
      const calls = blocks.filter(x => x.type === 'tool_use')
      if (calls.length) { this.expected = calls.length; this.finishTools() }
    }
    if (j.type === 'result') {
      if (typeof j.total_credits === 'number' && Number.isFinite(j.total_credits) && j.total_credits >= this.lastSessionCredits) {
        const delta = j.total_credits - this.lastSessionCredits
        this.lastSessionCredits = j.total_credits
        p.onSessionUsage?.(delta, j.uuid)
      }
      if (j.is_error || String(j.subtype || '').startsWith('error')) {
        const detail = Array.isArray(j.errors) ? j.errors.join('; ') : typeof j.result === 'string' ? j.result : 'Qoder upstream error'
        throw Error(detail.slice(0, 1200))
      }
      if (!p.content && typeof j.result === 'string') { p.content = j.result; p.onText?.(j.result) }
      this.complete({ content: p.content, calls: [], usage: p.usage || j.usage,
        finishReason: /max_tokens|length/.test(p.stop || '') ? 'length' : 'stop' })
    }
  }
  finishTools() {
    if (!this.pending || !this.expected || this.waiting.size < this.expected) return
    if (this.waiting.size !== this.expected) throw Error('Qoder tool batch size mismatch')
    this.complete({ content: this.pending.content, calls: [...this.waiting.values()].map(x => x.call), usage: this.pending.usage, finishReason: 'tool_calls' })
  }
  complete(output) {
    const p = this.pending; if (!p) return
    this.pending = null; clearTimeout(p.timer); p.cleanup?.(); p.resolve(output)
  }
  turn({ prompt, images = [], toolResults, onText, onReasoning, onUsage, onSessionUsage, signal } = {}) {
    if (this.pending) return Promise.reject(Error('Qoder worker already has a pending request'))
    if (signal?.aborted) { this.destroy(); return Promise.reject(Error('Client disconnected')) }
    return new Promise((resolve, reject) => {
      const p = { resolve, reject, onText, onReasoning, onUsage, onSessionUsage, content: '', usage: null }
      const cancel = () => this.abort(Error('Client disconnected'))
      p.cleanup = () => signal?.removeEventListener('abort', cancel)
      signal?.addEventListener('abort', cancel, { once: true })
      p.timer = setTimeout(() => this.abort(Error('Qoder request timed out')), this.timeout)
      this.pending = p
      try {
        if (this.waiting.size) {
          if (!(toolResults instanceof Map) || toolResults.size !== this.waiting.size || [...this.waiting.keys()].some(id => !toolResults.has(id)))
            throw Error('Tool results do not match the pending Qoder calls')
          const batch = this.waiting; this.waiting = new Map(); this.expected = 0
          for (const [id, item] of batch) {
            const result = toolResults.get(id)
            const content = typeof result === 'string' ? [{ type: 'text', text: result }] : [
              { type: 'text', text: result.text },
              ...result.images.map(image => ({ type: 'image', data: image.source.data, mimeType: image.source.media_type }))
            ]
            this.respond(item.control, { content })
          }
        } else {
          this.expected = 0
          this.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt || '' }, ...images] } })
        }
      } catch (e) { this.abort(e) }
    })
  }
  abort(error) {
    const state = this.starting; this.starting = null
    if (state) { clearTimeout(state.timer); state.reject(error) }
    const p = this.pending; this.pending = null
    if (p) { clearTimeout(p.timer); p.cleanup?.(); p.reject(error) }
    this.destroy()
  }
  destroy() {
    const state = this.starting; this.starting = null
    if (state) { clearTimeout(state.timer); state.reject(Error('Qoder worker closed')) }
    const p = this.pending; this.pending = null
    if (p) { clearTimeout(p.timer); p.cleanup?.(); p.reject(Error('Qoder worker closed')) }
    for (const state of this.controls.values()) { clearTimeout(state.timer); state.reject(Error('Qoder worker closed')) }
    this.controls.clear()
    const proc = this.proc || this.prestarted; this.proc = null; this.prestarted = null; this.waiting.clear(); this.expected = 0
    if (proc) { try { proc.kill() } catch {} }
  }
}
