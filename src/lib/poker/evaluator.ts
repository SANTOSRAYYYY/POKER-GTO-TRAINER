/**
 * 牌力评估模块
 *
 * 评分方案约定（所有实现者必须遵守，保证跨模块可比较）：
 * - evaluate7 接受 5-7 张牌，取其中最优 5 张组合。
 * - 返回单个 number，分数越大牌越强；任意两手（同一副公共牌下）可直接用数值比较。
 * - 编码：score = category * 13^5 + Σ (rank_i - 2) * 13^(4-i)，i=0..4，
 *   其中 rank_i 为决定牌型的 5 张牌点数（2-14），从大到小排列；
 *   特殊地，A-5 轮顺（wheel）按 5 为高处理。
 * - category 取值：0 高牌 / 1 对子 / 2 两对 / 3 三条 / 4 顺子 / 5 同花 / 6 葫芦 / 7 四条 / 8 同花顺。
 */
import type { Card, RankValue } from "@/lib/types";
import { cardParts } from "@/lib/poker/cards";

const BASE = 13;
const CATEGORY_WEIGHT = BASE ** 5;

const RANK_VALUES: Record<string, RankValue> = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7,
  "8": 8, "9": 9, T: 10, J: 11, Q: 12, K: 13, A: 14,
};

const CATEGORY_NAMES = [
  "高牌",
  "一对",
  "两对",
  "三条",
  "顺子",
  "同花",
  "葫芦",
  "四条",
  "同花顺",
] as const;

interface RankCount {
  value: RankValue;
  count: number;
}

function encodeScore(category: number, ranks: number[]): number {
  let score = category * CATEGORY_WEIGHT;
  for (let i = 0; i < 5; i++) {
    score += (ranks[i] - 2) * BASE ** (4 - i);
  }
  return score;
}

/** 评估恰好 5 张牌，返回 { category, ranks, score }。 */
function evaluate5(cards: Card[]): { category: number; score: number } {
  const values: RankValue[] = [];
  const suits: string[] = [];
  const countByValue = new Map<RankValue, number>();
  for (const c of cards) {
    const { rank, suit } = cardParts(c);
    const v = RANK_VALUES[rank];
    values.push(v);
    suits.push(suit);
    countByValue.set(v, (countByValue.get(v) ?? 0) + 1);
  }

  const flush = suits.every((s) => s === suits[0]);

  const groups: RankCount[] = [...countByValue.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || b.value - a.value);

  const unique = [...countByValue.keys()].sort((a, b) => b - a);

  // 顺子判定：5 张点数互不重复且 max-min === 4；wheel（A,5,4,3,2）按 5 高。
  let straightHigh: RankValue | null = null;
  if (unique.length === 5) {
    if (unique[0] - unique[4] === 4) {
      straightHigh = unique[0];
    } else if (
      unique[0] === 14 && unique[1] === 5 && unique[2] === 4 &&
      unique[3] === 3 && unique[4] === 2
    ) {
      straightHigh = 5;
    }
  }

  if (flush && straightHigh !== null) {
    return { category: 8, score: encodeScore(8, [straightHigh, 0, 0, 0, 0]) };
  }
  if (groups[0].count === 4) {
    return {
      category: 7,
      score: encodeScore(7, [
        groups[0].value, groups[0].value, groups[0].value, groups[0].value,
        groups[1].value,
      ]),
    };
  }
  if (groups[0].count === 3 && groups[1].count === 2) {
    return {
      category: 6,
      score: encodeScore(6, [
        groups[0].value, groups[0].value, groups[0].value,
        groups[1].value, groups[1].value,
      ]),
    };
  }
  if (flush) {
    const ranks = unique;
    return {
      category: 5,
      score: encodeScore(5, [ranks[0], ranks[1], ranks[2], ranks[3], ranks[4]]),
    };
  }
  if (straightHigh !== null) {
    return { category: 4, score: encodeScore(4, [straightHigh, 0, 0, 0, 0]) };
  }
  if (groups[0].count === 3) {
    const kickers = groups.slice(1).map((g) => g.value);
    return {
      category: 3,
      score: encodeScore(3, [
        groups[0].value, groups[0].value, groups[0].value,
        kickers[0], kickers[1],
      ]),
    };
  }
  if (groups[0].count === 2 && groups[1].count === 2) {
    // groups 同 count 时已按点数降序，groups[0] 是大对子
    return {
      category: 2,
      score: encodeScore(2, [
        groups[0].value, groups[0].value,
        groups[1].value, groups[1].value,
        groups[2].value,
      ]),
    };
  }
  if (groups[0].count === 2) {
    const kickers = groups.slice(1).map((g) => g.value);
    return {
      category: 1,
      score: encodeScore(1, [
        groups[0].value, groups[0].value, kickers[0], kickers[1], kickers[2],
      ]),
    };
  }
  return {
    category: 0,
    score: encodeScore(0, [unique[0], unique[1], unique[2], unique[3], unique[4]]),
  };
}

function assertValidCards(cards: Card[]): void {
  if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7) {
    throw new Error(`evaluate7 需要 5-7 张牌，实际收到 ${cards?.length}`);
  }
  const seen = new Set<string>();
  for (const c of cards) {
    if (seen.has(c)) {
      throw new Error(`重复牌: ${c}`);
    }
    seen.add(c);
  }
}

/**
 * 评估 5-7 张牌的最优牌型分数（越大越强，见顶部编码约定）。
 * @throws Error 张数不在 5-7 范围内或有重复牌。
 */
export function evaluate7(cards: Card[]): number {
  assertValidCards(cards);
  const n = cards.length;
  let best = -1;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const score = evaluate5([
              cards[a], cards[b], cards[c], cards[d], cards[e],
            ]).score;
            if (score > best) best = score;
          }
  return best;
}

/** 返回 5-7 张牌最优牌型的 category（0-8），内部用于 handName。 */
function bestCategory(cards: Card[]): number {
  assertValidCards(cards);
  const n = cards.length;
  let best = -1;
  let bestCategoryValue = 0;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const { category, score } = evaluate5([
              cards[a], cards[b], cards[c], cards[d], cards[e],
            ]);
            if (score > best) {
              best = score;
              bestCategoryValue = category;
            }
          }
  return bestCategoryValue;
}

/**
 * 在给定公共牌 board 下比较两手牌：
 * a 强于 b 返回 1，b 强于 a 返回 -1，平局返回 0。
 * board 为 3-5 张；a、b 各 2 张底牌（evaluate7(a + board) vs evaluate7(b + board)）。
 */
export function compareHands(a: Card[], b: Card[], board: Card[]): -1 | 0 | 1 {
  const sa = evaluate7([...a, ...board]);
  const sb = evaluate7([...b, ...board]);
  return sa > sb ? 1 : sa < sb ? -1 : 0;
}

/**
 * 返回 5-7 张牌最优牌型的中文名称，
 * 如 "同花顺" / "四条" / "葫芦" / "同花" / "顺子" / "三条" / "两对" / "一对" / "高牌"。
 */
export function handName(cards: Card[]): string {
  return CATEGORY_NAMES[bestCategory(cards)];
}
