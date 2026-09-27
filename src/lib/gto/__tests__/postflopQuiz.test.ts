/**
 * postflopQuiz.ts（翻后特训出题器）测试
 *
 * - 发牌：5 张互不重复且都是合法牌；种子 rng 可复现；题型合法
 * - 判定规则：55% 进攻线（含边界）、防守题 30% 弃牌线（含边界）、
 *   进攻题弱牌只过牌不弃牌（没人下注无可弃）
 * - 实算胜率：四条 A 不败（win=1）、7-2 高牌垃圾面 < 30%
 * - 整题生成：答案与 judgePostflop 一致、win+tie+lose≈1
 */
import { describe, expect, it } from "vitest";
import type { Card } from "@/lib/types";
import {
  dealPostflopScenario,
  DEFENSE_CALL_THRESHOLD,
  DEFENSE_RANGE_SPEC,
  DEFENSE_RAISE_THRESHOLD,
  evaluateScenario,
  generatePostflopQuiz,
  judgePostflop,
  quizComment,
  type PostflopScenario,
} from "../postflopQuiz";
import { equityVsRange } from "@/lib/ai/range";

/** 线性同余种子 rng（测试可复现） */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const c = (s: string) => s.split(" ") as Card[];

describe("dealPostflopScenario 发牌", () => {
  it("5 张牌互不重复，hero 2 张 + 公共牌 3 张", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = dealPostflopScenario(lcg(seed));
      const all = [...s.hero, ...s.board];
      expect(new Set(all).size).toBe(5);
      expect(s.hero).toHaveLength(2);
      expect(s.board).toHaveLength(3);
      for (const card of all) expect(card).toMatch(/^[2-9TJQKA][shdc]$/);
      expect(["attack", "defense"]).toContain(s.type);
    }
  });

  it("同一种子 rng 发同样的牌（可复现）", () => {
    const a = dealPostflopScenario(lcg(42));
    const b = dealPostflopScenario(lcg(42));
    expect(a).toEqual(b);
  });

  it("题型随 rng 变化（1000 次抽样两种题型都出现）", () => {
    const rng = lcg(7);
    const types = new Set<string>();
    for (let i = 0; i < 1000; i++) types.add(dealPostflopScenario(rng).type);
    expect(types.size).toBe(2);
  });
});

describe("judgePostflop 判定规则", () => {
  it("进攻题：对随机胜率 ≥55% 进攻（含 0.55 边界），否则过牌", () => {
    expect(judgePostflop(0.55, "attack")).toBe("aggressive");
    expect(judgePostflop(0.8, "attack")).toBe("aggressive");
    expect(judgePostflop(0.549, "attack")).toBe("passive");
  });

  it("防守题：对下注者范围胜率 ≥68% 才加注（第三对子不再误判加注）", () => {
    // 0.55（旧规则的误判区）现在必须是跟注
    expect(judgePostflop(0.9, "defense", 0.55)).toBe("passive");
    expect(judgePostflop(0.9, "defense", 0.68)).toBe("aggressive");
    expect(judgePostflop(0.9, "defense", 0.8)).toBe("aggressive");
    expect(judgePostflop(0.9, "defense", 0.679)).toBe("passive");
  });

  it("防守题：<28% 弃牌（含 0.28 边界跟注）", () => {
    expect(judgePostflop(0.9, "defense", 0.28)).toBe("passive");
    expect(judgePostflop(0.9, "defense", 0.27)).toBe("fold");
    expect(judgePostflop(0.9, "defense", 0.12)).toBe("fold");
  });

  it("防守题不传范围胜率时回退用 win（兼容旧签名）", () => {
    expect(judgePostflop(0.7, "defense")).toBe("aggressive");
    expect(judgePostflop(0.12, "defense")).toBe("fold");
  });

  it("进攻题弱牌只过牌不弃牌", () => {
    expect(judgePostflop(0.3, "attack")).toBe("passive");
    expect(judgePostflop(0.05, "attack")).toBe("passive");
  });
});

describe("evaluateScenario 实算胜率", () => {
  it("四条 A 面不败：win = 1", () => {
    const s: PostflopScenario = {
      hero: c("As Ah") as [Card, Card],
      board: c("Ac Ad 2s") as [Card, Card, Card],
      type: "attack",
    };
    const r = evaluateScenario(s, 500);
    expect(r.win).toBe(1);
    expect(r.lose).toBe(0);
  });

  it("7-2 高牌垃圾面胜率 < 30%（应对应防守题弃牌）", () => {
    const s: PostflopScenario = {
      hero: c("7c 2d") as [Card, Card],
      board: c("As Kh Qd") as [Card, Card, Card],
      type: "defense",
    };
    const r = evaluateScenario(s, 3000);
    expect(r.win).toBeLessThan(0.3);
    expect(r.win + r.tie + r.lose).toBeCloseTo(1, 6);
  });

  it("翻牌圈中天顺面高胜率（>55%，应对应进攻）", () => {
    // hero JdTd 在 9s 8s 2c 面：两头顺 + 对子出路，对随机手大幅领先
    const s: PostflopScenario = {
      hero: c("Qh Jc") as [Card, Card],
      board: c("Ts 9d 2c") as [Card, Card, Card],
      type: "attack",
    };
    const r = evaluateScenario(s, 3000);
    expect(r.win).toBeGreaterThan(0.55);
  });
});

describe("generatePostflopQuiz 整题", () => {
  it("用户实报场景：2♦J♠ 在 T♠2♥K♥ 面对半池注 → 跟注（不判加注）", () => {
    // 第三对子 + J 踢脚：对随机胜率 ~55% 曾误判「加注」，对下注者范围应为跟注
    const scenario: PostflopScenario = {
      hero: c("2d Js") as [Card, Card],
      board: c("Ts 2h Kh") as [Card, Card, Card],
      type: "defense",
    };
    const defenseWin = equityVsRange(scenario.hero, scenario.board, DEFENSE_RANGE_SPEC, 3000, lcg(7));
    const answer = judgePostflop(0.553, "defense", defenseWin);
    expect(answer).not.toBe("aggressive"); // 对范围胜率应远低于 0.55
    expect(answer).toBe("passive");
    expect(defenseWin).toBeGreaterThanOrEqual(DEFENSE_CALL_THRESHOLD);
    expect(defenseWin).toBeLessThan(DEFENSE_RAISE_THRESHOLD);
  });

  it("答案与 judgePostflop(win, type, defenseEquity) 一致，概率和≈1", () => {
    for (let seed = 100; seed < 110; seed++) {
      const q = generatePostflopQuiz(lcg(seed), 800);
      expect(q.answer).toBe(
        judgePostflop(q.equity.win, q.type, q.defenseEquity ?? undefined),
      );
      expect(q.equity.win + q.equity.tie + q.equity.lose).toBeCloseTo(1, 5);
      if (q.type === "defense") {
        expect(q.defenseEquity).not.toBeNull();
        expect(q.defenseEquity!).toBeGreaterThanOrEqual(0);
        expect(q.defenseEquity!).toBeLessThanOrEqual(1);
      } else {
        expect(q.defenseEquity).toBeNull();
      }
    }
  });

  it("quizComment 返回含胜率百分比的非空简评", () => {
    const q = generatePostflopQuiz(lcg(1), 500);
    const text = quizComment(q);
    expect(text.length).toBeGreaterThan(10);
    expect(text).toContain((q.equity.win * 100).toFixed(1));
  });
});
