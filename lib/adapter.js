/**
 * Grok chat-proxy adapter for the harness LLM seam: OAuth-bearer requests to
 * `cli-chat-proxy.grok.com`, a live account-entitled model catalog with a
 * static fallback, and per-model routing between the Responses API and
 * chat-completions dialects.
 * @module dsh-llm-grok-oauth/adapter
 */
import { LlmAdapter, LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm';
import { randomUUID } from 'node:crypto';
import { fetchWithProxy } from './net.js';
import {
  parseSse,
  serializeChatRequest,
  serializeResponsesRequest,
  translateChat,
  translateResponses,
} from './wire.js';

/** Advisory catalog served while the live listing is unavailable (not logged in yet, offline). */
export const FALLBACK_MODELS = [
  {
    id: 'grok-4.6',
    name: 'Grok 4.6',
    description: 'xAI frontier model (subscription via Grok OAuth)',
    contextWindow: 500_000,
    apiBackend: 'responses',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
  },
  {
    id: 'grok-4.5',
    name: 'Grok 4.5',
    contextWindow: 500_000,
    apiBackend: 'responses',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
  },
];

const EFFORT_LABELS = {
  low: 'Low Effort',
  medium: 'Medium Effort',
  high: 'High Effort',
  xhigh: 'Extra High Effort',
};

/**
 * Version reported to the chat proxy. The proxy rejects requests without an
 * `x-grok-client-version` at or above its minimum (HTTP 426), so this tracks
 * the official Grok CLI release the wire format was validated against.
 */
const GROK_CLIENT_VERSION = '1.0.3';

/** Map one wire catalog entry (models / models-v2 shapes) to the internal shape. */
function normalizeWireModel(id, info) {
  const efforts = [];
  if (Array.isArray(info.reasoning_efforts)) {
    for (const effort of info.reasoning_efforts) {
      const value = typeof effort === 'string' ? effort : effort?.value ?? effort?.id;
      if (typeof value === 'string' && value.length > 0 && !efforts.includes(value)) efforts.push(value);
    }
  }
  let defaultEffort = typeof info.reasoning_effort === 'string' ? info.reasoning_effort : undefined;
  if (defaultEffort === undefined && Array.isArray(info.reasoning_efforts)) {
    const flagged = info.reasoning_efforts.find((effort) => effort?.default === true);
    const value = flagged?.value ?? flagged?.id;
    if (typeof value === 'string') defaultEffort = value;
  }
  return {
    id,
    name: typeof info.name === 'string' && info.name.length > 0 ? info.name : id,
    ...(typeof info.description === 'string' && info.description.length > 0 ? { description: info.description } : {}),
    ...(Number.isInteger(info.context_window) && info.context_window > 0 ? { contextWindow: info.context_window } : {}),
    ...(Number.isInteger(info.max_completion_tokens) && info.max_completion_tokens > 0
      ? { maxTokens: info.max_completion_tokens }
      : {}),
    apiBackend: info.api_backend === 'chat_completions' || info.api_backend === 'chat' ? 'chat' : 'responses',
    efforts: info.supports_reasoning_effort === false ? [] : efforts,
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
    hidden: info.hidden === true || info.supported_in_api === false,
  };
}

/** Parse the several catalog response shapes the proxy has been seen to use. */
function parseCatalog(json) {
  const out = [];
  const push = (id, info) => {
    if (typeof id === 'string' && id.length > 0) out.push(normalizeWireModel(id, info ?? {}));
  };
  if (Array.isArray(json?.data)) {
    for (const entry of json.data) push(entry?.id, entry?.info ?? entry);
  } else if (Array.isArray(json?.models)) {
    for (const entry of json.models) push(entry?.id, entry?.info ?? entry);
  } else if (json?.models !== undefined && typeof json.models === 'object') {
    for (const [id, entry] of Object.entries(json.models)) push(id, entry?.info ?? entry);
  }
  return out;
}

function httpErrorCode(status, providerError) {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 402) return 'QUOTA';
  if (status === 429) {
    const text = `${providerError?.code ?? ''} ${providerError?.type ?? ''} ${providerError?.message ?? ''}`.toLowerCase();
    return /quota|credit|balance|billing/.test(text) ? 'QUOTA' : 'RATE_LIMIT';
  }
  if (status === 400) {
    const text = `${providerError?.code ?? ''} ${providerError?.type ?? ''} ${providerError?.message ?? ''}`.toLowerCase();
    return /context|too long|maximum.*tokens|token limit/.test(text) ? 'CONTEXT_WINDOW_EXCEEDED' : 'INVALID_REQUEST';
  }
  if (status >= 500) return 'SERVER';
  return `HTTP_${status}`;
}

function providerRetryAfterMs(headerValue) {
  if (headerValue === null || headerValue === undefined) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  const at = Date.parse(headerValue);
  if (Number.isFinite(at) && at > Date.now()) return at - Date.now();
  return undefined;
}

