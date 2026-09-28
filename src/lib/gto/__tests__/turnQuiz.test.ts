/**
 * turnQuiz.ts（转牌圈出题器）测试
 *
 * - 发牌：6 张互不重复、hero 2 + board 4；种子 rng 可复现；子题型合法
 * - 判定边界：第二枪 55% 进攻线 / 35% 半诈唬下限（±0.01 卡点），
 *   面对第二枪 68% 加注线 / 30% 跟注线（±0.01 卡点）
 * - 实算回归：超对继续第二枪、组合听半诈唬、空气弃牌等
 * - 混合场景：50 题内两种子题型都出现、答案分布不止一种
 * - 点评文案含胜率数字
 */
import { describe, expect, it } from "vitest";
import type { Card } from "@/lib/types";
import {
  dealTurnScenario,
  generateTurnQuiz,
  judgeTurn,
  TURN_BARREL_EQUITY_THRESHOLD,
  TURN_BARREL_SEMIBLUFF_MIN,
  TURN_CALLER_RANGE_SPEC,
  TURN_BETTOR_RANGE_SPEC,
  TURN_DEFENSE_CALL_THRESHOLD,
  TURN_DEFENSE_RAISE_THRESHOLD,
  turnQuizComment,
} from "../turnQuiz";
import { analyzeDraws, isStrongDraw } from "../postflopQuiz";
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

describe("dealTurnScenario 发牌", () => {
  it("6 张牌互不重复，hero 2 张 + 公共牌 4 张", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = dealTurnScenario(lcg(seed));
      const all = [...s.hero, ...s.board];
      expect(new Set(all).size).toBe(6);
      expect(s.hero).toHaveLength(2);
      expect(s.board).toHaveLength(4);
      for (const card of all) expect(card).toMatch(/^[2-9TJQKA][shdc]$/);
      expect(["barrel", "defense"]).toContain(s.type);
    }
  });

  it("同一种子 rng 发同样的牌（可复现）", () => {
    expect(dealTurnScenario(lcg(42))).toEqual(dealTurnScenario(lcg(42)));
  });
});

describe("judgeTurn 判定边界（±0.01 卡点）", () => {
  it("第二枪：对跟注者范围 ≥55% 进攻（含 0.55 边界），否则过牌", () => {
    expect(judgeTurn(0.56, "barrel")).toBe("aggressive");
    expect(judgeTurn(TURN_BARREL_EQUITY_THRESHOLD, "barrel")).toBe("aggressive");
    expect(judgeTurn(0.54, "barrel")).toBe("passive");
  });

  it("第二枪：35-55% 且强听牌 → 半诈唬进攻（含 0.35 边界）", () => {
    const draw = { flushDraw: true, straightOuts: 0 };
    expect(judgeTurn(0.45, "barrel", draw)).toBe("aggressive");
    expect(judgeTurn(TURN_BARREL_SEMIBLUFF_MIN, "barrel", draw)).toBe("aggressive");
    expect(judgeTurn(0.34, "barrel", draw)).toBe("passive");
  });

  it("第二枪：35-55% 无强听牌仍过牌（防误放宽）", () => {
    const noDraw = { flushDraw: false, straightOuts: 0 };
    expect(judgeTurn(0.45, "barrel", noDraw)).toBe("passive");
    expect(judgeTurn(0.45, "barrel")).toBe("passive");
  });

  it("面对第二枪：≥68% 加注（含 0.68 边界）", () => {
    expect(judgeTurn(0.69, "defense")).toBe("aggressive");
    expect(judgeTurn(TURN_DEFENSE_RAISE_THRESHOLD, "defense")).toBe("aggressive");
    expect(judgeTurn(0.67, "defense")).toBe("passive");
  });

  it("面对第二枪：≥30% 跟注（含 0.30 边界），否则弃牌", () => {
    expect(judgeTurn(0.31, "defense")).toBe("passive");
    expect(judgeTurn(TURN_DEFENSE_CALL_THRESHOLD, "defense")).toBe("passive");
    expect(judgeTurn(0.29, "defense")).toBe("fold");
    expect(judgeTurn(0.05, "defense")).toBe("fold");
  });

  it("第二枪题只进攻或过牌，不弃牌（没人下注无可弃）", () => {
    expect(judgeTurn(0.05, "barrel")).toBe("passive");
  });
});

