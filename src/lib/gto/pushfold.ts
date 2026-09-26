/**
 * src/lib/gto/pushfold.ts — 单挑（heads-up）SB 位（即 BTN，翻前先行动）
 * 短码 push/fold 表：169 种起手牌型 × 筹码深度（5/8/10/12/15bb）→ 全下或弃牌。
 *
 * 数据来源与精度说明：
 * - 公认的单挑 Nash 近似（push/fold 二元均衡，SB 只能全下或弃牌的简化博弈），
 *   与 holdemresources 等公开 HU Nash 表同量级，但并非逐格精算值——边界档
 *   的个别牌型与精确均衡差半档属正常，训练器场景够用。
 * - 组合数占比（按 1326 组合计）：5bb ≈ 75%、8bb ≈ 61%、10bb ≈ 56%、
 *   12bb ≈ 47%、15bb ≈ 39%。满足单调性：越深越紧（浅档范围 ⊇ 深档范围）。
 * - 10bb 档锚点：所有对子、所有 Ax、K2s+、K3o+、任意同花 Q、Q6o+、J4s+、
 *   J7o+、T6s+、T7o+、95s+、98o、85s+、75s+、64s、54s。
 * - 中间深度（如 11bb）由 nearestTableDepth 量化到最近表档（并列取更深/更紧
 *   的一档，保守）；超出 [5,15] 钳到端点。
 *
 * 表示法：每档两张阈值表 suitedMinKicker / offsuitMinKicker，
 * 键 = 高牌 RankValue（A=14…2=2），值 = 入范围的最小踢脚 RankValue
 * （踢脚 < 高牌；缺键 = 该高牌整行不入范围）。对子在所有档一律全下。
 */
import type { Card, Rank, RankValue } from "@/lib/types";
import { handLabel } from "@/lib/gto/ranges";

export type PushFoldDepth = 5 | 8 | 10 | 12 | 15;
export const PUSH_FOLD_DEPTHS: readonly PushFoldDepth[] = [5, 8, 10, 12, 15];

export type PushFoldAction = "push" | "fold";

/** 高牌 → 入范围最小踢脚（RankValue）。仅列至少有一格入范围的高牌。 */
type KickerTable = Readonly<Partial<Record<RankValue, RankValue>>>;

interface DepthRange {
  suited: KickerTable;
  offsuit: KickerTable;
}

/** 高/踢脚点数表 */
const V = {
  A: 14, K: 13, Q: 12, J: 11, T: 10, "9": 9, "8": 8, "7": 7,
  "6": 6, "5": 5, "4": 4, "3": 3, "2": 2,
} as const;

const RANK_VALUES: Record<Rank, RankValue> = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};

/**
 * 各深度 push 范围（近似 Nash；越深越紧，单调嵌套）。
 * 读法例：10bb offsuit[13]=3 ⇒ K3o+（K 高杂色踢脚 ≥3 全下）。
 */
export const PUSH_FOLD_RANGES: Readonly<Record<PushFoldDepth, DepthRange>> = {
  // ~75%：任意对子、任意同花、任意 Ax/Kx，Q3o+、J5o+、T6o+、96o+、85o+、76o、65o
  5: {
    suited: {
      [V.A]: 2, [V.K]: 2, [V.Q]: 2, [V.J]: 2, [V.T]: 2, [V["9"]]: 2,
      [V["8"]]: 2, [V["7"]]: 2, [V["6"]]: 2, [V["5"]]: 2, [V["4"]]: 2,
      [V["3"]]: 2,
    },
    offsuit: {
      [V.A]: 2, [V.K]: 2, [V.Q]: 3, [V.J]: 5, [V.T]: 6, [V["9"]]: 6,
      [V["8"]]: 5, [V["7"]]: 6, [V["6"]]: 5,
    },
  },
  // ~61%：任意对子；同花 A2s+/K2s+/Q2s+/J3s+/T5s+/95s+/84s+/74s+/63s+/53s/43s；
  //       杂色 A2+/K3o+/Q5o+/J7o+/T7o+/97o+/86o
  8: {
    suited: {
      [V.A]: 2, [V.K]: 2, [V.Q]: 2, [V.J]: 3, [V.T]: 5, [V["9"]]: 5,
      [V["8"]]: 4, [V["7"]]: 4, [V["6"]]: 3, [V["5"]]: 3, [V["4"]]: 3,
    },
    offsuit: {
      [V.A]: 2, [V.K]: 3, [V.Q]: 5, [V.J]: 7, [V.T]: 7, [V["9"]]: 7,
      [V["8"]]: 6,
    },
  },
  // ~56%：任意对子；同花 A2s+/K2s+/Q2s+/J4s+/T6s+/95s+/85s+/75s+/64s/54s；
  //       杂色 A2+/K3o+/Q6o+/J7o+/T7o+/98o
  10: {
    suited: {
      [V.A]: 2, [V.K]: 2, [V.Q]: 2, [V.J]: 4, [V.T]: 6, [V["9"]]: 5,
      [V["8"]]: 5, [V["7"]]: 5, [V["6"]]: 4, [V["5"]]: 4,
    },
    offsuit: {
      [V.A]: 2, [V.K]: 3, [V.Q]: 6, [V.J]: 7, [V.T]: 7, [V["9"]]: 8,
    },
  },
  // ~47%：任意对子；同花 A2s+/K2s+/Q3s+/J5s+/T7s+/97s+/86s/76s/65s/54s；
  //       杂色 A2+/K4o+/Q8o+/J9o+/T9o/98o
  12: {
    suited: {
      [V.A]: 2, [V.K]: 2, [V.Q]: 3, [V.J]: 5, [V.T]: 7, [V["9"]]: 7,
      [V["8"]]: 6, [V["7"]]: 6, [V["6"]]: 5, [V["5"]]: 4,
    },
    offsuit: {
      [V.A]: 2, [V.K]: 4, [V.Q]: 8, [V.J]: 9, [V.T]: 9, [V["9"]]: 8,
    },
  },
  // ~39%：任意对子；同花 A2s+/K2s+/Q7s+/J8s+/T8s+/98s/87s/76s/65s；
  //       杂色 A2+/K7o+/Q9o+/J9o+/T9o
  15: {
    suited: {
      [V.A]: 2, [V.K]: 2, [V.Q]: 7, [V.J]: 8, [V.T]: 8, [V["9"]]: 8,
      [V["8"]]: 7, [V["7"]]: 6, [V["6"]]: 5,
    },
    offsuit: {
      [V.A]: 2, [V.K]: 7, [V.Q]: 9, [V.J]: 9, [V.T]: 9,
    },
  },
};

