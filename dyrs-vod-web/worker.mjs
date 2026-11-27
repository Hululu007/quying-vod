// Cloudflare Workers 入口：把 fetch Request 适配成 Node 风格的 req/res，
// 复用 server.mjs 的全部路由；静态文件交给 Static Assets 绑定。
import { Buffer } from 'node:buffer';

// 由 server.mjs 动态处理的路径（其余视为静态资源）。
const DYNAMIC_EXACT = new Set([
  '/play.m3u8', '/resolve', '/img', '/live.m3u',
  '/live-proxy.m3u8', '/live-seg',
  '/vod', '/api.php/provide/vod',
]);

function isDynamic(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/') || DYNAMIC_EXACT.has(pathname);
}

let appPromise = null;
function getApp() {
  if (!appPromise) appPromise = import('./server.mjs');
  return appPromise;
}

// 请求体一次性读完；readJsonBody 依赖 data/end 事件，这里在微任务里补发。
function makeRequest(request, url, body) {
  const listeners = { data: [], end: [], error: [] };
  const headers = {};
  request.headers.forEach((value, key) => { headers[key] = value; });
  if (!headers.host) headers.host = url.host;
  if (!headers['x-forwarded-proto']) headers['x-forwarded-proto'] = url.protocol.replace(':', '');
  const req = {
    method: request.method,
    url: url.pathname + url.search,
    headers,
    on(event, handler) {
      (listeners[event] || (listeners[event] = [])).push(handler);
      return req;
    },
    destroy() {},
  };
  queueMicrotask(() => {
    if (body && body.length) for (const handler of listeners.data) handler(body);
    for (const handler of listeners.end) handler();
  });
  return req;
}

// 响应先全部缓存在内存，最后转换成标准 Response（体积远小于 Workers 128MB 限制）。
function makeResponse(req) {
  const state = { status: 200, headers: new Headers(), chunks: [] };
  const res = {
    req,
    statusCode: 200,
    setHeader(name, value) { state.headers.set(name, String(value)); },
    getHeader(name) { return state.headers.get(name); },
    writeHead(status, headers) {
      state.status = status;
      res.statusCode = status;
      for (const [key, value] of Object.entries(headers || {})) {
        for (const item of Array.isArray(value) ? value : [value]) state.headers.set(key, String(item));
      }
    },
    write(chunk) {
      if (chunk != null && chunk !== '') state.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
    end(chunk) {
      if (chunk != null && chunk !== '') state.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
    toResponse() {
      const body = state.status === 204 || state.status === 304 ? null : Buffer.concat(state.chunks);
      return new Response(body, { status: state.status, headers: state.headers });
    },
  };
  return res;
}

async function serveStatic(request, env, url) {
  // /admin 由 Assets 的 html_handling 自动映射到 admin.html，这里不重写路径，
  // 否则 /admin.html → /admin 的 307 会与 worker 形成循环重定向。
  const response = await env.ASSETS.fetch(new Request(url.toString(), request));
  // 无扩展名的前端路由回落到 index.html（与 Node 版行为一致）。
  if (response.status === 404 && !/\.[a-z0-9]+$/i.test(url.pathname)) {
    return env.ASSETS.fetch(new Request(new URL('/index.html', url).toString(), request));
  }
  return response;
}

let warmed = false;

export default {
  async fetch(request, env, ctx) {
    // runtime.mjs 在模块加载时读取该全局变量判断运行环境。
    globalThis.__CF_ENV__ = env;
    const url = new URL(request.url);

    if (!isDynamic(url.pathname)) {
      return serveStatic(request, env, url);
    }

    try {
      const app = await getApp();
      if (!warmed && String(env.LIVE_WARMUP ?? '1') !== '0') {
        warmed = true;
        // 直播清单采集耗时较长，放到响应之后进行，避免首个请求 30s 超时。
        ctx.waitUntil(app.warmLiveSnapshot().catch(() => {}));
      }
      const body = request.method === 'GET' || request.method === 'HEAD'
        ? null
        : Buffer.from(await request.arrayBuffer());
      const req = makeRequest(request, url, body);
      const res = makeResponse(req);
      await app.requestHandler(req, res);
      return res.toResponse();
    } catch (error) {
      return new Response(JSON.stringify({ ok: false, error: String((error && error.message) || error) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
  },
};
