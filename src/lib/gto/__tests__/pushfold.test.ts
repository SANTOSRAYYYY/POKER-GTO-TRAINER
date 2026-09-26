/**
 * pushfold.ts（单挑 SB 位 push/fold 表）测试
 *
 * - 铁律：AA 任何深度必推、72o 任何深度必弃
 * - 边界牌按表：每档取范围边沿内外各一手（如 10bb：K3o 推 / K2o 弃、
 *   95s 推 / 94s 弃），深度加深一格时边沿牌翻弃（85s：8bb 推 / 10bb 弃… 按表）
 * - 单调性：浅档范围 ⊇ 深档范围（169 型全量比对相邻档）
 * - 组合数占比窗口：5bb ~75%、10bb 55-60%、15bb ~40%
 * - nearestTableDepth：就近量化、并列取更深档、越界钳端点
 */
import { describe, expect, it } from "vitest";
import type { Card, Rank, RankValue } from "@/lib/types";
import { MATRIX_RANKS } from "@/lib/gto/ranges";
import {
  cardsToHandType,
  handTypeLabel,
  nearestTableDepth,
  PUSH_COMBO_PCT,
  PUSH_FOLD_DEPTHS,
  PUSH_FOLD_RANGES,
  pushFoldAction,
  pushFoldActionBB,
  type PushFoldDepth,
} from "../pushfold";

const RV: Record<string, RankValue> = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};

/** "K8o" / "AA" / "98s" → (hi, lo, suited) */
function parse(label: string): { hi: RankValue; lo: RankValue; suited: boolean } {
  const pair = label.length === 2;
  const suited = label.endsWith("s");
  const hi = RV[label[0]];
  const lo = RV[label[1]];
  return { hi, lo, suited: !pair && suited };
}

function actionOf(label: string, depth: PushFoldDepth): "push" | "fold" {
  const { hi, lo, suited } = parse(label);
  return pushFoldAction(hi, lo, suited, depth);
}

describe("铁律", () => {
  it("AA 任何深度必推", () => {
    for (const d of PUSH_FOLD_DEPTHS) expect(actionOf("AA", d)).toBe("push");
  });
  it("22（最小对子）任何深度必推", () => {
    for (const d of PUSH_FOLD_DEPTHS) expect(actionOf("22", d)).toBe("push");
  });
  it("72o 任何深度必弃", () => {
    for (const d of PUSH_FOLD_DEPTHS) expect(actionOf("72o", d)).toBe("fold");
  });
});

describe("边界牌按表", () => {
  // [手牌, 推的最深档（该档及以下推、更深弃）]
  const cases: Array<[string, PushFoldDepth]> = [
    ["A2o", 15], // 任意 Ax 全深度推
    ["K2s", 15], // 任意同花 K 全深度推
    ["K7o", 15],
    ["K6o", 12],
    ["K4o", 12],
    ["K3o", 10],
    ["K2o", 5], // 8bb 起 K3o+ → K2o 仅 5bb（任意 Kx）推
    ["Q7s", 15],
    ["Q6s", 12],
    ["Q3s", 12],
    ["Q2s", 10], // 12bb Q3s+ → Q2s 弃；10bb 起任意同花 Q
    ["Q9o", 15],
    ["Q8o", 12],
    ["Q7o", 10], // 10bb Q6o+ 含 Q7o；12bb Q8o+ 弃
    ["J8s", 15],
    ["J7s", 12],
    ["J5s", 12],
    ["J4s", 10],
    ["J3s", 8],
    ["J9o", 15],
    ["J7o", 10],
    ["J6o", 5], // 5bb J5o+ 含；8bb 起 J7o+ 弃
    ["T8s", 15],
    ["T7s", 12],
    ["T6s", 10],
    ["T5s", 8],
    ["T9o", 15],
    ["T7o", 10],
    ["T6o", 5], // 8bb T7o+ → T6o 仅 5bb 推
    ["98s", 15],
    ["97s", 12],
    ["95s", 10],
    ["98o", 12],
    ["97o", 8],
    ["87s", 15],
    ["86s", 12],
    ["85s", 10],
    ["84s", 8],
    ["86o", 8],
    ["85o", 5],
    ["76s", 15],
    ["75s", 10],
    ["74s", 8],
    ["76o", 5],
    ["65s", 15],
    ["64s", 10],
    ["54s", 12],
    ["53s", 8],
    ["43s", 8],
    ["32s", 5], // 仅 5bb 任意同花
    ["72s", 5],
  ];
  for (const [label, deepestPush] of cases) {
    it(`${label}：${deepestPush}bb 及以下推、更深弃`, () => {
      for (const d of PUSH_FOLD_DEPTHS) {
        expect(actionOf(label, d), `${label}@${d}bb`).toBe(
          d <= deepestPush ? "push" : "fold",
        );
      }
    });
  }
});

