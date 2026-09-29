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
 *     ≥ 第二枪线（单挑 55%，每多一对手 +6pp）→ aggressive（第二枪）；
 *     35-55% 且强听牌（复用 postflopQuiz 的 analyzeDraws/isStrongDraw）
 *       → aggressive（半诈唬第二枪，仅单挑放宽）；
 *     否则 → passive（过牌放弃）。
 * - defense：对手转牌再下注，范围比翻牌圈下注者更紧（turnRangeSpecFor：
 *   open 线 topPct 0.45 / threeBet 线 0.3，诈唬混入不变 15%）：
 *     ≥ 加注线（单挑 68%，+6pp/人）→ aggressive（价值加注）；
 *     ≥ 跟注线（单挑 30%，+3pp/人实现率税；比翻牌圈 28% 略紧——转牌底池更大、
 *       河牌实现权益更差）→ passive；
 *     否则 → fold。
 *
 * 多路底池（multiway，见 multiway.ts）：opponents 按 55/30/15% 抽 1|2|3。
 * 多人行动线 kind 恒 open：barrel 多人线 = 你开局被多家跟注、翻牌持续下注
 * 被多家跟注（hero role = open）；defense 多人线 = 你（大盲）跟注多人池，
 * 面对开局者第二枪且身后还有人（hero role = bbDefend，复用既有映射故
 * heroRoleForTurn 签名不变）。两套胜率口径（2026-09-29 修正）：
 * - barrel（进攻侧）：主动第二枪要赢全场，对 opponents 名跟注者联合采样，
 *   进攻线步进不变；
 * - defense（防守侧）：面对第二枪只评估 hero 对第二枪者的胜率
 *   （equityVsRange(..., opponents=1)）——身后尚未行动的跟注者视为死钱，
 *   死钱反而改善直接赔率，实现率税体现为跟注线 +0.03/人（加注线 +0.06/人
 *   不变）。旧框架「联合胜率 + 跟注线 +0.04/人」对多人摊薄重复计费——用户
 *   实报：T♥9♥ 顶两对在 6♣8♥8♣9♦ 四人池面对第二枪被误弃（对第二枪者胜率
 *   ~0.60，新口径判跟注）。单挑（opponents=1）行为逐比特不变。
 * 半诈唬放宽仅单挑生效（semibluffAllowed）——多人底池诈唬成功率大幅下降。
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
  drawMultiwayOpenerPos,
  drawOpponentCount,
  potPlayers,
  semibluffAllowed,
  turnBarrelLine,
  turnDefenseCallLine,
  turnDefenseRaiseLine,
  type OpponentCount,
} from "@/lib/gto/multiway";
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
  /** 对手数：1 = 单挑，2 = 三人池，3 = 四人池（胜率联合采样与门槛函数共用） */
  opponents: OpponentCount;
}

export interface TurnQuiz extends TurnScenario {
  /** 对 opponents 名随机对手的实算胜率（联合采样，展示用） */
  equity: EquityResult;
  /** 判定胜率（对跟注者/第二枪下注者范围采样；barrel 多人池联合采样，defense 含多人池只对第二枪者，0-1） */
  rangeEquity: number;
  /** 听牌分析（第二枪题的半诈唬判定用） */
  draws: DrawInfo;
  /** 由范围胜率与子题型推导的标准答案 */
  answer: PostflopChoice;
}

/** 第二枪进攻线（单挑基准）：对跟注者范围胜率 ≥ 55%；多人用 turnBarrelLine */
export const TURN_BARREL_EQUITY_THRESHOLD = turnBarrelLine(1);
/** 半诈唬下限：35-55% 且强听牌 → 半诈唬第二枪（仅单挑放宽，semibluffAllowed） */
export const TURN_BARREL_SEMIBLUFF_MIN = 0.35;
/** 面对第二枪加注线（单挑基准）：对下注者范围胜率 ≥ 68%；多人用 turnDefenseRaiseLine */
export const TURN_DEFENSE_RAISE_THRESHOLD = turnDefenseRaiseLine(1);
/** 面对第二枪跟注线（单挑基准）：≥ 30%（比翻牌圈 28% 略紧：池更大、河牌实现更差）；多人用 turnDefenseCallLine */
export const TURN_DEFENSE_CALL_THRESHOLD = turnDefenseCallLine(1);
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

