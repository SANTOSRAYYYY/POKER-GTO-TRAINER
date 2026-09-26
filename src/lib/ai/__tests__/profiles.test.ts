import { describe, expect, it } from "vitest";
import type { ConcreteAIStyle } from "@/lib/types";
import { AI_PROFILES, assignStyles, HEURISTIC_PARAMS, resolveStyle } from "../profiles";

const ALL_STYLES: ConcreteAIStyle[] = [
  "nit", "tag", "lag", "maniac", "calling_station", "gto",
];

describe("AI_PROFILES", () => {
  it("覆盖全部 6 种具体风格且字段完整", () => {
    expect(Object.keys(AI_PROFILES).sort()).toEqual([...ALL_STYLES].sort());
    for (const style of ALL_STYLES) {
      const p = AI_PROFILES[style];
      expect(p.id).toBe(style);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      // 人设提示词应足够具体
      expect(p.personaPrompt.length).toBeGreaterThan(30);
    }
  });

  it("启发式参数齐全且在 0-1 区间", () => {
    for (const style of ALL_STYLES) {
      const params = HEURISTIC_PARAMS[style];
      expect(params).toBeDefined();
      for (const v of [params.vpip, params.aggression, params.bluffFreq]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("风格参数符合人设相对关系", () => {
    expect(HEURISTIC_PARAMS.nit.vpip).toBeLessThan(HEURISTIC_PARAMS.lag.vpip);
    expect(HEURISTIC_PARAMS.maniac.aggression).toBeGreaterThan(
      HEURISTIC_PARAMS.calling_station.aggression,
    );
    expect(HEURISTIC_PARAMS.maniac.bluffFreq).toBeGreaterThan(
      HEURISTIC_PARAMS.nit.bluffFreq,
    );
  });
});

describe("resolveStyle", () => {
  it("具体风格原样返回", () => {
    for (const s of ALL_STYLES) expect(resolveStyle(s)).toBe(s);
  });

  it("'random' 返回具体风格", () => {
    for (let i = 0; i < 50; i++) {
      const s = resolveStyle("random");
      expect(ALL_STYLES).toContain(s);
      expect(s).not.toBe("random");
    }
  });

  it("'random' 多次抽样能覆盖多种风格", () => {
    const seen = new Set<ConcreteAIStyle>();
    for (let i = 0; i < 200; i++) seen.add(resolveStyle("random"));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("assignStyles", () => {
  it("具体风格：全员同风格", () => {
    expect(assignStyles(5, "lag")).toEqual(["lag", "lag", "lag", "lag", "lag"]);
    expect(assignStyles(1, "nit")).toEqual(["nit"]);
  });

  it("count<=0 返回空数组", () => {
    expect(assignStyles(0, "random")).toEqual([]);
    expect(assignStyles(0, "tag")).toEqual([]);
  });

  it("'random' 且 count<=6 时不重复（洗牌式无放回抽取）", () => {
    for (let i = 0; i < 50; i++) {
      const r6 = assignStyles(6, "random");
      expect(r6).toHaveLength(6);
      expect(new Set(r6).size).toBe(6);
      expect([...r6].sort()).toEqual([...ALL_STYLES].sort());

      const r3 = assignStyles(3, "random");
      expect(r3).toHaveLength(3);
      expect(new Set(r3).size).toBe(3);
    }
  });

  it("'random' 且 count>6 时允许重复，但前 6 个不重复", () => {
    for (let i = 0; i < 50; i++) {
      const r = assignStyles(9, "random");
      expect(r).toHaveLength(9);
      expect(new Set(r.slice(0, 6)).size).toBe(6);
      for (const s of r) expect(ALL_STYLES).toContain(s);
    }
  });

  it("'random' 多次调用产生不同排列（分布覆盖）", () => {
    const firsts = new Set<ConcreteAIStyle>();
    for (let i = 0; i < 100; i++) firsts.add(assignStyles(6, "random")[0]);
    expect(firsts.size).toBeGreaterThan(1);
  });
});
