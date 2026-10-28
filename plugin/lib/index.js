import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { resolveRetryPolicy, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

export const name = 'llm-qoder';
export const inject = ['llm'];

const PROVIDER_ID = 'qoder';
const DISPLAY_NAME = 'Qoder CN';
const BASE_URL = (process.env.QODER_PROXY_BASE || 'http://127.0.0.1:18082/v1').replace(/\/+$/, '');
const proxyUrl = new URL(BASE_URL);
if (proxyUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(proxyUrl.hostname)) {
  throw new Error('Qoder 本地代理必须使用本机 HTTP 地址');
}
const TOKEN_FILE = process.env.QCP_TOKEN_FILE || path.join(os.homedir(), '.dsh', 'qoder-bridge-v2', 'token');
const FALLBACK_CONTEXT = Number(process.env.QODER_CONTEXT_WINDOW) || 200000;
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const REFRESH_MS = 15000;
const PRICE_MAX_AGE_MS = 70 * 60 * 1000;

function localToken() {
  let value;
  try { value = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); }
  catch { throw new Error('Qoder 本地代理密钥不存在，请先完成代理安装'); }
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Qoder 本地代理密钥文件无效');
  return value;
}

// These are the modes already checked locally; live CLI metadata replaces them.
const FALLBACK_MODELS = [
  ['auto', 'Auto', true],
  ['qwen3.8-max', 'Qwen3.8 Max', true],
  ['qwen3.8-flash', 'Qwen3.8 Flash', true],
  ['deepseek-v4-pro', 'DeepSeek V4 Pro', true],
  ['deepseek-flash', 'DeepSeek Flash', true],
  ['glm-5.3', 'GLM-5.3', false],
  ['glm-5.3-flash', 'GLM-5.3 Flash', false],
  ['kimi-k3.1-pro', 'Kimi K3.1 Pro', true],
  ['kimi-k2.8-preview', 'Kimi K2.8 Preview', true],
  ['minimax-m3.1-flash', 'MiniMax M3.1 Flash', false],
].map(([id, displayName, canDisable]) => ({
  id,
  displayName,
  contextWindow: FALLBACK_CONTEXT,
  maxTokens: 32768,
  canDisable,
  efforts: canDisable ? [] : ['medium'],
  supportsImages: false,
  priceLabel: '额度待确认',
}));

