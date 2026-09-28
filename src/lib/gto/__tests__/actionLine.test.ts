/**
 * actionLine.ts（行动线共享基元）测试
 *
 * - drawOpenPos：候选在 UTG+1~BTN 内、无重复值定义、多 seed 抽样覆盖全部候选
 * - drawBetSize：只出 1/2 底池或 2/3 底池两档，双语齐全
 * - threeBetToText：9bb 双语
 * - rng 越界/端点鲁棒：rng()=0 取首项，rng()→1 钳到末项不越界
 */
import { describe, expect, it } from "vitest";
import {
  BET_SIZE_OPTS,
  drawBetSize,
  drawOpenPos,
  OPEN_POS_OPTS,
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
});

describe("threeBetToText", () => {
  it("3bet 尺度固定 9bb（双语）", () => {
    expect(threeBetToText()).toEqual({ zh: "9bb", en: "9bb" });
  });
});
