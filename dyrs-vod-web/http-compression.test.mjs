import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
function rawRequest(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('文本响应按 Accept-Encoding 返回 gzip，不带则原样返回', async (t) => {
  process.env.DISABLE_DB = '1';
  process.env.VERCEL = '1';
  process.env.LIVE_DISABLE_LOCAL = '1';
  const { requestHandler } = await import('./server.mjs');
  const app = http.createServer(requestHandler);
  const port = await listen(app);
  t.after(() => close(app));

  // 1) JSON API：带 gzip → 压缩且内容可还原
  const gz = await rawRequest(port, '/api/health', { 'Accept-Encoding': 'gzip, deflate' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(gz.headers['vary'], 'Accept-Encoding');
  const decoded = JSON.parse(zlib.gunzipSync(gz.body).toString('utf8'));
  assert.equal(decoded.ok, true);

  // 2) 不带 Accept-Encoding → 不压缩
  const plain = await rawRequest(port, '/api/health', {});
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(JSON.parse(plain.body.toString('utf8')).ok, true);

  // 3) 静态 JS：压缩后仍是合法脚本，且带缓存头
  const js = await rawRequest(port, '/app.js', { 'Accept-Encoding': 'gzip' });
  assert.equal(js.status, 200);
  assert.equal(js.headers['content-encoding'], 'gzip');
  const jsText = zlib.gunzipSync(js.body).toString('utf8');
  assert.match(jsText, /function /);
  assert.match(js.headers['cache-control'], /max-age/);

  // 4) 静态资源不带 Accept-Encoding 时原样返回
  const jsPlain = await rawRequest(port, '/app.js', {});
  assert.equal(jsPlain.status, 200);
  assert.equal(jsPlain.headers['content-encoding'], undefined);
  assert.match(jsPlain.body.toString('utf8'), /function /);
});
