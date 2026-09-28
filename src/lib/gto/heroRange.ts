/**
 * src/lib/gto/heroRange.ts — 底牌与行动线一致性（scenario plausibility）
 *
 * 背景（用户实报 bug）：各出题器过去从 52 张牌里完全随机发 hero 底牌，
 * 会出现「2♥4♥ 的你却跟注了翻前加注和翻牌持续下注」这种不可能的局面——
 * 拿绝对垃圾牌的人根本不会走到行动线描述的这一步。本模块把 hero 底牌
 * 约束到「与行动线中 hero 角色一致」的范围里：先按角色过滤 169 牌型集合，
 * 均匀抽一个牌型，再展开成具体两张牌（花色随机）。
 *
 * 角色 → 范围映射（数据全部复用 ranges.ts 的矩阵/范围记号）：
 * - open（你开局加注）：按行动线中的开局位取 9 人桌开局表（UTG+1 ~20%、
 *   LJ ~23%、HJ ~28%、CO ~31%、BTN ~48% 的 raise 格）。openPos 缺省时
 *   内部随机抽一个开局位。行动线文本写哪个位就用哪张表，牌与文一致。
 * - caller（你跟注防守）：BB_DEFEND_VS_OPEN 的 call 格（对子 22-55、
 *   同花除 AJs+/KQs、杂色 A2o-AQo/K9o+/Q9o+/J9o+/T9o/98o）再剔除 9 个
 *   低点无连接同花垃圾（CALLER_TRASH_SUITED，如 42s/72s/92s）——
 *   约 41% 组合，72o/82o/92o/94o 档绝对垃圾全灭。
 * - threeBet（你 3bet）：顶端价值带 THREEBET_VALUE_NOTATION
 *   （77+/A9s+/KTs+/QTs+/JTs/AJo+/KQo，约 10.6% 组合）+ 少量同花连张 /
 *   轮子 Ax 诈唬（A2s-A5s、87s-54s），即「顶端 12% + 指定诈唬集」。
 * - bbDefend（你大盲防守跟注）：宽范围（约 57% 组合）——全部对子、
 *   全部同花（剔除同样的 9 个同花垃圾）、杂色 A2o+/K5o+/Q8o+/J8o+/T8o+/
 *   98o/87o/76o/65o，排除底部纯垃圾杂色与同花垃圾。
 *
 * 与难度过滤（trainerDifficulty.ts）的联动：底牌有范围后，「纯垃圾面对
 * 下注」在发牌层就已消失，胜率带过滤的下限（<20% 纯垃圾弃牌）大多休眠；
 * 但上限（>85% 坚果级无脑题）仍然必需——范围内的强牌照样会发出坚果，
 * 故各出题器的 isTooObvious 过滤原样保留，FILTER_MAX_ATTEMPTS 兜底不变。
 *
 * 抽样口径：在角色过滤后的 169 牌型集合上均匀抽（不按组合数加权——
 * 对子/同花/杂色牌型等概率，教学覆盖面更均匀）。牌型 → 两张牌的展开
 * （labelToCards）与公共牌补发（dealRemainingCards）都在本模块，rng 注入。
 */
import type { Card, Rank, Suit } from "@/lib/types";
import { newDeck } from "@/lib/poker/cards";
import {
  BB_DEFEND_VS_OPEN,
  expandRange,
  handLabel,
  MATRIX_RANKS,
  RANGE_TABLES,
  type RangeAction,
} from "@/lib/gto/ranges";
import { drawOpenPos, type OpenPos } from "@/lib/gto/actionLine";

/** hero 在行动线中的翻前角色（决定底牌从哪个范围抽） */
export type HeroRole = "open" | "caller" | "threeBet" | "bbDefend";

/** 低点无连接的同花垃圾：caller/bbDefend 范围共同剔除（2♥4♥ 类牌的同花形态） */
const TRASH_SUITED: readonly string[] = [
  "32s", "42s", "52s", "62s", "72s", "73s", "82s", "83s", "92s",
];

/** threeBet 价值带：顶端约 10.6% 组合（77+/A9s+/KTs+/QTs+/JTs/AJo+/KQo） */
export const THREEBET_VALUE_NOTATION = "77+,A9s+,KTs+,QTs+,JTs,AJo+,KQo";
/** threeBet 诈唬集：轮子 Ax 同花 + 小同花连张（标准 3bet 诈唬候选） */
export const THREEBET_BLUFF_NOTATION = "A2s,A3s,A4s,A5s,87s,76s,65s,54s";
/** 大盲防守跟注：宽范围（约 57% 组合），排除底部纯垃圾 */
export const BB_DEFEND_NOTATION =
  "22+,A2s+,K2s+,Q2s+,J2s+,T2s+,93s+,84s+,74s+,63s+,53s+,43s," +
  "A2o+,K5o+,Q8o+,J8o+,T8o+,98o,87o,76o,65o";

/** 开局位 → ranges.ts 9 人桌开局表 id */
const OPEN_POS_TABLE_ID: Record<OpenPos, string> = {
  "UTG+1": "utg1",
  LJ: "lj",
  HJ: "hj",
  CO: "co",
  BTN: "btn",
};

/** 从矩阵按动作过滤出 169 牌型名集合（行优先固定顺序，抽样可复现） */
function labelsFromMatrix(
  matrix: RangeAction[][],
  accept: (a: RangeAction) => boolean,
): Set<string> {
  const out = new Set<string>();
  for (let row = 0; row < MATRIX_RANKS.length; row++) {
    for (let col = 0; col < MATRIX_RANKS.length; col++) {
      if (accept(matrix[row][col])) out.add(handLabel(row, col));
    }
  }
  return out;
}

