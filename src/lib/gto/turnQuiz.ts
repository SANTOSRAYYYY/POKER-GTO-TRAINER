/**
 * src/lib/gto/turnQuiz.ts — 转牌圈出题器（turn 场景）
 *
 * 出题：按行动线的 hero 角色从对应范围抽底牌（sampleHeroCards，见
 * heroRange.ts 的「底牌与行动线一致性」设计）+ 从剩余牌发 4 张公共牌
 * （无重复），子题型二选一，并随机抽一条完整前文行动线（drawTurnLine，
 * rng 注入）：
 * - barrel（连开第二枪）：翻前你是进攻方（open = 开局加注 / threeBet =
 *   你 3bet），翻牌圈你的持续下注被跟注，转牌轮到你——继续进攻还是
 *   过牌放弃？
 * - defense（面对第二枪）：你跟注了对手翻牌圈的持续下注，对手转牌
 *   再开第二枪——加注/跟注/弃牌？行动线两种：
 *   - open：对手「翻前开局 + 翻牌 c-bet + 转牌第二枪」→ 范围前 45%；
 *   - threeBet：对手「翻前 3bet 方」连开两枪 → 范围收紧到前 30%。
 *
 * hero 角色映射（heroRoleForTurn）：barrel-open / defense-threeBet 线里
 * hero 是开局方 → open；barrel-threeBet 线里 hero 是大盲 3bet 方 →
 * threeBet；defense-open 线里 hero 是大盲跟注方 → bbDefend。
 *
 * 判定口径（全部对范围实算，不用对随机胜率）：
 * - barrel：对手是「跟注者」，其范围比下注者更紧——equityVsRange
 *   （TURN_CALLER_RANGE_SPEC：前 45% 强度 + 10% 诈唬混入）：
 *     ≥ 55% → aggressive（第二枪）；
 *     35-55% 且强听牌（复用 postflopQuiz 的 analyzeDraws/isStrongDraw）
 *       → aggressive（半诈唬第二枪）；
 *     否则 → passive（过牌放弃）。
 * - defense：对手转牌再下注，范围比翻牌圈下注者更紧（turnRangeSpecFor：
 *   open 线 topPct 0.45 / threeBet 线 0.3，诈唬混入不变 15%）：
 *     ≥ 68% → aggressive（价值加注）；
 *     ≥ 30% → passive（跟注：比翻牌圈 28% 略紧——转牌底池更大、
 *       河牌实现权益更差）；
 *     < 30% → fold。
 *
 * 难度过滤（isTooObvious，见 trainerDifficulty.ts）：判定胜率 <20%
 * （纯垃圾弃牌）或 >85%（坚果级）的防守题、>85% 或 <25% 且无强听牌
 * 的第二枪题 → 重发，10 次上限兜底。底牌有范围后下限大多休眠，
 * >85% 坚果级过滤仍必需（强范围照样发坚果）。
 */
import type { Card } from "@/lib/types";
import { equityMulti, type EquityResult } from "@/lib/poker/equity";
import { equityVsRange, type RangeSpec } from "@/lib/ai/range";
import {
  drawBetSize,
  drawOpenPos,
  threeBetToText,
  type LocalizedText,
  type OpenPos,
} from "@/lib/gto/actionLine";
import {
  dealRemainingCards,
  sampleHeroCards,
  type HeroRole,
} from "@/lib/gto/heroRange";
import {
  FILTER_MAX_ATTEMPTS,
  isDefenseLikeObvious,
  isOffenseLikeObvious,
} from "@/lib/gto/trainerDifficulty";
import {
  analyzeDraws,
  isStrongDraw,
  QUIZ_ITERATIONS,
  type DrawInfo,
  type PostflopChoice,
} from "@/lib/gto/postflopQuiz";

/** 子题型：barrel = 连开第二枪 / defense = 面对第二枪 */
export type TurnScenarioType = "barrel" | "defense";

/**
 * 行动线种类：
 * - open：常规开局池（barrel：hero 开局；defense：对手开局）；
 * - threeBet：3bet 池（barrel：hero 翻前 3bet 后 c-bet；defense：对手
 *   翻前 3bet 后连开两枪，下注者范围更紧）。
 */
export type TurnLineKind = "open" | "threeBet";

