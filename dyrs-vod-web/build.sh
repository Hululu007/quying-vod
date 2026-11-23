#!/bin/sh
set -eu

# 无论从仓库根目录还是应用目录调用，都切到脚本所在目录。
cd "$(dirname "$0")"

rm -rf dist
mkdir -p dist
cp package.json package-lock.json server.mjs live.mjs catalog-store.mjs admin-store.mjs pg-store.mjs db-layer.mjs sqlite-compat.mjs dist/
cp -R public dist/public
cp -R assets dist/assets
cp run.sh dist/run.sh
chmod 755 dist/run.sh

export NPM_CONFIG_REGISTRY='https://registry.npmjs.org/'
npm ci --omit=dev --prefix dist --registry='https://registry.npmjs.org/'
