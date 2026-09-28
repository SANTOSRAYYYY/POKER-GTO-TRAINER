/**
 * riverQuiz.ts（河牌圈出题器）测试
 *
 * - 发牌：7 张互不重复、hero 2 + board 5；种子 rng 可复现；子题型合法
 * - 精确枚举：riverEquityExact 确定性（无蒙特卡洛误差）、概率和 = 1、
 *   坚果 win = 1、与 equity() 河牌口径同量级
 * - 判定边界：价值 60% 线 / 抓诈 33% 线 / 诈唬 25%·45% 线（±0.01 卡点）
 * - 用户历史案例回归：纯空气 <25%——面对满池注弃牌、无人下注则诈唬
 *   （弃牌/诈唬的正确区分）；弱牌有摊牌价值（25-45%）不诈唬
 * - 混合场景：50 题内三种子题型都出现、答案分布合理
 * - 点评文案含胜率数字且解释摊牌价值
 */
import { describe, expect, it } from "vitest";
import type { Card } from "@/lib/types";
import {
  dealRiverScenario,
  drawRiverLine,
  generateRiverQuiz,
  isTooObvious,
  judgeRiver,
  RIVER_BLUFFCATCH_CALL_THRESHOLD,
  RIVER_BLUFFCATCH_POLAR_SPEC,
  RIVER_BLUFF_MAX_EQUITY,
  RIVER_SHOWDOWN_VALUE_MAX,
  RIVER_THIN_VALUE_MIN,
  RIVER_VALUE_BET_THRESHOLD,
  RIVER_VALUE_CALLER_2STREET_SPEC,
  RIVER_VALUE_CALLER_SPEC,
  riverEquityExact,
  riverQuizComment,
  riverValueCallerSpecFor,
  type RiverQuiz,
} from "../riverQuiz";
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

describe("dealRiverScenario 发牌", () => {
  it("7 张牌互不重复，hero 2 张 + 公共牌 5 张", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = dealRiverScenario(lcg(seed));
      const all = [...s.hero, ...s.board];
      expect(new Set(all).size).toBe(7);
      expect(s.hero).toHaveLength(2);
      expect(s.board).toHaveLength(5);
      for (const card of all) expect(card).toMatch(/^[2-9TJQKA][shdc]$/);
      expect(["value", "bluffcatch", "bluff"]).toContain(s.type);
    }
  });

  it("同一种子 rng 发同样的牌（可复现）", () => {
    expect(dealRiverScenario(lcg(42))).toEqual(dealRiverScenario(lcg(42)));
  });
});

describe("riverEquityExact 精确枚举", () => {
  it("结果确定（两次调用逐比特一致），概率和 = 1", () => {
    const hero = c("7s 2d") as [Card, Card];
    const board = c("Ac Kd Qh 9c 4s");
    const a = riverEquityExact(hero, board);
    const b = riverEquityExact(hero, board);
    expect(a).toEqual(b);
    expect(a.win + a.tie + a.lose).toBeCloseTo(1, 12);
  });

  it("坚果（天顺 J♠T♠ 在 A♣K♦Q♥9♣4♠）win ≈ 1（仅同牌平分）", () => {
    const r = riverEquityExact(c("Js Ts") as [Card, Card], c("Ac Kd Qh 9c 4s"));
    expect(r.win).toBeGreaterThan(0.99);
    expect(r.lose).toBe(0);
  });

  it("纯空气 7♠2♦ 在 A♣K♦Q♥9♣4♠：精确胜率 ~8.5%（< 25%）", () => {
    const r = riverEquityExact(c("7s 2d") as [Card, Card], c("Ac Kd Qh 9c 4s"));
    expect(r.win).toBeLessThan(RIVER_BLUFF_MAX_EQUITY);
    expect(r.win).toBeGreaterThan(0.05);
    expect(r.win).toBeLessThan(0.12);
  });

  it("拒绝重复牌与不足 5 张的公共牌", () => {
    expect(() =>
      riverEquityExact(c("As 2d") as [Card, Card], c("Ac Kd Qh 9c As")),
    ).toThrow();
    expect(() =>
      riverEquityExact(c("7s 2d") as [Card, Card], c("Ac Kd Qh 9c")),
    ).toThrow();
  });
});

