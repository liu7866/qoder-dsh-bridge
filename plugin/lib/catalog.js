const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MAX_AGE = 70 * 60 * 1000;
const positive = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback;

export function catalogFromResponse(payload, fallbackModels, fallbackContext, now = Date.now()) {
  if (!Array.isArray(payload?.data) || !payload.data.length) throw new Error('代理未返回可用模型列表');
  const seen = new Set(), fetched = Date.parse(payload.catalog_updated_at || '');
  const fresh = Number.isFinite(fetched) && fetched <= now + 60000 && now - fetched <= MAX_AGE;
  const fallbackById = new Map(fallbackModels.map(info => [info.id, info]));
  return payload.data.map(entry => {
    if (typeof entry?.id !== 'string' || !entry.id.trim() || seen.has(entry.id)) throw new Error('代理模型列表包含无效或重复的 ID');
    seen.add(entry.id);
    const fallback = fallbackById.get(entry.id);
    return {
      id: entry.id,
      displayName: typeof entry.display_name === 'string' && entry.display_name.trim() ? entry.display_name.trim() : fallback?.displayName || entry.id,
      contextWindow: positive(entry.context_window, fallback?.contextWindow || fallbackContext),
      maxTokens: positive(entry.max_output_tokens, fallback?.maxTokens || 32768),
      canDisable: typeof entry.can_disable_thinking === 'boolean' ? entry.can_disable_thinking : fallback?.canDisable === true,
      efforts: Array.isArray(entry.reasoning_efforts) ? EFFORTS.filter(level => entry.reasoning_efforts.includes(level)) : fallback?.efforts || [],
      supportsImages: entry.supports_images === true,
      priceLabel: !fresh ? '额度待确认' : entry.is_free === true ? '当前免费' :
        typeof entry.price_factor === 'number' && Number.isFinite(entry.price_factor) && entry.price_factor >= 0
          ? `额度 ${entry.price_factor}×${entry.promotion?.active ? ' 活动中' : ''}` : '额度待确认',
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function parseVisibility(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.hidden_models) || data.hidden_models.length > 500 ||
      !data.hidden_models.every(id => typeof id === 'string' && /^[a-z0-9._-]{1,128}$/.test(id))) throw new Error('Invalid model visibility settings');
  return new Set(data.hidden_models);
}

export function visibleModels(models, hidden) {
  return models.filter(model => !hidden.has(model.id));
}
