/**
 * src/lib/gto/postflopQuiz.ts — 翻后特训出题器（翻牌圈场景）
 *
 * 出题：随机发 hero 两张底牌 + 3 张公共牌（无重复），题型二选一：
 * - attack（进攻题）：翻牌圈无人下注，轮到你——主动进攻还是过牌？
 * - defense（防守题）：对手下注半个底池，轮到你——加注/跟注/弃牌？
 *
 * 判定口径（v2，修复「第三对子被判加注」的失真）：
 * - attack：对 1 名随机对手实算胜率 ≥ 55% → aggressive；其余 → passive（check）。
 * - defense：对手已下注，其范围不是随机——用 equityVsRange（下注者隐含范围：
 *   前 60% 强度 + 15% 诈唬混入）实算胜率：
 *     ≥ 68% → aggressive（价值加注）；
 *     ≥ 28% → passive（call：半池注赔率 25% + 实现折扣余量）；
 *     < 28% → fold。
 *   中间档一律跟注——中对/弱对加注只会打走差的留下强的。
 */
import type { Card } from "@/lib/types";
import { newDeck } from "@/lib/poker/cards";
import { equityMulti, type EquityResult } from "@/lib/poker/equity";
import { equityVsRange } from "@/lib/ai/range";

/** 题型：进攻题（无人下注）/ 防守题（面对半池注） */
export type ScenarioType = "attack" | "defense";

/** 三选项：进攻 / 过牌·跟注 / 弃牌 */
export type PostflopChoice = "aggressive" | "passive" | "fold";

export interface PostflopScenario {
  hero: [Card, Card];
  board: [Card, Card, Card];
  type: ScenarioType;
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
/** 防守题的下注者隐含范围：强度前 60% + 15% 诈唬混入（标准 c-bet 近似） */
export const DEFENSE_RANGE_SPEC = { topPct: 0.6, bluffPct: 0.15 } as const;
/** 出题预计算的蒙特卡洛迭代次数（约几十 ms） */
export const QUIZ_ITERATIONS = 2000;

/**
 * 随机发一个翻牌圈场景：hero 2 张 + 公共牌 3 张，无重复，题型随机。
 * @param rng 随机源（默认 Math.random），注入以便测试可复现。
 */
export function dealPostflopScenario(
  rng: () => number = Math.random,
): PostflopScenario {
  const deck = newDeck();
  // 部分 Fisher-Yates：洗前 5 张即可
  for (let k = 0; k < 5; k++) {
    const j = k + Math.floor(rng() * (deck.length - k));
    const tmp = deck[k];
    deck[k] = deck[j];
    deck[j] = tmp;
  }
  return {
    hero: [deck[0], deck[1]],
    board: [deck[2], deck[3], deck[4]],
    type: rng() < 0.5 ? "attack" : "defense",
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

/** 出一道完整的题：发场景 + 实算胜率 + 推导答案（同步，约几十 ms，调用方负责异步化） */
export function generatePostflopQuiz(
  rng: () => number = Math.random,
  iterations: number = QUIZ_ITERATIONS,
): PostflopQuiz {
  const scenario = dealPostflopScenario(rng);
  const equity = evaluateScenario(scenario, iterations);
  const defenseEquity =
    scenario.type === "defense"
      ? equityVsRange(scenario.hero, scenario.board, DEFENSE_RANGE_SPEC, iterations, rng)
      : null;
  const draws = analyzeDraws(scenario.hero, scenario.board);
  return {
    ...scenario,
    equity,
    defenseEquity,
    draws,
    answer: judgePostflop(
      equity.win,
      scenario.type,
      defenseEquity ?? undefined,
      draws,
    ),
  };
}

export const CHOICE_LABEL: Record<PostflopChoice, string> = {
  aggressive: "下注/加注",
  passive: "过牌/跟注",
  fold: "弃牌",
};

/** 判定后的一句话简评（防守题引用对下注者范围的胜率） */
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
      return `对下注者范围（前 60%）实算胜率 ${dPct}%${tie}，超过 68% 加注线——价值加注榨取，别给便宜看牌`;
    }
    case "fold":
      return `对下注者范围（前 60%）实算胜率 ${dPct}%${tie}，不足 28%——半池注需 25% 赔率也够不上，弃牌`;
    case "passive":
      return quiz.type === "attack"
        ? `实算胜率 ${pct}%${tie}，不够进攻线——过牌控池、免费看转牌，别用弱牌造池`
        : `对下注者范围（前 60%）实算胜率 ${dPct}%${tie}，够 28% 跟注线但不够 68% 加注线——中对/弱对的标准打法是跟注看转牌，加注只会打走差的留下强的`;
  }
}
