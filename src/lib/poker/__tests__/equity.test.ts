import { describe, expect, it } from "vitest";
import type { Card } from "@/lib/types";
import { equity, equityMulti } from "@/lib/poker/equity";

const c = (s: string) => s.split(" ") as Card[];

describe("equity: 蒙特卡洛胜率", () => {
  it("AA vs KK 翻前胜率 ≈ 80%±5%", () => {
    const r = equity(c("As Ah"), c("Ks Kh"), [], 5000);
    expect(r.win).toBeGreaterThan(0.75);
    expect(r.win).toBeLessThan(0.85);
    expect(r.win + r.tie + r.lose).toBeCloseTo(1, 6);
  });

  it("同花听牌翻牌圈胜率在合理区间", () => {
    // hero AsKs 在 2s 7s Jd 面有同花听牌 + 两张高牌，对 QhQd 约 45%
    const r = equity(c("As Ks"), c("Qh Qd"), c("2s 7s Jd"), 5000);
    expect(r.win).toBeGreaterThan(0.35);
    expect(r.win).toBeLessThan(0.6);
    expect(r.win + r.tie + r.lose).toBeCloseTo(1, 6);
  });

  it("对手底牌未知（null）时随机抽：AA vs 随机 ≈ 85%", () => {
    const r = equity(c("As Ah"), null, [], 3000);
    expect(r.win).toBeGreaterThan(0.75);
    expect(r.win).toBeLessThan(0.95);
  });

  it("河牌圈牌面确定：结果退化为 0/1", () => {
    const r = equity(c("As Ah"), c("Ks Kh"), c("2h 3d 4c 5s 9h"), 500);
    expect(r.win).toBe(1);
    expect(r.tie).toBe(0);
    expect(r.lose).toBe(0);
  });

  it("稳赢局面 win=1（公共牌四条 + hero A 踢脚）", () => {
    // board 四条 2，hero 有 A 踢脚，对手 K 踢脚
    const r = equity(c("As 9h"), c("Ks Qd"), c("2h 2d 2c 2s 3h"), 500);
    expect(r.win).toBe(1);
  });

  it("参数校验", () => {
    expect(() => equity(c("As"), null, [])).toThrow();
    expect(() => equity(c("As Ah"), c("Ks"), [])).toThrow();
    expect(() => equity(c("As Ah"), c("As Kh"), [])).toThrow(); // 重复牌
    expect(() => equity(c("As Ah"), null, c("2h 3d 4c 5s 9h Th"))).toThrow();
    expect(() => equity(c("As Ah"), null, [], 0)).toThrow();
  });
});

describe("equityMulti: 多人底池胜率", () => {
  it("AA vs 5 个随机对手 ≈ 49%±5%（蒙特卡洛文献值；任务书 35% 对应的是 vs 8 个对手）", () => {
    const r = equityMulti(c("As Ah"), [], 5, 5000);
    expect(r.win).toBeGreaterThan(0.44);
    expect(r.win).toBeLessThan(0.55);
    expect(r.win + r.tie + r.lose).toBeCloseTo(1, 6);
  });

  it("对手数越多胜率越低；1 个随机对手退化为 ≈85%", () => {
    const one = equityMulti(c("As Ah"), [], 1, 3000);
    expect(one.win).toBeGreaterThan(0.75);
    expect(one.win).toBeLessThan(0.95);
    const three = equityMulti(c("As Ah"), [], 3, 3000);
    expect(three.win).toBeLessThan(one.win);
  });

  it("河牌圈牌面确定：结果退化为 0/1", () => {
    // hero 皇家同花顺（As Ks + Qs Js Ts），A/K 在 hero 手中，无人能追平
    const r = equityMulti(c("As Ks"), c("Qs Js Ts 2h 3d"), 2, 300);
    expect(r.win).toBe(1);
    expect(r.tie + r.lose).toBe(0);
  });

  it("参数校验", () => {
    expect(() => equityMulti(c("As"), [], 2)).toThrow();
    expect(() => equityMulti(c("As Ah"), [], 0)).toThrow();
    expect(() => equityMulti(c("As Ah"), c("2h 3d 4c 5s 9h Th"), 2)).toThrow();
    expect(() => equityMulti(c("As Ah"), c("As 3d"), 2)).toThrow(); // 重复牌
    expect(() => equityMulti(c("As Ah"), [], 25)).toThrow(); // 牌不够发
    expect(() => equityMulti(c("As Ah"), [], 2, 0)).toThrow();
  });
});
