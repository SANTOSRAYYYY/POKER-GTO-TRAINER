/**
 * src/lib/gto/turnQuiz.ts — 转牌圈出题器（turn 场景）
 *
 * 出题：随机发 hero 两张底牌 + 4 张公共牌（无重复），子题型二选一：
 * - barrel（连开第二枪）：翻前你是进攻方，翻牌圈你的持续下注被跟注，
 *   转牌轮到你——继续进攻还是过牌放弃？
 * - defense（面对第二枪）：你跟注了对手翻牌圈的持续下注，对手转牌
 *   再开第二枪（半池）——加注/跟注/弃牌？
 *
 * 判定口径（全部对范围实算，不用对随机胜率）：
 * - barrel：对手是「跟注者」，其范围比下注者更紧——equityVsRange
 *   （TURN_CALLER_RANGE_SPEC：前 45% 强度 + 10% 诈唬混入）：
 *     ≥ 55% → aggressive（第二枪）；
 *     35-55% 且强听牌（复用 postflopQuiz 的 analyzeDraws/isStrongDraw）
 *       → aggressive（半诈唬第二枪）；
 *     否则 → passive（过牌放弃）。
 * - defense：对手转牌再下注，范围比翻牌圈下注者更紧（翻牌防守口径
 *   topPct 0.6 → 0.45，诈唬混入不变 15%）：
 *     ≥ 68% → aggressive（价值加注）；
 *     ≥ 30% → passive（跟注：比翻牌圈 28% 略紧——转牌底池更大、
 *       河牌实现权益更差）；
 *     < 30% → fold。
 */
import type { Card } from "@/lib/types";
import { newDeck } from "@/lib/poker/cards";
import { equityMulti, type EquityResult } from "@/lib/poker/equity";
import { equityVsRange } from "@/lib/ai/range";
import {
  analyzeDraws,
  isStrongDraw,
  QUIZ_ITERATIONS,
  type DrawInfo,
  type PostflopChoice,
} from "@/lib/gto/postflopQuiz";

/** 子题型：barrel = 连开第二枪 / defense = 面对第二枪 */
export type TurnScenarioType = "barrel" | "defense";

export interface TurnScenario {
  hero: [Card, Card];
  board: [Card, Card, Card, Card];
  type: TurnScenarioType;
}

export interface TurnQuiz extends TurnScenario {
  /** 对 1 名随机对手的实算胜率（展示用） */
  equity: EquityResult;
  /** 判定胜率（对跟注者/第二枪下注者范围，0-1） */
  rangeEquity: number;
  /** 听牌分析（第二枪题的半诈唬判定用） */
  draws: DrawInfo;
  /** 由范围胜率与子题型推导的标准答案 */
  answer: PostflopChoice;
}

/** 第二枪进攻线：对跟注者范围胜率 ≥ 55% */
export const TURN_BARREL_EQUITY_THRESHOLD = 0.55;
/** 半诈唬下限：35-55% 且强听牌 → 半诈唬第二枪 */
export const TURN_BARREL_SEMIBLUFF_MIN = 0.35;
/** 面对第二枪加注线：对下注者范围胜率 ≥ 68% */
export const TURN_DEFENSE_RAISE_THRESHOLD = 0.68;
/** 面对第二枪跟注线：≥ 30%（比翻牌圈 28% 略紧：池更大、河牌实现更差） */
export const TURN_DEFENSE_CALL_THRESHOLD = 0.3;
/** 第二枪判定用——翻牌圈跟注者隐含范围：前 45% 强度 + 10% 诈唬混入（比下注者紧） */
export const TURN_CALLER_RANGE_SPEC = { topPct: 0.45, bluffPct: 0.1 } as const;
/** 面对第二枪判定用——转牌再下注者隐含范围：同翻牌防守口径但 topPct 0.45（更紧） */
export const TURN_BETTOR_RANGE_SPEC = { topPct: 0.45, bluffPct: 0.15 } as const;

/**
 * 随机发一个转牌圈场景：hero 2 张 + 公共牌 4 张，无重复，子题型随机。
 * @param rng 随机源（默认 Math.random），注入以便测试可复现。
 */