describe("judgeRiver 判定边界（±0.01 卡点）", () => {
  it("价值题：对跟注范围 ≥60% 下注（含 0.60 边界），否则过牌", () => {
    expect(judgeRiver(0.9, "value", 0.61)).toBe("aggressive");
    expect(judgeRiver(0.9, "value", RIVER_VALUE_BET_THRESHOLD)).toBe("aggressive");
    expect(judgeRiver(0.9, "value", 0.59)).toBe("passive");
    expect(judgeRiver(0.9, "value", 0.44)).toBe("passive");
  });

  it("抓诈题：对极化范围 ≥33% 跟注（含 0.33 边界），否则弃牌", () => {
    expect(judgeRiver(0.1, "bluffcatch", 0.34)).toBe("passive");
    expect(judgeRiver(0.1, "bluffcatch", RIVER_BLUFFCATCH_CALL_THRESHOLD)).toBe("passive");
    expect(judgeRiver(0.1, "bluffcatch", 0.32)).toBe("fold");
    expect(judgeRiver(0.1, "bluffcatch", 0.05)).toBe("fold");
  });

  it("诈唬题：<25% 纯空气 → 诈唬（含 0.25 边界进摊牌价值带）", () => {
    expect(judgeRiver(0.24, "bluff")).toBe("aggressive");
    expect(judgeRiver(RIVER_BLUFF_MAX_EQUITY, "bluff")).toBe("passive");
    expect(judgeRiver(0.26, "bluff")).toBe("passive");
  });

  it("诈唬题：25-45% 有摊牌价值过牌；≥45% 价值下注（含 0.45 边界）", () => {
    expect(judgeRiver(0.44, "bluff")).toBe("passive");
    expect(judgeRiver(RIVER_SHOWDOWN_VALUE_MAX, "bluff")).toBe("aggressive");
    expect(judgeRiver(0.46, "bluff")).toBe("aggressive");
    expect(judgeRiver(0.9, "bluff")).toBe("aggressive");
  });

  it("抓诈/价值题不传范围胜率时回退用 win（兼容签名）", () => {
    expect(judgeRiver(0.61, "value")).toBe("aggressive");
    expect(judgeRiver(0.1, "bluffcatch")).toBe("fold");
  });
});

describe("generateRiverQuiz 实算回归", () => {
  const boardAir = c("Ac Kd Qh 9c 4s");

  it("用户历史案例：纯空气 7♠2♦ 面对满池注 → 弃牌（对极化范围 ~7% < 33%）", () => {
    const hero = c("7s 2d") as [Card, Card];
    const eq = equityVsRange(hero, boardAir, RIVER_BLUFFCATCH_POLAR_SPEC, 4000, lcg(7));
    expect(eq).toBeLessThan(RIVER_BLUFFCATCH_CALL_THRESHOLD);
    expect(judgeRiver(riverEquityExact(hero, boardAir).win, "bluffcatch", eq)).toBe("fold");
  });

  it("同一手纯空气在无人下注时 → 诈唬（<25%）：弃牌/诈唬的正确区分", () => {
    const hero = c("7s 2d") as [Card, Card];
    const exact = riverEquityExact(hero, boardAir);
    // 面对满池注：弃牌（上一条）；无人下注：诈唬（正确答案 aggressive）
    expect(judgeRiver(exact.win, "bluff")).toBe("aggressive");
    expect(exact.win).toBeLessThan(RIVER_BLUFF_MAX_EQUITY);
  });

  it("A 高牌 A♥5♦ 在 K♥9♦7♣6♠2♥：~29% 有摊牌价值 → 过牌不诈唬", () => {
    const hero = c("Ah 5d") as [Card, Card];
    const board = c("Kh 9d 7c 6s 2h");
    const exact = riverEquityExact(hero, board);
    expect(exact.win).toBeGreaterThanOrEqual(RIVER_BLUFF_MAX_EQUITY);
    expect(exact.win).toBeLessThan(RIVER_SHOWDOWN_VALUE_MAX);
    expect(judgeRiver(exact.win, "bluff")).toBe("passive");
  });

  it("顶两对 A♥K♥ 对跟注范围 ~94% ≥ 60% → 价值下注", () => {
    const hero = c("Ah Kh") as [Card, Card];
    const eq = equityVsRange(hero, boardAir, RIVER_VALUE_CALLER_SPEC, 4000, lcg(7));
    expect(eq).toBeGreaterThanOrEqual(RIVER_VALUE_BET_THRESHOLD);
    expect(judgeRiver(riverEquityExact(hero, boardAir).win, "value", eq)).toBe("aggressive");
  });

  it("9♥9♦ 在 K♥8♦5♣2♠2♥ 对跟注范围 ~52%（45-60% 薄价值带）→ 过牌", () => {
    const hero = c("9h 9d") as [Card, Card];
    const board = c("Kh 8d 5c 2s 2h");
    const eq = equityVsRange(hero, board, RIVER_VALUE_CALLER_SPEC, 4000, lcg(7));
    expect(eq).toBeGreaterThanOrEqual(RIVER_THIN_VALUE_MIN);
    expect(eq).toBeLessThan(RIVER_VALUE_BET_THRESHOLD);
    expect(judgeRiver(riverEquityExact(hero, board).win, "value", eq)).toBe("passive");
  });

  it("两对 A♠Q♠ 对极化范围 ~90% ≥ 33% → 跟注抓诈", () => {
    const hero = c("As Qs") as [Card, Card];
    const eq = equityVsRange(hero, boardAir, RIVER_BLUFFCATCH_POLAR_SPEC, 4000, lcg(7));
    expect(eq).toBeGreaterThanOrEqual(RIVER_BLUFFCATCH_CALL_THRESHOLD);
    expect(judgeRiver(riverEquityExact(hero, boardAir).win, "bluffcatch", eq)).toBe("passive");
  });
});