// The adapter requires numeric costs. These are placeholders, not a claim of free usage.
const UNKNOWN_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
};
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() { return []; },
    async modify() { throw new Error('dsh-qoder-connect: 凭据由本地代理管理'); },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() { return false; },
  },
};

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function catalogFromResponse(payload) {
  if (!Array.isArray(payload?.data) || payload.data.length === 0) {
    throw new Error('代理未返回可用模型列表');
  }
  const seen = new Set();
  const fetched = Date.parse(payload.catalog_updated_at || '');
  const fresh = Number.isFinite(fetched) && fetched <= Date.now() + 60000 && Date.now() - fetched <= PRICE_MAX_AGE_MS;
  const fallbackById = new Map(FALLBACK_MODELS.map(info => [info.id, info]));
  return payload.data.map(entry => {
    if (typeof entry?.id !== 'string' || !entry.id.trim() || seen.has(entry.id)) {
      throw new Error('代理模型列表包含无效或重复的 ID');
    }
    seen.add(entry.id);
    const fallback = fallbackById.get(entry.id);
    const efforts = Array.isArray(entry.reasoning_efforts)
      ? EFFORTS.filter(level => entry.reasoning_efforts.includes(level))
      : fallback?.efforts || [];
    return {
      id: entry.id,
      displayName: typeof entry.display_name === 'string' && entry.display_name.trim()
        ? entry.display_name.trim() : fallback?.displayName || entry.id,
      contextWindow: positiveInteger(entry.context_window, fallback?.contextWindow || FALLBACK_CONTEXT),
      maxTokens: positiveInteger(entry.max_output_tokens, fallback?.maxTokens || 32768),
      canDisable: typeof entry.can_disable_thinking === 'boolean'
        ? entry.can_disable_thinking : fallback?.canDisable === true,
      efforts,
      supportsImages: entry.supports_images === true,
      priceLabel: !fresh ? '额度待确认' : entry.is_free === true ? '当前免费' :
        typeof entry.price_factor === 'number' && Number.isFinite(entry.price_factor) && entry.price_factor >= 0
          ? `额度 ${entry.price_factor}×${entry.promotion?.active ? ' 活动中' : ''}` : '额度待确认',
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function toPiModel(info) {
  const thinkingLevelMap = { off: info.canDisable ? 'off' : null };
  for (const level of EFFORTS) thinkingLevelMap[level] = info.efforts.includes(level) ? level : null;
  return {
    id: info.id,
    name: `${info.displayName} · ${info.priceLabel}`,
    api: 'openai-completions',
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
    input: info.supportsImages ? ['text', 'image'] : ['text'],
    reasoning: info.canDisable || info.efforts.length > 0,
    thinkingLevelMap,
    cost: UNKNOWN_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    compat: {
      maxTokensField: 'max_tokens',
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: 'openrouter',
      supportsUsageInStreaming: true,
    },
  };
}

// Auxiliary title/compaction calls need independent, short-lived CLI sessions.
class QoderPiAiAdapter extends PiAiAdapter {
  streamWithSnapshot(options, snapshot) {
    const profile = snapshot.profiles.get(options.provider);
    if (!profile) return super.streamWithSnapshot(options, snapshot);
    const purpose = options.purpose === 'session-title' || options.purpose === 'compaction' ? options.purpose : 'chat';
    const profiles = new Map(snapshot.profiles);
    profiles.set(options.provider, { ...profile, headers: { ...profile.headers, 'x-qcp-purpose': purpose } });
    return super.streamWithSnapshot(options, { ...snapshot, profiles });
  }
}

export function apply(ctx) {
  let modelInfo = FALLBACK_MODELS;
  let models = modelInfo.map(toPiModel);
  let signature = JSON.stringify(modelInfo);
  let disposed = false;
  let syncing = false;
  let lastSyncSucceeded;
  const lifecycle = new AbortController();
  const provider = {
    ...createProvider({
      id: PROVIDER_ID,
      name: DISPLAY_NAME,
      auth: {
        apiKey: {
          name: 'Qoder 本地代理',
          async resolve({ credential }) {
            const apiKey = credential?.key;
            if (typeof apiKey !== 'string' || !apiKey.length) return undefined;
            return { auth: { apiKey }, source: 'Qoder' };
          },
        },
      },
      models,
      api: openAICompletionsApi(),
    }),
    getModels: () => models,
  };
  const profile = {
    provider: PROVIDER_ID,
    displayName: DISPLAY_NAME,
    streamIdleTimeoutMs: 300000,
    cacheRetention: 'short',
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-qoder-connect retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  };
  // Keep snapshot identity stable until the catalog actually changes.
  let profiles = new Map([[PROVIDER_ID, profile]]);
  const adapter = new QoderPiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => localToken(),
    resolveAttachments: () => ctx.get?.('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get?.('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
  });

  async function syncFromProxy() {
    if (syncing || disposed) return;
    syncing = true;
    try {
      const response = await fetch(BASE_URL + '/models', {
        headers: { Authorization: 'Bearer ' + localToken() },
        signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(5000)]),
      });
      if (!response.ok) throw new Error('代理模型接口 HTTP ' + response.status);
      const nextInfo = catalogFromResponse(await response.json());
      if (disposed) return;
      const nextSignature = JSON.stringify(nextInfo);
      const changed = nextSignature !== signature;
      if (changed) {
        modelInfo = nextInfo;
        signature = nextSignature;
        models = modelInfo.map(toPiModel);
        profiles = new Map([[PROVIDER_ID, profile]]);
        // The desktop selector caches its catalog until this registration announces a change.
        if (typeof release.replace === 'function') release.replace([PROVIDER_ID]);
        else ctx.emit?.('llm/adapters-updated');
      }
      if (changed || lastSyncSucceeded === false) {
        ctx.logger.info('dsh-qoder-connect: 已同步代理模型能力，模型数 ' + models.length);
      }
      lastSyncSucceeded = true;
    } catch (error) {
      if (!disposed && lastSyncSucceeded !== false) {
        ctx.logger.info('dsh-qoder-connect: 模型同步失败，保留现有列表：' + error.message);
      }
      lastSyncSucceeded = false;
    } finally {
      syncing = false;
    }
  }

  const release = ctx.llm.registerAdapter([PROVIDER_ID], adapter);
  const refresh = setInterval(() => { void syncFromProxy(); }, REFRESH_MS);
  refresh.unref?.();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    lifecycle.abort();
    clearInterval(refresh);
    release();
  };
  try { ctx.effect(() => dispose); }
  catch { dispose(); return; }
  void syncFromProxy();
  ctx.logger.info('dsh-qoder-connect: 已注册 Qoder CN，模型数 ' + models.length + '，代理 ' + BASE_URL);
}
