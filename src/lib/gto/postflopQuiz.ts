/**
 * src/lib/gto/postflopQuiz.ts — 翻后特训出题器（翻牌圈场景）
 *
 * 出题：按行动线的 hero 角色从对应范围抽底牌（sampleHeroCards，见
 * heroRange.ts 的「底牌与行动线一致性」设计）+ 从剩余牌发 3 张公共牌
 * （无重复），题型二选一，并随机抽一条行动线（drawPostflopLine，见
 * actionLine.ts）：
 * - attack（进攻题）：你翻前开局（UTG+1~BTN 随机），大盲跟注；翻牌对手
 *   过牌，轮到你——主动进攻还是过牌？
 * - defense（防守题）：对手下注，轮到你——加注/跟注/弃牌？行动线两种：
 *   - open：对手是「翻前跟注者+翻牌反主动下注/持续下注」→ 范围前 60%；
 *   - threeBet：对手「翻前 3bet 后持续下注」→ 范围收紧到前 35%
 *     （defenseRangeSpecFor，范围随行动线收窄）。
 * 两种题型的行动线里 hero 都是翻前开局方（defense threeBet 线 = 你开局后
 * 跟注大盲的 3bet），故底牌一律按 open 角色从 hero 开局位的开局范围抽
 * （heroRoleForPostflop）——2♥4♥ 这类牌永不会以开局者身份出现。
 *
 * 判定口径（v2，修复「第三对子被判加注」的失真）：
 * - attack：对 1 名随机对手实算胜率 ≥ 55% → aggressive；其余 → passive（check）。
 * - defense：对手已下注，其范围不是随机——用 equityVsRange（下注者隐含范围，
 *   按行动线取 spec + 15% 诈唬混入）实算胜率：
 *     ≥ 68% → aggressive（价值加注）；
 *     ≥ 28% → passive（call：半池注赔率 25% + 实现折扣余量）；
 *     < 28% → fold。
 *   中间档一律跟注——中对/弱对加注只会打走差的留下强的。
 *
 * 难度过滤（isTooObvious，见 trainerDifficulty.ts）：防守题判定胜率 <20%
 * （纯垃圾弃牌）或 >85%（坚果级无脑加注）、进攻题 >85%（无脑价值）或 <25%
 * 且无强听牌（纯空气过牌）→ 重发，FILTER_MAX_ATTEMPTS 次上限兜底。
 * 底牌有范围后下限大多休眠，>85% 坚果级过滤仍必需（强范围照样发坚果）。
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

/** 题型：进攻题（无人下注）/ 防守题（面对下注） */
export type ScenarioType = "attack" | "defense";

/** 三选项：进攻 / 过牌·跟注 / 弃牌 */
export type PostflopChoice = "aggressive" | "passive" | "fold";

/**
 * 行动线种类：
 * - open：常规开局池——hero 开局（attack）/ 对手开局（defense）；
 * - threeBet：3bet 池——对手翻前 3bet 后持续下注（仅 defense，范围更紧）。
 */
export type PostflopLineKind = "open" | "threeBet";

export interface PostflopScenario {
  hero: [Card, Card];
  board: [Card, Card, Card];
  type: ScenarioType;
  /** 本题的前文行动线（双语多行，页面渲染用） */
  actionLine: LocalizedText[];
  /** 行动线种类（驱动防守题范围收窄与文案） */
  lineKind: PostflopLineKind;
  /** 行动线中 hero 的开局位（底牌按该位开局范围抽样，与行动线文本对齐） */
  openPos: OpenPos;
}

export interface PostflopQuiz extends PostflopScenario {
  /** 实算胜率（对 1 名随机对手，win/tie/lose 0-1，展示用） */
  equity: EquityResult;
  /** 防守题的判定胜率（对下注者范围，0-1；进攻题为 null） */
  defenseEquity: number | null;
  /** 听牌分析（进攻题的半诈唬判定用） */
  draws: DrawInfo;
  /** 由胜率与题型推导的标准答案 */
  answer: PostflopChoice;
}