/** 任意筹码深度 → 最近表档（并列取更深/更紧的一档；超出 [5,15] 钳端点） */
export function nearestTableDepth(bb: number): PushFoldDepth {
  let best: PushFoldDepth = 5;
  let bestDist = Infinity;
  for (const d of PUSH_FOLD_DEPTHS) {
    const dist = Math.abs(bb - d);
    if (dist < bestDist || (dist === bestDist && d > best)) {
      best = d;
      bestDist = dist;
    }
  }
  return best;
}

/** 起手牌型判定：hi ≥ lo（RankValue），suited，深度档 → push/fold */
export function pushFoldAction(
  hi: RankValue,
  lo: RankValue,
  suited: boolean,
  depth: PushFoldDepth,
): PushFoldAction {
  if (hi === lo) return "push"; // 对子所有深度一律全下
  const table = PUSH_FOLD_RANGES[depth];
  const min = (suited ? table.suited : table.offsuit)[hi];
  return min !== undefined && lo >= min ? "push" : "fold";
}

/** 手牌型标签（"AA" / "K8o" / "98s"），hi ≥ lo */
export function handTypeLabel(
  hi: RankValue,
  lo: RankValue,
  suited: boolean,
): string {
  if (hi === lo) return handLabel(14 - hi, 14 - lo);
  return suited ? handLabel(14 - hi, 14 - lo) : handLabel(14 - lo, 14 - hi);
}

export interface HandType {
  hi: RankValue;
  lo: RankValue;
  suited: boolean;
  /** 形如 "K8o" / "AA" / "98s" */
  label: string;
}

/** 两张底牌 → 169 手牌型（hi/lo/suited + 标签） */
export function cardsToHandType(c1: Card, c2: Card): HandType {
  const v1 = RANK_VALUES[c1[0] as Rank];
  const v2 = RANK_VALUES[c2[0] as Rank];
  const hi = Math.max(v1, v2) as RankValue;
  const lo = Math.min(v1, v2) as RankValue;
  const suited = c1[1] === c2[1];
  return { hi, lo, suited, label: handTypeLabel(hi, lo, suited) };
}

/** 任意实际筹码深度（bb）下的判定：量化到最近表档 */
export function pushFoldActionBB(
  c1: Card,
  c2: Card,
  stackBB: number,
): { action: PushFoldAction; depth: PushFoldDepth; hand: HandType } {
  const depth = nearestTableDepth(stackBB);
  const hand = cardsToHandType(c1, c2);
  return { action: pushFoldAction(hand.hi, hand.lo, hand.suited, depth), depth, hand };
}

/** 单档 push 组合数占比（%），模块加载时由范围表算得（对子 6 组合、同花 4、杂色 12） */
export const PUSH_COMBO_PCT: Readonly<Record<PushFoldDepth, number>> = (() => {
  const out = {} as Record<PushFoldDepth, number>;
  for (const d of PUSH_FOLD_DEPTHS) {
    let combos = 13 * 6; // 对子
    const { suited, offsuit } = PUSH_FOLD_RANGES[d];
    for (const [h, k] of Object.entries(suited)) {
      combos += (Number(h) - Number(k)) * 4;
    }
    for (const [h, k] of Object.entries(offsuit)) {
      combos += (Number(h) - Number(k)) * 12;
    }
    out[d] = Math.round((combos / 1326) * 1000) / 10;
  }
  return out;
})();
