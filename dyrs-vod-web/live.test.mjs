import test from 'node:test';
import assert from 'node:assert/strict';

const live = await import('./live.mjs').catch(() => ({}));

test('解析 EXTINF 属性、频道名和 URL，并跳过不支持的协议', () => {
  assert.equal(typeof live.parseM3U, 'function');
  const rows = live.parseM3U(`#EXTM3U\n#EXTINF:-1 tvg-id="cctv1" tvg-logo="https://img.example/cctv1.png" group-title="央视",CCTV-1 综合\nhttps://live.example/cctv1.m3u8\n#EXTINF:-1 group-title="体育",CCTV-5 体育\nrtmp://live.example/cctv5\n#EXTINF:-1,组播频道\nudp://239.0.0.1:1234\n`, '主力源');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    name: 'CCTV-1 综合',
    tvgId: 'cctv1',
    logo: 'https://img.example/cctv1.png',
    rawGroup: '央视',
    group: '央视',
    url: 'https://live.example/cctv1.m3u8',
    source: '主力源',
  });
});

test('解析逗号属性值与未加引号的 group-title', () => {
  assert.equal(typeof live.parseM3U, 'function');
  const rows = live.parseM3U(`#EXTM3U\n#EXTINF:-1 tvg-name="Channel, One" group-title=Sports,Channel, One\nhttp://live.example/one.m3u8\n`);
  assert.equal(rows[0].name, 'Channel, One');
  assert.equal(rows[0].rawGroup, 'Sports');
  assert.equal(rows[0].group, '体育');
});

test('同名频道按规范化名称合并并保留不同线路', () => {
  assert.equal(typeof live.mergeLiveChannels, 'function');
  const channels = live.mergeLiveChannels([
    { name: 'CCTV-1 综合', rawGroup: '央视', group: '央视', url: 'https://a.example/1.m3u8', source: '甲', logo: 'https://img.example/1.png', tvgId: 'cctv1' },
    { name: ' cctv1综合 ', rawGroup: '央视', group: '央视', url: 'https://b.example/1.m3u8', source: '乙', logo: '', tvgId: '' },
    { name: 'CCTV1 综合', rawGroup: '央视', group: '央视', url: 'https://a.example/1.m3u8', source: '丙', logo: '', tvgId: '' },
  ]);
  assert.equal(channels.length, 1);
  assert.match(channels[0].id, /^live-[a-f0-9]{16}$/);
  assert.equal(channels[0].name, 'CCTV-1 综合');
  assert.equal(channels[0].logo, 'https://img.example/1.png');
  assert.deepEqual(channels[0].lines.map((line) => line.url), ['https://a.example/1.m3u8', 'https://b.example/1.m3u8']);
});

test('英文与中文分组归类到标准分类', () => {
  assert.equal(typeof live.classifyLiveGroup, 'function');
  assert.equal(live.classifyLiveGroup('NBA TV', 'Sports'), '体育');
  assert.equal(live.classifyLiveGroup('Movie Channel', 'Movies'), '影视');
  assert.equal(live.classifyLiveGroup('Cartoon TV', 'Kids'), '少儿');
  assert.equal(live.classifyLiveGroup('凤凰卫视', '港澳台'), '港澳台');
  assert.equal(live.classifyLiveGroup('湖南卫视', ''), '卫视');
  assert.equal(live.classifyLiveGroup('安徽卫视', '央视'), '卫视');
  assert.equal(live.classifyLiveGroup('未知频道', '自定义'), '其他');
});

test('直播频道查询支持分组、规范化搜索与分页', () => {
  assert.equal(typeof live.queryLiveChannels, 'function');
  const channels = live.mergeLiveChannels([
    { name: 'CCTV-1 综合', group: '央视', url: 'https://a.example/1.m3u8', source: '甲' },
    { name: 'CCTV-2 财经', group: '央视', url: 'https://a.example/2.m3u8', source: '甲' },
    { name: '湖南卫视', group: '卫视', url: 'https://a.example/hn.m3u8', source: '甲' },
  ]);
  const result = live.queryLiveChannels(channels, { group: '央视', wd: 'cctv ', page: 1, size: 1 });
  assert.equal(result.total, 2);
  assert.equal(result.pagecount, 2);
  assert.equal(result.list.length, 1);
  assert.equal(result.list[0].group, '央视');
});

