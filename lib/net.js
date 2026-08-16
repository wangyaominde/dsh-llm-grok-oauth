/**
 * Outbound HTTP for xAI OAuth and the Grok chat proxy. Node's built-in fetch
 * ignores the OS / HTTPS_PROXY; many machines can open those hosts in a
 * browser but not from DSH. Resolve env/system proxy once, then send through
 * undici.ProxyAgent (SSE-safe). OAuth form POST still falls back to curl.
 * @module dsh-llm-grok-oauth/net
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function envProxyUrl() {
  const value = [
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.ALL_PROXY,
    process.env.all_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
  ].find((item) => typeof item === 'string' && item.length > 0);
  return value;
}

function parseScutilProxy(text) {
  const httpsOn = /HTTPSEnable\s*:\s*1/.test(text);
  const httpOn = /HTTPEnable\s*:\s*1/.test(text);
  const socksOn = /SOCKSEnable\s*:\s*1/.test(text);
  const pick = (key) => {
    const match = text.match(new RegExp(`${key}\\s*:\\s*(\\S+)`));
    return match?.[1];
  };
  if (httpsOn || httpOn) {
    const host = (httpsOn ? pick('HTTPSProxy') : undefined) ?? pick('HTTPProxy');
    const port = (httpsOn ? pick('HTTPSPort') : undefined) ?? pick('HTTPPort');
    if (host && port) return `http://${host}:${port}`;
  }
  if (socksOn) {
    const host = pick('SOCKSProxy');
    const port = pick('SOCKSPort');
    if (host && port) return `socks5://${host}:${port}`;
  }
  return undefined;
}

async function darwinProxyUrl() {
  if (process.platform !== 'darwin') return undefined;
  try {
    const { stdout } = await execFileAsync('scutil', ['--proxy'], { timeout: 3000 });
    return parseScutilProxy(String(stdout));
  } catch {
    return undefined;
  }
}

/** Cached proxy URL, or `null` when none. */
let cachedProxy;

export async function resolveProxyUrl() {
  if (cachedProxy !== undefined) return cachedProxy ?? undefined;
  const found = envProxyUrl() ?? await darwinProxyUrl();
  cachedProxy = found ?? null;
  return found;
}

let proxyDispatcher;
let proxyDispatcherUrl;

async function dispatcherFor(proxyUrl) {
  if (proxyDispatcher !== undefined && proxyDispatcherUrl === proxyUrl) return proxyDispatcher;
  const undici = await import('undici');
  proxyDispatcher = new undici.ProxyAgent(proxyUrl);
  proxyDispatcherUrl = proxyUrl;
  return proxyDispatcher;
}

async function fetchViaUndici(url, init, proxyUrl) {
  const undici = await import('undici');
  const dispatcher = await dispatcherFor(proxyUrl);
  return undici.fetch(url, { ...init, dispatcher });
}

/**
 * Same proxy resolution as OAuth, for catalog GET and chat/SSE POST.
 * Uses undici.ProxyAgent when a proxy is configured so the stream body
 * stays a web `ReadableStream`. Direct `fetch` is used only when no proxy.
 */
export async function fetchWithProxy(url, init = {}) {
  const proxyUrl = await resolveProxyUrl();
  if (proxyUrl === undefined) return fetch(url, init);
  return fetchViaUndici(url, init, proxyUrl);
}

async function postFormCurl(url, body, proxyUrl, timeoutMs) {
  const args = [
    '-sS',
    '-X', 'POST',
    '-H', 'content-type: application/x-www-form-urlencoded',
    '-H', 'accept: application/json',
    '--max-time', String(Math.max(5, Math.ceil(timeoutMs / 1000))),
    '--data-binary', body,
    '-w', '\n__HTTP_STATUS__:%{http_code}',
  ];
  if (proxyUrl) args.push('-x', proxyUrl);
  args.push(url);
  const { stdout } = await execFileAsync('curl', args, {
    timeout: timeoutMs + 2000,
    maxBuffer: 2 * 1024 * 1024,
    env: process.env,
  });
  const text = String(stdout);
  const marker = text.lastIndexOf('\n__HTTP_STATUS__:');
  if (marker < 0) return { ok: false, status: 0, body: {} };
  const status = Number(text.slice(marker + '\n__HTTP_STATUS__:'.length).trim());
  let parsed = {};
  try {
    parsed = JSON.parse(text.slice(0, marker));
  } catch {
    parsed = {};
  }
  return { ok: Number.isFinite(status) && status >= 200 && status < 300, status, body: parsed };
}

/**
 * POST `application/x-www-form-urlencoded` and parse JSON.
 * @returns {{ ok: boolean, status: number, body: object }}
 */
export async function postFormJson(url, form, timeoutMs = 30_000) {
  const body = new URLSearchParams(form).toString();
  const proxyUrl = await resolveProxyUrl();
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  };

  if (proxyUrl !== undefined) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchViaUndici(url, { ...init, signal: controller.signal }, proxyUrl);
        let parsed = {};
        try {
          parsed = await response.json();
        } catch {
          parsed = {};
        }
        return { ok: response.ok, status: response.status, body: parsed };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // try curl with the same proxy
    }
    try {
      return await postFormCurl(url, body, proxyUrl, timeoutMs);
    } catch {
      // fall through to direct fetch
    }
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      let parsed = {};
      try {
        parsed = await response.json();
      } catch {
        parsed = {};
      }
      return { ok: response.ok, status: response.status, body: parsed };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeout = new Error('timeout');
      timeout.cause = error;
      timeout.code = 'timeout';
      throw timeout;
    }
    try {
      return await postFormCurl(url, body, proxyUrl, timeoutMs);
    } catch (curlError) {
      const network = new Error('network');
      network.cause = curlError;
      network.code = 'network';
      throw network;
    }
  }
}

export function grokBinaryPresent() {
  return new Promise((resolve) => {
    execFile('grok', ['--version'], { timeout: 3000 }, (error) => {
      resolve(error == null);
    });
  });
}
