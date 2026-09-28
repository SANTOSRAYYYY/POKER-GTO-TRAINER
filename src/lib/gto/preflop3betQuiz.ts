/**
 * src/lib/gto/preflop3betQuiz.ts — 翻前 3bet 应对出题器
 *
 * 场景：你在 BTN/CO（随机）开局加注，盲注位 3bet，轮到你——4bet / 跟注 / 弃牌？
 * hero 底牌按 open 角色从 hero 开局位（BTN ~48% / CO ~31%）的开局范围抽
 * （sampleHeroCards，见 heroRange.ts 的「底牌与行动线一致性」设计）——
 * 你既已开局加注，手里就不会是 72o 这类开局范围外的垃圾牌。
 * 行动线（actionLine，双语两行）三种真实常见路线：小盲 3bet / 大盲 3bet /
 * 大盲（激进型玩家）3bet；范围档位仍由 threeBetRangePct 决定（8% 紧 / 15% 松），
 * 行动线只补上下文叙述。
 *
 * 判定口径（实算驱动）：
 * - 手牌 label 推导复用 pushfold.cardsToHandType（ranges.ts 的 169 牌型记号：
 *   对子 / 同花 s / 杂色 o，如 "AA"/"AKs"/"AKo"）。
 * - 胜率用 ai/range.ts 的 preflopEquityVsOpenRange(label, rangePct)——
 *   169 牌型 × 范围档位的翻前真实胜率静态表（scripts/selfplay 离线蒙特卡洛
 *   生成，每格 4000 次迭代）。
 * - 3bet 范围两档：8%（紧）/ 15%（松，出题时随机）。
 *     ≥ 60% → fourbet（4bet 反手加注）；
 *     45-60% → call（跟注利用位置看翻后）；
 *     < 45% → fold（对 3bet 范围落后太多，弃牌止损）。
 *
 * 难度过滤（isTooObvious，见 trainerDifficulty.ts）：对范围胜率 <25%
 * （无脑弃）或 >75%（坚果级无脑 4bet，如对紧范围 84% 的 AA）→
 * 重发，FILTER_MAX_ATTEMPTS 次上限兜底。底牌限到开局范围后 <25% 的
 * 纯垃圾已不存在（开局范围最弱牌对 3bet 也有 ~28%+），该下限实际休眠，
 * >75% 坚果级过滤仍必需（AA/KK 照样会发到）。
 *
 * 实现注记（静态表档位量化）：preflopEquityVsOpenRange 把 rangePct 映射到
 * 最近的 PREFLOP_RANGE_TIERS 档位（[0.15, 0.2, 0.28, 0.4, 0.55]），当前
 * 8% 与 15% 都落到最紧的 15% 档，两档胜率数值相同——松紧随机影响场景叙述
 * 与教学语境，判定阈值一致。若 range.ts 未来补充更紧的档位，这里自动生效。
 */
import type { Card } from "@/lib/types";
import { preflopEquityVsOpenRange } from "@/lib/ai/range";
import { threeBetToText, type LocalizedText } from "@/lib/gto/actionLine";
import { sampleHeroCards } from "@/lib/gto/heroRange";
import {
  FILTER_MAX_ATTEMPTS,
  isVsRangePreflopObvious,
} from "@/lib/gto/trainerDifficulty";
import { cardsToHandType } from "@/lib/gto/pushfold";

/** 三选项：4bet / 跟注 / 弃牌 */
export type ThreeBetChoice = "fourbet" | "call" | "fold";

/** 开局位置：按钮位 / 关煞位 */
export type ThreeBetPosition = "BTN" | "CO";

/** 行动线种类：小盲 3bet / 大盲 3bet / 大盲（激进型）3bet */
export type ThreeBetLineKind = "sb" | "bb" | "aggro";

export interface Preflop3BetScenario {
  hero: [Card, Card];
  position: ThreeBetPosition;
  /** 对手 3bet 范围宽度（顶部牌型占比）：0.08 紧 / 0.15 松 */
  threeBetRangePct: 0.08 | 0.15;
  /** 本题的前文行动线（双语两行，页面渲染用） */
  actionLine: LocalizedText[];
  /** 行动线种类（哪个盲注 3bet / 是否激进画像） */
  lineKind: ThreeBetLineKind;
}

export interface Preflop3BetQuiz extends Preflop3BetScenario {
  /** 169 牌型标签（如 "AKs"/"77"） */
  handLabel: string;
  /** 对 3bet 范围的翻前胜率（静态表，0-1） */
  equity: number;
  /** 由胜率推导的标准答案 */
  answer: ThreeBetChoice;
}

/** 4bet 线：对 3bet 范围胜率 ≥ 60% */
export const FOURBET_THRESHOLD = 0.6;
/** 跟注线：≥ 45%（45-60% 之间跟注看翻后） */
export const THREEBET_CALL_THRESHOLD = 0.45;
/** 3bet 范围两档：紧 8% / 松 15% */
export const THREEBET_RANGE_TIGHT = 0.08;
export const THREEBET_RANGE_LOOSE = 0.15;