describe("单调性与占比", () => {
  const allTypes: Array<{ hi: RankValue; lo: RankValue; suited: boolean }> = [];
  for (let hi = 2; hi <= 14; hi++) {
    for (let lo = 2; lo <= 14; lo++) {
      if (lo > hi) continue;
      if (hi === lo) {
        allTypes.push({ hi: hi as RankValue, lo: lo as RankValue, suited: false });
      } else {
        allTypes.push({ hi: hi as RankValue, lo: lo as RankValue, suited: true });
        allTypes.push({ hi: hi as RankValue, lo: lo as RankValue, suited: false });
      }
    }
  }
  it("共 169 种手牌型", () => {
    expect(allTypes.length).toBe(169);
  });
  it("浅档范围 ⊇ 深档范围（相邻档全量比对）", () => {
    const order: PushFoldDepth[] = [15, 12, 10, 8, 5];
    for (let i = 0; i + 1 < order.length; i++) {
      const [deep, shallow] = [order[i], order[i + 1]];
      for (const t of allTypes) {
        if (pushFoldAction(t.hi, t.lo, t.suited, deep) === "push") {
          expect(
            pushFoldAction(t.hi, t.lo, t.suited, shallow),
            `${handTypeLabel(t.hi, t.lo, t.suited)} ${deep}→${shallow}`,
          ).toBe("push");
        }
      }
    }
  });
  it("组合数占比落在目标窗口（近似 Nash 量级）", () => {
    expect(PUSH_COMBO_PCT[5]).toBeGreaterThanOrEqual(70);
    expect(PUSH_COMBO_PCT[5]).toBeLessThanOrEqual(80);
    expect(PUSH_COMBO_PCT[10]).toBeGreaterThanOrEqual(55);
    expect(PUSH_COMBO_PCT[10]).toBeLessThanOrEqual(60);
    expect(PUSH_COMBO_PCT[15]).toBeGreaterThanOrEqual(36);
    expect(PUSH_COMBO_PCT[15]).toBeLessThanOrEqual(42);
    // 严格单调递减
    const pcts = PUSH_FOLD_DEPTHS.map((d) => PUSH_COMBO_PCT[d]);
    for (let i = 0; i + 1 < pcts.length; i++) {
      expect(pcts[i]).toBeGreaterThan(pcts[i + 1]);
    }
  });
});

describe("nearestTableDepth", () => {
  it("就近量化，并列取更深档，越界钳端点", () => {
    expect(nearestTableDepth(5)).toBe(5);
    expect(nearestTableDepth(6)).toBe(5);
    expect(nearestTableDepth(7)).toBe(8);
    expect(nearestTableDepth(8)).toBe(8);
    expect(nearestTableDepth(9)).toBe(10); // 并列 → 更深
    expect(nearestTableDepth(11)).toBe(12); // 并列 → 更深
    expect(nearestTableDepth(13)).toBe(12);
    expect(nearestTableDepth(14)).toBe(15);
    expect(nearestTableDepth(15)).toBe(15);
    expect(nearestTableDepth(3)).toBe(5);
    expect(nearestTableDepth(25)).toBe(15);
  });
});

describe("底牌转换与一体化查询", () => {
  it("cardsToHandType：高/低牌排序、同花判定、标签", () => {
    expect(cardsToHandType("Kc" as Card, "8d" as Card)).toMatchObject({
      hi: 13, lo: 8, suited: false, label: "K8o",
    });
    expect(cardsToHandType("8h" as Card, "Kh" as Card)).toMatchObject({
      hi: 13, lo: 8, suited: true, label: "K8s",
    });
    expect(cardsToHandType("As" as Card, "Ah" as Card).label).toBe("AA");
    // 标签与 ranges.ts 矩阵记号一致（A..2 降序、右上 s、左下 o）
    expect(handTypeLabel(13, 8, false)).toBe("K8o");
    expect(handTypeLabel(9, 8, true)).toBe("98s");
  });
  it("pushFoldActionBB：任意深度量化判定（11bb 按 12bb 档）", () => {
    const r = pushFoldActionBB("Qc" as Card, "7h" as Card, 11);
    expect(r.depth).toBe(12);
    expect(r.hand.label).toBe("Q7o");
    expect(r.action).toBe("fold"); // 12bb Q8o+
    expect(pushFoldActionBB("Qc" as Card, "7h" as Card, 8).action).toBe("push");
  });
  it("MATRIX_RANKS 与本地点数映射一致（防抄错）", () => {
    MATRIX_RANKS.forEach((r, i) => {
      expect(RV[r as Rank]).toBe(14 - i);
    });
  });
});
