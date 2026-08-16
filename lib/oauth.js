/**
 * Grok (xAI) subscription OAuth: authorization-code + PKCE browser flow and
 * the RFC 8628 device-code flow against the auth.x.ai OIDC issuer, plus
 * single-flight refresh and durable token storage.
 *
 * Token storage goes through the harness credential seam when mounted
 * (`ctx.credentials`, one JSON bundle under the `GROK_OAUTH_TOKENS`
 * reference), with a `$DSH_HOME/grok-oauth.json` file fallback otherwise.
 * @module dsh-llm-grok-oauth/oauth
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { grokBinaryPresent, postFormJson } from './net.js';

/** Credential reference the token bundle is stored under. */
export const TOKEN_CREDENTIAL_REF = 'GROK_OAUTH_TOKENS';

const CLI_AUTH_PATH = path.join(os.homedir(), '.grok', 'auth.json');
const CLI_SLOT = (issuer, clientId) => `${issuer}::${clientId}`;
const importHoldPath = () => path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'grok-oauth.logged-out');
const NETWORK_AUTH_PREFIX = '无法访问 xAI 认证服务（https://auth.x.ai）。请检查网络，或设置 HTTPS_PROXY 后重试。';

function cliAuthPaths() {
  const paths = [];
  if (typeof process.env.GROK_AUTH_FILE === 'string' && process.env.GROK_AUTH_FILE.length > 0) {
    paths.push(process.env.GROK_AUTH_FILE);
  }
  if (typeof process.env.GROK_HOME === 'string' && process.env.GROK_HOME.length > 0) {
    paths.push(path.join(process.env.GROK_HOME, 'auth.json'));
  }
  paths.push(CLI_AUTH_PATH);
  return [...new Set(paths)];
}

/** Epoch-ms expiry from `expires_at`, numeric seconds, or JWT `exp`. `0` = unknown. */
function expiryMs(access, expiresAt) {
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > 0) {
    return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
  }
  if (typeof expiresAt === 'string' && expiresAt.length > 0) {
    if (/^\d+$/.test(expiresAt)) {
      const n = Number(expiresAt);
      return n < 1e12 ? n * 1000 : n;
    }
    const parsed = Date.parse(expiresAt);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const exp = decodeJwtClaims(access).exp;
  if (Number.isFinite(exp) && exp > 0) return exp * 1000;
  return 0;
}

function isFresh(access, expiresAt, earlyMs = REFRESH_EARLY_MS) {
  if (typeof access !== 'string' || access.length === 0) return false;
  const at = expiryMs(access, expiresAt);
  if (at === 0) return true;
  return Date.now() < at - earlyMs;
}

/** Open the system browser for the device-code confirmation page. */
export function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (error) {
    console.warn(`llm-grok: failed to open browser: ${error?.message ?? error}`);
  }
}

/** Refresh this many milliseconds before the access token expires. */
const REFRESH_EARLY_MS = 120_000;
/** Browser-flow state entries older than this are refused. */
const PENDING_TTL_MS = 10 * 60_000;
/** Hard cap so a huge `expires_in` or stacked `slow_down` cannot hang forever. */
const LOGIN_HARD_TIMEOUT_MS = 11 * 60_000;
const MAX_POLL_INTERVAL_MS = 15_000;
const MAX_SLOW_DOWNS = 12;

const base64url = (buf) => Buffer.from(buf).toString('base64url');

