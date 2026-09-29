/**
 * borderline.ts（判定胜率边界带高精度复核，A3）测试
 *
 * - 纯函数单元：isBorderline 边界带判定（含 ±0.03 端点）；
 *   rejudgeIfBorderline 带内复算被调用（计数断言，迭代数 = 20000）、
 *   带外不触发、原值返回
 * - 各族出题器集成（vi.mock 把 equityVsRange/equityMulti 换成可控假值）：
 *   基础精度判定胜率压在阈值边界带内时，答案由 20000 次复核值决定
 *   （基础值会判反——翻转即证明用了复核值），且展示胜率同步为复核值；
 *   边界带外批量出题 0 次复核
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Card } from "@/lib/types";
import type { RangeSpec } from "@/lib/ai/range";
import type { EquityResult } from "@/lib/poker/equity";
import {
  BORDERLINE_BAND,
  isBorderline,
  REJUDGE_ITERATIONS,
  rejudgeIfBorderline,
} from "../borderline";
import { generatePostflopQuiz, judgePostflop } from "../postflopQuiz";
import { generateTurnQuiz } from "../turnQuiz";
import { generateRiverQuiz } from "../riverQuiz";

/** 测试可控的胜率假值与调用计数（vi.mock 工厂函数提升，必须走 vi.hoisted） */
const state = vi.hoisted(() => ({
  REJUDGE: 20000,
  rangeBase: 0.3,
  rangeRefined: 0.5,
  multiBase: 0.56,
  multiRefined: 0.4,
  rangeCalls: [] as number[],
  multiCalls: [] as number[],
}));

vi.mock("@/lib/ai/range", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/ai/range")>();
  const equityVsRange = (
    _hero: [Card, Card],
    _board: Card[],
    _spec: RangeSpec,
    iterations: number = 400,
  ): number => {
    state.rangeCalls.push(iterations);
    return iterations >= state.REJUDGE ? state.rangeRefined : state.rangeBase;
  };
  return { ...mod, equityVsRange };
});

vi.mock("@/lib/poker/equity", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/poker/equity")>();
  const equityMulti = (
    _heroCards: Card[],
    _board: Card[],
    _opponents: number,
    iterations: number = 10000,
  ): EquityResult => {
    state.multiCalls.push(iterations);
    const win =
      iterations >= state.REJUDGE ? state.multiRefined : state.multiBase;
    return { win, tie: 0, lose: 1 - win };
  };
  return { ...mod, equityMulti };
});

/** 线性同余种子 rng（测试可复现） */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const rejudgeCount = (calls: number[]) =>
  calls.filter((n) => n >= REJUDGE_ITERATIONS).length;

beforeEach(() => {
  state.rangeCalls.length = 0;
  state.multiCalls.length = 0;
});

describe("isBorderline / rejudgeIfBorderline 纯函数", () => {
  it("常量：边界带 ±3pp，复核 20000 次", () => {
    expect(BORDERLINE_BAND).toBe(0.03);
    expect(REJUDGE_ITERATIONS).toBe(20000);
    expect(state.REJUDGE).toBe(REJUDGE_ITERATIONS); // mock 阈值与生产常量一致
  });

  it("距任一阈值 ≤3pp 即边界（含端点），否则不是", () => {
    expect(isBorderline(0.56, [0.55])).toBe(true);
    expect(isBorderline(0.52, [0.55])).toBe(true);
    expect(isBorderline(0.58, [0.55])).toBe(true); // 端点 +0.03
    expect(isBorderline(0.581, [0.55])).toBe(false);
    expect(isBorderline(0.31, [0.68, 0.28])).toBe(true); // 多阈值：距 0.28 恰好 0.03
    expect(isBorderline(0.5, [0.68, 0.28])).toBe(false);
  });

  it("边界带内：复算被调用一次且迭代数 = 20000，返回复核值（计数断言）", () => {
    const seen: number[] = [];
    const out = rejudgeIfBorderline(0.56, [0.55], (iters) => {
      seen.push(iters);
      return 0.54;
    });
    expect(seen).toEqual([REJUDGE_ITERATIONS]);
    expect(out).toBe(0.54);
  });

  it("边界带外：复算不触发，原值返回", () => {
    const seen: number[] = [];
    const out = rejudgeIfBorderline(0.62, [0.55], (iters) => {
      seen.push(iters);
      return 0.61;
    });
    expect(seen).toEqual([]);
    expect(out).toBe(0.62);
  });
});

