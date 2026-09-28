/**
 * src/lib/gto/riverQuiz.ts — 河牌圈出题器（river 场景）
 *
 * 出题：按行动线的 hero 角色从对应范围抽底牌（sampleHeroCards，见
 * heroRange.ts 的「底牌与行动线一致性」设计）+ 从剩余牌发 5 张公共牌
 * （无重复），子题型三选一（随机），并随机抽一条覆盖三条街的完整行动线
 * （drawRiverLine，rng 注入）：
 * - value（薄价值 or 过牌）：你最后行动、无人下注——下注拿价值还是过牌比牌？
 *   行动线两种：open（你开局，c-bet 一枪后转牌双方过牌 → 对手跟注范围前 50%）
 *   / threeBet（你翻前 3bet 后连开两枪都被跟 → 前两街都跟了，范围收窄到前 40%）。
 * - bluffcatch（抓诈 or 弃牌）：对手下注一个满池——跟注抓诈还是弃牌？
 *   行动线两种（open / threeBet），极化范围不变（前 25% 强牌 + 35% 诈唬混入）。
 * - bluff（诈唬 or 放弃）：你的听牌全没中、无人下注——诈唬偷池还是过牌放弃？
 *   行动线两种：open（你 c-bet 一枪后转牌双方过牌）/ flat（你跟注开局，翻牌
 *   双方过牌、转牌对手过牌放弃）。
 *
 * hero 角色映射（heroRoleForRiver）：open 线（你开局）→ open；threeBet 线
 * （你大盲 3bet）→ threeBet；flat 线（你大盲跟注对手开局）→ bbDefend。
 * 听牌没中的合理性由此成立：可玩牌才有听牌入池。
 *
 * 判定口径（全部实算）：
 * - 河牌公共牌已齐，vs 随机胜率可精确枚举：riverEquityExact 遍历剩余
 *   45 张牌的全部 C(45,2)=990 个对手组合，evaluate7 逐个比大小，无蒙特卡洛
 *   误差（确定性结果，答题判定与测试都稳定）。
 * - value：equityVsRange（对手 = 跟注范围 riverValueCallerSpecFor：open 线
 *   前 50% / threeBet 线前 40%，均 + 5% 诈唬混入）≥ 60% → aggressive（价值
 *   下注）；45-60% → passive（薄价值不够薄别贪：下注多半只被更强的牌跟）；
 *   < 45% → passive（过牌）。
 * - bluffcatch：equityVsRange（对手 = 极化范围 RIVER_BLUFFCATCH_POLAR_SPEC：
 *   前 25% 强牌 + 35% 诈唬混入）≥ 33% → passive（跟注抓诈：满池注跟 1 池
 *   赢 3 池，保本胜率 33%）；否则 → fold。
 * - bluff：精确胜率 < 25% → aggressive（诈唬：毫无摊牌价值，过牌=认输，
 *   唯有下注能赢）；25-45% → passive（弱牌有摊牌价值别诈唬：诈唬只会打走
 *   更弱的、被更强的跟）；≥ 45% → aggressive（牌力领先，价值下注）。
 *
 * 难度过滤（isTooObvious，见 trainerDifficulty.ts）：抓诈题 <20%/>85% 重发；
 * 薄价值题 >85%（无脑价值）或 <25%（纯空气过牌）重发；诈唬题 >85%（坚果级
 * 价值下注毫无决策含量）或 <25%（纯空气——河牌已无听牌可言，过牌=认输的
 * 必诈题）重发，10 次上限兜底。底牌有范围后下限大多休眠，>85% 坚果级
 * 过滤仍必需（强范围照样发坚果）。
 *
 * 「摊牌价值」（showdown value）：弱成牌（如小对子）过牌有机会在摊牌赢下
 * 更弱的牌，但一旦下注，更弱的牌会弃、更强的牌会跟——下注反而把赢面打没。
 * 所以河牌极化：强牌与纯空气下注，中间牌过牌。
 */
import type { Card } from "@/lib/types";
import { newDeck } from "@/lib/poker/cards";
import { evaluate7 } from "@/lib/poker/evaluator";
import type { EquityResult } from "@/lib/poker/equity";
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
import { QUIZ_ITERATIONS, type PostflopChoice } from "@/lib/gto/postflopQuiz";

/** 子题型：value = 薄价值 / bluffcatch = 抓诈 / bluff = 诈唬 */
export type RiverScenarioType = "value" | "bluffcatch" | "bluff";

