/**
 * pushfoldQuiz.ts（单挑短码 push/fold 出题器）测试
 *
 * - 发牌：2 张互不重复；stackBB ∈ [5,15] 整数；种子 rng 可复现
 * - 行动线：单行双语，含「单挑 / SB / 筹码深度」
 * - 判定一致性：answer 与 pushfold 表（nearestTableDepth + pushFoldAction）一致
 * - 难度过滤：isTooObvious 口径（对跟注范围胜率 <0.25 / >0.75 重发）；
 *   生成的题胜率恒在 [0.25, 0.75] 且 AA（86%）不再出现；
 *   恒定 rng 下 10 次兜底不死循环
 */
import { describe, expect, it } from "vitest";
import { preflopEquityVsOpenRange } from "@/lib/ai/range";
import {
  cardsToHandType,
  nearestTableDepth,
  pushFoldAction,
} from "@/lib/gto/pushfold";
import {
  dealPushFoldScenario,
  generatePushFoldQuiz,
  isTooObvious,
  PUSHFOLD_CALLER_RANGE_PCT,
  pushFoldActionLine,
} from "../pushfoldQuiz";
import { FILTER_MAX_ATTEMPTS } from "../trainerDifficulty";

/** 线性同余种子 rng（测试可复现） */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("dealPushFoldScenario 发牌", () => {
  it("2 张牌互不重复，stackBB 为 5-15 整数，行动线单行双语", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const s = dealPushFoldScenario(lcg(seed));
      expect(new Set(s.cards).size).toBe(2);
      for (const card of s.cards) expect(card).toMatch(/^[2-9TJQKA][shdc]$/);
      expect(Number.isInteger(s.stackBB)).toBe(true);
      expect(s.stackBB).toBeGreaterThanOrEqual(5);
      expect(s.stackBB).toBeLessThanOrEqual(15);
      expect(s.actionLine.length).toBe(1);
      expect(s.actionLine[0].zh).toContain("单挑");
      expect(s.actionLine[0].zh).toContain("SB");
      expect(s.actionLine[0].zh).toContain(`${s.stackBB}bb`);
      expect(s.actionLine[0].en).toContain("Heads-up");
      expect(s.actionLine[0].en).toContain(`${s.stackBB}bb`);
    }
  });

  it("同一种子 rng 发同样的牌（可复现）", () => {
    expect(dealPushFoldScenario(lcg(42))).toEqual(dealPushFoldScenario(lcg(42)));
  });

  it("pushFoldActionLine 随筹码深度插值", () => {
    expect(pushFoldActionLine(12)[0].zh).toContain("12bb");
    expect(pushFoldActionLine(12)[0].en).toContain("12bb");
  });
});

describe("generatePushFoldQuiz 整题", () => {
  it("答案与 pushfold 表一致；equityVsCaller 与静态表一致", () => {
    for (let seed = 50; seed < 70; seed++) {
      const q = generatePushFoldQuiz(lcg(seed));
      const hand = cardsToHandType(q.cards[0], q.cards[1]);
      expect(q.handLabel).toBe(hand.label);
      expect(q.depth).toBe(nearestTableDepth(q.stackBB));
      expect(q.answer).toBe(
        pushFoldAction(hand.hi, hand.lo, hand.suited, q.depth),
      );
      expect(q.equityVsCaller).toBe(
        preflopEquityVsOpenRange(q.handLabel, PUSHFOLD_CALLER_RANGE_PCT),
      );
    }
  });

  it("属性断言：对子恒为 push（与表的铁律一致）", () => {
    const rng = lcg(7);
    let pairs = 0;
    for (let i = 0; i < 200 && pairs < 3; i++) {
      const q = generatePushFoldQuiz(rng);
      if (q.handLabel.length === 2) {
        pairs++;
        // 对子推全下——但对子 AA 胜率 86% > 75% 会被过滤，出现的对子皆非 AA
        expect(q.answer).toBe("push");
        expect(q.handLabel).not.toBe("AA");
      }
    }
    expect(pairs).toBeGreaterThan(0);
  });
});

describe("难度过滤（反脑残）", () => {
  it("对跟注范围胜率 <25%（纯垃圾无脑弃）或 >75%（坚果级无脑推）重发，0.5 保留", () => {
    expect(isTooObvious(0.1)).toBe(true);
    expect(isTooObvious(0.86)).toBe(true); // AA 对跟注范围
    expect(isTooObvious(0.5)).toBe(false);
    expect(isTooObvious(0.25)).toBe(false); // 边界保留
    expect(isTooObvious(0.75)).toBe(false);
  });

  it("生成的 100 道题胜率全部落在 [0.25, 0.75]，AA（86%）被过滤", () => {
    const rng = lcg(999);
    for (let i = 0; i < 100; i++) {
      const q = generatePushFoldQuiz(rng);
      expect(q.equityVsCaller).toBeGreaterThanOrEqual(0.25);
      expect(q.equityVsCaller).toBeLessThanOrEqual(0.75);
      expect(q.handLabel).not.toBe("AA");
    }
  });

  it("恒定 rng 极端情形：10 次上限兜底返回合法题，不死循环", () => {
    expect(FILTER_MAX_ATTEMPTS).toBe(10);
    const q = generatePushFoldQuiz(() => 0);
    expect(["push", "fold"]).toContain(q.answer);
    expect(new Set(q.cards).size).toBe(2);
  });
});