/** open 角色：各开局位的开局牌型集（模块加载时算一次） */
const OPEN_LABELS_BY_POS: Record<OpenPos, Set<string>> = (() => {
  const byId = new Map(RANGE_TABLES.map((t) => [t.id, t]));
  const out = {} as Record<OpenPos, Set<string>>;
  for (const pos of Object.keys(OPEN_POS_TABLE_ID) as OpenPos[]) {
    const table = byId.get(OPEN_POS_TABLE_ID[pos]);
    if (!table) throw new Error(`ranges.ts 缺少开局表：${OPEN_POS_TABLE_ID[pos]}`);
    out[pos] = labelsFromMatrix(table.matrix, (a) => a === "raise");
  }
  return out;
})();

/** open 角色的并集（= 最宽的 BTN 开局集；openPos 缺省时/测试用） */
const OPEN_LABELS_UNION: Set<string> = (() => {
  const out = new Set<string>();
  for (const pos of Object.keys(OPEN_LABELS_BY_POS) as OpenPos[]) {
    for (const label of OPEN_LABELS_BY_POS[pos]) out.add(label);
  }
  return out;
})();

/** caller 角色：BB 防守矩阵的 call 格，剔除低点同花垃圾 */
const CALLER_LABELS: Set<string> = (() => {
  const out = labelsFromMatrix(BB_DEFEND_VS_OPEN, (a) => a === "call");
  for (const t of TRASH_SUITED) out.delete(t);
  return out;
})();

/** threeBet 角色：顶端价值带 + 指定诈唬集 */
const THREEBET_LABELS: Set<string> = (() => {
  const out = expandRange(THREEBET_VALUE_NOTATION);
  for (const label of expandRange(THREEBET_BLUFF_NOTATION)) out.add(label);
  return out;
})();

/** bbDefend 角色：宽防守范围 */
const BB_DEFEND_LABELS: Set<string> = expandRange(BB_DEFEND_NOTATION);

/**
 * 角色 → 169 牌型集合（open 可带开局位取对应开局表；缺省/其他角色忽略 openPos）。
 * 返回的集合只读；抽样器内部会转成数组按 rng 均匀抽。
 */
export function heroRangeLabels(
  role: HeroRole,
  openPos?: OpenPos,
): ReadonlySet<string> {
  switch (role) {
    case "open":
      return openPos ? OPEN_LABELS_BY_POS[openPos] : OPEN_LABELS_UNION;
    case "caller":
      return CALLER_LABELS;
    case "threeBet":
      return THREEBET_LABELS;
    case "bbDefend":
      return BB_DEFEND_LABELS;
  }
}

const SUITS: readonly Suit[] = ["s", "h", "d", "c"];

/** rng → [0, len) 下标（越界钳到末位，防 rng()===1 的极端实现） */
function pickIdx(len: number, rng: () => number): number {
  return Math.min(len - 1, Math.floor(rng() * len));
}

/**
 * 169 牌型名 → 具体两张牌（rng 注入）：
 * - 对子（"AA"）：两个不同花色（先抽一张，另一张在剩余 3 个花色里抽）；
 * - 同花（"AKs"）：同一花色；
 * - 杂色（"AKo"）：两个不同花色。
 */
export function labelToCards(
  label: string,
  rng: () => number = Math.random,
): [Card, Card] {
  const r1 = label[0] as Rank;
  const r2 = label[1] as Rank;
  if (label.length === 2) {
    const i = pickIdx(SUITS.length, rng);
    const j = (i + 1 + pickIdx(SUITS.length - 1, rng)) % SUITS.length;
    return [`${r1}${SUITS[i]}` as Card, `${r1}${SUITS[j]}` as Card];
  }
  if (label[2] === "s") {
    const s = SUITS[pickIdx(SUITS.length, rng)];
    return [`${r1}${s}` as Card, `${r2}${s}` as Card];
  }
  const i = pickIdx(SUITS.length, rng);
  let j = pickIdx(SUITS.length - 1, rng);
  if (j >= i) j++;
  return [`${r1}${SUITS[i]}` as Card, `${r2}${SUITS[j]}` as Card];
}

export interface SampleHeroOptions {
  /**
   * open 角色专用：行动线中 hero 的开局位（牌与行动线文本对齐的关键）。
   * 缺省时内部随机抽一个开局位（等价于在全部开局表的并集上抽）。
   */
  openPos?: OpenPos;
}

/**
 * 按角色从对应范围抽 hero 底牌：角色过滤后的 169 牌型集合上均匀抽一个
 * 牌型，再展开成两张具体牌（花色随机）。
 * @param rng 随机源（默认 Math.random），注入以便测试可复现。
 */
export function sampleHeroCards(
  rng: () => number = Math.random,
  role: HeroRole,
  opts?: SampleHeroOptions,
): [Card, Card] {
  const pos = role === "open" ? (opts?.openPos ?? drawOpenPos(rng)) : undefined;
  const labels = [...heroRangeLabels(role, pos)];
  return labelToCards(labels[pickIdx(labels.length, rng)], rng);
}

/**
 * 从剩余牌堆（剔除 exclude，如 hero 底牌）发 count 张公共牌，无重复。
 * 部分 Fisher-Yates：只洗前 count 张。
 */
export function dealRemainingCards(
  rng: () => number = Math.random,
  exclude: readonly Card[],
  count: number,
): Card[] {
  const used = new Set<string>(exclude);
  const rest = newDeck().filter((c) => !used.has(c));
  if (count > rest.length) throw new Error("剩余牌不足");
  for (let k = 0; k < count; k++) {
    const j = k + pickIdx(rest.length - k, rng);
    const tmp = rest[k];
    rest[k] = rest[j];
    rest[j] = tmp;
  }
  return rest.slice(0, count);
}
