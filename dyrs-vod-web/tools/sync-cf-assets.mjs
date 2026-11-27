// Cloudflare Static Assets 只能托管 public/ 一个目录：
// 部署前把 assets/*.m3u 同步到 public/assets/，并生成 manifest.json 供 Workers 读取本地兜底源。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceDir = path.join(root, 'assets');
const targetDir = path.join(root, 'public', 'assets');

fs.mkdirSync(targetDir, { recursive: true });

const names = fs.existsSync(sourceDir)
  ? fs.readdirSync(sourceDir).filter((name) => /\.m3u$/i.test(name)).sort()
  : [];

for (const name of names) {
  fs.copyFileSync(path.join(sourceDir, name), path.join(targetDir, name));
}
fs.writeFileSync(path.join(targetDir, 'manifest.json'), `${JSON.stringify(names, null, 2)}\n`);

console.log(`[cf-assets] synced ${names.length} playlist(s) to public/assets`);