/** 进攻线：对随机胜率 ≥ 55% */
export const ATTACK_EQUITY_THRESHOLD = 0.55;
/** 防守加注线：对下注者范围胜率 ≥ 68%（价值加注） */
export const DEFENSE_RAISE_THRESHOLD = 0.68;
/** 防守跟注线：对下注者范围胜率 ≥ 28%（半池赔率 25% + 实现折扣） */
export const DEFENSE_CALL_THRESHOLD = 0.28;
/** 防守题的下注者隐含范围（常规开局池）：强度前 60% + 15% 诈唬混入（标准 c-bet 近似） */
export const DEFENSE_RANGE_SPEC = { topPct: 0.6, bluffPct: 0.15 } as const;
/** 防守题的下注者隐含范围（3bet 池持续下注）：收紧到前 35% + 15% 诈唬混入 */
export const FLOP_DEFENSE_3BET_RANGE_SPEC = { topPct: 0.35, bluffPct: 0.15 } as const;
/** 出题预计算的蒙特卡洛迭代次数（约几十 ms） */
export const QUIZ_ITERATIONS = 2000;

/**
 * 防守题范围随行动线收窄：
 * - open（翻前跟注者+翻牌下注者）→ DEFENSE_RANGE_SPEC（前 60%）；
 * - threeBet（对手翻前 3bet 后持续下注）→ FLOP_DEFENSE_3BET_RANGE_SPEC（前 35%）。
 * 进攻题无下注者范围概念（判定用对随机胜率），此函数仅供 defense 使用。
 */
export function defenseRangeSpecFor(lineKind: PostflopLineKind): RangeSpec {
  return lineKind === "threeBet" ? FLOP_DEFENSE_3BET_RANGE_SPEC : DEFENSE_RANGE_SPEC;
}

/** 随机抽一条翻牌圈行动线（rng 注入可复现）：attack 固定 open 线，defense 二选一；返回开局位供底牌范围对齐 */
export function drawPostflopLine(
  type: ScenarioType,
  rng: () => number = Math.random,
): { kind: PostflopLineKind; lines: LocalizedText[]; pos: OpenPos } {
  const pos = drawOpenPos(rng);
  if (type === "attack") {
    return {
      kind: "open",
      pos,
      lines: [
        {
          zh: `翻前：你（${pos}）开局加注到 2.5bb，大盲跟注`,
          en: `Preflop: you (${pos}) open-raise to 2.5bb and the big blind calls`,
        },
        {
          zh: "翻牌圈：对手过牌，轮到你行动",
          en: "Flop: the big blind checks to you",
        },
      ],
    };
  }
  const size = drawBetSize(rng);
  if (rng() < 0.5) {
    return {
      kind: "open",
      pos,
      lines: [
        {
          zh: `翻前：你（${pos}）开局加注到 2.5bb，大盲跟注`,
          en: `Preflop: you (${pos}) open-raise to 2.5bb and the big blind calls`,
        },
        {
          zh: `翻牌圈：对手反主动下注 ${size.zh}，轮到你`,
          en: `Flop: the big blind leads out for ${size.en} — action on you`,
        },
      ],
    };
  }
  return {
    kind: "threeBet",
    pos,
    lines: [
      {
        zh: `翻前：你（${pos}）开局加注到 2.5bb，大盲 3bet 到 ${threeBetToText().zh}，你跟注`,
        en: `Preflop: you (${pos}) open-raise to 2.5bb; the big blind 3-bets to ${threeBetToText().en} and you call`,
      },
      {
        zh: `翻牌圈：对手持续下注 ${size.zh}，轮到你`,
        en: `Flop: the 3-bettor continuation-bets ${size.en} — action on you`,
      },
    ],
  };
}

/**
 * 翻牌圈行动线里的 hero 翻前角色（驱动底牌范围，见 heroRange.ts）：
 * 所有行动线里 hero 都是开局方——attack/defense-open 线你开局大盲跟注，
 * defense-threeBet 线你开局后跟注大盲的 3bet——故一律按 open 角色抽底牌。
 */
export function heroRoleForPostflop(
  _type: ScenarioType,
  _lineKind: PostflopLineKind,
): HeroRole {
  return "open";
}

/**
 * 随机发一个翻牌圈场景：先抽题型与行动线，再按行动线的 hero 角色
 * （一律 open）从 hero 开局位的开局范围抽底牌，最后从剩余牌发 3 张
 * 公共牌（无重复）。防守题的行动线决定下注者范围松紧。
 * @param rng 随机源（默认 Math.random），注入以便测试可复现。
 */