export interface TurnScenario {
  hero: [Card, Card];
  board: [Card, Card, Card, Card];
  type: TurnScenarioType;
  /** 本题的前文行动线（双语多行，页面渲染用） */
  actionLine: LocalizedText[];
  /** 行动线种类（驱动防守题范围收窄与文案） */
  lineKind: TurnLineKind;
  /** 行动线中的开局位（hero 开局线 = hero 位置；底牌范围对齐用） */
  openPos: OpenPos;
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
/** 面对第二枪判定用——转牌再下注者隐含范围（常规开局池）：前 45% + 15% 诈唬混入 */
export const TURN_BETTOR_RANGE_SPEC = { topPct: 0.45, bluffPct: 0.15 } as const;
/** 面对第二枪判定用——对手为翻前 3bet 方连开两枪：收紧到前 30% + 15% 诈唬混入 */
export const TURN_BETTOR_3BET_RANGE_SPEC = { topPct: 0.3, bluffPct: 0.15 } as const;

/**
 * 范围随行动线收窄：
 * - barrel：对手是翻牌圈跟注者 → TURN_CALLER_RANGE_SPEC（前 45%，两种线相同）；
 * - defense + open：对手「翻前开局 + 翻牌 c-bet + 转牌第二枪」→ 前 45%；
 * - defense + threeBet：对手「翻前 3bet 方」连开两枪 → TURN_BETTOR_3BET_RANGE_SPEC（前 30%）。
 */
export function turnRangeSpecFor(
  type: TurnScenarioType,
  lineKind: TurnLineKind,
): RangeSpec {
  if (type === "barrel") return TURN_CALLER_RANGE_SPEC;
  return lineKind === "threeBet"
    ? TURN_BETTOR_3BET_RANGE_SPEC
    : TURN_BETTOR_RANGE_SPEC;
}

/** 随机抽一条转牌圈行动线（rng 注入可复现）：两个子题型各 2 种真实常见路线；返回开局位供底牌范围对齐 */
export function drawTurnLine(
  type: TurnScenarioType,
  rng: () => number = Math.random,
): { kind: TurnLineKind; lines: LocalizedText[]; pos: OpenPos } {
  const pos = drawOpenPos(rng);
  const size = drawBetSize(rng);
  const kind: TurnLineKind = rng() < 0.5 ? "open" : "threeBet";
  if (type === "barrel") {
    if (kind === "open") {
      return {
        kind,
        pos,
        lines: [
          {
            zh: `翻前：你（${pos}）开局加注到 2.5bb，大盲跟注`,
            en: `Preflop: you (${pos}) open-raise to 2.5bb and the big blind calls`,
          },
          {
            zh: `翻牌圈：对手过牌，你持续下注 ${size.zh}，对手跟注`,
            en: `Flop: the big blind checks, you c-bet ${size.en}, and they call`,
          },
          {
            zh: "转牌圈：对手过牌，轮到你",
            en: "Turn: the big blind checks again — action on you",
          },
        ],
      };
    }
    return {
      kind,
      pos,
      lines: [
        {
          zh: `翻前：对手（${pos}）开局加注到 2.5bb，你（大盲）3bet 到 ${threeBetToText().zh}，对手跟注`,
          en: `Preflop: the ${pos} opens to 2.5bb; you (big blind) 3-bet to ${threeBetToText().en} and they call`,
        },
        {
          zh: `翻牌圈：你持续下注 ${size.zh}，对手跟注`,
          en: `Flop: you continuation-bet ${size.en} and the opener calls`,
        },
        {
          zh: "转牌圈：轮到你行动",
          en: "Turn: action on you",
        },
      ],
    };
  }
  if (kind === "open") {
    return {
      kind,
      pos,
      lines: [
        {
          zh: `翻前：对手（${pos}）开局加注到 2.5bb，你（大盲）跟注`,
          en: `Preflop: the ${pos} open-raises to 2.5bb and you (big blind) call`,
        },
        {
          zh: `翻牌圈：你过牌，对手持续下注 ${size.zh}，你跟注`,
          en: `Flop: you check, the opener c-bets ${size.en}, and you call`,
        },
        {
          zh: `转牌圈：你过牌，对手再开第二枪 ${size.zh}`,
          en: `Turn: you check and the opener fires a second barrel (${size.en})`,
        },
      ],
    };
  }
  return {
    kind,
    pos,
    lines: [
      {
        zh: `翻前：你（${pos}）开局加注到 2.5bb，大盲 3bet 到 ${threeBetToText().zh}，你跟注`,
        en: `Preflop: you (${pos}) open-raise to 2.5bb; the big blind 3-bets to ${threeBetToText().en} and you call`,
      },
      {
        zh: `翻牌圈：对手持续下注 ${size.zh}，你跟注`,
        en: `Flop: the 3-bettor continuation-bets ${size.en} and you call`,
      },
      {
        zh: `转牌圈：对手再开第二枪 ${size.zh}`,
        en: `Turn: the 3-bettor fires a second barrel (${size.en})`,
      },
    ],
  };
}

/**
 * 转牌圈行动线里的 hero 翻前角色（驱动底牌范围，见 heroRange.ts）：
 * - barrel-open：你开局大盲跟注 → open；
 * - barrel-threeBet：你（大盲）3bet 对手开局 → threeBet；
 * - defense-open：对手开局你（大盲）跟注 → bbDefend；
 * - defense-threeBet：你开局后跟注大盲的 3bet → open。
 */
export function heroRoleForTurn(
  type: TurnScenarioType,
  lineKind: TurnLineKind,
): HeroRole {
  if (type === "barrel") return lineKind === "threeBet" ? "threeBet" : "open";
  return lineKind === "threeBet" ? "open" : "bbDefend";
}

/**
 * 随机发一个转牌圈场景：先抽子题型与行动线，再按行动线的 hero 角色
 * （heroRoleForTurn）从对应范围抽底牌，最后从剩余牌发 4 张公共牌
 * （无重复）。防守题的行动线决定下注者范围松紧。
 * @param rng 随机源（默认 Math.random），注入以便测试可复现。
 */
export function dealTurnScenario(
  rng: () => number = Math.random,
): TurnScenario {
  const type: TurnScenarioType = rng() < 0.5 ? "barrel" : "defense";
  const line = drawTurnLine(type, rng);
  const role = heroRoleForTurn(type, line.kind);
  const hero = sampleHeroCards(rng, role, {
    openPos: role === "open" ? line.pos : undefined,
  });
  const board = dealRemainingCards(rng, hero, 4) as [Card, Card, Card, Card];
  return {
    hero,
    board,
    type,
    actionLine: line.lines,
    lineKind: line.kind,
    openPos: line.pos,
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

/**
 * 难度过滤（反脑残，纯函数）：rangeWin 传判定胜率（对跟注者/第二枪下注者范围）。
 * - defense：<20%（纯垃圾弃牌）或 >85%（坚果级无脑加注/跟注）→ 重发；
 * - barrel：>85%（无脑价值第二枪）或 <25% 且无强听牌（纯空气过牌）→ 重发。
 */
export function isTooObvious(
  rangeWin: number,
  type: TurnScenarioType,
  draws?: DrawInfo,
): boolean {
  if (type === "defense") return isDefenseLikeObvious(rangeWin);
  return isOffenseLikeObvious(rangeWin, !!draws && isStrongDraw(draws));
}

/**
 * 出一道完整的转牌圈题（同步，约几十 ms，调用方负责异步化）。
 * 显而易见的情形（isTooObvious）重发，FILTER_MAX_ATTEMPTS 次上限兜底。
 */
export function generateTurnQuiz(
  rng: () => number = Math.random,
  iterations: number = QUIZ_ITERATIONS,
): TurnQuiz {
  for (let attempt = 0; ; attempt++) {
    const scenario = dealTurnScenario(rng);
    const equity = equityMulti([...scenario.hero], [...scenario.board], 1, iterations);
    const spec = turnRangeSpecFor(scenario.type, scenario.lineKind);
    const rangeEquity = equityVsRange(
      scenario.hero,
      scenario.board,
      spec,
      iterations,
      rng,
    );
    const draws = analyzeDraws(scenario.hero, scenario.board);
    const answer = judgeTurn(rangeEquity, scenario.type, draws);
    if (
      attempt + 1 < FILTER_MAX_ATTEMPTS &&
      isTooObvious(rangeEquity, scenario.type, draws)
    ) {
      continue; // 显而易见的题重发
    }
    return { ...scenario, equity, rangeEquity, draws, answer };
  }
}

/** 判定后的一句话简评（中文库内版；页面组件走字典双语同逻辑；范围宽度随行动线） */
export function turnQuizComment(quiz: TurnQuiz): string {
  const pct = (quiz.rangeEquity * 100).toFixed(1);
  const tie =
    quiz.equity.tie >= 0.005
      ? `（另平局 ${(quiz.equity.tie * 100).toFixed(1)}%）`
      : "";
  const rPct = Math.round(
    turnRangeSpecFor(quiz.type, quiz.lineKind).topPct * 100,
  );
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
          return `对跟注者范围（前 ${rPct}%）实算胜率 ${pct}%${tie}，${parts.join(" + ")}——标准半诈唬第二枪：对手弃牌直接收池，被跟也有大量补牌`;
        }
        return `对跟注者范围（前 ${rPct}%）实算胜率 ${pct}%${tie}，越过 55% 第二枪线——继续进攻拿价值、别给免费河牌`;
      }
      return `对第二枪范围（前 ${rPct}%，随行动线收窄）实算胜率 ${pct}%${tie}，超过 68% 加注线——价值加注榨取，别给便宜看河牌`;
    case "fold":
      return `对第二枪范围（前 ${rPct}%，随行动线收窄）实算胜率 ${pct}%${tie}，不足 30%——对手转牌还下注范围更紧，半池注赔率也够不上，弃牌`;
    case "passive":
      return quiz.type === "barrel"
        ? `对跟注者范围（前 ${rPct}%）实算胜率 ${pct}%${tie}，不足 35% 或无强听牌——过牌放弃：能跟翻牌下注的范围不弱，弱牌别再造池`
        : `对第二枪范围（前 ${rPct}%，随行动线收窄）实算胜率 ${pct}%${tie}，够 30% 跟注线但不够 68% 加注线——跟注看河牌，加注只会打走差的留下强的`;
  }
}
