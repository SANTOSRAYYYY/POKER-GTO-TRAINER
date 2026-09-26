/**
 * scripts/selfplay/icm-ab.ts — Phase 7 锦标赛 ICM 旋钮 A/B 台架驱动
 *
 * 配对口径：锦标赛模式不支持 runPaired（淘汰/升盲使两臂手数不对齐），
 * 改为「同 masterSeed 两场 match」——发牌逐手一致（只依赖 masterSeed ×
 * handIndex），唯一变量是座位 0 的 icmEnabled（false → true），其余 7 个
 * 座位保持默认 gto。决策流一旦分叉两场比赛不再逐手对齐，靠 30 个种子的
 * 独立重复消噪。
 *
 * 赛制（任务定案）：8 人 heuristic 锦标赛，100bb 起步（startStack 2000 /
 * level0 bb=20），rebuy 0，handsPerLevel 10，原始 10 级升盲表
 * （DEFAULT_BLIND_LEVELS），maxHands 200。
 *
 * 判定指标（座位 0）：
 * - 名次差 placeDiff = placeA − placeB（正值 = ICM 臂名次更好）
 * - 盈亏差 profitDiff = profitB − profitA（筹码；正 = ICM 臂多赢）
 * 采纳规则：30 个种子的 placeDiff 95% CI 全正（下限 > 0）且中值 > +0.15
 * 才保留 icmEnabled 默认开启，否则默认改回 false。
 *
 * 用法：
 *   ENTRY=scripts/selfplay/icm-ab.ts bash scripts/selfplay/build-and-run.sh \
 *     --out scripts/selfplay/results/phase7-icm-seeds.json [--seeds 42:72]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_BLIND_LEVELS } from "@/lib/types";
import { runMatch, type MatchConfig, type SeatBrain } from "./match";

interface SeedRow {
  seed: number;
  placeA: number | null; // icmEnabled:false 臂座位 0 名次
  placeB: number | null; // icmEnabled:true 臂座位 0 名次
  profitA: number;
  profitB: number;
  placeDiff: number | null; // A - B（正 = ICM 更好）
  profitDiff: number; // B - A（正 = ICM 更好）
  handsA: number;
  handsB: number;
  endedByA: string;
  endedByB: string;
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function sampleSd(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (n - 1));
}

function ci95(xs: number[]): { mean: number; lo: number; hi: number; median: number } {
  const m = mean(xs);
  const se = xs.length > 0 ? sampleSd(xs) / Math.sqrt(xs.length) : 0;
  return { mean: m, lo: m - 1.96 * se, hi: m + 1.96 * se, median: median(xs) };
}

function seatBrains(icm: boolean): SeatBrain[] {
  return [
    { style: "gto", tuning: { icmEnabled: icm } },
    ...Array.from({ length: 7 }, (): SeatBrain => ({ style: "gto" })),
  ];
}

function matchConfig(seed: number, icm: boolean): MatchConfig {
  return {
    seats: 8,
    hands: 200, // 锦标赛模式 = maxHands 上限
    masterSeed: seed,
    tournament: {
      levels: DEFAULT_BLIND_LEVELS,
      handsPerLevel: 10,
      startStack: 2000, // 100bb（level0 bb=20）
      rebuysAllowed: 0,
    },
    seatBrains: seatBrains(icm),
  };
}

function parseArgs(argv: string[]): { out: string; seedLo: number; seedHi: number } {
  let out = "scripts/selfplay/results/phase7-icm-seeds.json";
  let seedLo = 42;
  let seedHi = 72; // 半开区间：默认 42..71 共 30 个种子
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i] ?? out;
    else if (argv[i] === "--seeds") {
      const [a, b] = (argv[++i] ?? "").split(":").map((s) => parseInt(s, 10));
      if (Number.isInteger(a) && Number.isInteger(b) && b > a) {
        seedLo = a;
        seedHi = b;
      }
    }
  }
  return { out, seedLo, seedHi };
}

async function main(): Promise<void> {
  const { out, seedLo, seedHi } = parseArgs(process.argv.slice(2));
  const seeds = Array.from({ length: seedHi - seedLo }, (_, i) => seedLo + i);
  const rows: SeedRow[] = [];
  const t0 = performance.now();

  for (const seed of seeds) {
    const a = await runMatch(matchConfig(seed, false));
    const b = await runMatch(matchConfig(seed, true));
    const placeA = a.tournament?.finishPlaces[0] ?? null;
    const placeB = b.tournament?.finishPlaces[0] ?? null;
    const profitA = a.seats[0].totalProfit;
    const profitB = b.seats[0].totalProfit;
    rows.push({
      seed,
      placeA,
      placeB,
      profitA,
      profitB,
      placeDiff: placeA !== null && placeB !== null ? placeA - placeB : null,
      profitDiff: profitB - profitA,
      handsA: a.tournament?.handsPlayed ?? 0,
      handsB: b.tournament?.handsPlayed ?? 0,
      endedByA: a.tournament?.endedBy ?? "?",
      endedByB: b.tournament?.endedBy ?? "?",
    });
    console.error(
      `[icm-ab] seed ${seed} 完成：名次 ${placeA} → ${placeB}，` +
        `盈亏 ${profitA} → ${profitB}（累计 ${rows.length}/${seeds.length}，` +
        `${((performance.now() - t0) / 1000).toFixed(0)}s）`,
    );
  }

  const placeDiffs = rows.map((r) => r.placeDiff).filter((x): x is number => x !== null);
  const profitDiffs = rows.map((r) => r.profitDiff);
  const placeStats = ci95(placeDiffs);
  const profitStats = ci95(profitDiffs);

  const summary = {
    format:
      "8 人 heuristic 锦标赛（100bb 起步 startStack=2000、rebuy 0、handsPerLevel 10、" +
      "DEFAULT_BLIND_LEVELS 10 级、maxHands 200）；同 seed 两场 match，唯一变量 = " +
      "座位 0 的 icmEnabled（A=false，B=true），其余 7 座位默认 gto",
    seeds: [seedLo, seedHi - 1],
    nSeeds: rows.length,
    seat0: {
      avgPlaceA: mean(rows.map((r) => r.placeA ?? NaN).filter(Number.isFinite)),
      avgPlaceB: mean(rows.map((r) => r.placeB ?? NaN).filter(Number.isFinite)),
      totalProfitA: rows.reduce((s, r) => s + r.profitA, 0),
      totalProfitB: rows.reduce((s, r) => s + r.profitB, 0),
      placeDiff: {
        n: placeDiffs.length,
        mean: placeStats.mean,
        median: placeStats.median,
        ci95: [placeStats.lo, placeStats.hi],
      },
      profitDiff: {
        n: profitDiffs.length,
        mean: profitStats.mean,
        median: profitStats.median,
        ci95: [profitStats.lo, profitStats.hi],
      },
      championA: rows.filter((r) => r.placeA === 1).length,
      championB: rows.filter((r) => r.placeB === 1).length,
    },
    rows,
    durationMs: performance.now() - t0,
    finishedAt: new Date().toISOString(),
  };

  const outPath = resolve(out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(summary, null, 2));

  console.log("\n== Phase 7 ICM A/B（座位 0：icmEnabled false → true）==");
  console.log(`种子 ${seedLo}..${seedHi - 1}（n=${rows.length}）`);
  console.log(
    `座位 0 平均名次：${summary.seat0.avgPlaceA.toFixed(2)} → ${summary.seat0.avgPlaceB.toFixed(2)}`,
  );
  console.log(
    `名次差（A−B，正=ICM 更好）：mean ${placeStats.mean.toFixed(3)}，median ${placeStats.median.toFixed(3)}，` +
      `95% CI [${placeStats.lo.toFixed(3)}, ${placeStats.hi.toFixed(3)}]`,
  );
  console.log(
    `盈亏差（B−A，筹码）：mean ${profitStats.mean.toFixed(1)}，median ${profitStats.median.toFixed(1)}，` +
      `95% CI [${profitStats.lo.toFixed(1)}, ${profitStats.hi.toFixed(1)}]`,
  );
  console.log(
    `座位 0 累计盈亏：${summary.seat0.totalProfitA} → ${summary.seat0.totalProfitB}；` +
      `夺冠次数：${summary.seat0.championA} → ${summary.seat0.championB}`,
  );
  const adopt = placeStats.lo > 0 && placeStats.median > 0.15;
  console.log(
    `采纳判定（CI 全正 且 中值 > +0.15）：${adopt ? "通过 → icmEnabled 默认 true" : "未通过 → icmEnabled 默认改回 false"}`,
  );
  console.log(`结果已写入 ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
