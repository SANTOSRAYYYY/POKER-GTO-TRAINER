/**
 * scripts/selfplay/merge-paired.ts — 双种子配对结果合并
 *
 * 用法：
 *   ENTRY=scripts/selfplay/merge-paired.ts bash scripts/selfplay/build-and-run.sh <paired1.json> <paired2.json> [...]
 *
 * 对每个配对结果取座位 0 的逐手差值序列（b - a），跨种子拼接后按台架同一
 * 公式（mean ± 1.96·SE，bb/100）输出合并 diff 与 95% CI，并逐种子列出。
 */
import { readFileSync } from "node:fs";
import type { PairedMatchResult } from "./match";

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function sampleSd(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) acc += (x - m) * (x - m);
  return Math.sqrt(acc / (n - 1));
}

function bb100WithCI(series: number[], bigBlind: number) {
  const n = series.length;
  const sd = sampleSd(series);
  const se = n > 0 ? sd / Math.sqrt(n) : 0;
  const m = (mean(series) / bigBlind) * 100;
  const s = (se / bigBlind) * 100;
  return { bb100: m, ci: [m - 1.96 * s, m + 1.96 * s] as [number, number], sdBB: sd / bigBlind, n };
}

function fmt(x: number): string {
  return (x >= 0 ? "+" : "") + x.toFixed(1);
}

const files = process.argv.slice(2);
if (files.length < 1) {
  console.error("用法: merge-paired.ts <paired结果json> [...]");
  process.exit(1);
}

const all: number[] = [];
for (const f of files) {
  const r = JSON.parse(readFileSync(f, "utf8")) as PairedMatchResult;
  if (r.kind !== "paired") throw new Error(`${f} 不是配对结果`);
  const bb = r.meta.bigBlind;
  const diff = r.a.seats[0].profitSeries.map((p, i) => r.b.seats[0].profitSeries[i] - p);
  const stat = bb100WithCI(diff, bb);
  console.log(
    `${f}\n  seed=${r.meta.masterSeed} hands=${r.meta.hands} diff ${fmt(stat.bb100)} bb/100，` +
      `95% CI [${fmt(stat.ci[0])}, ${fmt(stat.ci[1])}]，sd/手 ${stat.sdBB.toFixed(1)}bb`,
  );
  all.push(...diff);
}

if (files.length > 1) {
  const first = JSON.parse(readFileSync(files[0], "utf8")) as PairedMatchResult;
  const stat = bb100WithCI(all, first.meta.bigBlind);
  console.log(
    `\n合并（n=${stat.n}）：diff ${fmt(stat.bb100)} bb/100，` +
      `95% CI [${fmt(stat.ci[0])}, ${fmt(stat.ci[1])}]，sd/手 ${stat.sdBB.toFixed(1)}bb`,
  );
}
