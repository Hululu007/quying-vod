import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const index = fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('./public/styles.css', import.meta.url), 'utf8');

test('前台导航包含直播入口并接入直播视图', () => {
  assert.match(index, /data-view="live"/);
  assert.match(app, /function renderLive\(\)/);
  assert.match(app, /v === 'live'/);
});

test('直播页接入分组频道接口与 HLS 多线路播放器', () => {
  assert.match(app, /\/api\/live\/groups/);
  assert.match(app, /\/api\/live\/channels/);
  assert.match(app, /new window\.Hls\(/);
  assert.match(app, /loadLiveLine/);
  assert.match(styles, /\.live-layout/);
  assert.match(styles, /\.live-channel/);
});

test('频道首次播放时自动选择首条 HTTPS 线路，避免 HTTPS 页面触发 HTTP 混合内容失败', () => {
  assert.match(app, /preferredLiveLine|pickPreferredLine|findIndex.*https|lines\.findIndex/);
});

test('播放前按 CODECS 预检，H.265 等不可解码线路自动切换而不是只出声', () => {
  assert.match(app, /function videoCodecSupported/);
  assert.match(app, /MediaSource\.isTypeSupported/);
  assert.match(app, /function levelVideoCodec/);
  assert.match(app, /Hls\.Events\.MANIFEST_PARSED[\s\S]{0,600}levelVideoCodec/);
  assert.match(app, /function watchLiveFrames/);
  assert.match(app, /只有声音没有画面/);
});

test('直播错误分级恢复：网络错误重连、媒体错误 recover、卡顿跳直播边缘', () => {
  assert.match(app, /Hls\.ErrorTypes\.NETWORK_ERROR/);
  assert.match(app, /hls\.startLoad\(\)/);
  assert.match(app, /recoverMediaError/);
  assert.match(app, /onwaiting = |onstalled = /);
  assert.match(app, /seekable\.end/);
  assert.match(app, /capLevelToPlayerSize: true/);
});
