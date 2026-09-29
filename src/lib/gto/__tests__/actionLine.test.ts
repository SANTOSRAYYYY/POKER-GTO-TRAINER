/**
 * actionLine.ts（行动线共享基元）测试
 *
 * - drawOpenPos：候选在 UTG+1~BTN 内、无重复值定义、多 seed 抽样覆盖全部候选
 * - drawBetSize：只出 1/2 底池或 2/3 底池两档，双语齐全，带底池倍数 frac
 * - directPotOdds / potOddsText：按尺度算直接赔率（半池 25% / 2/3 池 28.6%）
 * - threeBetToText：9bb 双语
 * - rng 越界/端点鲁棒：rng()=0 取首项，rng()→1 钳到末项不越界
 */
import { describe, expect, it } from "vitest";
import {
  BET_SIZE_OPTS,
  directPotOdds,
  drawBetSize,
  drawOpenPos,
  OPEN_POS_OPTS,
  potOddsText,
  threeBetToText,
} from "../actionLine";

/** 线性同余种子 rng（测试可复现） */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("drawOpenPos 开局位", () => {
  it("候选清单为 UTG+1/LJ/HJ/CO/BTN，无重复", () => {
    expect(new Set(OPEN_POS_OPTS).size).toBe(OPEN_POS_OPTS.length);
    expect(OPEN_POS_OPTS).toContain("UTG+1");
    expect(OPEN_POS_OPTS).toContain("BTN");
  });

  it("单流多次抽样覆盖全部候选且都合法", () => {
    // 注意：lcg(seed) 的首个输出在小 seed 区间几乎相同，覆盖率测试必须用单流连抽
    const rng = lcg(7);
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const pos = drawOpenPos(rng);
      expect(OPEN_POS_OPTS).toContain(pos);
      seen.add(pos);
    }
    expect(seen.size).toBe(OPEN_POS_OPTS.length);
  });

  it("端点鲁棒：rng()=0 → 首项；rng()→1 → 末项（钳制不越界）", () => {
    expect(drawOpenPos(() => 0)).toBe(OPEN_POS_OPTS[0]);
    expect(drawOpenPos(() => 0.999999)).toBe(
      OPEN_POS_OPTS[OPEN_POS_OPTS.length - 1],
    );
  });
});

describe("drawBetSize 下注尺度", () => {
  it("只出 1/2 底池或 2/3 底池两档，双语齐全", () => {
    expect(BET_SIZE_OPTS.length).toBe(2);
    const rng = lcg(7);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const size = drawBetSize(rng);
      expect(["1/2 底池", "2/3 底池"]).toContain(size.zh);
      expect(["half pot", "2/3 pot"]).toContain(size.en);
      seen.add(size.zh);
    }
    expect(seen.size).toBe(2);
  });

  it("端点鲁棒：rng()=0 → 1/2 底池；rng()→1 → 2/3 底池", () => {
    expect(drawBetSize(() => 0).zh).toBe("1/2 底池");
    expect(drawBetSize(() => 0.999999).zh).toBe("2/3 底池");
  });

  it("带底池倍数 frac：1/2 池 = 0.5，2/3 池 = 2/3", () => {
    expect(drawBetSize(() => 0).frac).toBe(0.5);
    expect(drawBetSize(() => 0.999999).frac).toBeCloseTo(2 / 3, 12);
  });
});

describe("directPotOdds / potOddsText 直接赔率（A2）", () => {
  it("1/2 池 = 25%，2/3 池 ≈ 28.6%（跟 frac 池赢 1+2×frac 池）", () => {
    expect(directPotOdds(0.5)).toBe(0.25);
    expect(directPotOdds(2 / 3)).toBeCloseTo(2 / 7, 12);
    expect(directPotOdds(1)).toBeCloseTo(1 / 3, 12); // 满池 33%
  });

  it("百分比文案：25 →「25」，2/7 →「28.6」", () => {
    expect(potOddsText(0.5)).toBe("25");
    expect(potOddsText(2 / 3)).toBe("28.6");
    expect(potOddsText(1)).toBe("33.3");
  });
});

describe("threeBetToText", () => {
  it("3bet 尺度固定 9bb（双语）", () => {
    expect(threeBetToText()).toEqual({ zh: "9bb", en: "9bb" });
  });
});
