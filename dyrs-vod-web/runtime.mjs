// 运行时抽象：同一份 server.mjs 既跑 Node 长驻进程 / Serverless，
// 也跑 Cloudflare Workers（nodejs_compat）。
// 差异集中在这里：环境变量来源、出站 HTTP 客户端、静态资源读取。
import { Buffer } from 'node:buffer';

// worker.mjs 会在动态 import server.mjs 之前写入 globalThis.__CF_ENV__。
export const isWorkers = typeof globalThis.__CF_ENV__ !== 'undefined' && !!globalThis.__CF_ENV__;
// Workers 的 env 对象按请求创建，这里用 Proxy 每次读取都取当前请求的绑定；
// Node 下 ENV 必须是对 process.env 的引用而不是快照（测试会在 import 后修改环境变量）。
export const ENV = isWorkers
  ? new Proxy({}, { get: (_target, key) => globalThis.__CF_ENV__?.[key] })
  : process.env;

const DEFAULT_TIMEOUT_MS = 5000;

// ---- Node 出站 HTTP：按需动态引入，避免 Workers 打包时强依赖 ----
let nodeHttp = null;
let nodeHttps = null;
async function nodeLib(protocol) {
  if (protocol === 'https:') {
    if (!nodeHttps) nodeHttps = (await import('node:https')).default;
    return nodeHttps;
  }
  if (!nodeHttp) nodeHttp = (await import('node:http')).default;
  return nodeHttp;
}

function timeoutOf(opts) {
  return opts.deadline ? opts.deadline - Date.now() : (opts.timeout || DEFAULT_TIMEOUT_MS);
}

function nodeGetText(target, opts = {}) {
  return new Promise((resolveRequest) => {
    let settled = false;
    let totalTimer = null;
    const resolve = (value) => {
      if (settled) return;
      settled = true;
      if (totalTimer) clearTimeout(totalTimer);
      resolveRequest(value);
    };
    let parsed;
    try { parsed = new URL(target); } catch { resolve({ status: 0, error: 'invalid url' }); return; }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      resolve({ status: 0, error: 'invalid protocol' });
      return;
    }
    const remaining = timeoutOf(opts);
    if (remaining <= 0) { resolve({ status: 0, error: 'upstream timeout' }); return; }

    nodeLib(parsed.protocol).then((lib) => {
      // 4K 站 WAF 会拦截 Node 的 TLS 1.3 指纹，强制 TLS 1.2 才能拿到正常页面。
      const tlsOptions = parsed.protocol === 'https:' && opts.tls12
        ? { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' }
        : {};
      const req = lib.get(parsed, { headers: opts.headers || {}, family: 4, ...tlsOptions }, (resp) => {
        const status = resp.statusCode || 0;
        const location = resp.headers.location;
        if (opts.followRedirects && location && status >= 300 && status < 400) {
          let next;
          try { next = new URL(location, parsed); } catch {
            resp.resume();
            resolve({ status: 0, error: 'invalid redirect' });
            return;
          }
          const redirects = (opts.redirects || 0) + 1;
          const allowed = opts.redirectAllowed ? opts.redirectAllowed(next) : next.origin === parsed.origin;
          // 不要 destroy：销毁请求会触发 error 事件，抢在重定向结果前把 Promise 判为失败。
          resp.resume();
          if (redirects > 3 || !allowed) { resolve({ status: 0, error: 'redirect not allowed' }); return; }
          resolve(httpGetText(next.toString(), { ...opts, redirects }));
          return;
        }
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => resolve({
          status,
          headers: resp.headers || {},
          body: Buffer.concat(chunks),
        }));
        resp.on('error', (e) => resolve({ status: 0, error: String((e && e.message) || e) }));
      });
      req.on('error', (e) => resolve({ status: 0, error: String((e && e.message) || e) }));
      // setTimeout 只限制 socket 空闲时间；总计时器同时限制持续慢速传输，避免清单永远不结束。
      totalTimer = setTimeout(() => req.destroy(new Error('upstream timeout')), remaining);
      if (typeof totalTimer.unref === 'function') totalTimer.unref();
      req.setTimeout(Math.min(opts.timeout || DEFAULT_TIMEOUT_MS, remaining), () => req.destroy(new Error('upstream timeout')));
    }).catch((error) => resolve({ status: 0, error: String((error && error.message) || error) }));
  });
}

// Workers 只允许设置部分请求头，过滤浏览器/运行时禁用的字段，避免 fetch 直接抛错。
const WORKERS_HEADER_BLOCKLIST = new Set(['accept-encoding', 'connection', 'content-length', 'host', 'transfer-encoding']);

function workersHeaders(headers) {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers || {})) {
    if (value == null) continue;
    if (WORKERS_HEADER_BLOCKLIST.has(String(key).toLowerCase())) continue;
    try { out.set(key, String(value)); } catch { /* 非法头名直接忽略 */ }
  }
  return out;
}

async function workersGetText(target, opts = {}) {
  let parsed;
  try { parsed = new URL(target); } catch { return { status: 0, error: 'invalid url' }; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { status: 0, error: 'invalid protocol' };
  }
  const remaining = timeoutOf(opts);
  if (remaining <= 0) return { status: 0, error: 'upstream timeout' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('upstream timeout')), remaining);
  try {
    let current = parsed;
    for (let hop = 0; hop <= 3; hop += 1) {
      const response = await fetch(current.toString(), {
        method: 'GET',
        headers: workersHeaders(opts.headers),
        redirect: 'manual',
        signal: controller.signal,
      });
      const status = response.status;
      const location = response.headers.get('location');
      if (opts.followRedirects && location && status >= 300 && status < 400) {
        const next = new URL(location, current);
        const allowed = opts.redirectAllowed ? opts.redirectAllowed(next) : next.origin === current.origin;
        if (hop >= 3 || !allowed) {
          try { await response.body?.cancel(); } catch {}
          return { status: 0, error: 'redirect not allowed' };
        }
        try { await response.body?.cancel(); } catch {}
        current = next;
        continue;
      }
      const headers = {};
      response.headers.forEach((value, key) => { headers[key] = value; });
      const body = Buffer.from(await response.arrayBuffer());
      return { status, headers, body };
    }
    return { status: 0, error: 'redirect not allowed' };
  } catch (error) {
    return { status: 0, error: String((error && error.message) || error) };
  } finally {
    clearTimeout(timer);
  }
}

// 统一的文本/二进制抓取入口：返回 { status, headers, body: Buffer } 或 { status: 0, error }。
export function httpGetText(target, opts = {}) {
  return isWorkers ? workersGetText(target, opts) : nodeGetText(target, opts);
}

// 读取 Workers Static Assets。Node 模式返回 null，由调用方走文件系统。
export async function readAssetText(pathname) {
  if (!isWorkers || !ENV.ASSETS) return null;
  try {
    const response = await ENV.ASSETS.fetch(new URL(pathname, 'https://assets.internal'));
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

// 静态资源直接交给 Assets 绑定返回（含 304/ETag 处理）。
export async function fetchAsset(request) {
  if (!isWorkers || !ENV.ASSETS) return null;
  return ENV.ASSETS.fetch(request);
}
