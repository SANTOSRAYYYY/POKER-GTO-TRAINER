/**
 * preflop3betQuiz.ts（翻前 3bet 应对出题器）测试
 *
 * - 发牌：hero 2 张互不重复；位置 BTN/CO 与 3bet 范围紧/松合法；种子可复现
 * - 判定边界：60% 4bet 线 / 45% 跟注线（±0.01 卡点）
 * - 静态表锚点（preflopEquityVsOpenRange 实算值）：
 *   AA/AKs → 4bet；AKo/TT/AJo → 跟注；66/KQs/72o → 弃牌
 * - 混合场景：50 题内两种位置、两档范围都出现，答案分布含 call 与 fold
 * - 点评文案含胜率数字与「对紧/松 3bet 范围」字样
 */
import { describe, expect, it } from "vitest";
import type { Card } from "@/lib/types";
import {
  dealPreflop3BetScenario,
  FOURBET_THRESHOLD,
  generatePreflop3BetQuiz,
  judge3bet,
  THREEBET_CALL_THRESHOLD,
  THREEBET_RANGE_LOOSE,
  THREEBET_RANGE_TIGHT,
  threeBetQuizComment,
} from "../preflop3betQuiz";

/** 线性同余种子 rng（测试可复现） */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("dealPreflop3BetScenario 发牌", () => {
  it("hero 2 张互不重复，位置与范围档合法", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = dealPreflop3BetScenario(lcg(seed));
      expect(new Set(s.hero).size).toBe(2);
      for (const card of s.hero) expect(card).toMatch(/^[2-9TJQKA][shdc]$/);
      expect(["BTN", "CO"]).toContain(s.position);
      expect([THREEBET_RANGE_TIGHT, THREEBET_RANGE_LOOSE]).toContain(
        s.threeBetRangePct,
      );
    }
  });

  it("同一种子 rng 发同样的牌（可复现）", () => {
    expect(dealPreflop3BetScenario(lcg(42))).toEqual(dealPreflop3BetScenario(lcg(42)));
  });
});

describe("judge3bet 判定边界（±0.01 卡点）", () => {
  it("≥60% → 4bet（含 0.60 边界）", () => {
    expect(judge3bet(0.61)).toBe("fourbet");
    expect(judge3bet(FOURBET_THRESHOLD)).toBe("fourbet");
    expect(judge3bet(0.59)).toBe("call");
  });

  it("45-60% → 跟注（含 0.45 边界）；<45% → 弃牌", () => {
    expect(judge3bet(0.46)).toBe("call");
    expect(judge3bet(THREEBET_CALL_THRESHOLD)).toBe("call");
    expect(judge3bet(0.44)).toBe("fold");
    expect(judge3bet(0.25)).toBe("fold");
  });
});

describe("generatePreflop3BetQuiz 静态表锚点（实算胜率表）", () => {
  /** 固定种子出题直到拿到指定 label 的题 */
  function quizOf(label: string, tight?: boolean) {
    for (let seed = 1; seed < 200000; seed++) {
      const q = generatePreflop3BetQuiz(lcg(seed));
      if (q.handLabel !== label) continue;
      if (tight !== undefined) {
        const want = tight ? THREEBET_RANGE_TIGHT : THREEBET_RANGE_LOOSE;
        if (q.threeBetRangePct !== want) continue;
      }
      return q;
    }
    throw new Error(`未抽到 ${label}`);
  }

  it("AA（84.3%）与 AKs（60.6%）→ 4bet", () => {
    const aa = quizOf("AA");
    expect(aa.equity).toBeCloseTo(0.843, 3);
    expect(aa.answer).toBe("fourbet");
    const aks = quizOf("AKs");
    expect(aks.equity).toBeCloseTo(0.606, 3);
    expect(aks.answer).toBe("fourbet");
  });

  it("AKo（59.2%）/ TT（56.0%）/ AJo（47.0%）→ 跟注（45-60% 带）", () => {
    for (const [label, eq] of [
      ["AKo", 0.592],
      ["TT", 0.56],
      ["AJo", 0.47],
    ] as const) {
      const q = quizOf(label);
      expect(q.equity).toBeCloseTo(eq, 3);
      expect(q.answer).toBe("call");
    }
  });

  it("66（44.0% 紧贴 45% 线下方）/ KQs（42.0%）/ 72o（25.3%）→ 弃牌", () => {
    for (const [label, eq] of [
      ["66", 0.44],
      ["KQs", 0.42],
      ["72o", 0.253],
    ] as const) {
      const q = quizOf(label);
      expect(q.equity).toBeCloseTo(eq, 3);
      expect(q.answer).toBe("fold");
    }
  });

  it("紧/松两档范围当前映射同一静态表档（15% 档），胜率一致（量化注记回归）", () => {
    const tight = quizOf("TT", true);
    const loose = quizOf("TT", false);
    expect(tight.threeBetRangePct).toBe(THREEBET_RANGE_TIGHT);
    expect(loose.threeBetRangePct).toBe(THREEBET_RANGE_LOOSE);
    expect(tight.equity).toBe(loose.equity);
  });
});

describe("generatePreflop3BetQuiz 混合场景与点评", () => {
  it("50 题内两种位置、两档范围都出现，三种答案都有且弃牌占多数", () => {
    const rng = lcg(42);
    const positions = new Set<string>();
    const tiers = new Set<number>();
    const counts = new Map<string, number>();
    for (let i = 0; i < 50; i++) {
      const q = generatePreflop3BetQuiz(rng);
      positions.add(q.position);
      tiers.add(q.threeBetRangePct);
      counts.set(q.answer, (counts.get(q.answer) ?? 0) + 1);
      expect(q.answer).toBe(judge3bet(q.equity));
      expect(q.handLabel).toMatch(/^[2-9TJQKA]{2}[so]?$/);
    }
    expect(positions.size).toBe(2);
    expect(tiers.size).toBe(2);
    // 对 8-15% 的 3bet 范围：大多数起手牌该弃，少数中对/大 A 跟注，极强牌 4bet
    expect(counts.has("fourbet")).toBe(true);
    expect(counts.has("call")).toBe(true);
    expect(counts.get("fold")!).toBeGreaterThan(counts.get("call")!);
    expect(counts.get("fold")!).toBeGreaterThan(counts.get("fourbet")!);
  });

  it("threeBetQuizComment 含胜率数字与「对紧/松 3bet 范围」字样", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const q = generatePreflop3BetQuiz(lcg(seed));
      const text = threeBetQuizComment(q);
      expect(text).toContain((q.equity * 100).toFixed(1));
      expect(text).toContain(q.handLabel);
      const tightness = q.threeBetRangePct === THREEBET_RANGE_TIGHT ? "紧" : "松";
      expect(text).toContain(`对${tightness} 3bet 范围`);
    }
  });
});