export function dealTurnScenario(
  rng: () => number = Math.random,
): TurnScenario {
  const deck = newDeck();
  // 部分 Fisher-Yates：洗前 6 张即可
  for (let k = 0; k < 6; k++) {
    const j = k + Math.floor(rng() * (deck.length - k));
    const tmp = deck[k];
    deck[k] = deck[j];
    deck[j] = tmp;
  }
  return {
    hero: [deck[0], deck[1]],
    board: [deck[2], deck[3], deck[4], deck[5]],
    type: rng() < 0.5 ? "barrel" : "defense",
  };
}

/** 范围胜率 + 子题型 → 标准答案（纯函数）。rangeWin 为对相应隐含范围的胜率 */
export function judgeTurn(
  rangeWin: number,
  type: TurnScenarioType,
  draws?: DrawInfo,
): PostflopChoice {
  if (type === "defense") {
    if (rangeWin >= TURN_DEFENSE_RAISE_THRESHOLD) return "aggressive";
    if (rangeWin >= TURN_DEFENSE_CALL_THRESHOLD) return "passive";
    return "fold";
  }
  if (rangeWin >= TURN_BARREL_EQUITY_THRESHOLD) return "aggressive";
  // 35-55% 且强听牌（同花听 / 顺子出路 ≥8）= 标准半诈唬第二枪：
  // 对手弃牌直接收池，被跟也有大量补牌
  if (rangeWin >= TURN_BARREL_SEMIBLUFF_MIN && draws && isStrongDraw(draws)) {
    return "aggressive";
  }
  return "passive";
}

/** 出一道完整的转牌圈题（同步，约几十 ms，调用方负责异步化） */
export function generateTurnQuiz(
  rng: () => number = Math.random,
  iterations: number = QUIZ_ITERATIONS,
): TurnQuiz {
  const scenario = dealTurnScenario(rng);
  const equity = equityMulti([...scenario.hero], [...scenario.board], 1, iterations);
  const spec =
    scenario.type === "barrel" ? TURN_CALLER_RANGE_SPEC : TURN_BETTOR_RANGE_SPEC;
  const rangeEquity = equityVsRange(
    scenario.hero,
    scenario.board,
    spec,
    iterations,
    rng,
  );
  const draws = analyzeDraws(scenario.hero, scenario.board);
  return {
    ...scenario,
    equity,
    rangeEquity,
    draws,
    answer: judgeTurn(rangeEquity, scenario.type, draws),
  };
}

/** 判定后的一句话简评（中文库内版；页面组件走字典双语同逻辑） */
export function turnQuizComment(quiz: TurnQuiz): string {
  const pct = (quiz.rangeEquity * 100).toFixed(1);
  const tie =
    quiz.equity.tie >= 0.005
      ? `（另平局 ${(quiz.equity.tie * 100).toFixed(1)}%）`
      : "";
  switch (quiz.answer) {
    case "aggressive":
      if (quiz.type === "barrel") {
        if (
          quiz.rangeEquity < TURN_BARREL_EQUITY_THRESHOLD &&
          isStrongDraw(quiz.draws)
        ) {
          const parts: string[] = [];
          if (quiz.draws.straightOuts >= 8)
            parts.push(`顺子听 ${quiz.draws.straightOuts} 张出路`);
          if (quiz.draws.flushDraw) parts.push("同花听");
          return `对跟注者范围（前 45%）实算胜率 ${pct}%${tie}，${parts.join(" + ")}——标准半诈唬第二枪：对手弃牌直接收池，被跟也有大量补牌`;
        }
        return `对跟注者范围（前 45%）实算胜率 ${pct}%${tie}，越过 55% 第二枪线——继续进攻拿价值、别给免费河牌`;
      }
      return `对第二枪范围（前 45%）实算胜率 ${pct}%${tie}，超过 68% 加注线——价值加注榨取，别给便宜看河牌`;
    case "fold":
      return `对第二枪范围（前 45%）实算胜率 ${pct}%${tie}，不足 30%——对手转牌还下注范围更紧，半池注赔率也够不上，弃牌`;
    case "passive":
      return quiz.type === "barrel"
        ? `对跟注者范围（前 45%）实算胜率 ${pct}%${tie}，不足 35% 或无强听牌——过牌放弃：能跟翻牌下注的范围不弱，弱牌别再造池`
        : `对第二枪范围（前 45%）实算胜率 ${pct}%${tie}，够 30% 跟注线但不够 68% 加注线——跟注看河牌，加注只会打走差的留下强的`;
  }
}