/** 随机抽一条转牌圈行动线（rng 注入可复现）：单挑两个子题型各 2 种真实常见路线；多人池（opponents>1）走多人线（kind 恒 open）；返回开局位供底牌范围对齐 */
export function drawTurnLine(
  type: TurnScenarioType,
  rng: () => number = Math.random,
  opponents: OpponentCount = 1,
): { kind: TurnLineKind; lines: LocalizedText[]; pos: OpenPos } {
  const size = drawBetSize(rng);
  if (opponents > 1) {
    const threeWay = opponents === 2;
    if (type === "barrel") {
      // 多人第二枪：hero 开局被多家跟注（开局位不限，跟注者按家数泛称）
      const pos = drawOpenPos(rng);
      return {
        kind: "open",
        pos,
        lines: [
          threeWay
            ? {
                zh: `翻前：你（${pos}）开局加注到 2.5bb，两家跟注（三人池）`,
                en: `Preflop: you (${pos}) open-raise to 2.5bb and get two callers (three-way pot)`,
              }
            : {
                zh: `翻前：你（${pos}）开局加注到 2.5bb，三家跟注（四人池）`,
                en: `Preflop: you (${pos}) open-raise to 2.5bb and get three callers (four-way pot)`,
              },
          threeWay
            ? {
                zh: `翻牌圈：你持续下注 ${size.zh}，两家都跟注`,
                en: `Flop: you continuation-bet ${size.en} and both call`,
              }
            : {
                zh: `翻牌圈：你持续下注 ${size.zh}，三家都跟注`,
                en: `Flop: you continuation-bet ${size.en} and all three call`,
              },
          {
            zh: "转牌圈：大盲过牌，轮到你行动",
            en: "Turn: the big blind checks — action on you",
          },
        ],
      };
    }
    // 多人面对第二枪：hero 大盲跟注，开局者连开两枪且身后还有人
    const pos = drawMultiwayOpenerPos(rng);
    return {
      kind: "open",
      pos,
      lines: [
        threeWay
          ? {
              zh: `翻前：对手（${pos}）开局加注到 2.5bb，按钮跟注，你（大盲）也跟注（三人池）`,
              en: `Preflop: the ${pos} opens to 2.5bb, the button calls, and you call in the big blind (three-way pot)`,
            }
          : {
              zh: `翻前：对手（${pos}）开局加注到 2.5bb，中位与按钮都跟注，你（大盲）也跟注（四人池）`,
              en: `Preflop: the ${pos} opens to 2.5bb, middle position and the button both call, and you call in the big blind (four-way pot)`,
            },
        threeWay
          ? {
              zh: `翻牌圈：你过牌，对手持续下注 ${size.zh}，按钮跟注，你也跟注`,
              en: `Flop: you check, the opener c-bets ${size.en}, the button calls, and you call too`,
            }
          : {
              zh: `翻牌圈：你过牌，对手持续下注 ${size.zh}，两家跟注，你也跟注`,
              en: `Flop: you check, the opener c-bets ${size.en}, both call, and you call too`,
            },
        threeWay
          ? {
              zh: `转牌圈：你过牌，对手再开第二枪 ${size.zh}，按钮尚未行动——轮到你`,
              en: `Turn: you check, the opener fires a second barrel (${size.en}) with the button still to act — action on you`,
            }
          : {
              zh: `转牌圈：你过牌，对手再开第二枪 ${size.zh}，两家尚未行动——轮到你`,
              en: `Turn: you check, the opener fires a second barrel (${size.en}) with two players still to act — action on you`,
            },
      ],
    };
  }
  const pos = drawOpenPos(rng);
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
 * 多人线 kind 恒 open（barrel 多人 = hero 开局被多家跟注 → open；
 * defense 多人 = hero 大盲跟注 → bbDefend），复用同一映射故无需对手数参数。
 */
export function heroRoleForTurn(
  type: TurnScenarioType,
  lineKind: TurnLineKind,
): HeroRole {
  if (type === "barrel") return lineKind === "threeBet" ? "threeBet" : "open";
  return lineKind === "threeBet" ? "open" : "bbDefend";
}

/**
 * 随机发一个转牌圈场景：先抽子题型、对手数（55/30/15%）与行动线，再按行动线
 * 的 hero 角色（heroRoleForTurn）从对应范围抽底牌，最后从剩余牌发 4 张公共牌
 * （无重复）。防守题的行动线决定下注者范围松紧。
 * @param rng 随机源（默认 Math.random），注入以便测试可复现。
 */
export function dealTurnScenario(
  rng: () => number = Math.random,
): TurnScenario {
  const type: TurnScenarioType = rng() < 0.5 ? "barrel" : "defense";
  const opponents = drawOpponentCount(rng);
  const line = drawTurnLine(type, rng, opponents);
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
    opponents,
  };
}

/** 范围胜率 + 子题型 → 标准答案（纯函数）。rangeWin 为对相应隐含范围的胜率；opponents 驱动多人池门槛（multiway.ts） */
export function judgeTurn(
  rangeWin: number,
  type: TurnScenarioType,
  draws?: DrawInfo,
  opponents: OpponentCount = 1,
): PostflopChoice {
  if (type === "defense") {
    if (rangeWin >= turnDefenseRaiseLine(opponents)) return "aggressive";
    if (rangeWin >= turnDefenseCallLine(opponents)) return "passive";
    return "fold";
  }
  if (rangeWin >= turnBarrelLine(opponents)) return "aggressive";
  // 35-55% 且强听牌（同花听 / 顺子出路 ≥8）= 标准半诈唬第二枪：
  // 对手弃牌直接收池，被跟也有大量补牌。
  // 仅单挑放宽：多人底池诈唬成功率大幅下降，强听牌不再放宽第二枪。
  if (
    semibluffAllowed(opponents) &&
    rangeWin >= TURN_BARREL_SEMIBLUFF_MIN &&
    draws &&
    isStrongDraw(draws)
  ) {
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
    const equity = equityMulti(
      [...scenario.hero],
      [...scenario.board],
      scenario.opponents,
      iterations,
    );
    const spec = turnRangeSpecFor(scenario.type, scenario.lineKind);
    // defense（含多人池）：只评估对第二枪者的胜率（opponents=1，身后跟注者视为
    // 死钱）；barrel（进攻侧）：对 opponents 名跟注者联合采样（主动进攻要赢全场）
    const rangeEquity = equityVsRange(
      scenario.hero,
      scenario.board,
      spec,
      iterations,
      rng,
      scenario.type === "defense" ? 1 : scenario.opponents,
    );
    const draws = analyzeDraws(scenario.hero, scenario.board);
    const answer = judgeTurn(
      rangeEquity,
      scenario.type,
      draws,
      scenario.opponents,
    );
    if (
      attempt + 1 < FILTER_MAX_ATTEMPTS &&
      isTooObvious(rangeEquity, scenario.type, draws)
    ) {
      continue; // 显而易见的题重发
    }
    return { ...scenario, equity, rangeEquity, draws, answer };
  }
}