describe("generateTurnQuiz 实算回归", () => {
  it("超对 AA 在干燥面继续第二枪（对跟注者范围 ~81% ≥ 55%）", () => {
    const hero = c("As Ah") as [Card, Card];
    const board = c("Ts 9d 2c 4h");
    const eq = equityVsRange(hero, board, TURN_CALLER_RANGE_SPEC, 4000, lcg(7));
    expect(eq).toBeGreaterThanOrEqual(TURN_BARREL_EQUITY_THRESHOLD);
    expect(judgeTurn(eq, "barrel", analyzeDraws(hero, board))).toBe("aggressive");
  });

  it("组合听 J♣T♣ 在 9♣8♣2♦4♥：对跟注者范围 ~44% + 强听牌 → 半诈唬第二枪", () => {
    const hero = c("Jc Tc") as [Card, Card];
    const board = c("9c 8c 2d 4h");
    const draws = analyzeDraws(hero, board);
    expect(isStrongDraw(draws)).toBe(true);
    const eq = equityVsRange(hero, board, TURN_CALLER_RANGE_SPEC, 4000, lcg(7));
    expect(eq).toBeGreaterThanOrEqual(TURN_BARREL_SEMIBLUFF_MIN);
    expect(eq).toBeLessThan(TURN_BARREL_EQUITY_THRESHOLD);
    expect(judgeTurn(eq, "barrel", draws)).toBe("aggressive");
  });

  it("空气 7♣2♦ 在 A♠K♥Q♦9♣ 面对第二枪 → 弃牌（~3% < 30%）", () => {
    const hero = c("7c 2d") as [Card, Card];
    const board = c("As Kh Qd 9c");
    const eq = equityVsRange(hero, board, TURN_BETTOR_RANGE_SPEC, 4000, lcg(7));
    expect(eq).toBeLessThan(TURN_DEFENSE_CALL_THRESHOLD);
    expect(judgeTurn(eq, "defense")).toBe("fold");
  });

  it("中对 9♥9♦ 在 T♥6♦2♣4♥ 面对第二枪 → 跟注（~54%，30-68% 之间）", () => {
    const hero = c("9h 9d") as [Card, Card];
    const board = c("Th 6d 2c 4h");
    const eq = equityVsRange(hero, board, TURN_BETTOR_RANGE_SPEC, 4000, lcg(7));
    expect(eq).toBeGreaterThanOrEqual(TURN_DEFENSE_CALL_THRESHOLD);
    expect(eq).toBeLessThan(TURN_DEFENSE_RAISE_THRESHOLD);
    expect(judgeTurn(eq, "defense")).toBe("passive");
  });
});

describe("generateTurnQuiz 混合场景与整题", () => {
  // 50 题循环逐题构建范围池 + 蒙特卡洛，全仓并行跑时 CPU 争抢会超默认 5s——显式放宽
  it(
    "50 题内两种子题型都出现，答案分布不止一种",
    () => {
      const rng = lcg(2026);
      const types = new Set<string>();
      const answers = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const q = generateTurnQuiz(rng, 400);
        types.add(q.type);
        answers.add(q.answer);
        // 答案与判定函数一致
        expect(q.answer).toBe(judgeTurn(q.rangeEquity, q.type, q.draws));
        expect(q.rangeEquity).toBeGreaterThanOrEqual(0);
        expect(q.rangeEquity).toBeLessThanOrEqual(1);
      }
      expect(types.size).toBe(2);
      expect(answers.size).toBeGreaterThan(1);
    },
    30000,
  );

  it(
    "turnQuizComment 返回含胜率百分比的非空简评",
    () => {
      for (let seed = 1; seed <= 6; seed++) {
        const q = generateTurnQuiz(lcg(seed), 400);
        const text = turnQuizComment(q);
        expect(text.length).toBeGreaterThan(10);
        expect(text).toContain((q.rangeEquity * 100).toFixed(1));
      }
    },
    15000,
  );

  it("半诈唬第二枪的点评包含听牌描述", () => {
    const hero = c("Jc Tc") as [Card, Card];
    const board = c("9c 8c 2d 4h") as [Card, Card, Card, Card];
    const draws = analyzeDraws(hero, board);
    const q = {
      hero,
      board,
      type: "barrel" as const,
      equity: { win: 0.4399, tie: 0, lose: 0.5601 },
      rangeEquity: 0.4399,
      draws,
      answer: judgeTurn(0.4399, "barrel", draws),
    };
    expect(q.answer).toBe("aggressive");
    const text = turnQuizComment(q);
    expect(text).toContain("44.0");
    expect(text).toContain("半诈唬");
  });
});