/** Decode one JWT segment without verifying; display metadata only. */
function decodeJwtClaims(token) {
  try {
    const payload = String(token).split('.')[1];
    if (payload === undefined) return {};
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/** Durable token-bundle storage: credential seam first, file fallback. */
export class TokenStore {
  #ctx;
  #ref = credentialRef(TOKEN_CREDENTIAL_REF);

  constructor(ctx) {
    this.#ctx = ctx;
  }

  #filePath() {
    const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
    return path.join(home, 'grok-oauth.json');
  }

  async load() {
    const credentials = this.#ctx.get('credentials');
    let raw;
    if (credentials !== undefined) {
      raw = (await credentials.resolve(this.#ref))?.value;
    } else {
      raw = await fs.readFile(this.#filePath(), 'utf8').catch(() => undefined);
    }
    if (raw === undefined) return undefined;
    try {
      const bundle = JSON.parse(raw);
      return typeof bundle === 'object' && bundle !== null ? bundle : undefined;
    } catch {
      return undefined;
    }
  }

  async save(bundle) {
    const value = JSON.stringify(bundle);
    const credentials = this.#ctx.get('credentials');
    if (credentials !== undefined) {
      await credentials.set(this.#ref, value);
      return;
    }
    const file = this.#filePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value, { mode: 0o600 });
  }

  async clear() {
    const credentials = this.#ctx.get('credentials');
    if (credentials !== undefined) {
      await credentials.unset(this.#ref);
    }
    await fs.rm(this.#filePath(), { force: true });
  }
}

/** Error whose `oauthCode` carries the wire `error` field of a failed grant. */
export class OAuthFlowError extends Error {
  constructor(message, oauthCode, status) {
    super(message);
    this.name = 'OAuthFlowError';
    this.oauthCode = oauthCode;
    this.status = status;
  }
}

export class GrokOAuth {
  /** @param options thunk returning `{ authBaseURL, clientId, scopes }`. */
  constructor(options, store, logger, publishStatus) {
    this.options = options;
    this.store = store;
    this.logger = logger;
    this.publishStatus = publishStatus ?? (async () => {});
    /** state -> { verifier, nonce, redirectUri, createdAt } */
    this.pendingBrowser = new Map();
    /** handle -> { deviceCode, intervalMs, expiresAt } */
    this.pendingDevice = new Map();
    this.refreshing = undefined;
    this.loginTask = undefined;
    this.skipCliImport = false;
    this.loginEpoch = 0;
    this.ignoreLoginUntil = 0;
  }

  #slotTokens(slot) {
    if (slot === null || typeof slot !== 'object') return undefined;
    const access = [slot.key, slot.access_token, slot.accessToken]
      .find((value) => typeof value === 'string' && value.length > 0);
    const refresh = [slot.refresh_token, slot.refreshToken]
      .find((value) => typeof value === 'string' && value.length > 0);
    if (access === undefined && refresh === undefined) return undefined;
    return {
      slot,
      access_token: access,
      refresh_token: refresh,
      expires_at: typeof slot.expires_at === 'string' || typeof slot.expires_at === 'number'
        ? slot.expires_at
        : undefined,
      email: typeof slot.email === 'string' ? slot.email : undefined,
      name: typeof slot.name === 'string' ? slot.name : undefined,
    };
  }

  #pickCliSlot(entries, requireFresh) {
    let best;
    for (const entry of entries) {
      if (entry === undefined || entry.access_token === undefined) continue;
      const exp = expiryMs(entry.access_token, entry.expires_at);
      const fresh = exp === 0 || exp > Date.now();
      if (requireFresh && !fresh) continue;
      if (best === undefined || (fresh && !best.fresh) || (fresh === best.fresh && exp > best.exp)) {
        best = { entry, exp, fresh };
      }
    }
    return best?.entry;
  }

  async #importHoldActive() {
    try {
      await fs.access(importHoldPath());
      return true;
    } catch {
      return false;
    }
  }

  async #setImportHold(active) {
    const file = importHoldPath();
    if (active) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `${new Date().toISOString()}\n`, { mode: 0o600 });
      this.skipCliImport = true;
      return;
    }
    await fs.rm(file, { force: true });
    this.skipCliImport = false;
  }

  async #readCliSession() {
    if (this.skipCliImport || await this.#importHoldActive()) return undefined;
    let doc;
    let usedPath;
    for (const file of cliAuthPaths()) {
      try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
        if (parsed !== null && typeof parsed === 'object') {
          doc = parsed;
          usedPath = file;
          break;
        }
      } catch {
        // try the next documented location
      }
    }
    if (doc === undefined) return undefined;
    this.cliAuthPath = usedPath;

    const { authBaseURL, clientId } = this.options();
    const preferredKeys = [
      CLI_SLOT(authBaseURL, clientId),
      `https://auth.x.ai::${clientId}`,
      'https://auth.x.ai',
      'https://accounts.x.ai/sign-in',
      'https://auth.x.ai/sign-in',
    ];
    const groups = [
      preferredKeys.map((key) => this.#slotTokens(doc[key])),
      Object.entries(doc)
        .filter(([key]) => typeof key === 'string' && (key === 'https://auth.x.ai' || key.startsWith('https://auth.x.ai::')))
        .map(([, value]) => this.#slotTokens(value)),
      Object.entries(doc)
        .filter(([key]) => typeof key === 'string' && key.includes('::'))
        .map(([, value]) => this.#slotTokens(value)),
      Object.values(doc).map((value) => this.#slotTokens(value)),
      [this.#slotTokens(doc)],
    ];
    for (const requireFresh of [true, false]) {
      for (const group of groups) {
        const found = this.#pickCliSlot(group, requireFresh);
        if (found !== undefined) return { doc, path: usedPath, ...found };
      }
    }
    return undefined;
  }

  async #writeCliSession(bundle) {
    const file = this.cliAuthPath ?? CLI_AUTH_PATH;
    let doc = {};
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      if (raw !== null && typeof raw === 'object') doc = raw;
    } catch {
      // first write
    }
    const { authBaseURL, clientId } = this.options();
    const key = CLI_SLOT(authBaseURL, clientId);
    const prev = doc[key] !== null && typeof doc[key] === 'object' ? doc[key] : {};
    doc[key] = {
      ...prev,
      key: bundle.access_token,
      auth_mode: prev.auth_mode || 'oidc',
      refresh_token: bundle.refresh_token,
      expires_at: bundle.expires_at,
      oidc_issuer: authBaseURL,
      oidc_client_id: clientId,
      ...(bundle.email !== undefined ? { email: bundle.email } : {}),
    };
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  async importCliSession() {
    const session = await this.#readCliSession();
    if (session?.access_token === undefined) return undefined;
    const at = expiryMs(session.access_token, session.expires_at);
    const tokens = {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    };
    if (at > Date.now()) {
      tokens.expires_in = Math.max(60, Math.round((at - Date.now()) / 1000));
    } else if (at > 0) {
      tokens.expires_in = 60;
    }
    return this.#adopt(tokens, {
      email: session.email,
      name: session.name,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
    }, { syncCli: false });
  }

  async #networkMessage(code) {
    const prefix = code === 'timeout'
      ? '连接 xAI 认证服务超时。请检查网络，或设置 HTTPS_PROXY 后重试。'
      : NETWORK_AUTH_PREFIX;
    if (await grokBinaryPresent()) {
      return `${prefix} 若已安装官方 Grok CLI，可先执行 grok login，再点击登录。`;
    }
    return prefix;
  }

  async #postForm(pathname, form) {
    const { authBaseURL } = this.options();
    let result;
    try {
      result = await postFormJson(`${authBaseURL}${pathname}`, form, 30_000);
    } catch (error) {
      const code = error?.code === 'timeout' ? 'timeout' : 'network';
      throw new OAuthFlowError(await this.#networkMessage(code), code);
    }
    const body = result.body ?? {};
    if (!result.ok) {
      const code = typeof body.error === 'string' ? body.error : `http_${result.status}`;
      const detail = typeof body.error_description === 'string' ? body.error_description : '';
      throw new OAuthFlowError(
        `Grok OAuth ${pathname} failed (HTTP ${result.status}${code ? `, ${code}` : ''})${detail ? `: ${detail}` : ''}`,
        code,
        result.status,
      );
    }
    return body;
  }

  /** Persist one successful token-endpoint response as the stored bundle. */
  async #adopt(tokens, previous, { syncCli = true } = {}) {
    if (this.skipCliImport || await this.#importHoldActive()) {
      throw new OAuthFlowError('已退出登录', 'signed_out');
    }
    const claims = decodeJwtClaims(tokens.access_token);
    const idClaims = tokens.id_token !== undefined ? decodeJwtClaims(tokens.id_token) : {};
    const expiresIn = Number.isFinite(tokens.expires_in) ? Number(tokens.expires_in) : undefined;
    const bundle = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? previous?.refresh_token,
      expires_at: expiresIn !== undefined
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : previous?.expires_at,
      obtained_at: new Date().toISOString(),
      scope: tokens.scope ?? claims.scope ?? previous?.scope,
      email: idClaims.email ?? previous?.email,
      name: idClaims.name ?? idClaims.given_name ?? previous?.name,
      tier: claims.tier ?? previous?.tier,
      issuer: this.options().authBaseURL,
      client_id: this.options().clientId,
    };
    await this.store.save(bundle);
    if (syncCli) {
      try {
        await this.#writeCliSession(bundle);
      } catch (error) {
        this.logger?.warn(`grok-oauth: could not update ~/.grok/auth.json: ${error?.message ?? error}`);
      }
    }
    return bundle;
  }

  /** Begin the browser flow; returns the authorize URL to redirect to. */
  beginBrowserLogin(redirectUri) {
    const { authBaseURL, clientId, scopes } = this.options();
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(24));
    const nonce = base64url(randomBytes(24));
    for (const [key, pending] of this.pendingBrowser) {
      if (Date.now() - pending.createdAt > PENDING_TTL_MS) this.pendingBrowser.delete(key);
    }
    this.pendingBrowser.set(state, { verifier, nonce, redirectUri, createdAt: Date.now() });
    const url = new URL(`${authBaseURL}/oauth2/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    }).toString();
    return url.toString();
  }

  /** Exchange the browser-flow callback code; state must match a pending login. */
  async completeBrowserLogin(code, state) {
    const pending = state !== undefined ? this.pendingBrowser.get(state) : undefined;
    if (pending === undefined) {
      throw new OAuthFlowError('登录会话不存在或已过期，请重新发起登录', 'state_mismatch');
    }
    this.pendingBrowser.delete(state);
    if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
      throw new OAuthFlowError('登录会话已过期，请重新发起登录', 'state_expired');
    }
    const { clientId } = this.options();
    const tokens = await this.#postForm('/oauth2/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      client_id: clientId,
      code_verifier: pending.verifier,
    });
    const bundle = await this.#adopt(tokens);
    this.notifyCatalogChanged?.();
    return bundle;
  }

  /** Request a device code; returns display facts plus a poll handle. */
  async beginDeviceLogin() {
    const { clientId, scopes } = this.options();
    const body = await this.#postForm('/oauth2/device/code', {
      client_id: clientId,
      scope: scopes,
    });
    const handle = randomUUID();
    const intervalMs = (Number.isFinite(body.interval) ? Number(body.interval) : 5) * 1000;
    const expiresAt = Date.now() + (Number.isFinite(body.expires_in) ? Number(body.expires_in) : 600) * 1000;
    this.pendingDevice.set(handle, { deviceCode: body.device_code, intervalMs, expiresAt });
    return {
      handle,
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      verificationUriComplete: body.verification_uri_complete,
      intervalMs,
      expiresAt,
    };
  }

  /**
   * One device-flow poll.
   * @returns `{ status: 'ok' | 'pending', bundle?, intervalMs? }`; terminal
   * failures throw {@link OAuthFlowError}.
   */
  async pollDeviceLogin(handle) {
    const pending = this.pendingDevice.get(handle);
    if (pending === undefined) throw new OAuthFlowError('设备码会话不存在，请重新发起', 'unknown_handle');
    if (Date.now() > pending.expiresAt) {
      this.pendingDevice.delete(handle);
      throw new OAuthFlowError('设备码已过期，请重新发起登录', 'expired_token');
    }
    const { clientId } = this.options();
    try {
      const tokens = await this.#postForm('/oauth2/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: pending.deviceCode,
        client_id: clientId,
      });
      this.pendingDevice.delete(handle);
      const bundle = await this.#adopt(tokens);
      this.notifyCatalogChanged?.();
      return { status: 'ok', bundle };
    } catch (error) {
      if (error instanceof OAuthFlowError && error.oauthCode === 'authorization_pending') {
        return { status: 'pending', intervalMs: pending.intervalMs };
      }
      if (error instanceof OAuthFlowError && error.oauthCode === 'slow_down') {
        pending.intervalMs = Math.min(pending.intervalMs + 5000, MAX_POLL_INTERVAL_MS);
        return { status: 'pending', intervalMs: pending.intervalMs, slowDown: true };
      }
      if (error instanceof OAuthFlowError && (error.oauthCode === 'expired_token' || error.oauthCode === 'access_denied')) {
        this.pendingDevice.delete(handle);
      }
      throw error;
    }
  }

  /**
   * Resolve a currently-valid access token, refreshing single-flight when the
   * stored one is missing, expiring within {@link REFRESH_EARLY_MS}, or
   * `force` is set (after a provider 401).
   * @returns the access token, or `undefined` when no login is stored.
   */
  async getAccessToken(force = false) {
    if (this.skipCliImport || await this.#importHoldActive()) return undefined;
    const bundle = await this.store.load();
    if (!force && bundle?.access_token !== undefined && isFresh(bundle.access_token, bundle.expires_at)) {
      return bundle.access_token;
    }

    try {
      const session = await this.#readCliSession();
      if (
        session?.access_token !== undefined
        && (isFresh(session.access_token, session.expires_at) || session.access_token !== bundle?.access_token)
      ) {
        const imported = await this.importCliSession();
        if (imported?.access_token !== undefined) return imported.access_token;
      }
    } catch (error) {
      this.logger?.warn(`grok-oauth: Grok CLI session import failed: ${error?.message ?? error}`);
    }

    if (bundle?.refresh_token !== undefined) {
      this.refreshing ??= this.#refresh(bundle)
        .catch((error) => {
          this.logger?.warn(`grok-oauth: refresh failed: ${error?.message ?? error}`);
          if (bundle.access_token !== undefined) return bundle.access_token;
          throw error;
        })
        .finally(() => {
          this.refreshing = undefined;
        });
      return this.refreshing;
    }

    return bundle?.access_token;
  }

  async #refresh(bundle) {
    const { clientId } = this.options();
    const tokens = await this.#postForm('/oauth2/token', {
      grant_type: 'refresh_token',
      refresh_token: bundle.refresh_token,
      client_id: clientId,
    });
    const next = await this.#adopt(tokens, bundle);
    this.logger?.info('grok-oauth: access token refreshed');
    return next.access_token;
  }

  /** True when a leftover settings `oauthAction=login` must not run after sign-out. */
  shouldIgnoreStaleLogin() {
    return Date.now() < this.ignoreLoginUntil;
  }

  /** Clear local login immediately. Remote revoke is best-effort and must not block. */
  async logout() {
    this.loginEpoch += 1;
    this.ignoreLoginUntil = Date.now() + 5000;
    this.skipCliImport = true;
    const bundle = await this.store.load();
    await this.#setImportHold(true);
    this.pendingDevice.clear();
    this.pendingBrowser.clear();
    await this.store.clear();
    await this.publishStatus({
      oauthStatus: 'signed-out',
      oauthMessage: '已退出登录',
      oauthAction: 'idle',
      verificationUrl: '',
      userCode: '',
    });
    this.notifyCatalogChanged?.();
    if (bundle?.refresh_token !== undefined) {
      const { clientId } = this.options();
      void this.#postForm('/oauth2/revoke', {
        token: bundle.refresh_token,
        token_type_hint: 'refresh_token',
        client_id: clientId,
      }).catch(() => undefined);
    }
  }

  /** UI snapshot from the real store and logout hold, not a stale cache. */
  async uiStatus() {
    if (this.loginTask !== undefined) return undefined;
    if (this.skipCliImport || await this.#importHoldActive()) {
      return {
        oauthStatus: 'signed-out',
        oauthMessage: '已退出登录',
        verificationUrl: '',
        userCode: '',
      };
    }
    const status = await this.status();
    if (status.loggedIn) {
      return {
        oauthStatus: 'signed-in',
        oauthMessage: status.email ? `已登录 ${status.email}` : 'Grok 账号已登录',
        verificationUrl: '',
        userCode: '',
      };
    }
    return {
      oauthStatus: 'signed-out',
      oauthMessage: '',
      verificationUrl: '',
      userCode: '',
    };
  }

  async hydrate() {
    if (await this.#importHoldActive()) {
      this.skipCliImport = true;
      await this.store.clear();
      await this.publishStatus({
        oauthStatus: 'signed-out',
        oauthMessage: '已退出登录',
        oauthAction: 'idle',
        verificationUrl: '',
        userCode: '',
      });
      return;
    }
    const status = await this.status();
    if (status.loggedIn) {
      await this.publishStatus({
        oauthStatus: 'signed-in',
        oauthMessage: status.email ? `已登录 ${status.email}` : 'Grok 账号已登录',
        verificationUrl: '',
        userCode: '',
      });
      return;
    }
    try {
      const imported = await this.importCliSession();
      if (imported !== undefined) {
        await this.publishStatus({
          oauthStatus: 'signed-in',
          oauthMessage: imported.email ? `已复用 Grok CLI（${imported.email}）` : '已复用本机 Grok CLI 登录',
          verificationUrl: '',
          userCode: '',
        });
        this.notifyCatalogChanged?.();
        return;
      }
    } catch (error) {
      this.logger?.warn(`grok-oauth: hydrate CLI import failed: ${error?.message ?? error}`);
    }
    await this.publishStatus({
      oauthStatus: 'signed-out',
      oauthMessage: '',
      verificationUrl: '',
      userCode: '',
    });
  }

  async startLogin() {
    this.ignoreLoginUntil = 0;
    if (this.loginTask !== undefined) return this.loginTask;
    this.loginEpoch += 1;
    const epoch = this.loginEpoch;
    this.loginTask = this.#runLogin(epoch).finally(() => {
      this.loginTask = undefined;
    });
    return this.loginTask;
  }

  /** Stop an in-flight device-code poll without revoking an existing session. */
  async cancelLogin() {
    this.loginEpoch += 1;
    this.pendingDevice.clear();
    this.pendingBrowser.clear();
    await this.publishStatus({
      oauthStatus: 'error',
      oauthMessage: '已取消登录',
      oauthAction: 'idle',
      verificationUrl: '',
      userCode: '',
    });
  }

  async #abandonLogin() {
    await this.store.clear();
    await this.#setImportHold(true);
  }

  async #runLogin(epoch) {
    await this.#setImportHold(false);
    if (epoch !== this.loginEpoch) {
      await this.#setImportHold(true);
      return;
    }
    try {
      await this.publishStatus({
        oauthStatus: 'pending',
        oauthMessage: '正在发起网页登录…',
        verificationUrl: '',
        userCode: '',
      });
      try {
        const imported = await this.importCliSession();
        if (epoch !== this.loginEpoch) {
          if (this.skipCliImport || await this.#importHoldActive()) await this.#abandonLogin();
          return;
        }
        if (imported !== undefined) {
          await this.publishStatus({
            oauthStatus: 'signed-in',
            oauthMessage: imported.email ? `已复用 Grok CLI（${imported.email}）` : '已复用本机 Grok CLI 登录',
            verificationUrl: '',
            userCode: '',
          });
          this.notifyCatalogChanged?.();
          return;
        }
      } catch (error) {
        if (error instanceof OAuthFlowError && error.oauthCode === 'signed_out') return;
        this.logger?.warn(`grok-oauth: could not reuse Grok CLI session: ${error?.message ?? error}`);
      }

      const device = await this.beginDeviceLogin();
      if (epoch !== this.loginEpoch) {
        await this.#setImportHold(true);
        return;
      }
      const url = device.verificationUriComplete || device.verificationUri || '';
      await this.publishStatus({
        oauthStatus: 'pending',
        oauthMessage: device.userCode ? `在浏览器中确认代码 ${device.userCode}` : '请在打开的浏览器中完成登录',
        verificationUrl: url,
        userCode: device.userCode ?? '',
      });
      if (url.length > 0) openBrowser(url);

      const hardDeadline = Math.min(device.expiresAt, Date.now() + LOGIN_HARD_TIMEOUT_MS);
      let intervalMs = Math.min(device.intervalMs, MAX_POLL_INTERVAL_MS);
      let slowDowns = 0;
      while (true) {
        const remaining = hardDeadline - Date.now();
        if (remaining <= 0) {
          this.pendingDevice.delete(device.handle);
          throw new OAuthFlowError('设备码已过期，请重新发起登录', 'expired_token');
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
        if (epoch !== this.loginEpoch) {
          if (this.skipCliImport || await this.#importHoldActive()) await this.#abandonLogin();
          return;
        }
        if (Date.now() >= hardDeadline) {
          this.pendingDevice.delete(device.handle);
          throw new OAuthFlowError('设备码已过期，请重新发起登录', 'expired_token');
        }
        const result = await this.pollDeviceLogin(device.handle);
        if (epoch !== this.loginEpoch) {
          if (this.skipCliImport || await this.#importHoldActive()) await this.#abandonLogin();
          return;
        }
        if (result.status === 'ok') {
          await this.publishStatus({
            oauthStatus: 'signed-in',
            oauthMessage: 'Grok 账号已登录',
            verificationUrl: '',
            userCode: '',
          });
          return;
        }
        if (result.slowDown === true) {
          slowDowns += 1;
          if (slowDowns >= MAX_SLOW_DOWNS) {
            this.pendingDevice.delete(device.handle);
            throw new OAuthFlowError('登录轮询被限速过久，请重新发起', 'slow_down');
          }
        }
        if (typeof result.intervalMs === 'number' && result.intervalMs > 0) {
          intervalMs = Math.min(result.intervalMs, MAX_POLL_INTERVAL_MS);
        }
      }
    } catch (error) {
      if (epoch !== this.loginEpoch) return;
      if (error instanceof OAuthFlowError && error.oauthCode === 'signed_out') return;
      this.logger?.warn(`grok-oauth: login failed: ${error?.message ?? error}`);
      const oauthMessage = error instanceof OAuthFlowError && (error.oauthCode === 'network' || error.oauthCode === 'timeout')
        ? await this.#networkMessage(error.oauthCode)
        : error instanceof Error ? error.message : '登录失败';
      await this.publishStatus({
        oauthStatus: 'error',
        oauthMessage,
        verificationUrl: '',
        userCode: '',
      });
    }
  }

  /** Display-safe login status; never includes token material. */
  async status() {
    if (this.skipCliImport || await this.#importHoldActive()) return { loggedIn: false };
    const bundle = await this.store.load();
    if (bundle === undefined) return { loggedIn: false };
    return {
      loggedIn: bundle.refresh_token !== undefined || bundle.access_token !== undefined,
      email: bundle.email,
      name: bundle.name,
      tier: bundle.tier,
      scope: bundle.scope,
      expiresAt: bundle.expires_at,
      obtainedAt: bundle.obtained_at,
    };
  }
}
