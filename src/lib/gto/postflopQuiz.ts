/**
 * src/lib/gto/postflopQuiz.ts — 翻后特训出题器（翻牌圈场景）
 *
 * 出题：随机发 hero 两张底牌 + 3 张公共牌（无重复），题型二选一：
 * - attack（进攻题）：翻牌圈无人下注，轮到你——主动进攻还是过牌？
 * - defense（防守题）：对手下注半个底池，轮到你——加注/跟注/弃牌？
 *
 * 判定口径（实算胜率驱动，equityMulti 对 1 名随机对手跑蒙特卡洛）：
 * - 胜率 ≥ 55% → aggressive（下注/加注进攻）；
 * - 胜率 ≤ 30% 且面对半池注（defense）→ fold（弃牌）；
 * - 其余 → passive（过牌/跟注）。
 * 进攻题（无人下注）不产生 fold 答案——没人下注时没有可弃的对象，弱牌过牌即可。
 *
 * 半池注的底池赔率是 25%（跟 0.5 池赢 1.5 池），弃牌线取 30% 是为无位置、
 * 无主动权时的实现折扣留余量。
 */
import type { Card } from "@/lib/types";
import { newDeck } from "@/lib/poker/cards";
import { equityMulti, type EquityResult } from "@/lib/poker/equity";

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
  /** 实算胜率（对 1 名随机对手，win/tie/lose 0-1） */
  equity: EquityResult;
  /** 由胜率与题型推导的标准答案 */
  answer: PostflopChoice;
}

/** 进攻线：胜率 ≥ 55% */
export const ATTACK_EQUITY_THRESHOLD = 0.55;
/** 弃牌线：面对半池注且胜率 ≤ 30% */
export const FOLD_EQUITY_THRESHOLD = 0.3;
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

/** 胜率 + 题型 → 标准答案（纯函数） */
export function judgePostflop(win: number, type: ScenarioType): PostflopChoice {
  if (win >= ATTACK_EQUITY_THRESHOLD) return "aggressive";
  if (type === "defense" && win <= FOLD_EQUITY_THRESHOLD) return "fold";
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
  return { ...scenario, equity, answer: judgePostflop(equity.win, scenario.type) };
}

export const CHOICE_LABEL: Record<PostflopChoice, string> = {
  aggressive: "下注/加注",
  passive: "过牌/跟注",
  fold: "弃牌",
};

/** 判定后的一句话简评（实算胜率口径） */
export function quizComment(quiz: PostflopQuiz): string {
  const pct = (quiz.equity.win * 100).toFixed(1);
  const tie =
    quiz.equity.tie >= 0.005
      ? `（另平局 ${(quiz.equity.tie * 100).toFixed(1)}%）`
      : "";
  switch (quiz.answer) {
    case "aggressive":
      return quiz.type === "attack"
        ? `实算胜率 ${pct}%${tie}，越过 55% 进攻线——牌力明显领先随机手，主动下注拿价值、直接收池`
        : `实算胜率 ${pct}%${tie}，面对半池注仍显著领先——加注进攻榨取价值，别给便宜看牌`;
    case "fold":
      return `实算胜率 ${pct}%${tie}，不足 30%——半池注虽只需 25% 赔率，但无主动权时实现率打折，弃牌`;
    case "passive":
      return quiz.type === "attack"
        ? `实算胜率 ${pct}%${tie}，不够进攻线——过牌控池、免费看转牌，别用弱牌造池`
        : `实算胜率 ${pct}%${tie}，够 25% 跟注赔率但不够加注——跟注看转牌，保持底池可控`;
  }
}
