import test from 'node:test'
import assert from 'node:assert/strict'
import { catalogFromResponse, parseVisibility, visibleModels } from './plugin/lib/catalog.js'

test('price becomes unknown when catalog ages even if proxy is unreachable', () => {
  const now = Date.parse('2026-10-28T10:00:00Z')
  const data = { catalog_updated_at: new Date(now).toISOString(), data: [
    { id: 'free', display_name: 'Free', is_free: true },
    { id: 'discount', display_name: 'Discount', price_factor: 0.5, promotion: { active: true } }
  ] }
  const fresh = catalogFromResponse(data, [], 200000, now)
  assert.deepEqual(fresh.map(m => m.priceLabel), ['额度 0.5× 活动中', '当前免费'])
  const stale = catalogFromResponse(data, [], 200000, now + 71 * 60 * 1000)
  assert.deepEqual(stale.map(m => m.priceLabel), ['额度待确认', '额度待确认'])
})

test('visibility hides selected ids and rejects malformed settings', () => {
  const hidden = parseVisibility('{"hidden_models":["deepseek-flash"]}')
  assert.deepEqual(visibleModels([{ id: 'deepseek-flash' }, { id: 'auto' }], hidden), [{ id: 'auto' }])
  assert.throws(() => parseVisibility('{"hidden_models":["../bad"]}'))
  assert.throws(() => parseVisibility('{}'))
})