export function dealPostflopScenario(
  rng: () => number = Math.random,
): PostflopScenario {
  const type: ScenarioType = rng() < 0.5 ? "attack" : "defense";
  const line = drawPostflopLine(type, rng);
  const hero = sampleHeroCards(rng, heroRoleForPostflop(type, line.kind), {
    openPos: line.pos,
  });
  const board = dealRemainingCards(rng, hero, 3) as [Card, Card, Card];
  return {
    hero,
    board,
    type,
    actionLine: line.lines,
    lineKind: line.kind,
    openPos: line.pos,
  };
}

/** 听牌分析：同花听（4 张同花）与顺子出路数 */
export interface DrawInfo {
  /** 是否有同花听牌（hero+board 中某花色 ≥4 张） */
  flushDraw: boolean;
  /** 顺子补牌张数（能让 5 张成顺的剩余牌数，去重按张计） */
  straightOuts: number;
}

const RANKS = "23456789TJQKA";

/** 分析 hero 在当前 board 上的听牌（纯函数，可测） */
export function analyzeDraws(hero: [Card, Card], board: Card[]): DrawInfo {
  const cards = [...hero, ...board];
  // 同花听：任一花色 ≥4 张
  const suitCount = new Map<string, number>();
  for (const c of cards) {
    const s = c.slice(-1);
    suitCount.set(s, (suitCount.get(s) ?? 0) + 1);
  }
  const flushDraw = [...suitCount.values()].some((n) => n >= 4);

  // 顺子出路：枚举每个点数，加入该点数一张牌后是否成顺（5 张连）
  const rankSet = new Set(cards.map((c) => RANKS.indexOf(c[0])));
  let straightOuts = 0;
  for (let r = 0; r < 13; r++) {
    if (rankSet.has(r)) continue; // 已有该点数的牌，跳过（保守不重复计）
    const test = new Set([...rankSet, r]);
    // 5 连检测：存在长度为 5 的连续序列
    let run = 0;
    for (let i = 0; i < 13; i++) {
      run = test.has(i) ? run + 1 : 0;
      if (run >= 5) break;
    }
    // A 也可以当 1（A2345）
    if (run < 5 && test.has(12) && test.has(0) && test.has(1) && test.has(2) && test.has(3)) {
      run = 5;
    }
    if (run >= 5) straightOuts += 4; // 每个点数 4 张（花色）
  }
  return { flushDraw, straightOuts };
}

/** 强听牌：同花听 或 顺子出路 ≥8（两头顺/更强） */
export function isStrongDraw(d: DrawInfo): boolean {
  return d.flushDraw || d.straightOuts >= 8;
}

/** 胜率 + 题型 → 标准答案（纯函数）。defense 请传对下注者范围的胜率 */
export function judgePostflop(
  win: number,
  type: ScenarioType,
  defenseWin?: number,
  draws?: DrawInfo,
): PostflopChoice {
  if (type === "defense") {
    const w = defenseWin ?? win;
    if (w >= DEFENSE_RAISE_THRESHOLD) return "aggressive";
    if (w >= DEFENSE_CALL_THRESHOLD) return "passive";
    return "fold";
  }
  if (win >= ATTACK_EQUITY_THRESHOLD) return "aggressive";
  // 强听牌（两头顺/同花听）即使胜率在 45-55% 也是标准半诈唬进攻，
  // 别把 T♣9♠ 这类牌当"弱牌"过牌（半诈唬：对手弃牌收池，对手跟注有大量补牌）
  if (win >= 0.45 && draws && isStrongDraw(draws)) return "aggressive";
  return "passive";
}

/** 实算场景胜率：对 1 名随机对手，蒙特卡洛 iterations 次 */
export function evaluateScenario(
  scenario: PostflopScenario,
  iterations: number = QUIZ_ITERATIONS,
): EquityResult {
  return equityMulti([...scenario.hero], [...scenario.board], 1, iterations);
}

/**
 * 难度过滤（反脑残，纯函数）：win 传判定胜率（防守题 = 对下注者范围的胜率）。
 * - defense：<20%（纯垃圾弃牌）或 >85%（坚果级无脑加注/跟注）→ 重发；
 * - attack：>85%（无脑价值）或 <25% 且无强听牌（纯空气过牌毫无决策含量）→ 重发。
 */
