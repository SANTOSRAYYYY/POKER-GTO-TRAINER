/**
 * src/lib/gto/riverQuiz.ts — 河牌圈出题器（river 场景）
 *
 * 出题：随机发 hero 两张底牌 + 5 张公共牌（无重复），子题型三选一（随机）：
 * - value（薄价值 or 过牌）：你最后行动、无人下注——下注拿价值还是过牌比牌？
 * - bluffcatch（抓诈 or 弃牌）：对手下注一个满池——跟注抓诈还是弃牌？
 * - bluff（诈唬 or 放弃）：你的听牌全没中、无人下注——诈唬偷池还是过牌放弃？
 *
 * 判定口径（全部实算）：
 * - 河牌公共牌已齐，vs 随机胜率可精确枚举：riverEquityExact 遍历剩余
 *   45 张牌的全部 C(45,2)=990 个对手组合，evaluate7 逐个比大小，无蒙特卡洛
 *   误差（确定性结果，答题判定与测试都稳定）。
 * - value：equityVsRange（对手 = 跟注范围 RIVER_VALUE_CALLER_SPEC：前 50%
 *   强度 + 5% 诈唬混入）≥ 60% → aggressive（价值下注）；45-60% → passive
 *   （薄价值不够薄别贪：下注多半只被更强的牌跟）；< 45% → passive（过牌）。
 * - bluffcatch：equityVsRange（对手 = 极化范围 RIVER_BLUFFCATCH_POLAR_SPEC：
 *   前 25% 强牌 + 35% 诈唬混入）≥ 33% → passive（跟注抓诈：满池注跟 1 池
 *   赢 3 池，保本胜率 33%）；否则 → fold。
 * - bluff：精确胜率 < 25% → aggressive（诈唬：毫无摊牌价值，过牌=认输，
 *   唯有下注能赢）；25-45% → passive（弱牌有摊牌价值别诈唬：诈唬只会打走
 *   更弱的、被更强的跟）；≥ 45% → aggressive（牌力领先，价值下注）。
 *
 * 「摊牌价值」（showdown value）：弱成牌（如小对子）过牌有机会在摊牌赢下
 * 更弱的牌，但一旦下注，更弱的牌会弃、更强的牌会跟——下注反而把赢面打没。
 * 所以河牌极化：强牌与纯空气下注，中间牌过牌。
 */
import type { Card } from "@/lib/types";
import { newDeck } from "@/lib/poker/cards";
import { evaluate7 } from "@/lib/poker/evaluator";
import type { EquityResult } from "@/lib/poker/equity";
import { equityVsRange } from "@/lib/ai/range";
import { QUIZ_ITERATIONS, type PostflopChoice } from "@/lib/gto/postflopQuiz";

/** 子题型：value = 薄价值 / bluffcatch = 抓诈 / bluff = 诈唬 */
export type RiverScenarioType = "value" | "bluffcatch" | "bluff";

export interface RiverScenario {
  hero: [Card, Card];
  board: [Card, Card, Card, Card, Card];
  type: RiverScenarioType;
}

export interface RiverQuiz extends RiverScenario {
  /** vs 随机对手的精确枚举胜率（展示用；bluff 题的判定胜率） */
  equity: EquityResult;
  /** 判定胜率（value/bluffcatch 题对相应隐含范围；bluff 题为 null） */
  rangeEquity: number | null;
  /** 由胜率与子题型推导的标准答案 */
  answer: PostflopChoice;
}

/** 价值下注线：对跟注范围胜率 ≥ 60% */
export const RIVER_VALUE_BET_THRESHOLD = 0.6;
/** 薄价值带下沿：45-60% 过牌（点评区分「薄价值不够」与「太弱」的分界） */
export const RIVER_THIN_VALUE_MIN = 0.45;
/** 价值题判定用——河牌跟注者隐含范围：前 50% 强度 + 5% 诈唬混入 */
export const RIVER_VALUE_CALLER_SPEC = { topPct: 0.5, bluffPct: 0.05 } as const;
/** 抓诈跟注线：对极化范围胜率 ≥ 33%（满池注赔率：跟 1 池赢 3 池） */
export const RIVER_BLUFFCATCH_CALL_THRESHOLD = 0.33;
/** 抓诈题判定用——满池下注者极化范围：前 25% 强牌 + 35% 诈唬混入 */
export const RIVER_BLUFFCATCH_POLAR_SPEC = { topPct: 0.25, bluffPct: 0.35 } as const;
/** 诈唬上限：精确胜率 < 25%（无摊牌价值）才诈唬 */
export const RIVER_BLUFF_MAX_EQUITY = 0.25;
/** 摊牌价值带上限：25-45% 过牌；≥ 45% 价值下注 */
export const RIVER_SHOWDOWN_VALUE_MAX = 0.45;

/**
 * 随机发一个河牌圈场景：hero 2 张 + 公共牌 5 张，无重复，子题型三等分随机。
 * @param rng 随机源（默认 Math.random），注入以便测试可复现。
 */
export function dealRiverScenario(
  rng: () => number = Math.random,
): RiverScenario {
  const deck = newDeck();
  // 部分 Fisher-Yates：洗前 7 张即可
  for (let k = 0; k < 7; k++) {
    const j = k + Math.floor(rng() * (deck.length - k));
    const tmp = deck[k];
    deck[k] = deck[j];
    deck[j] = tmp;
  }
  const t = rng();
  return {
    hero: [deck[0], deck[1]],
    board: [deck[2], deck[3], deck[4], deck[5], deck[6]],
    type: t < 1 / 3 ? "value" : t < 2 / 3 ? "bluffcatch" : "bluff",
  };
}

