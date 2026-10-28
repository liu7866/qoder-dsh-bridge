import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { nextPromotionBoundary, sanitizeQuota, UsageLedger } from './bridge-support.mjs'

test('promotion boundary uses the advertised timezone across midnight', () => {
  const models = [{ promotion: { timezone: 'Asia/Shanghai', window_start: '22:00', window_end: '08:00' } }]
  assert.equal(nextPromotionBoundary(models, Date.parse('2026-10-28T13:59:15Z')), Date.parse('2026-10-28T14:00:00Z'))
  assert.equal(nextPromotionBoundary(models, Date.parse('2026-10-28T14:01:00Z')), Date.parse('2026-10-29T00:00:00Z'))
  assert.equal(nextPromotionBoundary([{ promotion: { timezone: 'invalid', window_start: '99:00' } }]), null)
})

test('quota excludes user identifiers and URLs while keeping unknown values absent', () => {
  const result = sanitizeQuota({ userId: 'secret', upgradeUrl: 'secret', userQuota: { used: 3, remaining: 9, detailUrl: 'secret' } })
  assert.deepEqual(result, { userQuota: { used: 3, remaining: 9 } })
  assert.equal(sanitizeQuota(null), null)
})

test('ledger deduplicates requests, keeps free status, and never stores prompt or raw request id', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcp-ledger-'))
  t.after(() => { const resolved = path.resolve(dir); if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('qcp-ledger-')) fs.rmSync(resolved, { recursive: true, force: true }) })
  const file = path.join(dir, 'usage.jsonl'), usage = { request_id: 'private-request', credits: 0.25, original_credits: 0.5, billable: false, prompt: 'secret-prompt' }
  const ledger = new UsageLedger(file, 'test-secret')
  ledger.record(usage, 'message-id', 'test-model', 'chat'); ledger.record(usage, 'message-id', 'test-model', 'chat')
  assert.equal(ledger.snapshot().recent.length, 1)
  assert.equal(ledger.snapshot().recent[0].billable, false)
  assert(!fs.readFileSync(file, 'utf8').includes('private-request'))
  assert(!fs.readFileSync(file, 'utf8').includes('secret-prompt'))
  const again = new UsageLedger(file, 'test-secret'); again.record(usage, 'message-id', 'test-model', 'chat')
  assert.equal(again.snapshot().recent.length, 1)
  again.record({ credits: 1 }, undefined, 'test-model', 'chat')
  assert.equal(again.snapshot().unidentified_events, 1)
  again.recordSessionDelta(0, 'result-id', 'test-model', 'chat')
  again.recordSessionDelta(0, 'result-id', 'test-model', 'chat')
  assert.equal(again.snapshot().recent.length, 2)
  assert.equal(again.snapshot().recent[0].kind, 'session_delta')
  assert.equal(again.snapshot().recent[0].credits, 0)
})