/** 判定后的一句话简评（中文库内版；页面组件走字典双语同逻辑；范围宽度随行动线；多人池带底池人数提示与动态门槛） */
export function turnQuizComment(quiz: TurnQuiz): string {
  const pct = (quiz.rangeEquity * 100).toFixed(1);
  const tie =
    quiz.equity.tie >= 0.005
      ? `（另平局 ${(quiz.equity.tie * 100).toFixed(1)}%）`
      : "";
  const rPct = Math.round(
    turnRangeSpecFor(quiz.type, quiz.lineKind).topPct * 100,
  );
  const barrel = Math.round(turnBarrelLine(quiz.opponents) * 100);
  const raise = Math.round(turnDefenseRaiseLine(quiz.opponents) * 100);
  const call = Math.round(turnDefenseCallLine(quiz.opponents) * 100);
  const note =
    quiz.opponents > 1
      ? `${potPlayers(quiz.opponents)} 人底池：胜率被稀释，继续需要更强牌力——`
      : "";
  const noteDefense =
    quiz.opponents > 1
      ? `${potPlayers(quiz.opponents)} 人底池：只评估对第二枪者的胜率，身后跟注者视为死钱改善直接赔率——`
      : "";
  switch (quiz.answer) {
    case "aggressive":
      if (quiz.type === "barrel") {
        if (
          quiz.rangeEquity < turnBarrelLine(quiz.opponents) &&
          isStrongDraw(quiz.draws)
        ) {
          // 半诈唬第二枪（仅单挑可达：多人池不放宽）
          const parts: string[] = [];
          if (quiz.draws.straightOuts >= 8)
            parts.push(`顺子听 ${quiz.draws.straightOuts} 张出路`);
          if (quiz.draws.flushDraw) parts.push("同花听");
          return `对跟注者范围（前 ${rPct}%）实算胜率 ${pct}%${tie}，${parts.join(" + ")}——标准半诈唬第二枪：对手弃牌直接收池，被跟也有大量补牌`;
        }
        return `${note}对跟注者范围（前 ${rPct}%）实算胜率 ${pct}%${tie}，越过 ${barrel}% 第二枪线——继续进攻拿价值、别给免费河牌`;
      }
      return `${noteDefense}对第二枪范围（前 ${rPct}%，随行动线收窄）实算胜率 ${pct}%${tie}，超过 ${raise}% 加注线——价值加注榨取，别给便宜看河牌`;
    case "fold":
      return `${noteDefense}对第二枪范围（前 ${rPct}%，随行动线收窄）实算胜率 ${pct}%${tie}，不足 ${call}%——对手转牌还下注范围更紧，半池注赔率也够不上，弃牌`;
    case "passive":
      if (quiz.type === "barrel") {
        if (quiz.opponents > 1 && isStrongDraw(quiz.draws)) {
          const parts: string[] = [];
          if (quiz.draws.straightOuts >= 8)
            parts.push(`顺子听 ${quiz.draws.straightOuts} 张出路`);
          if (quiz.draws.flushDraw) parts.push("同花听");
          return `${note}对跟注者范围（前 ${rPct}%）实算胜率 ${pct}%${tie}，${parts.join(" + ")}——但多人底池诈唬成功率大幅下降，强听牌不再放宽第二枪；过牌放弃`;
        }
        if (quiz.opponents > 1) {
          return `${note}对跟注者范围（前 ${rPct}%）实算胜率 ${pct}%${tie}，不够 ${barrel}% 第二枪线——多人池弱牌别再造池，过牌放弃`;
        }
        return `对跟注者范围（前 ${rPct}%）实算胜率 ${pct}%${tie}，不足 35% 或无强听牌——过牌放弃：能跟翻牌下注的范围不弱，弱牌别再造池`;
      }
      return `${noteDefense}对第二枪范围（前 ${rPct}%，随行动线收窄）实算胜率 ${pct}%${tie}，够 ${call}% 跟注线但不够 ${raise}% 加注线——跟注看河牌，加注只会打走差的留下强的`;
  }
}
