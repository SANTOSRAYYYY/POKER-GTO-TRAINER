/**
 * src/lib/gto/pushfoldQuiz.ts — 单挑短码 push/fold 出题器
 *
 * 场景：单挑，你在 SB（即 BTN，翻前先行动），有效筹码 5-15bb 随机整数，
 * 全下还是弃牌？判定用 pushfold.ts 的 Nash 近似表（nearestTableDepth 量化）。
 *
 * 行动线（actionLine，双语单行）：单挑短码没有前序行动可讲，行动线固定为
 * 「单挑：你（SB/按钮位）有效筹码 {bb}bb，翻前你先行动」，与其他四族的
 * 场景接口（actionLine 字段）保持一致，页面统一渲染。
 *
 * 难度过滤（isTooObvious，见 trainerDifficulty.ts）：手牌对「跟注范围」的
 * 翻前胜率（preflopEquityVsOpenRange 静态表，PUSHFOLD_CALLER_RANGE_PCT
 * ≈ 顶部 18%，映射到 20% 档）<25%（纯垃圾无脑弃）或 >75%（坚果级无脑推，
 * 如 AA 86%）→ 重发，FILTER_MAX_ATTEMPTS 次上限兜底。
 */
import type { Card } from "@/lib/types";
import { newDeck } from "@/lib/poker/cards";
import { preflopEquityVsOpenRange } from "@/lib/ai/range";
import type { LocalizedText } from "@/lib/gto/actionLine";
import {
  FILTER_MAX_ATTEMPTS,
  isVsRangePreflopObvious,
} from "@/lib/gto/trainerDifficulty";
import {
  cardsToHandType,
  nearestTableDepth,
  pushFoldAction,
  type PushFoldAction,
  type PushFoldDepth,
} from "@/lib/gto/pushfold";

/** 难度过滤用——对手跟注全下的隐含范围：约顶部 18%（静态表映射到 20% 档） */
export const PUSHFOLD_CALLER_RANGE_PCT = 0.18;

export interface PushFoldScenario {
  cards: [Card, Card];
  /** 有效筹码（bb，5-15 随机整数） */
  stackBB: number;
  /** 本题的前文行动线（双语单行，页面渲染用） */
  actionLine: LocalizedText[];
}

export interface PushFoldQuiz extends PushFoldScenario {
  /** 169 牌型标签（如 "K8o"/"AA"/"98s"） */
  handLabel: string;
  /** 量化后的表档深度（5/8/10/12/15） */
  depth: PushFoldDepth;
  /** 对跟注范围的翻前胜率（静态表，0-1；难度过滤用，页面不展示） */
  equityVsCaller: number;
  /** 由 Nash 近似表推导的标准答案 */
  answer: PushFoldAction;
}

/** 单挑短码场景的行动线（单行，随筹码深度插值） */
export function pushFoldActionLine(stackBB: number): LocalizedText[] {
  return [
    {
      zh: `单挑：你（SB/按钮位）有效筹码 ${stackBB}bb，翻前你先行动`,
      en: `Heads-up: you're in the SB (button) with ${stackBB}bb effective — first to act preflop`,
    },
  ];
}

/**
 * 随机发一个 push/fold 场景：hero 2 张无重复 + 5-15bb 随机整数深度。
 * @param rng 随机源（默认 Math.random），注入以便测试可复现。
 */
export function dealPushFoldScenario(
  rng: () => number = Math.random,
): PushFoldScenario {
  const deck = newDeck();
  // 部分 Fisher-Yates：洗前 2 张即可
  for (let k = 0; k < 2; k++) {
    const j = k + Math.floor(rng() * (deck.length - k));
    const tmp = deck[k];
    deck[k] = deck[j];
    deck[j] = tmp;
  }
  const stackBB = 5 + Math.floor(rng() * 11);
  return {
    cards: [deck[0], deck[1]],
    stackBB,
    actionLine: pushFoldActionLine(stackBB),
  };
}

/**
 * 难度过滤（反脑残，纯函数）：对跟注范围胜率 <25%（纯垃圾无脑弃）
 * 或 >75%（坚果级无脑推）→ 重发。
 */
export function isTooObvious(equityVsCaller: number): boolean {
  return isVsRangePreflopObvious(equityVsCaller);
}

/**
 * 出一道完整的 push/fold 题（查表 + 静态胜率，同步瞬时返回）。
 * 显而易见的情形（isTooObvious）重发，FILTER_MAX_ATTEMPTS 次上限兜底。
 */
export function generatePushFoldQuiz(
  rng: () => number = Math.random,
): PushFoldQuiz {
  for (let attempt = 0; ; attempt++) {
    const scenario = dealPushFoldScenario(rng);
    const hand = cardsToHandType(scenario.cards[0], scenario.cards[1]);
    const depth = nearestTableDepth(scenario.stackBB);
    const equityVsCaller = preflopEquityVsOpenRange(
      hand.label,
      PUSHFOLD_CALLER_RANGE_PCT,
    );
    const answer = pushFoldAction(hand.hi, hand.lo, hand.suited, depth);
    if (attempt + 1 < FILTER_MAX_ATTEMPTS && isTooObvious(equityVsCaller)) {
      continue; // 显而易见的题重发
    }
    return {
      ...scenario,
      handLabel: hand.label,
      depth,
      equityVsCaller,
      answer,
    };
  }
}