export function isTooObvious(
  win: number,
  type: ScenarioType,
  draws?: DrawInfo,
): boolean {
  if (type === "defense") return isDefenseLikeObvious(win);
  return isOffenseLikeObvious(win, !!draws && isStrongDraw(draws));
}

/**
 * 出一道完整的题：发场景（含行动线）+ 实算胜率 + 推导答案
 * （同步，约几十 ms，调用方负责异步化）。
 * 显而易见的情形（isTooObvious）重发，FILTER_MAX_ATTEMPTS 次上限兜底——
 * 连续抽到极端牌时按最后一次结果出题，保证不死循环。
 */
export function generatePostflopQuiz(
  rng: () => number = Math.random,
  iterations: number = QUIZ_ITERATIONS,
): PostflopQuiz {
  for (let attempt = 0; ; attempt++) {
    const scenario = dealPostflopScenario(rng);
    const equity = evaluateScenario(scenario, iterations);
    const defenseEquity =
      scenario.type === "defense"
        ? equityVsRange(
            scenario.hero,
            scenario.board,
            defenseRangeSpecFor(scenario.lineKind),
            iterations,
            rng,
          )
        : null;
    const draws = analyzeDraws(scenario.hero, scenario.board);
    const answer = judgePostflop(
      equity.win,
      scenario.type,
      defenseEquity ?? undefined,
      draws,
    );
    const judgeWin = defenseEquity ?? equity.win;
    if (
      attempt + 1 < FILTER_MAX_ATTEMPTS &&
      isTooObvious(judgeWin, scenario.type, draws)
    ) {
      continue; // 显而易见的题重发
    }
    return { ...scenario, equity, defenseEquity, draws, answer };
  }
}

export const CHOICE_LABEL: Record<PostflopChoice, string> = {
  aggressive: "下注/加注",
  passive: "过牌/跟注",
  fold: "弃牌",
};

/** 判定后的一句话简评（防守题引用对下注者范围的胜率，范围宽度随行动线） */
export function quizComment(quiz: PostflopQuiz): string {
  const pct = (quiz.equity.win * 100).toFixed(1);
  const tie =
    quiz.equity.tie >= 0.005
      ? `（另平局 ${(quiz.equity.tie * 100).toFixed(1)}%）`
      : "";
  const dPct =
    quiz.defenseEquity !== null
      ? (quiz.defenseEquity * 100).toFixed(1)
      : null;
  const rPct = Math.round(defenseRangeSpecFor(quiz.lineKind).topPct * 100);
  switch (quiz.answer) {
    case "aggressive": {
      if (quiz.type === "attack") {
        // 区分价值进攻与半诈唬进攻
        if (quiz.equity.win < ATTACK_EQUITY_THRESHOLD && isStrongDraw(quiz.draws)) {
          const parts: string[] = [];
          if (quiz.draws.straightOuts >= 8) parts.push(`顺子听 ${quiz.draws.straightOuts} 张出路`);
          if (quiz.draws.flushDraw) parts.push("同花听");
          return `实算胜率 ${pct}%${tie}，${parts.join(" + ")}——标准半诈唬：下注让对手弃牌直接收池，被跟也有大量补牌`;
        }
        return `实算胜率 ${pct}%${tie}，越过 55% 进攻线——牌力明显领先随机手，主动下注拿价值、直接收池`;
      }
      return `对下注者范围（前 ${rPct}%，随行动线收窄）实算胜率 ${dPct}%${tie}，超过 68% 加注线——价值加注榨取，别给便宜看牌`;
    }
    case "fold":
      return `对下注者范围（前 ${rPct}%，随行动线收窄）实算胜率 ${dPct}%${tie}，不足 28%——半池注需 25% 赔率也够不上，弃牌`;
    case "passive":
      return quiz.type === "attack"
        ? `实算胜率 ${pct}%${tie}，不够进攻线——过牌控池、免费看转牌，别用弱牌造池`
        : `对下注者范围（前 ${rPct}%，随行动线收窄）实算胜率 ${dPct}%${tie}，够 28% 跟注线但不够 68% 加注线——中对/弱对的标准打法是跟注看转牌，加注只会打走差的留下强的`;
  }
}
