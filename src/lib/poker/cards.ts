/**
 * 牌工具模块
 */
import type { Card, Rank, Suit } from "@/lib/types";

const SUITS: readonly Suit[] = ["s", "h", "d", "c"];
const RANKS: readonly Rank[] = [
  "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A",
];

const RANK_SET = new Set<string>(RANKS);
const SUIT_SET = new Set<string>(SUITS);

/**
 * 生成一副完整 52 张牌（未洗牌，顺序约定：按花色 s,h,d,c × 点数 2..A 升序）。
 */
export function newDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(`${rank}${suit}` as Card);
    }
  }
  return deck;
}

/**
 * Fisher-Yates 洗牌，返回新数组（不修改入参）。
 * @param rng 可选随机源（默认 Math.random），注入以便测试可复现。
 */
export function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * 把牌转为短码字符串。由于 Card 本身就是短码字符串，实现上等价于返回自身；
 * 保留此函数作为统一序列化入口，便于将来切换内部表示。
 */
export function cardToString(card: Card): string {
  return card;
}

/**
 * 解析并校验短码字符串为 Card。
 * 接受大小写不敏感的输入（如 "AS"、"td"、"2c"），归一化为标准短码（"As"/"Td"/"2c"）。
 * @throws Error 输入不是合法的 Rank+Suit 组合时抛出。
 */
export function parseCard(code: string): Card {
  if (typeof code !== "string" || code.length !== 2) {
    throw new Error(`invalid card code: ${String(code)}`);
  }
  const rankRaw = code[0].toUpperCase();
  const suitRaw = code[1].toLowerCase();
  const rank = rankRaw === "10" ? "T" : rankRaw;
  if (!RANK_SET.has(rank) || !SUIT_SET.has(suitRaw)) {
    throw new Error(`invalid card code: ${String(code)}`);
  }
  return `${rank}${suitRaw}` as Card;
}

/** 辅助：拆出点数与花色（实现时可导出，供 evaluator 使用） */
export function cardParts(card: Card): { rank: Rank; suit: Suit } {
  return { rank: card[0] as Rank, suit: card[1] as Suit };
}
