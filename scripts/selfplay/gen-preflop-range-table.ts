/**
 * scripts/selfplay/gen-preflop-range-table.ts — 离线生成「169 牌型 × 开局范围宽度」
 * 翻前真实胜率静态表（供 src/lib/ai/range.ts 的 PREFLOP_VS_RANGE_EQUITY 使用）。
 *
 * 用法：
 *   ENTRY=scripts/selfplay/gen-preflop-range-table.ts bash scripts/selfplay/build-and-run.sh
 *
 * 口径：
 * - 范围 = PREFLOP_ORDER（对随机单对手胜率降序的 169 牌型）的前 ceil(169×X) 个牌型的
 *   全部底牌组合（对子 6 / 同花 4 / 非同花 12，天然组合加权）。这是「顶部 X%」的近似—
 *   真实开局范围并非严格按对随机胜率截断（如 65s 实际常先于 K7o 开局），注释即此意。
 * - 每格蒙特卡洛 ITERATIONS 次：hero 牌型均匀抽组合，对手组合从范围内均匀抽
 *   （与 hero 不共牌），公共牌 5 张随机，evaluate7 比大小，tie 计 0.5。
 * - 单调性修整：同一牌型的胜率应对范围宽度单调不减（范围越宽越弱）；蒙特卡洛
 *   噪声可能产生微小倒挂，逐格取 cumulative max 修正（修正量 << 1 个标准误）。
 * - 每格用 mulberry32(hash(label)+tier) 独立种子，结果跨进程可复现。
 */
import { writeFileSync } from "node:fs";
import type { Card } from "@/lib/types";
import { newDeck } from "@/lib/poker/cards";
import { evaluate7 } from "@/lib/poker/evaluator";
import { PREFLOP_ORDER } from "@/lib/ai/brain";

/** 范围宽度档位（与 range.ts 的 PREFLOP_RANGE_TIERS 一致） */
const TIERS = [0.15, 0.2, 0.28, 0.4, 0.55] as const;
const ITERATIONS = 4000;

const RANK_CHAR_TO_VALUE: Record<string, number> = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};
const VALUE_TO_RANK_CHAR = "23456789TJQKA";
const SUITS = ["s", "h", "d", "c"] as const;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashLabel(label: string): number {
  let h = 2166136261;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 牌型标签（"AA"/"AKs"/"AKo"）→ 全部底牌组合 */
function combosOf(label: string): [Card, Card][] {
  const v1 = RANK_CHAR_TO_VALUE[label[0]];
  const v2 = RANK_CHAR_TO_VALUE[label[1]];
  const r1 = VALUE_TO_RANK_CHAR[v1 - 2];
  const r2 = VALUE_TO_RANK_CHAR[v2 - 2];
  const out: [Card, Card][] = [];
  if (label.length === 2) {
    // 对子：C(4,2)=6
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        out.push([`${r1}${SUITS[i]}` as Card, `${r1}${SUITS[j]}` as Card]);
      }
    }
  } else if (label[2] === "s") {
    for (const s of SUITS) out.push([`${r1}${s}` as Card, `${r2}${s}` as Card]);
  } else {
    for (const s1 of SUITS) {
      for (const s2 of SUITS) {
        if (s1 !== s2) out.push([`${r1}${s1}` as Card, `${r2}${s2}` as Card]);
      }
    }
  }
  return out;
}

const DECK = newDeck();

/** hero 组合 vs 范围组合池的蒙特卡洛胜率（win + tie/2） */
function equityOfLabelVsRange(
  heroCombos: [Card, Card][],
  rangeCombos: [Card, Card][],
  rng: () => number,
): number {
  let win = 0;
  let tie = 0;
  for (let it = 0; it < ITERATIONS; it++) {
    const hero = heroCombos[Math.floor(rng() * heroCombos.length)];
    const dead = new Set<string>(hero);
    let vill = rangeCombos[0];
    for (let attempt = 0; attempt < 40; attempt++) {
      const cand = rangeCombos[Math.floor(rng() * rangeCombos.length)];
      if (!dead.has(cand[0]) && !dead.has(cand[1])) {
        vill = cand;
        break;
      }
    }
    dead.add(vill[0]);
    dead.add(vill[1]);
    const pool = DECK.filter((c) => !dead.has(c));
    for (let k = 0; k < 5; k++) {
      const j = k + Math.floor(rng() * (pool.length - k));
      const tmp = pool[k];
      pool[k] = pool[j];
      pool[j] = tmp;
    }
    const board = pool.slice(0, 5);
    const hs = evaluate7([...hero, ...board]);
    const vs = evaluate7([...vill, ...board]);
    if (hs > vs) win++;
    else if (hs === vs) tie++;
  }
  return (win + tie / 2) / ITERATIONS;
}

const tierCombos = TIERS.map((t) => {
  const n = Math.ceil(PREFLOP_ORDER.length * t);
  return PREFLOP_ORDER.slice(0, n).flatMap(combosOf);
});

const table: Record<string, number[]> = {};
let monotFixed = 0;
for (const label of PREFLOP_ORDER) {
  const hero = combosOf(label);
  const row: number[] = [];
  for (let t = 0; t < TIERS.length; t++) {
    const rng = mulberry32(hashLabel(label) + t * 0x9e3779b9);
    row.push(equityOfLabelVsRange(hero, tierCombos[t], rng));
  }
  // 单调性修整：范围越宽（越弱），hero 胜率不减
  for (let t = 1; t < row.length; t++) {
    if (row[t] < row[t - 1]) {
      monotFixed++;
      row[t] = row[t - 1];
    }
  }
  table[label] = row.map((x) => Math.round(x * 1000) / 1000);
}

// TS 字面量输出（逐牌型一行，tier 顺序注释在 range.ts 表头）
const lines = PREFLOP_ORDER.map(
  (label) => `  ${JSON.stringify(label)}: [${table[label].map((x) => x.toFixed(3)).join(", ")}],`,
);
const out = lines.join("\n");
writeFileSync("scripts/selfplay/results/preflop-vs-range-table.txt", out + "\n");

console.log(`tiers=${TIERS.join("/")} iterations=${ITERATIONS} 单调性修正格数=${monotFixed}`);
for (const probe of ["AA", "KK", "AKs", "99", "77", "JTs", "JTo", "A3o", "72o", "32o"]) {
  console.log(`${probe}: [${table[probe].map((x) => x.toFixed(3)).join(", ")}]`);
}
