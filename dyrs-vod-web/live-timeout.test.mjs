import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('持续慢速传输的清单也受采集总超时约束', async (t) => {
  let interval;
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.write('#EXTM3U\n');
    interval = setInterval(() => res.write('# still downloading\n'), 50);
    res.on('close', () => clearInterval(interval));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => {
    clearInterval(interval);
    upstream.closeAllConnections();
    return new Promise((resolve) => upstream.close(resolve));
  });

  process.env.DISABLE_DB = '1';
  process.env.VERCEL = '1';
  process.env.LIVE_SOURCES = `http://127.0.0.1:${upstreamPort}/slow.m3u`;
  process.env.LIVE_FETCH_TIMEOUT_MS = '1000';
  const { requestHandler } = await import('./server.mjs');
  const app = http.createServer(requestHandler);
  const appPort = await listen(app);
  t.after(() => {
    app.closeAllConnections();
    return new Promise((resolve) => app.close(resolve));
  });

  const response = await fetch(`http://127.0.0.1:${appPort}/api/live/groups`, { signal: AbortSignal.timeout(4000) });
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.ok, false);
});
