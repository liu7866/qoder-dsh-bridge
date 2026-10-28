import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { catalogFromResponse, parseVisibility, visibleModels } from './catalog.js';

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
const VISIBILITY_FILE = path.join(path.dirname(TOKEN_FILE), 'model-visibility.json');

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
  let lastCatalog, hidden = new Set();
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
      const payload = await response.json();
      catalogFromResponse(payload, FALLBACK_MODELS, FALLBACK_CONTEXT);
      lastCatalog = payload;
      if (lastSyncSucceeded === false) ctx.logger.info('dsh-qoder-connect: 已重新连接代理');
      lastSyncSucceeded = true;
    } catch (error) {
      if (!disposed && lastSyncSucceeded !== false) ctx.logger.info('dsh-qoder-connect: 模型同步失败，保留现有列表：' + error.message);
      lastSyncSucceeded = false;
    } finally {
      if (!disposed) {
        try { hidden = parseVisibility(fs.readFileSync(VISIBILITY_FILE, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') hidden = new Set(); }
        const catalog = lastCatalog ? catalogFromResponse(lastCatalog, FALLBACK_MODELS, FALLBACK_CONTEXT) : FALLBACK_MODELS;
        const nextInfo = visibleModels(catalog, hidden);
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
          ctx.logger.info('dsh-qoder-connect: 已同步代理模型能力，模型数 ' + models.length);
        }
      }
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