/**
 * 行动线种类：
 * - open：hero 翻前开局加注（value/bluffcatch/bluff 通用）；
 * - threeBet：hero 翻前 3bet（value/bluffcatch）——前两街都打满，范围更紧；
 * - flat：hero 翻前跟注对手开局（仅 bluff：翻牌双方过牌的弱池）。
 */
export type RiverLineKind = "open" | "threeBet" | "flat";

export interface RiverScenario {
  hero: [Card, Card];
  board: [Card, Card, Card, Card, Card];
  type: RiverScenarioType;
  /** 本题的前文行动线（双语多行，页面渲染用） */
  actionLine: LocalizedText[];
  /** 行动线种类（驱动价值题跟注范围收窄与文案） */
  lineKind: RiverLineKind;
  /** 行动线中的开局位（hero 开局线 = hero 位置；底牌范围对齐用） */
  openPos: OpenPos;
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
/** 价值题判定用——河牌跟注者隐含范围（常规线）：前 50% 强度 + 5% 诈唬混入 */
export const RIVER_VALUE_CALLER_SPEC = { topPct: 0.5, bluffPct: 0.05 } as const;
/** 价值题判定用——前两街都开枪都被跟后的跟注范围：收紧到前 40% + 5% 诈唬混入 */
export const RIVER_VALUE_CALLER_2STREET_SPEC = { topPct: 0.4, bluffPct: 0.05 } as const;
/** 抓诈跟注线：对极化范围胜率 ≥ 33%（满池注赔率：跟 1 池赢 3 池） */
export const RIVER_BLUFFCATCH_CALL_THRESHOLD = 0.33;
/** 抓诈题判定用——满池下注者极化范围：前 25% 强牌 + 35% 诈唬混入（不随行动线变化） */
export const RIVER_BLUFFCATCH_POLAR_SPEC = { topPct: 0.25, bluffPct: 0.35 } as const;
/** 诈唬上限：精确胜率 < 25%（无摊牌价值）才诈唬 */
export const RIVER_BLUFF_MAX_EQUITY = 0.25;
/** 摊牌价值带上限：25-45% 过牌；≥ 45% 价值下注 */
export const RIVER_SHOWDOWN_VALUE_MAX = 0.45;

/**
 * 价值题跟注范围随行动线收窄（前文越多范围越紧）：
 * - open（c-bet 一枪后转牌双方过牌）→ RIVER_VALUE_CALLER_SPEC（前 50%）；
 * - threeBet（翻前 3bet + 连开两枪都被跟）→ RIVER_VALUE_CALLER_2STREET_SPEC（前 40%）。
 */
export function riverValueCallerSpecFor(lineKind: RiverLineKind): RangeSpec {
  return lineKind === "threeBet"
    ? RIVER_VALUE_CALLER_2STREET_SPEC
    : RIVER_VALUE_CALLER_SPEC;
}

/** 随机抽一条河牌圈行动线（rng 注入可复现）：三个子题型各 2 种真实常见路线；返回开局位供底牌范围对齐 */
export function drawRiverLine(
  type: RiverScenarioType,
  rng: () => number = Math.random,
): { kind: RiverLineKind; lines: LocalizedText[]; pos: OpenPos } {
  const pos = drawOpenPos(rng);
  const size = drawBetSize(rng);
  const threeBet = threeBetToText();
  const kind: RiverLineKind =
    type === "bluff"
      ? rng() < 0.5
        ? "open"
        : "flat"
      : rng() < 0.5
        ? "open"
        : "threeBet";

  if (type === "value") {
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
            zh: `翻牌圈：你持续下注 ${size.zh}，对手跟注`,
            en: `Flop: you continuation-bet ${size.en} and the big blind calls`,
          },
          { zh: "转牌圈：双方都过牌", en: "Turn: both players check" },
          {
            zh: "河牌圈：对手过牌，轮到你",
            en: "River: the big blind checks — action on you",
          },
        ],
      };
    }
    return {
      kind,
      pos,
      lines: [
        {
          zh: `翻前：对手（${pos}）开局加注到 2.5bb，你（大盲）3bet 到 ${threeBet.zh}，对手跟注`,
          en: `Preflop: the ${pos} opens to 2.5bb; you (big blind) 3-bet to ${threeBet.en} and they call`,
        },
        {
          zh: `翻牌圈：你持续下注 ${size.zh}，对手跟注`,
          en: `Flop: you continuation-bet ${size.en} and the opener calls`,
        },
        {
          zh: `转牌圈：你再开第二枪 ${size.zh}，对手仍跟注`,
          en: `Turn: you fire a second barrel (${size.en}) and they call again`,
        },
        {
          zh: "河牌圈：对手过牌，轮到你",
          en: "River: the opener checks — action on you",
        },
      ],
    };
  }

  if (type === "bluffcatch") {
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
            zh: `翻牌圈：你持续下注 ${size.zh}，对手跟注`,
            en: `Flop: you continuation-bet ${size.en} and the big blind calls`,
          },
          {
            zh: `转牌圈：你过牌，对手下注 ${size.zh}，你跟注`,
            en: `Turn: you check, the big blind bets ${size.en}, and you call`,
          },
          {
            zh: "河牌圈：对手下注一个满池",
            en: "River: the big blind bets a full pot",
          },
        ],
      };
    }
    return {
      kind,
      pos,
      lines: [
        {
          zh: `翻前：对手（${pos}）开局加注到 2.5bb，你（大盲）3bet 到 ${threeBet.zh}，对手跟注`,
          en: `Preflop: the ${pos} opens to 2.5bb; you (big blind) 3-bet to ${threeBet.en} and they call`,
        },
        {
          zh: `翻牌圈：你过牌，对手下注 ${size.zh}，你跟注`,
          en: `Flop: you check, the opener bets ${size.en}, and you call`,
        },
        {
          zh: `转牌圈：你过牌，对手再下注 ${size.zh}，你跟注`,
          en: `Turn: you check, the opener bets ${size.en} again, and you call`,
        },
        {
          zh: "河牌圈：对手下注一个满池",
          en: "River: the opener bets a full pot",
        },
      ],
    };
  }

  // bluff
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
          zh: `翻牌圈：你持续下注 ${size.zh}，对手跟注`,
          en: `Flop: you continuation-bet ${size.en} and the big blind calls`,
        },
        { zh: "转牌圈：双方都过牌", en: "Turn: both players check" },
        {
          zh: "河牌圈：对手过牌，你的听牌全没中",
          en: "River: the big blind checks and all your draws have missed",
        },
      ],
    };
  }
  return {
    kind,
    pos,
    lines: [
      {
        zh: `翻前：对手（${pos}）开局加注到 2.5bb，你（大盲）跟注`,
        en: `Preflop: the ${pos} open-raises to 2.5bb and you (big blind) call`,
      },
      { zh: "翻牌圈：双方都过牌", en: "Flop: both players check" },
      {
        zh: "转牌圈：你过牌，对手也过牌",
        en: "Turn: you check and the opener checks back",
      },
      {
        zh: "河牌圈：轮到你行动——你的听牌全没中",
        en: "River: action on you — all your draws have missed",
      },
    ],
  };
}

