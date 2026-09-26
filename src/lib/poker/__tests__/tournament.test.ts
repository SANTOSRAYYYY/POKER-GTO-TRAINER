import { describe, expect, it } from "vitest";
import { DEFAULT_BLIND_LEVELS } from "@/lib/types";
import {
  DEFAULT_TOURNAMENT,
  currentBlinds,
  extendLevelsInfinite,
  INFINITE_TOTAL_LEVELS,
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

  it("DEFAULT_BLIND_LEVELS：每级 ante = 该级大盲（含第 1 级）", () => {
    expect(DEFAULT_BLIND_LEVELS[0]).toEqual({ smallBlind: 10, bigBlind: 20, ante: 20 });
    expect(DEFAULT_BLIND_LEVELS[2]).toEqual({ smallBlind: 25, bigBlind: 50, ante: 50 });
    expect(DEFAULT_BLIND_LEVELS[3]).toEqual({ smallBlind: 50, bigBlind: 100, ante: 100 });
    expect(DEFAULT_BLIND_LEVELS[4]).toEqual({ smallBlind: 75, bigBlind: 150, ante: 150 });
    expect(DEFAULT_BLIND_LEVELS[6]).toEqual({ smallBlind: 150, bigBlind: 300, ante: 300 });
    expect(DEFAULT_BLIND_LEVELS[9]).toEqual({ smallBlind: 400, bigBlind: 800, ante: 800 });
    // 逐级单调不降；ante 恒等于大盲
    for (let i = 1; i < DEFAULT_BLIND_LEVELS.length; i++) {
      expect(DEFAULT_BLIND_LEVELS[i].bigBlind).toBeGreaterThan(
        DEFAULT_BLIND_LEVELS[i - 1].bigBlind,
      );
      expect(DEFAULT_BLIND_LEVELS[i].ante).toBeGreaterThanOrEqual(
        DEFAULT_BLIND_LEVELS[i - 1].ante,
      );
    }
    for (const lv of DEFAULT_BLIND_LEVELS) {
      expect(lv.ante).toBe(lv.bigBlind);
    }
  });
});

describe("tournament: 纯函数", () => {
  it("currentBlinds 取级别，越界钳制", () => {
    expect(currentBlinds(0)).toEqual({ smallBlind: 10, bigBlind: 20, ante: 20 });
    expect(currentBlinds(3)).toEqual({ smallBlind: 50, bigBlind: 100, ante: 100 });
    expect(currentBlinds(99)).toEqual({ smallBlind: 400, bigBlind: 800, ante: 800 });
    expect(currentBlinds(-5)).toEqual({ smallBlind: 10, bigBlind: 20, ante: 20 });
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

describe("tournament: extendLevelsInfinite（无限升盲扩展表）", () => {
  it("原 10 级原样保留，之后按大盲 ×2 生成至 40 级", () => {
    const ext = extendLevelsInfinite(DEFAULT_BLIND_LEVELS, INFINITE_TOTAL_LEVELS);
    expect(ext).toHaveLength(40);
    // 前 10 级与默认表一致
    for (let i = 0; i < DEFAULT_BLIND_LEVELS.length; i++) {
      expect(ext[i]).toEqual(DEFAULT_BLIND_LEVELS[i]);
    }
    // 第 11 级（索引 10）起：小盲/大盲 ×2，ante = 大盲
    expect(ext[10]).toEqual({ smallBlind: 800, bigBlind: 1600, ante: 1600 });
    expect(ext[11]).toEqual({ smallBlind: 1600, bigBlind: 3200, ante: 3200 });
    for (let i = DEFAULT_BLIND_LEVELS.length; i < ext.length; i++) {
      expect(ext[i].smallBlind).toBe(ext[i - 1].smallBlind * 2);
      expect(ext[i].bigBlind).toBe(ext[i - 1].bigBlind * 2);
      expect(ext[i].ante).toBe(ext[i].bigBlind);
    }
    // 顶级大盲 = 800 × 2^30
    expect(ext[39].bigBlind).toBe(800 * 2 ** 30);
  });

  it("不修改入参；与 nextLevel/currentBlinds 组合驱动升盲", () => {
    const snapshot = DEFAULT_BLIND_LEVELS.map((l) => ({ ...l }));
    const ext = extendLevelsInfinite(DEFAULT_BLIND_LEVELS, 15);
    expect(DEFAULT_BLIND_LEVELS).toEqual(snapshot);
    expect(ext).toHaveLength(15);
    expect(nextLevel(9, ext)).toBe(10); // 原顶级之后还能再升
    expect(currentBlinds(14, ext)).toEqual(ext[14]);
    expect(nextLevel(14, ext)).toBe(14); // 扩展表到顶同样停住
  });

  it("total <= 原表长度时原样返回（副本）；空表抛错", () => {
    const out = extendLevelsInfinite(DEFAULT_BLIND_LEVELS, 5);
    expect(out).toEqual(DEFAULT_BLIND_LEVELS);
    expect(out).not.toBe(DEFAULT_BLIND_LEVELS);
    expect(() => extendLevelsInfinite([], 10)).toThrow("levels 不能为空");
  });
});