describe("generateRiverQuiz 混合场景与整题", () => {
  // 50 题循环逐题精确枚举 + 范围蒙特卡洛，全仓并行跑时 CPU 争抢会超默认 5s——显式放宽
  it(
    "50 题内三种子题型都出现，答案分布合理（三种答案都有）",
    () => {
      const rng = lcg(2026);
      const types = new Set<string>();
      const answers = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const q: RiverQuiz = generateRiverQuiz(rng, 400);
        types.add(q.type);
        answers.add(q.answer);
        expect(q.answer).toBe(
          judgeRiver(q.equity.win, q.type, q.rangeEquity ?? undefined),
        );
        expect(q.equity.win + q.equity.tie + q.equity.lose).toBeCloseTo(1, 9);
        if (q.type === "bluff") expect(q.rangeEquity).toBeNull();
        else expect(q.rangeEquity).not.toBeNull();
      }
      expect(types.size).toBe(3);
      expect(answers.size).toBe(3);
    },
    30000,
  );

  it(
    "riverQuizComment 含胜率数字",
    () => {
      for (let seed = 1; seed <= 6; seed++) {
        const q = generateRiverQuiz(lcg(seed), 400);
        const text = riverQuizComment(q);
        expect(text.length).toBeGreaterThan(10);
        const shown =
          q.rangeEquity !== null
            ? (q.rangeEquity * 100).toFixed(1)
            : (q.equity.win * 100).toFixed(1);
        expect(text).toContain(shown);
      }
    },
    15000,
  );

  it("摊牌价值概念出现在相关点评中（诈唬过牌/薄价值过牌/纯空气诈唬）", () => {
    const showdownQuiz: RiverQuiz = {
      hero: c("Ah 5d") as [Card, Card],
      board: c("Kh 9d 7c 6s 2h") as [Card, Card, Card, Card, Card],
      type: "bluff",
      actionLine: [{ zh: "翻前：测试线", en: "Preflop: test line" }],
      lineKind: "open",
      equity: riverEquityExact(c("Ah 5d") as [Card, Card], c("Kh 9d 7c 6s 2h")),
      rangeEquity: null,
      answer: "passive",
    };
    expect(showdownQuiz.answer).toBe(
      judgeRiver(showdownQuiz.equity.win, "bluff"),
    );
    expect(riverQuizComment(showdownQuiz)).toContain("摊牌价值");

    const thinQuiz: RiverQuiz = {
      hero: c("9h 9d") as [Card, Card],
      board: c("Kh 8d 5c 2s 2h") as [Card, Card, Card, Card, Card],
      type: "value",
      actionLine: [{ zh: "翻前：测试线", en: "Preflop: test line" }],
      lineKind: "open",
      equity: riverEquityExact(c("9h 9d") as [Card, Card], c("Kh 8d 5c 2s 2h")),
      rangeEquity: 0.522,
      answer: "passive",
    };
    expect(riverQuizComment(thinQuiz)).toContain("摊牌价值");

    const airBluff: RiverQuiz = {
      hero: c("7s 2d") as [Card, Card],
      board: c("Ac Kd Qh 9c 4s") as [Card, Card, Card, Card, Card],
      type: "bluff",
      actionLine: [{ zh: "翻前：测试线", en: "Preflop: test line" }],
      lineKind: "open",
      equity: riverEquityExact(c("7s 2d") as [Card, Card], c("Ac Kd Qh 9c 4s")),
      rangeEquity: null,
      answer: "aggressive",
    };
    expect(riverQuizComment(airBluff)).toContain("摊牌价值");
  });
});