describe("各族出题器集成：边界带内自动 20000 次复核", () => {
  // 注意：lcg(seed) 的首个输出在小 seed 区间几乎相同（首抽题型会恒定），
  // 必须用单流 rng 连抽才能让题型/对手数覆盖（与既有测试同约定）。
  it("postflop 防守：基础 0.29 越 0.28 跟注线会误判 call，复核 0.25 → fold 且只复核一次", () => {
    state.rangeBase = 0.29; // |0.29-0.28| = 0.01 → 边界带
    state.rangeRefined = 0.25;
    let found = false;
    const rng = lcg(101);
    for (let i = 0; i < 400 && !found; i++) {
      state.rangeCalls.length = 0;
      const q = generatePostflopQuiz(rng, 400);
      if (q.type !== "defense" || q.opponents !== 1) continue;
      found = true;
      // 基础精度下答案本会相反（证明答案由复核值决定）
      expect(judgePostflop(q.equity.win, "defense", 0.29, q.draws, 1)).toBe(
        "passive",
      );
      expect(q.defenseEquity).toBe(0.25); // 展示胜率同步为复核值
      expect(q.answer).toBe("fold");
      expect(rejudgeCount(state.rangeCalls)).toBe(1);
    }
    expect(found).toBe(true);
  });

  it("postflop 进攻：基础 0.56 越 0.55 进攻线会误判 aggressive，复核 0.40 → passive", () => {
    state.multiBase = 0.56; // |0.56-0.55| = 0.01 → 边界带
    state.multiRefined = 0.4;
    state.rangeBase = 0.5; // 防守线外，避免干扰
    let found = false;
    const rng = lcg(102);
    for (let i = 0; i < 400 && !found; i++) {
      state.multiCalls.length = 0;
      const q = generatePostflopQuiz(rng, 400);
      if (q.type !== "attack" || q.opponents !== 1) continue;
      found = true;
      expect(judgePostflop(0.56, "attack", undefined, q.draws, 1)).toBe(
        "aggressive",
      );
      expect(q.equity.win).toBe(0.4); // 展示胜率同步为复核值
      expect(q.answer).toBe("passive");
      expect(rejudgeCount(state.multiCalls)).toBe(1);
    }
    expect(found).toBe(true);
  });

  it("turn 第二枪：基础 0.56 越 0.55 线会误判 aggressive，复核 0.30 → passive", () => {
    state.rangeBase = 0.56;
    state.rangeRefined = 0.3;
    let found = false;
    const rng = lcg(103);
    for (let i = 0; i < 400 && !found; i++) {
      state.rangeCalls.length = 0;
      const q = generateTurnQuiz(rng, 400);
      if (q.type !== "barrel" || q.opponents !== 1) continue;
      found = true;
      expect(q.rangeEquity).toBe(0.3);
      expect(q.answer).toBe("passive"); // 0.30 < 0.35 半诈唬下限，与听牌无关
      expect(rejudgeCount(state.rangeCalls)).toBe(1);
    }
    expect(found).toBe(true);
  });

  it("river 价值题：基础 0.61 越 0.60 价值线会误判下注，复核 0.50 → passive", () => {
    state.rangeBase = 0.61;
    state.rangeRefined = 0.5;
    let found = false;
    const rng = lcg(104);
    for (let i = 0; i < 400 && !found; i++) {
      state.rangeCalls.length = 0;
      const q = generateRiverQuiz(rng, 400);
      if (q.type !== "value" || q.opponents !== 1) continue;
      found = true;
      expect(q.rangeEquity).toBe(0.5);
      expect(q.answer).toBe("passive");
      expect(rejudgeCount(state.rangeCalls)).toBe(1);
    }
    expect(found).toBe(true);
  });

  it("边界带外不触发：三族各 20 题（判定胜率 0.5 远离所有阈值）0 次复核", () => {
    state.rangeBase = 0.5;
    state.rangeRefined = 0.9;
    state.multiBase = 0.5;
    state.multiRefined = 0.9;
    const rng1 = lcg(7);
    for (let i = 0; i < 20; i++) generatePostflopQuiz(rng1, 400);
    const rng2 = lcg(8);
    for (let i = 0; i < 20; i++) generateTurnQuiz(rng2, 400);
    const rng3 = lcg(9);
    for (let i = 0; i < 20; i++) generateRiverQuiz(rng3, 400);
    expect(rejudgeCount(state.rangeCalls)).toBe(0);
    expect(rejudgeCount(state.multiCalls)).toBe(0);
  });
});
