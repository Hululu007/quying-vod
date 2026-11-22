import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('服务端代理端点：改写 m3u8 绝对分片 URL 走同源代理', async (t) => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/live.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/x-mpegURL' });
      res.end('#EXTM3U\n#EXTINF:0,-\nhttp://upstream.example/seg1.ts\n#EXTINF:0,-\n/seg2.ts\n');
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  process.env.DISABLE_DB = '1';
  process.env.VERCEL = '1';
  process.env.ALLOW_LOCAL_PROXY = '1';
  const { requestHandler } = await import('./server.mjs');
  const app = http.createServer(requestHandler);
  const appPort = await listen(app);
  t.after(() => close(app));

  const r = await get(appPort, `/live-proxy.m3u8?url=http://127.0.0.1:${upstreamPort}/live.m3u8`);
  assert.equal(r.status, 200);
  assert.match(r.body, /\/live-seg\?url=http%3A%2F%2Fupstream\.example%2Fseg1\.ts/);
  const re = new RegExp(`/live-seg\\?url=http%3A%2F%2F127\\.0\\.0\\.1%3A${upstreamPort}%2Fseg2\\.ts`);
  assert.match(r.body, re);
});

test('服务端代理端点：拒绝内网 IP 的 SSRF 请求', async (t) => {
  process.env.DISABLE_DB = '1';
  process.env.VERCEL = '1';
  delete process.env.ALLOW_LOCAL_PROXY;
  const { requestHandler } = await import('./server.mjs');
  const app = http.createServer(requestHandler);
  const appPort = await listen(app);
  t.after(() => close(app));

  const r = await get(appPort, '/live-proxy.m3u8?url=http://127.0.0.1:8080/secret.m3u8');
  assert.equal(r.status, 403);
});

test('HTTPS 页面上前端自动把 HTTP 直播线路包一层同源代理', async () => {
  const fs = await import('node:fs');
  const app = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
  assert.match(app, /liveProxy|protocol !== .https:.*startsWith.*http:/);
});