/**
 * 河牌圈行动线里的 hero 翻前角色（驱动底牌范围，见 heroRange.ts）：
 * - open 线：你开局大盲跟注（value/bluffcatch/bluff 通用）→ open；
 * - threeBet 线：你（大盲）3bet 对手开局 → threeBet；
 * - flat 线（仅 bluff）：对手开局你（大盲）跟注 → bbDefend。
 */
export function heroRoleForRiver(lineKind: RiverLineKind): HeroRole {
  if (lineKind === "threeBet") return "threeBet";
  if (lineKind === "flat") return "bbDefend";
  return "open";
}

/**
 * 随机发一个河牌圈场景：先抽子题型与行动线，再按行动线的 hero 角色
 * （heroRoleForRiver）从对应范围抽底牌，最后从剩余牌发 5 张公共牌
 * （无重复）。价值题的行动线决定跟注范围松紧。
 * @param rng 随机源（默认 Math.random），注入以便测试可复现。
 */
export function dealRiverScenario(
  rng: () => number = Math.random,
): RiverScenario {
  const t = rng();
  const type: RiverScenarioType =
    t < 1 / 3 ? "value" : t < 2 / 3 ? "bluffcatch" : "bluff";
  const line = drawRiverLine(type, rng);
  const role = heroRoleForRiver(line.kind);
  const hero = sampleHeroCards(rng, role, {
    openPos: role === "open" ? line.pos : undefined,
  });
  const board = dealRemainingCards(rng, hero, 5) as [
    Card,
    Card,
    Card,
    Card,
    Card,
  ];
  return {
    hero,
    board,
    type,
    actionLine: line.lines,
    lineKind: line.kind,
    openPos: line.pos,
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

/**
 * 难度过滤（反脑残，纯函数）：
 * - value：对跟注范围胜率 >85%（无脑价值）或 <25%（纯空气过牌毫无决策
 *   含量；河牌已无听牌可言，hasStrongDraw 恒 false）→ 重发；
 * - bluffcatch：对极化范围胜率 <20%（纯垃圾弃牌）或 >85%（坚果级无脑跟注）→ 重发；
 * - bluff：精确胜率 >85%（坚果级无脑价值下注）或 <25%（纯空气必诈，
 *   过牌=认输毫无决策含量）→ 重发（诈唬题调用时 rangeWin 缺省）。
 */
export function isTooObvious(
  win: number,
  type: RiverScenarioType,
  rangeWin?: number,
): boolean {
  if (type === "value") return isOffenseLikeObvious(rangeWin ?? win, false);
  if (type === "bluffcatch") return isDefenseLikeObvious(rangeWin ?? win);
  return isOffenseLikeObvious(win, false);
}

/**
 * 出一道完整的河牌圈题（精确枚举 + 范围蒙特卡洛，约几十 ms，调用方负责异步化）。
 * 显而易见的情形（isTooObvious）重发，FILTER_MAX_ATTEMPTS 次上限兜底。
 */
export function generateRiverQuiz(
  rng: () => number = Math.random,
  iterations: number = QUIZ_ITERATIONS,
): RiverQuiz {
  for (let attempt = 0; ; attempt++) {
    const scenario = dealRiverScenario(rng);
    const equity = riverEquityExact(scenario.hero, scenario.board);
    const rangeEquity =
      scenario.type === "value"
        ? equityVsRange(
            scenario.hero,
            scenario.board,
            riverValueCallerSpecFor(scenario.lineKind),
            iterations,
            rng,
          )
        : scenario.type === "bluffcatch"
          ? equityVsRange(
              scenario.hero,
              scenario.board,
              RIVER_BLUFFCATCH_POLAR_SPEC,
              iterations,
              rng,
            )
          : null;
    const answer = judgeRiver(equity.win, scenario.type, rangeEquity ?? undefined);
    if (
      attempt + 1 < FILTER_MAX_ATTEMPTS &&
      isTooObvious(equity.win, scenario.type, rangeEquity ?? undefined)
    ) {
      continue; // 显而易见的题重发
    }
    return { ...scenario, equity, rangeEquity, answer };
  }
}

/** 判定后的一句话简评（中文库内版；页面组件走字典双语同逻辑；价值题范围宽度随行动线） */
export function riverQuizComment(quiz: RiverQuiz): string {
  const pct = (quiz.equity.win * 100).toFixed(1);
  const rPct =
    quiz.rangeEquity !== null ? (quiz.rangeEquity * 100).toFixed(1) : null;
  const tie =
    quiz.equity.tie >= 0.005
      ? `（另平局 ${(quiz.equity.tie * 100).toFixed(1)}%）`
      : "";
  const callerPct = Math.round(
    riverValueCallerSpecFor(quiz.lineKind).topPct * 100,
  );
  switch (quiz.answer) {
    case "aggressive":
      if (quiz.type === "value") {
        return `对跟注范围（前 ${callerPct}%，随行动线收窄）实算胜率 ${rPct}%${tie}，越过 60% 价值线——下注拿价值：更差的牌会跟注，别浪费最后一条街`;
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
          ? `对跟注范围（前 ${callerPct}%，随行动线收窄）实算胜率 ${rPct}%${tie}，在 45-60% 之间——薄价值不够薄别贪：下注多半只被更强的牌跟；过牌利用摊牌价值免费比牌`
          : `对跟注范围（前 ${callerPct}%，随行动线收窄）实算胜率 ${rPct}%${tie}，不足 45%——下注等于诈唬而非价值；有摊牌价值的牌过牌比牌`;
      }
      if (quiz.type === "bluffcatch") {
        return `对极化范围（前 25% 强牌 + 35% 诈唬）实算胜率 ${rPct}%${tie}，越过 33% 满池赔率线——跟注抓诈：对方的诈唬组合足够多，满池注只需三分之一胜率`;
      }
      return `精确胜率 ${pct}%${tie}，在 25-45% 之间——弱牌有摊牌价值：过牌有机会赢下更弱的牌；诈唬只会打走更弱的、被更强的跟注，把赢面打没`;
  }
}
