#!/usr/bin/env bash
# scripts/selfplay/build-and-run.sh — self-play CLI 执行封装
#
# tsx 不在项目依赖里，这里用 node_modules 中已有的 esbuild 把入口打成单个
# cjs（@/* 别名由根 tsconfig.json 的 paths 自动解析），再用 node 执行。
# 所有参数原样透传：
#   bash scripts/selfplay/build-and-run.sh --config <json> --out <结果json>
# 其他入口（如配对校验）：
#   ENTRY=scripts/selfplay/verify-paired.ts bash scripts/selfplay/build-and-run.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
ENTRY="${ENTRY:-scripts/selfplay/run.ts}"
NAME="$(basename "$ENTRY" .ts)"
DIST="scripts/selfplay/.dist"
mkdir -p "$DIST"
./node_modules/.bin/esbuild "$ENTRY" \
  --bundle --platform=node --format=cjs --target=node18 \
  --outfile="$DIST/$NAME.cjs"
node "$DIST/$NAME.cjs" "$@"
