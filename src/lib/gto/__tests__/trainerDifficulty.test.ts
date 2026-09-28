/**
 * trainerDifficulty.ts（出题难度过滤共享口径）测试
 *
 * - isDefenseLikeObvious：<20% 纯垃圾弃牌 / >85% 坚果级无脑 → 重发；边界 0.2/0.85 保留
 * - isOffenseLikeObvious：>85% 无脑价值 / <25% 且无听牌 → 重发；有听牌豁免
 * - isVsRangePreflopObvious：<25% / >75% → 重发；边界 0.25/0.75 保留
 * - FILTER_MAX_ATTEMPTS = 10（出题器重发上限的契约）
 */
import { describe, expect, it } from "vitest";
import {
  FILTER_MAX_ATTEMPTS,
  isDefenseLikeObvious,
  isOffenseLikeObvious,
  isVsRangePreflopObvious,
  OBVIOUS_AIR_MAX,
  OBVIOUS_DEFENSE_MAX,
  OBVIOUS_NUTS_MIN,
  OBVIOUS_VS_RANGE_MAX,
  OBVIOUS_VS_RANGE_MIN,
} from "../trainerDifficulty";

describe("isDefenseLikeObvious（防守/抓诈题）", () => {
  it("0.1 胜率（纯垃圾弃牌）必重发，0.5 保留", () => {
    expect(isDefenseLikeObvious(0.1)).toBe(true);
    expect(isDefenseLikeObvious(0.5)).toBe(false);
  });

  it("边界：<0.2 重发、0.2 保留；>0.85 重发、0.85 保留", () => {
    expect(isDefenseLikeObvious(0.19)).toBe(true);
    expect(isDefenseLikeObvious(OBVIOUS_DEFENSE_MAX)).toBe(false);
    expect(isDefenseLikeObvious(0.86)).toBe(true);
    expect(isDefenseLikeObvious(OBVIOUS_NUTS_MIN)).toBe(false);
  });
});

describe("isOffenseLikeObvious（进攻/薄价值题）", () => {
  it(">85% 无脑价值重发；<25% 无听牌重发、有听牌豁免", () => {
    expect(isOffenseLikeObvious(0.9, false)).toBe(true);
    expect(isOffenseLikeObvious(0.24, false)).toBe(true);
    expect(isOffenseLikeObvious(0.24, true)).toBe(false);
    expect(isOffenseLikeObvious(0.5, false)).toBe(false);
  });

  it("边界：0.25 无听牌保留（<25% 才重发）、0.85 保留", () => {
    expect(isOffenseLikeObvious(OBVIOUS_AIR_MAX, false)).toBe(false);
    expect(isOffenseLikeObvious(OBVIOUS_NUTS_MIN, false)).toBe(false);
  });
});

describe("isVsRangePreflopObvious（push/fold 与 3bet 题）", () => {
  it("<25% 无脑弃 / >75% 无脑推重发，0.5 保留", () => {
    expect(isVsRangePreflopObvious(0.1)).toBe(true);
    expect(isVsRangePreflopObvious(0.9)).toBe(true);
    expect(isVsRangePreflopObvious(0.5)).toBe(false);
  });

  it("边界：0.25 / 0.75 保留（严格不等号）", () => {
    expect(isVsRangePreflopObvious(OBVIOUS_VS_RANGE_MIN)).toBe(false);
    expect(isVsRangePreflopObvious(OBVIOUS_VS_RANGE_MAX)).toBe(false);
    expect(isVsRangePreflopObvious(0.249)).toBe(true);
    expect(isVsRangePreflopObvious(0.751)).toBe(true);
  });
});

describe("FILTER_MAX_ATTEMPTS", () => {
  it("重发上限为 10（防死循环契约）", () => {
    expect(FILTER_MAX_ATTEMPTS).toBe(10);
  });
});