describe("行动线生成", () => {
  it("三个子题型的行动线各 4 行、覆盖到河牌、双语、行内无重复，kind 合法", () => {
    const rng = lcg(77);
    const kindsByType = new Map<string, Set<string>>();
    for (let i = 0; i < 90; i++) {
      const s = dealRiverScenario(rng);
      expect(s.actionLine.length).toBe(4);
      expect(new Set(s.actionLine.map((l) => l.zh)).size).toBe(4);
      for (const line of s.actionLine) {
        expect(line.zh.length).toBeGreaterThan(4);
        expect(line.en.length).toBeGreaterThan(4);
      }
      expect(s.actionLine[0].zh).toContain("翻前");
      expect(s.actionLine[3].zh).toContain("河牌");
      const kinds = kindsByType.get(s.type) ?? new Set<string>();
      kinds.add(s.lineKind);
      kindsByType.set(s.type, kinds);
    }
    expect(kindsByType.get("value")!.size).toBe(2);
    expect(kindsByType.get("bluffcatch")!.size).toBe(2);
    expect(kindsByType.get("bluff")!.size).toBe(2);
    // bluff 没有 threeBet 线，flat 线是其第二种路线
    expect([...kindsByType.get("bluff")!].sort()).toEqual(["flat", "open"]);
  });

  it("范围收窄联动：value 的 threeBet 线（前两街都跟了）topPct 0.4 < open 线 0.5；抓诈极化范围不变", () => {
    expect(riverValueCallerSpecFor("open")).toEqual(RIVER_VALUE_CALLER_SPEC);
    expect(riverValueCallerSpecFor("flat")).toEqual(RIVER_VALUE_CALLER_SPEC);
    expect(riverValueCallerSpecFor("threeBet")).toEqual(
      RIVER_VALUE_CALLER_2STREET_SPEC,
    );
    expect(riverValueCallerSpecFor("threeBet").topPct).toBeLessThan(
      riverValueCallerSpecFor("open").topPct,
    );
    // 抓诈题极化范围不随行动线收窄
    expect(RIVER_BLUFFCATCH_POLAR_SPEC).toEqual({ topPct: 0.25, bluffPct: 0.35 });
  });

  it("drawRiverLine 同一种子可复现", () => {
    expect(drawRiverLine("value", lcg(5))).toEqual(drawRiverLine("value", lcg(5)));
  });
});

describe("难度过滤（反脑残）", () => {
  it("抓诈题：判定胜率 0.1（纯垃圾面对满池弃牌）必被重发，0.5 保留，>0.85 重发", () => {
    expect(isTooObvious(0.1, "bluffcatch", 0.1)).toBe(true);
    expect(isTooObvious(0.5, "bluffcatch", 0.5)).toBe(false);
    expect(isTooObvious(0.9, "bluffcatch", 0.9)).toBe(true);
    expect(isTooObvious(0.5, "bluffcatch", 0.2)).toBe(false); // 边界：<20% 才重发
  });

  it("薄价值题：对跟注范围 >85%（无脑价值）或 <25%（纯空气过牌）重发", () => {
    expect(isTooObvious(0.9, "value", 0.9)).toBe(true);
    expect(isTooObvious(0.3, "value", 0.1)).toBe(true);
    expect(isTooObvious(0.5, "value", 0.5)).toBe(false);
    expect(isTooObvious(0.3, "value", 0.25)).toBe(false); // 边界保留
  });

  it("诈唬题：精确胜率 <25%（纯空气必诈）或 >85%（坚果级）重发，摊牌价值带保留", () => {
    expect(isTooObvious(0.1, "bluff")).toBe(true);
    expect(isTooObvious(0.9, "bluff")).toBe(true);
    expect(isTooObvious(0.35, "bluff")).toBe(false);
    expect(isTooObvious(0.5, "bluff")).toBe(false);
  });

  it(
    "生成的 40 道题全部不在显而易见区",
    () => {
      const rng = lcg(2028);
      for (let i = 0; i < 40; i++) {
        const q = generateRiverQuiz(rng, 400);
        expect(
          isTooObvious(q.equity.win, q.type, q.rangeEquity ?? undefined),
        ).toBe(false);
        if (q.type === "bluffcatch") {
          expect(q.rangeEquity!).toBeGreaterThanOrEqual(0.2);
          expect(q.rangeEquity!).toBeLessThanOrEqual(0.85);
        }
        if (q.type === "value") {
          expect(q.rangeEquity!).toBeGreaterThanOrEqual(0.25);
          expect(q.rangeEquity!).toBeLessThanOrEqual(0.85);
        }
        if (q.type === "bluff") {
          expect(q.equity.win).toBeGreaterThanOrEqual(0.25);
          expect(q.equity.win).toBeLessThanOrEqual(0.85);
        }
      }
    },
    30000,
  );

  it("恒定 rng 极端情形：10 次上限兜底返回合法题，不死循环", () => {
    const q = generateRiverQuiz(() => 0, 200);
    expect(["aggressive", "passive", "fold"]).toContain(q.answer);
    expect(new Set([...q.hero, ...q.board]).size).toBe(7);
  });
});