test('采集器合并成功源并记录失败源', async () => {
  assert.equal(typeof live.LiveCollector, 'function');
  const collector = new live.LiveCollector({
    sources: [{ name: '好源', url: 'https://good.example/list.m3u' }, { name: '坏源', url: 'https://bad.example/list.m3u' }],
    fetchText: async (url) => {
      if (url.includes('bad')) throw new Error('403 Forbidden');
      return '#EXTM3U\n#EXTINF:-1 group-title="央视",CCTV1\nhttps://live.example/cctv1.m3u8\n';
    },
  });
  const snapshot = await collector.getSnapshot();
  assert.equal(snapshot.channels.length, 1);
  assert.equal(snapshot.stale, false);
  assert.deepEqual(snapshot.sources.map((s) => [s.name, s.ok]), [['好源', true], ['坏源', false]]);
  assert.match(snapshot.sources[1].error, /403/);
  assert.equal(snapshot.groups.find((g) => g.name === '央视').count, 1);
});

test('全部源失败且无旧快照时抛出错误', async () => {
  assert.equal(typeof live.LiveCollector, 'function');
  const collector = new live.LiveCollector({
    sources: [{ name: '坏源', url: 'https://bad.example/list.m3u' }],
    fetchText: async () => { throw new Error(' unavailable '); },
  });
  await assert.rejects(() => collector.getSnapshot(), /所有直播清单源暂不可用/);
});

test('远端全挂时 assets/ 本地 m3u 自动兜底', async (t) => {
  assert.equal(typeof live.LiveCollector, 'function');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const localDir = path.join(import.meta.dirname, 'assets');
  const localFile = path.join(localDir, 'iptv4.m3u');
  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(localFile,
    '#EXTM3U\n#EXTINF:-1 group-title="央视",CCTV1\nhttps://local.example/cctv1.m3u8\n');
  t.after(() => { try { fs.rmSync(localDir, { recursive: true, force: true }); } catch {} });

  const collector = new live.LiveCollector({
    sources: [{ name: '坏源', url: 'https://bad.example/list.m3u' }],
    fetchText: async () => { throw new Error(' down '); },
    ttl: 0,
  });
  const snapshot = await collector.getSnapshot({ force: true });
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.channels.length, 1);
  assert.equal(snapshot.channels[0].name, 'CCTV1');
  const localSource = snapshot.sources.find((s) => s.local);
  assert.ok(localSource);
  assert.match(localSource.name, /本地/);
});

test('缓存内不重复采集，强制刷新会重新拉取', async () => {
  assert.equal(typeof live.LiveCollector, 'function');
  let calls = 0;
  const collector = new live.LiveCollector({
    sources: [{ name: '源', url: 'https://good.example/list.m3u' }],
    ttl: 3600000,
    fetchText: async () => {
      calls += 1;
      return '#EXTM3U\n#EXTINF:-1,测试频道\nhttps://live.example/test.m3u8\n';
    },
  });
  await Promise.all([collector.getSnapshot(), collector.getSnapshot()]);
  await collector.getSnapshot();
  assert.equal(calls, 1);
  await collector.getSnapshot({ force: true });
  assert.equal(calls, 2);
});

test('生成合并 M3U 时保留同名的多条线路', () => {
  assert.equal(typeof live.buildLiveM3U, 'function');
  const channels = live.mergeLiveChannels([
    { name: 'CCTV1', tvgId: 'cctv1', group: '央视', url: 'https://a.example/1.m3u8', source: '甲' },
    { name: 'CCTV1', tvgId: 'cctv1', group: '央视', url: 'https://b.example/1.m3u8', source: '乙' },
  ]);
  const output = live.buildLiveM3U(channels);
  assert.match(output, /^#EXTM3U x-tvg-url="http:\/\/epg\.51zmt\.top:8000\/e\.xml"/);
  assert.equal((output.match(/#EXTINF:/g) || []).length, 2);
  assert.match(output, /group-title="央视"/);
});
