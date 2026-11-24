import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseLivePlaylist, serializeLivePlaylist, liveEntryName } from './tools/refresh-live-sources.mjs';

test('解析与重写保留精选清单的结构和顺序', async () => {
  const text = await readFile(new URL('./assets/weishi-live.m3u', import.meta.url), 'utf8');
  const parsed = parseLivePlaylist(text);
  assert.equal(parsed.head[0], '#EXTM3U');
  assert.ok(parsed.entries.length > 5);
  assert.equal(parsed.entries[0].name, '新疆卫视');
  assert.match(parsed.entries[0].url, /^https?:/);
  const round = parseLivePlaylist(serializeLivePlaylist(parsed));
  assert.deepEqual(round.entries.map((entry) => entry.url), parsed.entries.map((entry) => entry.url));
});

test('剔除不可达条目后，其余条目与头部保持原样', () => {
  const text = '#EXTM3U\n#EXTINF:-1 group-title="卫视",A台\nhttp://a.example/x.m3u8\n#EXTINF:-1,B台\nhttp://b.example/y.m3u8\n';
  const parsed = parseLivePlaylist(text);
  const kept = parsed.entries.filter((entry) => entry.name !== 'A台');
  const out = serializeLivePlaylist({ head: parsed.head, entries: kept });
  assert.ok(!out.includes('http://a.example'));
  assert.ok(out.includes('#EXTINF:-1,B台') && out.includes('http://b.example/y.m3u8'));
  assert.equal(liveEntryName('#EXTINF:-1 tvg-id="x",C台'), 'C台');
});
