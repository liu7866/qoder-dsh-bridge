import fs from 'node:fs'
import { createHmac, randomUUID } from 'node:crypto'

const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
const short = value => typeof value === 'string' && value.length <= 80 ? value : undefined

// pi-ai moves images from tool results into this exact following user message.
export function matchToolResults(tail, waiting) {
  const results = tail.filter(message => message.role === 'tool')
  if (results.length !== waiting.size || new Set(results.map(m => m.tool_call_id)).size !== results.length ||
      results.some(m => !waiting.has(m.tool_call_id))) return null
  const extras = tail.filter(message => message.role !== 'tool')
  let attachment
  if (extras.length) {
    if (extras.length !== 1 || results.length !== 1 || tail.at(-1) !== extras[0] || extras[0].role !== 'user' ||
        extras[0].content !== 'Attached image(s) from tool result:' || !extras[0].images?.length) return null
    attachment = extras[0].images
  }
  return new Map(results.map(m => [m.tool_call_id, { text: m.content, images: [...(m.images || []), ...(attachment || [])] }]))
}

// Refresh at upstream-declared local-time boundaries, but never calculate prices ourselves.
export function nextPromotionBoundary(models, now = Date.now()) {
  const clocks = new Map()
  for (const model of models) {
    const p = model.promotion
    if (!p || typeof p.timezone !== 'string') continue
    for (const time of [p.window_start, p.window_end]) {
      if (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) continue
      try {
        let format = clocks.get(p.timezone)?.format
        if (!format) format = new Intl.DateTimeFormat('en-GB', { timeZone: p.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        if (!clocks.has(p.timezone)) clocks.set(p.timezone, { format, targets: new Set() })
        clocks.get(p.timezone).targets.add(time)
      } catch {}
    }
  }
  const begin = (Math.floor(now / 60000) + 1) * 60000
  for (let i = 0; i < 48 * 60; i++) {
    const time = begin + i * 60000
    for (const { format, targets } of clocks.values()) if (targets.has(format.format(time))) return time
  }
  return null
}

export function sanitizeQuota(value) {
  if (!value || typeof value !== 'object') return null
  const bucket = input => {
    if (!input || typeof input !== 'object') return undefined
    const output = {}
    for (const key of ['total', 'cap', 'used', 'remaining', 'percentage']) {
      const number = numeric(input[key]); if (number !== undefined) output[key] = number
    }
    const unit = short(input.unit); if (unit !== undefined) output.unit = unit
    if (typeof input.available === 'boolean') output.available = input.available
    return Object.keys(output).length ? output : undefined
  }
  const result = {}
  const userType = short(value.userType); if (userType !== undefined) result.userType = userType
  const percentage = numeric(value.totalUsagePercentage); if (percentage !== undefined) result.totalUsagePercentage = percentage
  if (typeof value.isQuotaExceeded === 'boolean') result.isQuotaExceeded = value.isQuotaExceeded
  for (const key of ['userQuota', 'addOnQuota', 'orgResourcePackage']) {
    const cleaned = bucket(value[key]); if (cleaned) result[key] = cleaned
  }
  return Object.keys(result).length ? result : null
}

export class UsageLedger {
  constructor(filename, secret) {
    this.filename = filename; this.secret = secret; this.seen = new Set(); this.records = []; this.recordingOk = true; this.unidentified = 0
    try {
      const fd = fs.openSync(filename, 'r')
      try {
        const size = fs.fstatSync(fd).size, length = Math.min(size, 1024 * 1024), bytes = Buffer.alloc(length)
        fs.readSync(fd, bytes, 0, length, size - length)
        const lines = bytes.toString('utf8').split('\n'); if (size > length) lines.shift()
        for (const line of lines) { try { const record = JSON.parse(line); if (record.key) this.add(record) } catch {} }
      } finally { fs.closeSync(fd) }
    } catch (error) { if (error.code !== 'ENOENT') this.recordingOk = false }
  }
  add(record) {
    this.seen.add(record.key); this.records.push(record)
    if (this.records.length > 5000) { const first = this.records.shift(); this.seen.delete(first.key) }
  }
  record(usage, messageId, model, purpose) {
    try {
      if (numeric(usage?.credits) === undefined && numeric(usage?.original_credits) === undefined && typeof usage?.billable !== 'boolean') return
      const sourceId = typeof usage?.request_id === 'string' && usage.request_id ? usage.request_id : typeof messageId === 'string' && messageId ? messageId : ''
      if (!sourceId) { this.unidentified++; return }
      const key = createHmac('sha256', this.secret).update(sourceId).digest('hex')
      if (this.seen.has(key)) return
      const entry = { key, at: new Date().toISOString(), kind: 'request', model, purpose, deduplication: usage.request_id ? 'request' : 'message' }
      for (const name of ['credits', 'original_credits', 'context_usage_ratio']) {
        const number = numeric(usage[name]); if (number !== undefined) entry[name] = number
      }
      if (typeof usage.billable === 'boolean') entry.billable = usage.billable
      this.add(entry)
      try { fs.appendFileSync(this.filename, JSON.stringify(entry) + '\n', { mode: 0o600 }) }
      catch { this.recordingOk = false }
    } catch { this.recordingOk = false }
  }
  recordSessionDelta(delta, eventId, model, purpose) {
    if (numeric(delta) === undefined) return
    try {
      const key = createHmac('sha256', this.secret).update('session-result:' + (eventId || randomUUID())).digest('hex')
      if (this.seen.has(key)) return
      const entry = { key, at: new Date().toISOString(), kind: 'session_delta', model, purpose, credits: delta }
      this.add(entry)
      try { fs.appendFileSync(this.filename, JSON.stringify(entry) + '\n', { mode: 0o600 }) }
      catch { this.recordingOk = false }
    } catch { this.recordingOk = false }
  }
  snapshot() {
    return { recording_ok: this.recordingOk, unidentified_events: this.unidentified,
      recent: this.records.slice(-50).reverse().map(({ key, ...record }) => record) }
  }
}
