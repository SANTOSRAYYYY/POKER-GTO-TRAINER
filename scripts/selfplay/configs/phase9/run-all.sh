#!/usr/bin/env bash
# Phase 9 深筹（200bb）复测：4 组 × 3 种子 = 12 场配对，每批 2 并发。
# 用法: bash scripts/selfplay/configs/phase9/run-all.sh
# 注意：全部使用绝对路径（后台任务 cwd 不保证是仓库根）；esbuild 只打一次包，
# 避免并发写同一 .dist/run.cjs。
set -uo pipefail
ROOT="/c/Users/coins/Desktop/poker"
cd "$ROOT" || { echo "FATAL: cannot cd $ROOT"; exit 1; }
DIST="scripts/selfplay/.dist"
mkdir -p "$DIST" scripts/selfplay/results/phase9/logs
echo "[build] esbuild 打包 run.ts $(date +%H:%M:%S)"
./node_modules/.bin/esbuild scripts/selfplay/run.ts \
  --bundle --platform=node --format=cjs --target=node18 \
  --outfile="$DIST/run.cjs" || { echo "FATAL: esbuild 失败"; exit 1; }
CFGS=(
  preflop200-s42 preflop200-s43 preflop200-s44
  showdown200-s42 showdown200-s43 showdown200-s44
  showdown-l96-200-s42 showdown-l96-200-s43 showdown-l96-200-s44
  blocker200-s42 blocker200-s43 blocker200-s44
)
i=0
for name in "${CFGS[@]}"; do
  out="$ROOT/scripts/selfplay/results/phase9/${name}.json"
  if [ -s "$out" ]; then echo "[skip] $name 已存在"; continue; fi
  echo "[start] $name $(date +%H:%M:%S)"
  node "$ROOT/$DIST/run.cjs" \
    --config "$ROOT/scripts/selfplay/configs/phase9/${name}.json" \
    --out "$out" \
    > "$ROOT/scripts/selfplay/results/phase9/logs/${name}.log" 2>&1 &
  i=$((i+1))
  if [ $((i % 2)) -eq 0 ]; then wait; fi
done
wait
echo "[done] 全部完成 $(date +%H:%M:%S)"
ls -la "$ROOT/scripts/selfplay/results/phase9/"*.json
