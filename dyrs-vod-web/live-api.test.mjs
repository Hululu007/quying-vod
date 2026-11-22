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

async function getJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: await response.json() };
}

test('直播 API 返回分组、分页频道和 TVBox 直播配置', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('#EXTM3U\n#EXTINF:-1 group-title="央视",CCTV1\nhttps://a.example/cctv1.m3u8\n#EXTINF:-1 group-title="央视",CCTV2\nhttps://a.example/cctv2.m3u8\n#EXTINF:-1 group-title="Sports",NBA TV\nhttps://a.example/nba.m3u8\n');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  process.env.DISABLE_DB = '1';
  process.env.VERCEL = '1';
  process.env.LIVE_SOURCES = `http://127.0.0.1:${upstreamPort}/list.m3u`;
  const { requestHandler } = await import('./server.mjs');
  const app = http.createServer(requestHandler);
  const appPort = await listen(app);
  t.after(() => close(app));

  const groups = await getJson(appPort, '/api/live/groups');
  assert.equal(groups.status, 200);
  assert.equal(groups.body.ok, true);
  assert.equal(groups.body.total, 3);
  assert.equal(groups.body.groups.find((g) => g.name === '央视').count, 2);

  const page = await getJson(appPort, '/api/live/channels?group=%E5%A4%AE%E8%A7%86&wd=cctv&pg=2&size=1');
  assert.equal(page.status, 200);
  assert.equal(page.body.total, 2);
  assert.equal(page.body.page, 2);
  assert.equal(page.body.pagecount, 2);
  assert.equal(page.body.list.length, 1);
  assert.equal(page.body.list[0].lines[0].url.startsWith('https://'), true);

  const tvbox = await getJson(appPort, '/api/vod/tvbox');
  assert.equal(tvbox.status, 200);
  assert.equal(tvbox.body.lives.length, 1);
  assert.match(tvbox.body.lives[0].url, /\/live\.m3u$/);
});

