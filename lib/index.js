/**
 * Grok (xAI) subscription OAuth provider plugin for DeepSeek Harness.
 *
 * Registers the `grok` provider route on `ctx.llm`, backed by the Grok CLI
 * chat proxy with tokens from a browser (PKCE) or device-code OAuth login
 * against `auth.x.ai` — the same first-party client the official Grok CLI
 * uses, so an active SuperGrok / X Premium subscription drives the harness
 * without an API key. Login is a one-click device-code flow from
 * Settings → Plugins → GROK OAUTH (no separate page). The live account
 * model catalog feeds the harness model selector.
 * @module dsh-llm-grok-oauth
 */
import z from '@deepseek-ai/schemastery';
import { RetryPolicySchema, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { GrokOAuth, TokenStore } from './oauth.js';
import { GrokAdapter } from './adapter.js';

export const name = 'llm-grok';
export const inject = ['llm'];

const NS = settingsNamespace('llm-grok');

/** The single provider route this plugin owns. */
export const PROVIDER = 'grok';

/** The Grok CLI chat proxy (subscription/session-token surface, not api.x.ai). */
export const DEFAULT_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
/** The xAI OIDC issuer. */
export const DEFAULT_AUTH_BASE_URL = 'https://auth.x.ai';
/** Public client id of the first-party Grok CLI (`grok login`). */
export const DEFAULT_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
/** Scope set the first-party CLI requests. */
export const DEFAULT_SCOPES = 'openid profile email offline_access grok-cli:access api:access';

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  apiBackend: z.union(['responses', 'chat']),
  efforts: z.array(z.union(['low', 'medium', 'high', 'xhigh'])),
  defaultEffort: z.union(['low', 'medium', 'high', 'xhigh']),
});

export const Config = z.object({
  baseURL: z.string().description('Grok CLI 聊天代理地址').default(DEFAULT_BASE_URL),
  authBaseURL: z.string().description('xAI OIDC 认证服务地址').default(DEFAULT_AUTH_BASE_URL),
  clientId: z.string().description('OAuth 公共客户端 ID（默认为官方 Grok CLI 客户端）').default(DEFAULT_CLIENT_ID),
  scopes: z.string().description('OAuth 授权范围').default(DEFAULT_SCOPES),
  reasoningEffort: z.union(['low', 'medium', 'high', 'xhigh']).description('默认推理档位（留空使用模型自身默认）'),
  maxTokens: z.number().step(1).min(1).description('默认单次输出上限（留空则不发送，交给服务端默认）'),
  defaultContextWindow: z.number().step(1).min(1).description('目录未标注上下文时的兜底值').default(131072),
  models: z.array(catalogModel).description('离线兜底模型目录（登录后以账号实时目录为准）'),
  modelsRefreshSeconds: z.number().step(1).min(10).description('实时模型目录缓存秒数').default(300),
  includeHiddenModels: z.boolean().description('是否展示目录中标记为隐藏的模型').default(false),
  streamIdleTimeoutMs: z.number().min(1000).description('流式响应空闲超时（毫秒）').default(300000),
  oauthAction: z.string().description('设置页登录动作（由插件卡片写入）').default('idle'),
  oauthStatus: z.string().description('登录状态（由插件回写，勿手改）').default('signed-out'),
  verificationUrl: z.string().description('设备码确认页').default(''),
  userCode: z.string().description('设备码').default(''),
  oauthMessage: z.string().description('登录提示').default(''),
  retryPolicy: RetryPolicySchema,
});

/** Re-judge raw config (settings snapshots may bypass schema normalization). */
function resolveOptions(config) {
  const asString = (value, fallback) =>
    typeof value === 'string' && value.length > 0 ? value : fallback;
  const asPositiveInt = (value, fallback, label) => {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value <= 0) throw new Error(`llm-grok: ${label} 必须是正整数`);
    return value;
  };
  const baseURL = asString(config.baseURL, DEFAULT_BASE_URL).replace(/\/+$/, '');
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 300000;
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs < 1000) {
    throw new Error('llm-grok: streamIdleTimeoutMs 必须不小于 1000');
  }
  return {
    baseURL,
    authBaseURL: asString(config.authBaseURL, DEFAULT_AUTH_BASE_URL).replace(/\/+$/, ''),
    clientId: asString(config.clientId, DEFAULT_CLIENT_ID),
    scopes: asString(config.scopes, DEFAULT_SCOPES),
    reasoningEffort: config.reasoningEffort,
    maxTokens: asPositiveInt(config.maxTokens, undefined, 'maxTokens'),
    defaultContextWindow: asPositiveInt(config.defaultContextWindow, 131072, 'defaultContextWindow'),
    models: config.models,
    modelsRefreshSeconds: asPositiveInt(config.modelsRefreshSeconds, 300, 'modelsRefreshSeconds'),
    includeHiddenModels: config.includeHiddenModels === true,
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-grok: retryPolicy'),
  };
}

