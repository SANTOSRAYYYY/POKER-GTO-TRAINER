import { describe, expect, it } from "vitest";
import { DEFAULT_BLIND_LEVELS } from "@/lib/types";
import {
  DEFAULT_TOURNAMENT,
  currentBlinds,
  nextLevel,
  shouldLevelUp,
} from "@/lib/poker/tournament";

describe("tournament: 默认配置", () => {
  it("DEFAULT_TOURNAMENT：1500 起始筹码、每级 8 手、默认升盲表", () => {
    expect(DEFAULT_TOURNAMENT.startStack).toBe(1500);
    expect(DEFAULT_TOURNAMENT.handsPerLevel).toBe(8);
    expect(DEFAULT_TOURNAMENT.levels).toBe(DEFAULT_BLIND_LEVELS);
    expect(DEFAULT_TOURNAMENT.levels).toHaveLength(10);
  });

  it("DEFAULT_BLIND_LEVELS：第 4 级起 ante = floor(bigBlind / 8)", () => {
    expect(DEFAULT_BLIND_LEVELS[0]).toEqual({ smallBlind: 10, bigBlind: 20, ante: 0 });
    expect(DEFAULT_BLIND_LEVELS[2]).toEqual({ smallBlind: 25, bigBlind: 50, ante: 0 });
    expect(DEFAULT_BLIND_LEVELS[3]).toEqual({ smallBlind: 50, bigBlind: 100, ante: 12 });
    expect(DEFAULT_BLIND_LEVELS[4]).toEqual({ smallBlind: 75, bigBlind: 150, ante: 18 });
    expect(DEFAULT_BLIND_LEVELS[6]).toEqual({ smallBlind: 150, bigBlind: 300, ante: 37 });
    expect(DEFAULT_BLIND_LEVELS[9]).toEqual({ smallBlind: 400, bigBlind: 800, ante: 100 });
    // 逐级单调不降
    for (let i = 1; i < DEFAULT_BLIND_LEVELS.length; i++) {
      expect(DEFAULT_BLIND_LEVELS[i].bigBlind).toBeGreaterThan(
        DEFAULT_BLIND_LEVELS[i - 1].bigBlind,
      );
      expect(DEFAULT_BLIND_LEVELS[i].ante).toBeGreaterThanOrEqual(
        DEFAULT_BLIND_LEVELS[i - 1].ante,
      );
    }
  });
});

describe("tournament: 纯函数", () => {
  it("currentBlinds 取级别，越界钳制", () => {
    expect(currentBlinds(0)).toEqual({ smallBlind: 10, bigBlind: 20, ante: 0 });
    expect(currentBlinds(3)).toEqual({ smallBlind: 50, bigBlind: 100, ante: 12 });
    expect(currentBlinds(99)).toEqual({ smallBlind: 400, bigBlind: 800, ante: 100 });
    expect(currentBlinds(-5)).toEqual({ smallBlind: 10, bigBlind: 20, ante: 0 });
  });

  it("shouldLevelUp：打满 handsPerLevel 即升", () => {
    expect(shouldLevelUp(7, 8)).toBe(false);
    expect(shouldLevelUp(8, 8)).toBe(true);
    expect(shouldLevelUp(9, 8)).toBe(true);
  });

  it("nextLevel 到顶停住", () => {
    expect(nextLevel(0)).toBe(1);
    expect(nextLevel(8)).toBe(9);
    expect(nextLevel(9)).toBe(9); // 最后一级停住
    // 与 currentBlinds 组合安全
    expect(currentBlinds(nextLevel(9))).toEqual(DEFAULT_BLIND_LEVELS[9]);
  });

  it("自定义 levels 表也可驱动", () => {
    const levels = [
      { smallBlind: 1, bigBlind: 2, ante: 0 },
      { smallBlind: 2, bigBlind: 4, ante: 1 },
    ];
    expect(currentBlinds(1, levels)).toEqual(levels[1]);
    expect(nextLevel(1, levels)).toBe(1);
  });
});