/**
 * 河牌 vs 随机对手的精确胜率：公共牌已齐，枚举剩余牌的全部对手底牌组合
 * （C(45,2)=990），evaluate7 逐个比大小。返回 win/tie/lose（0-1，和为 1）。
 */
export function riverEquityExact(
  hero: [Card, Card],
  board: Card[],
): EquityResult {
  if (board.length !== 5) throw new Error("riverEquityExact 需要 5 张公共牌");
  const dead = new Set<string>([...hero, ...board]);
  if (dead.size !== 7) throw new Error("存在重复牌");
  const cards = newDeck().filter((c) => !dead.has(c));
  const heroScore = evaluate7([...hero, ...board]);
  let win = 0;
  let tie = 0;
  let lose = 0;
  for (let i = 0; i < cards.length - 1; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const s = evaluate7([cards[i], cards[j], ...board]);
      if (heroScore > s) win++;
      else if (heroScore === s) tie++;
      else lose++;
    }
  }
  const n = (cards.length * (cards.length - 1)) / 2;
  return { win: win / n, tie: tie / n, lose: lose / n };
}

/**
 * 胜率 + 子题型 → 标准答案（纯函数）。
 * value/bluffcatch 请传对相应范围的胜率 rangeWin；bluff 用 vs 随机精确胜率 win。
 */
export function judgeRiver(
  win: number,
  type: RiverScenarioType,
  rangeWin?: number,
): PostflopChoice {
  if (type === "value") {
    return (rangeWin ?? win) >= RIVER_VALUE_BET_THRESHOLD
      ? "aggressive"
      : "passive";
  }
  if (type === "bluffcatch") {
    return (rangeWin ?? win) >= RIVER_BLUFFCATCH_CALL_THRESHOLD
      ? "passive"
      : "fold";
  }
  // bluff：极化策略——纯空气诈唬、中间（有摊牌价值）过牌、强牌价值下注
  if (win < RIVER_BLUFF_MAX_EQUITY) return "aggressive";
  if (win < RIVER_SHOWDOWN_VALUE_MAX) return "passive";
  return "aggressive";
}

/** 出一道完整的河牌圈题（精确枚举 + 范围蒙特卡洛，约几十 ms，调用方负责异步化） */
export function generateRiverQuiz(
  rng: () => number = Math.random,
  iterations: number = QUIZ_ITERATIONS,
): RiverQuiz {
  const scenario = dealRiverScenario(rng);
  const equity = riverEquityExact(scenario.hero, scenario.board);
  const rangeEquity =
    scenario.type === "value"
      ? equityVsRange(scenario.hero, scenario.board, RIVER_VALUE_CALLER_SPEC, iterations, rng)
      : scenario.type === "bluffcatch"
        ? equityVsRange(scenario.hero, scenario.board, RIVER_BLUFFCATCH_POLAR_SPEC, iterations, rng)
        : null;
  return {
    ...scenario,
    equity,
    rangeEquity,
    answer: judgeRiver(equity.win, scenario.type, rangeEquity ?? undefined),
  };
}

/** 判定后的一句话简评（中文库内版；页面组件走字典双语同逻辑） */
export function riverQuizComment(quiz: RiverQuiz): string {
  const pct = (quiz.equity.win * 100).toFixed(1);
  const rPct =
    quiz.rangeEquity !== null ? (quiz.rangeEquity * 100).toFixed(1) : null;
  const tie =
    quiz.equity.tie >= 0.005
      ? `（另平局 ${(quiz.equity.tie * 100).toFixed(1)}%）`
      : "";
  switch (quiz.answer) {
    case "aggressive":
      if (quiz.type === "value") {
        return `对跟注范围（前 50%）实算胜率 ${rPct}%${tie}，越过 60% 价值线——下注拿价值：更差的牌会跟注，别浪费最后一条街`;
      }
      if (quiz.type === "bluff" && quiz.equity.win < RIVER_BLUFF_MAX_EQUITY) {
        return `精确胜率 ${pct}%${tie}，不足 25%——听牌全没中、毫无摊牌价值，过牌等于认输；唯有诈唬下注能赢这个池（河牌极化策略：强牌与纯空气下注，中间牌过牌）`;
      }
      return `精确胜率 ${pct}%${tie}，超过 45%——牌力明显领先随机手，主动下注拿价值（这是价值不是诈唬）`;
    case "fold":
      return `对极化范围（前 25% 强牌 + 35% 诈唬）实算胜率 ${rPct}%${tie}，不足 33%——满池注需 33% 胜率保本，你连对方的诈唬组合都压不过，弃牌`;
    case "passive":
      if (quiz.type === "value") {
        return (quiz.rangeEquity ?? 0) >= RIVER_THIN_VALUE_MIN
          ? `对跟注范围（前 50%）实算胜率 ${rPct}%${tie}，在 45-60% 之间——薄价值不够薄别贪：下注多半只被更强的牌跟；过牌利用摊牌价值免费比牌`
          : `对跟注范围（前 50%）实算胜率 ${rPct}%${tie}，不足 45%——下注等于诈唬而非价值；有摊牌价值的牌过牌比牌`;
      }
      if (quiz.type === "bluffcatch") {
        return `对极化范围（前 25% 强牌 + 35% 诈唬）实算胜率 ${rPct}%${tie}，越过 33% 满池赔率线——跟注抓诈：对方的诈唬组合足够多，满池注只需三分之一胜率`;
      }
      return `精确胜率 ${pct}%${tie}，在 25-45% 之间——弱牌有摊牌价值：过牌有机会赢下更弱的牌；诈唬只会打走更弱的、被更强的跟注，把赢面打没`;
  }
}