export function apply(ctx, config) {
  let current = () => config;
  let lastRaw;
  let lastGood;
  const options = () => {
    const raw = current();
    if (raw === lastRaw && lastGood !== undefined) return lastGood;
    try {
      const next = resolveOptions(raw);
      lastRaw = raw;
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === undefined) throw error;
      lastRaw = raw;
      ctx.logger.error('llm-grok: 设置内容无效，继续沿用上一份有效配置');
      ctx.logger.error(error);
      return lastGood;
    }
  };
  options();

  const store = new TokenStore(ctx);
  let lastStatus = {
    oauthStatus: 'signed-out',
    oauthMessage: '',
    verificationUrl: '',
    userCode: '',
  };
  const publishStatus = async (patch) => {
    lastStatus = { ...lastStatus, ...patch };
    const settings = ctx.get('settings');
    if (settings === undefined) return;
    try {
      await settings.update(NS, patch);
    } catch (error) {
      ctx.logger.warn(`llm-grok: failed to publish status: ${error?.message ?? error}`);
    }
  };
  const oauth = new GrokOAuth(
    () => {
      const { authBaseURL, clientId, scopes } = options();
      return { authBaseURL, clientId, scopes };
    },
    store,
    ctx.logger,
    publishStatus,
  );
  const adapter = new GrokAdapter(options, oauth, ctx.logger);

  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: 'Grok (xAI 订阅)',
      settingsNs: NS,
      settingsPath: [],
    },
  ]);
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);

  // Login-state flips change the advertised catalog; republishing the same
  // route fires `llm/adapters-updated` so selectors re-read the model list.
  oauth.notifyCatalogChanged = () => {
    adapter.catalogCache = undefined;
    try {
      registration.replace([PROVIDER]);
    } catch {
      // disposed during teardown; nothing to announce
    }
  };

  let registeredPolicy = options().retryPolicy;
  const ensureRegistrationFacts = () => {
    const policy = options().retryPolicy;
    if (deepEqualJson(policy, registeredPolicy)) return;
    registration.replace([PROVIDER]);
    registeredPolicy = policy;
  };

  let actionInFlight = false;
  const consumeAction = async () => {
    if (actionInFlight) return;
    const value = current() || {};
    const action = value.oauthAction;
    if (action !== 'login' && action !== 'logout') return;
    actionInFlight = true;
    try {
      await publishStatus({ oauthAction: 'idle' });
      if (action === 'login') await oauth.startLogin();
      else await oauth.logout();
    } catch (error) {
      ctx.logger.warn(`llm-grok: ${action} failed: ${error?.message ?? error}`);
    } finally {
      actionInFlight = false;
    }
  };

  const writeJson = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const isLoopback = (req) => {
    const addr = req.socket?.remoteAddress;
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  };
  ctx.inject(['webServer'], (webCtx) => {
    const handle = (method, run) => async (req, res) => {
      if (!isLoopback(req)) {
        writeJson(res, 403, { ok: false, error: 'loopback only' });
        return;
      }
      if (req.method !== method) {
        writeJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      try {
        await run();
        writeJson(res, 200, { ok: true, ...lastStatus });
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error), ...lastStatus });
      }
    };
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/api/llm-grok/status',
      handler: handle('GET', async () => undefined),
    }), 'llm-grok: status route');
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/api/llm-grok/login',
      handler: handle('POST', async () => {
        await publishStatus({
          oauthStatus: 'pending',
          oauthMessage: '正在发起网页登录…',
          verificationUrl: '',
          userCode: '',
        });
        void oauth.startLogin().catch((error) => {
          ctx.logger.warn(`llm-grok: login failed: ${error?.message ?? error}`);
        });
      }),
    }), 'llm-grok: login route');
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/api/llm-grok/logout',
      handler: handle('POST', async () => {
        await oauth.logout();
      }),
    }), 'llm-grok: logout route');
  });

  let hydrated = false;
  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: () => {
      ensureRegistrationFacts();
      if (!hydrated) {
        hydrated = true;
        oauth.hydrate()
          .catch((error) => ctx.logger.warn(`llm-grok: hydrate failed: ${error?.message ?? error}`))
          .then(() => publishStatus({ oauthAction: 'idle' }))
          .catch((error) => ctx.logger.warn(`llm-grok: ${error?.message ?? error}`));
        return;
      }
      void consumeAction();
    },
  });
}