export class GrokAdapter extends LlmAdapter {
  /**
   * @param settings thunk returning resolved plugin options.
   * @param oauth the {@link GrokOAuth} token source.
   * @param logger plugin logger.
   */
  constructor(settings, oauth, logger) {
    super();
    this.settings = settings;
    this.oauth = oauth;
    this.logger = logger;
    this.catalogCache = undefined;
    this.catalogFetch = undefined;
  }

  providerInfo(provider) {
    return { id: provider, name: 'Grok (xAI 订阅)' };
  }

  providerRetryPolicy(_provider) {
    return this.settings().retryPolicy;
  }

  #headers(accessToken, model, extra = {}) {
    return {
      'authorization': `Bearer ${accessToken}`,
      ...attributionHeaders(),
      'x-xai-token-auth': 'xai-grok-cli',
      ...(model !== undefined ? { 'x-grok-model-override': model } : {}),
      'x-grok-client-identifier': 'dsh-llm-grok-oauth',
      'x-grok-client-version': GROK_CLIENT_VERSION,
      ...extra,
    };
  }

  /** Fetch the account-entitled catalog, `/models-v2` first, `/models` fallback. */
  async #fetchCatalog() {
    const accessToken = await this.oauth.getAccessToken();
    if (accessToken === undefined) return undefined;
    const { baseURL } = this.settings();
    for (const pathname of ['/models-v2', '/models']) {
      let response;
      try {
        response = await fetchWithProxy(`${baseURL}${pathname}`, { headers: this.#headers(accessToken) });
      } catch (error) {
        this.logger?.warn(`grok-oauth: model listing ${pathname} transport failure: ${error?.message ?? error}`);
        return undefined;
      }
      if (!response.ok) {
        if (response.status === 404 || response.status === 405) continue;
        this.logger?.warn(`grok-oauth: model listing ${pathname} failed with HTTP ${response.status}`);
        return undefined;
      }
      try {
        const models = parseCatalog(await response.json());
        if (models.length > 0) return models;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /** The live catalog under a TTL cache, else configured/static fallback. */
  async catalog(forceRefresh = false) {
    const { modelsRefreshSeconds } = this.settings();
    const fresh = this.catalogCache !== undefined
      && Date.now() - this.catalogCache.at < modelsRefreshSeconds * 1000;
    if (!forceRefresh && fresh) return this.catalogCache.models;
    this.catalogFetch ??= this.#fetchCatalog().finally(() => {
      this.catalogFetch = undefined;
    });
    const live = await this.catalogFetch;
    if (live !== undefined) {
      this.catalogCache = { at: Date.now(), models: live, live: true };
      return live;
    }
    if (this.catalogCache !== undefined) return this.catalogCache.models;
    return this.#fallbackModels();
  }

  #fallbackModels() {
    const { models } = this.settings();
    if (models !== undefined && models.length > 0) {
      return models.map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        ...(model.description !== undefined ? { description: model.description } : {}),
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
        apiBackend: model.apiBackend === 'chat' ? 'chat' : 'responses',
        efforts: model.efforts ?? [],
        ...(model.defaultEffort !== undefined ? { defaultEffort: model.defaultEffort } : {}),
      }));
    }
    return FALLBACK_MODELS;
  }

  /** Whether the current catalog came from the live endpoint. */
  catalogIsLive() {
    return this.catalogCache?.live === true;
  }

  async listModels(provider) {
    const { includeHiddenModels } = this.settings();
    const models = await this.catalog();
    return models
      .filter((model) => includeHiddenModels || model.hidden !== true)
      .map((model) => ({
        provider,
        id: model.id,
        name: model.name,
        ...(model.description !== undefined ? { description: model.description } : {}),
        inputModalities: ['text'],
      }));
  }

  async #modelMeta(model) {
    const models = await this.catalog();
    return models.find((entry) => entry.id === model);
  }

  async resolveModel(provider, model, _signal) {
    const { defaultContextWindow, maxTokens, reasoningEffort } = this.settings();
    const meta = await this.#modelMeta(model);
    const efforts = meta?.efforts ?? [];
    const defaultEffort = reasoningEffort !== undefined && efforts.includes(reasoningEffort)
      ? reasoningEffort
      : meta?.defaultEffort !== undefined && efforts.includes(meta.defaultEffort)
        ? meta.defaultEffort
        : undefined;
    const resolvedMaxTokens = meta?.maxTokens ?? maxTokens;
    return {
      provider,
      id: model,
      name: meta?.name ?? model,
      ...(meta?.description !== undefined ? { description: meta.description } : {}),
      inputModalities: ['text'],
      context: { contextWindow: meta?.contextWindow ?? defaultContextWindow },
      ...(resolvedMaxTokens !== undefined ? { defaultMaxTokens: resolvedMaxTokens } : {}),
      ...(efforts.length > 0
        ? {
            reasoning: {
              efforts: efforts.map((effort) => ({ id: effort, name: EFFORT_LABELS[effort] ?? effort })),
              ...(defaultEffort !== undefined ? { defaultEffort } : {}),
            },
          }
        : {}),
    };
  }

  async *stream(options) {
    const config = this.settings();
    let accessToken = await this.oauth.getAccessToken().catch((error) => {
      throw new LlmError(
        `grok-oauth: 刷新访问令牌失败（${error?.message ?? error}）；请在 Grok OAuth 登录页重新登录`,
        'AUTH',
        { cause: error },
      );
    });
    if (accessToken === undefined) {
      throw new LlmError(
        'grok-oauth: 尚未登录 Grok。请到 设置 → 模型 → Grok (xAI 订阅) 点击「使用 Grok 账号登录」',
        'MISSING_CREDENTIAL',
      );
    }
    const meta = await this.#modelMeta(options.model);
    const backend = meta?.apiBackend ?? 'responses';
    const requestOptions = options.purpose === 'session-title' && options.reasoningEffort === undefined
      ? { ...options, reasoningEffort: meta?.efforts?.includes('low') ? 'low' : undefined }
      : options;
    const defaults = { reasoningEffort: undefined };
    const body = backend === 'chat'
      ? serializeChatRequest(requestOptions, defaults)
      : serializeResponsesRequest(requestOptions, defaults);
    const pathname = backend === 'chat' ? '/chat/completions' : '/responses';
    const payload = JSON.stringify(body);

    let response = await this.#request(config, pathname, payload, options, accessToken);
    if (response.status === 401) {
      response.body?.cancel().catch(() => undefined);
      accessToken = await this.oauth.getAccessToken(true).catch(() => undefined);
      if (accessToken === undefined) {
        throw new LlmError(
          'grok-oauth: 访问令牌已失效且刷新失败；请到 设置 → 模型 → Grok (xAI 订阅) 重新登录',
          'AUTH',
          { status: 401 },
        );
      }
      response = await this.#request(config, pathname, payload, options, accessToken);
    }
    if (!response.ok) {
      await this.#throwHttpError(response, config);
    }
    if (response.body === null) throw new LlmError('Grok API returned no response body', 'EMPTY_RESPONSE');

    const watchdog = new AbortController();
    let timer;
    const rearm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => watchdog.abort(new LlmError(`Grok stream idle for ${config.streamIdleTimeoutMs}ms`, 'TIMEOUT')),
        config.streamIdleTimeoutMs,
      );
      timer.unref?.();
    };
    const onAbort = () => watchdog.abort(options.signal.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    rearm();
    try {
      const events = parseSse(response.body, backend === 'chat' ? 'data' : 'json', rearm);
      const chunks = backend === 'chat' ? translateChat(events) : translateResponses(events);
      for await (const chunk of chunks) {
        if (watchdog.signal.aborted) throw watchdog.signal.reason;
        yield chunk;
      }
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('Grok request aborted by caller', 'ABORTED', { cause: error });
      if (watchdog.signal.aborted && watchdog.signal.reason instanceof LlmError) throw watchdog.signal.reason;
      if (error instanceof LlmError) throw error;
      throw new LlmError(`Grok stream from ${config.baseURL} failed`, 'TRANSPORT', { cause: error });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      response.body.cancel().catch(() => undefined);
    }
  }

  async #request(config, pathname, payload, options, accessToken) {
    const headers = this.#headers(accessToken, options.model, {
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      'x-grok-req-id': randomUUID(),
      ...(options.sessionId !== undefined ? { 'x-grok-session-id': String(options.sessionId) } : {}),
    });
    try {
      return await fetchWithProxy(`${config.baseURL}${pathname}`, {
        method: 'POST',
        headers,
        body: payload,
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('Grok request aborted by caller', 'ABORTED', { cause: error });
      throw new LlmError(`Grok API request to ${config.baseURL} failed`, 'TRANSPORT', { cause: error });
    }
  }

  async #throwHttpError(response, config) {
    let message = `Grok API error (HTTP ${response.status})`;
    let providerError;
    try {
      const body = await response.json();
      providerError = body.error ?? body;
      const detail = typeof providerError === 'string' ? providerError : providerError?.message;
      if (typeof detail === 'string' && detail.length > 0) message = detail;
    } catch {
      // keep the status-only message
    }
    const delay = providerRetryAfterMs(response.headers.get('retry-after'));
    const requestId = response.headers.get('x-request-id') ?? response.headers.get('x-grok-req-id') ?? undefined;
    throw new LlmError(message, httpErrorCode(response.status, providerError), {
      status: response.status,
      ...(delay !== undefined ? { providerRetryAfterMs: delay } : {}),
      ...(requestId !== null && requestId !== undefined ? { requestId } : {}),
    });
  }
}
