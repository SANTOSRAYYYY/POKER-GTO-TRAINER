/**
 * scripts/selfplay/diff-runs.ts — 跨代码版本的「同发牌逐手配对」差值分析
 *
 * 用法：
 *   ENTRY=scripts/selfplay/diff-runs.ts bash scripts/selfplay/build-and-run.sh \
 *     <before1.json> <after1.json> [<before2.json> <after2.json> ...]
 *
 * 适用场景：静态表/常量级改动（不能经 seat0Alt 旋钮 A/B）前后各跑一遍同
 * masterSeed 的 match。resetStacksEachHand 下第 h 手的发牌与按钮只依赖
 * (masterSeed, handIndex)，两臂逐手一致 → 两结果同座位 profitSeries 可做
 * 逐手配对差值（配对 t 区间），比非配对 EV 对比收窄约一个数量级方差。
 * 与 runPaired 的区别：runPaired 换座位 0 一个变量；本脚本整桌都跑在新旧
 * 两版代码下（如全桌共用同一张翻前范围表）。
 *
 * 输出：每对（种子）各座位的 diff bb/100 与 95% CI、全部种子合并的差值 CI，
 * 以及 before/after 的 VPIP/PFR 对照。
 */
import { readFileSync } from "node:fs";
import type { MatchResult } from "./match";

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
if (files.length < 2 || files.length % 2 !== 0) {
  console.error("用法: diff-runs.ts <before1> <after1> [<before2> <after2> ...]");
  process.exit(1);
}

const merged: number[][] = []; // 每座位跨种子拼接的差值序列
let bigBlind = 0;
for (let p = 0; p < files.length; p += 2) {
  const a = JSON.parse(readFileSync(files[p], "utf8")) as MatchResult;
  const b = JSON.parse(readFileSync(files[p + 1], "utf8")) as MatchResult;
  if (a.kind !== "match" || b.kind !== "match") throw new Error("输入必须是（非配对）match 结果");
  if (a.meta.masterSeed !== b.meta.masterSeed) throw new Error("before/after 的 masterSeed 不一致");
  if (a.meta.hands !== b.meta.hands) throw new Error("before/after 的手数不一致");
  bigBlind = a.meta.bigBlind;
  console.log(`\n== seed ${a.meta.masterSeed}（${a.meta.hands} 手 ×2 臂）==`);
  for (const s of a.seats) {
    const diff = s.profitSeries.map((v, i) => b.seats[s.seat].profitSeries[i] - v);
    const stat = bb100WithCI(diff, bigBlind);
    (merged[s.seat] ??= []).push(...diff);
    console.log(
      `  seat${s.seat} VPIP ${(s.vpip * 100).toFixed(1)}%→${(b.seats[s.seat].vpip * 100).toFixed(1)}% ` +
        `PFR ${(s.pfr * 100).toFixed(1)}%→${(b.seats[s.seat].pfr * 100).toFixed(1)}% | ` +
        `diff ${fmt(stat.bb100)} bb/100，95% CI [${fmt(stat.ci[0])}, ${fmt(stat.ci[1])}]`,
    );
  }
}

if (files.length > 2) {
  console.log(`\n== 合并（${files.length / 2} 种子）==`);
  merged.forEach((series, seat) => {
    const stat = bb100WithCI(series, bigBlind);
    console.log(
      `  seat${seat}（n=${stat.n}）：diff ${fmt(stat.bb100)} bb/100，` +
        `95% CI [${fmt(stat.ci[0])}, ${fmt(stat.ci[1])}]`,
    );
  });
}
