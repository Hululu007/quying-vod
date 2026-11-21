#!/bin/sh
set -eu

# 无论从仓库根目录还是应用目录调用，都切到脚本所在目录。
cd "$(dirname "$0")"

rm -rf dist
mkdir -p dist
cp package.json package-lock.json server.mjs catalog-store.mjs admin-store.mjs mysql-store.mjs db-layer.mjs dist/
cp -R public dist/public
cp run.sh dist/run.sh
chmod 755 dist/run.sh

export NPM_CONFIG_REGISTRY='https://registry.npmjs.org/'
# 远程构建机可能是 Node 22/26，这里固定按 Node 20 ABI 拉取 better-sqlite3 预编译包。
npm_config_target="${npm_config_target:-20.18.1}" npm_config_runtime=node \
  npm ci --omit=dev --prefix dist --registry='https://registry.npmjs.org/'