/** 随机抽一条 3bet 应对行动线（rng 注入可复现）：小盲/大盲/激进大盲三种 */
export function drawThreeBetLine(
  position: ThreeBetPosition,
  rng: () => number = Math.random,
): { kind: ThreeBetLineKind; lines: LocalizedText[] } {
  const t = rng();
  const kind: ThreeBetLineKind = t < 1 / 3 ? "sb" : t < 2 / 3 ? "bb" : "aggro";
  const to = threeBetToText();
  const open: LocalizedText = {
    zh: `翻前：你（${position}）开局加注到 2.5bb`,
    en: `Preflop: you (${position}) open-raise to 2.5bb`,
  };
  if (kind === "sb") {
    return {
      kind,
      lines: [
        open,
        {
          zh: `小盲 3bet 到 ${to.zh}，大盲弃牌，轮到你`,
          en: `The small blind 3-bets to ${to.en}, the big blind folds — action on you`,
        },
      ],
    };
  }
  if (kind === "bb") {
    return {
      kind,
      lines: [
        open,
        {
          zh: `大盲 3bet 到 ${to.zh}，轮到你`,
          en: `The big blind 3-bets to ${to.en} — action on you`,
        },
      ],
    };
  }
  return {
    kind,
    lines: [
      open,
      {
        zh: `大盲（激进型玩家）3bet 到 ${to.zh}，轮到你`,
        en: `The big blind (an aggressive player) 3-bets to ${to.en} — action on you`,
      },
    ],
  };
}

/**
 * 随机发一个翻前 3bet 场景：位置 BTN/CO 随机，hero 底牌按 open 角色从
 * 该开局位的开局范围抽（牌与「你开局加注」的行动线一致），对手 3bet
 * 范围紧（8%）/松（15%）随机，并抽一条行动线（哪个盲注 3bet）。
 * @param rng 随机源（默认 Math.random），注入以便测试可复现。
 */
export function dealPreflop3BetScenario(
  rng: () => number = Math.random,
): Preflop3BetScenario {
  const position: ThreeBetPosition = rng() < 0.5 ? "BTN" : "CO";
  const hero = sampleHeroCards(rng, "open", { openPos: position });
  const threeBetRangePct =
    rng() < 0.5 ? THREEBET_RANGE_TIGHT : THREEBET_RANGE_LOOSE;
  const line = drawThreeBetLine(position, rng);
  return {
    hero,
    position,
    threeBetRangePct,
    actionLine: line.lines,
    lineKind: line.kind,
  };
}

/** 对 3bet 范围胜率 → 标准答案（纯函数） */
export function judge3bet(equity: number): ThreeBetChoice {
  if (equity >= FOURBET_THRESHOLD) return "fourbet";
  if (equity >= THREEBET_CALL_THRESHOLD) return "call";
  return "fold";
}

/**
 * 难度过滤（反脑残，纯函数）：对 3bet 范围胜率 <25%（纯垃圾无脑弃）
 * 或 >75%（坚果级无脑 4bet）→ 重发。
 */
export function isTooObvious(equity: number): boolean {
  return isVsRangePreflopObvious(equity);
}

/**
 * 出一道完整的翻前 3bet 题（纯静态表查表，同步瞬时返回）。
 * 显而易见的情形（isTooObvious）重发，FILTER_MAX_ATTEMPTS 次上限兜底。
 */
export function generatePreflop3BetQuiz(
  rng: () => number = Math.random,
): Preflop3BetQuiz {
  for (let attempt = 0; ; attempt++) {
    const scenario = dealPreflop3BetScenario(rng);
    const handLabel = cardsToHandType(scenario.hero[0], scenario.hero[1]).label;
    const equity = preflopEquityVsOpenRange(handLabel, scenario.threeBetRangePct);
    const answer = judge3bet(equity);
    if (attempt + 1 < FILTER_MAX_ATTEMPTS && isTooObvious(equity)) {
      continue; // 显而易见的题重发
    }
    return { ...scenario, handLabel, equity, answer };
  }
}

/** 判定后的一句话简评（中文库内版；页面组件走字典双语同逻辑） */
export function threeBetQuizComment(quiz: Preflop3BetQuiz): string {
  const pct = (quiz.equity * 100).toFixed(1);
  const tightness = quiz.threeBetRangePct === THREEBET_RANGE_TIGHT ? "紧" : "松";
  const rangePct = Math.round(quiz.threeBetRangePct * 100);
  switch (quiz.answer) {
    case "fourbet":
      return `${quiz.handLabel} 对${tightness} 3bet 范围（顶部约 ${rangePct}%）翻前胜率 ${pct}%，越过 60% 4bet 线——反手加注施压，别给便宜看翻牌`;
    case "call":
      return `${quiz.handLabel} 对${tightness} 3bet 范围（顶部约 ${rangePct}%）翻前胜率 ${pct}%，在 45-60% 之间——够跟注利用位置看翻后；4bet 只会打走差的留下强的`;
    case "fold":
      return `${quiz.handLabel} 对${tightness} 3bet 范围（顶部约 ${rangePct}%）翻前胜率 ${pct}%，不足 45%——落后太多，弃牌止损（开局遇 3bet，大部分牌都该弃）`;
  }
}
