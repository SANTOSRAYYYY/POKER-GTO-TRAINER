/**
 * reference.ts（决策点 GTO 参考线）测试
 *
 * - decideTendency：各阈值边界（0.65 加注线 / 0.45 边际带 / 0.55 下注线）、
 *   跟注所需胜率比较（req > equity+0.03 → fold/strong；±0.03 内 → marginal；
 *   赔率覆盖 → call/strong）、无人下注时的 check/bet 分档
 * - requiredEquity：保本胜率公式
 * - referenceLine：翻前口径（AA 对 1 人 raise/strong、72o check/fold 降级）、
 *   多人底池胜率衰减（AA 对 4 人落入边际带）、翻后强牌主动进攻
 *   （Math.random 用种子桩替换，结果可复现）
 * - heroDecisionInput：从 HandRecord 重放推导 potBefore / callAmount /
 *   activeOpponents（含翻前盲注预置投入、跨街底池累计），及 null 情形
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Card, HandRecord, StreetRecord } from "@/lib/types";
import {
  decideTendency,
  heroDecisionInput,
  referenceLine,
  requiredEquity,
} from "../reference";

/** 线性同余种子 rng（测试可复现） */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const c = (s: string) => s.split(" ") as Card[];

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// requiredEquity / decideTendency（纯规则，确定性）
// ---------------------------------------------------------------------------

describe("requiredEquity 保本胜率", () => {
  it("callAmount/(pot+callAmount)：pot 100 跟 50 → 1/3", () => {
    expect(requiredEquity(100, 50)).toBeCloseTo(1 / 3, 10);
  });
  it("底池注：pot 100 跟 100 → 0.5", () => {
    expect(requiredEquity(100, 100)).toBe(0.5);
  });
  it("无需跟注 → 0", () => {
    expect(requiredEquity(100, 0)).toBe(0);
  });
});

describe("decideTendency 面对下注", () => {
  it("equity = 0.65（加注线含边界）→ raise/strong", () => {
    const r = decideTendency({ equity: 0.65, potBefore: 100, callAmount: 50 });
    expect(r).toMatchObject({ tendency: "raise", confidence: "strong" });
  });
  it("equity = 0.45（边际带下沿含边界）→ call/marginal", () => {
    const r = decideTendency({ equity: 0.45, potBefore: 100, callAmount: 10 });
    expect(r).toMatchObject({ tendency: "call", confidence: "marginal" });
  });
  it("0.45–0.65 带内 → call/marginal", () => {
    const r = decideTendency({ equity: 0.55, potBefore: 100, callAmount: 50 });
    expect(r).toMatchObject({ tendency: "call", confidence: "marginal" });
  });
  it("赔率不够：req 0.5 > equity 0.30 + 0.03 → fold/strong", () => {
    const r = decideTendency({ equity: 0.3, potBefore: 100, callAmount: 100 });
    expect(r).toMatchObject({ tendency: "fold", confidence: "strong" });
  });
  it("赔率优先于边际带：equity 0.46 在带内，但 req 0.5 > 0.46+0.03 → fold/strong", () => {
    const r = decideTendency({ equity: 0.46, potBefore: 100, callAmount: 100 });
    expect(r).toMatchObject({ tendency: "fold", confidence: "strong" });
  });
  it("±0.03 边缘：req 0.5 与 equity 0.48 差 0.02 → call/marginal（不弃牌）", () => {
    const r = decideTendency({ equity: 0.48, potBefore: 100, callAmount: 100 });
    expect(r).toMatchObject({ tendency: "call", confidence: "marginal" });
  });
  it("带外但赔率刚好：equity 0.38，req 0.4，差 0.02 → call/marginal", () => {
    const r = decideTendency({ equity: 0.38, potBefore: 60, callAmount: 40 });
    expect(r).toMatchObject({ tendency: "call", confidence: "marginal" });
  });
  it("带外且赔率覆盖：equity 0.30 > req 0.25 + 0.03 → call/strong", () => {
    const r = decideTendency({ equity: 0.3, potBefore: 90, callAmount: 30 });
    expect(r).toMatchObject({ tendency: "call", confidence: "strong" });
  });
});

describe("decideTendency 无人下注", () => {
  it("equity ≥ 0.65 → raise/strong（主动下注）", () => {
    const r = decideTendency({ equity: 0.7, potBefore: 100, callAmount: 0 });
    expect(r).toMatchObject({ tendency: "raise", confidence: "strong" });
  });
  it("equity = 0.55（下注线含边界）→ raise/marginal", () => {
    const r = decideTendency({ equity: 0.55, potBefore: 100, callAmount: 0 });
    expect(r).toMatchObject({ tendency: "raise", confidence: "marginal" });
  });
  it("0.45–0.55 → check/marginal", () => {
    const r = decideTendency({ equity: 0.5, potBefore: 100, callAmount: 0 });
    expect(r).toMatchObject({ tendency: "check", confidence: "marginal" });
  });
  it("equity < 0.45 → check/strong（弱牌过牌，不产生 fold）", () => {
    const r = decideTendency({ equity: 0.3, potBefore: 100, callAmount: 0 });
    expect(r).toMatchObject({ tendency: "check", confidence: "strong" });
  });
});

// ---------------------------------------------------------------------------
// referenceLine（实算胜率集成，Math.random 种子桩可复现）
// ---------------------------------------------------------------------------

describe("referenceLine 翻前口径（equityMulti 统一口径）", () => {
  it("AA 对 1 名随机对手：胜率 > 0.78 → raise/strong", () => {
    vi.spyOn(Math, "random").mockImplementation(lcg(7));
    const r = referenceLine(
      { heroCards: c("Ah Ad"), board: [], potBefore: 50, callAmount: 30, activeOpponents: 1 },
      2000,
    );
    expect(r.equity).toBeGreaterThan(0.78);
    expect(r).toMatchObject({ tendency: "raise", confidence: "strong" });
  });
  it("AA 对 4 名对手：胜率衰减进边际带 → call/marginal（降级）", () => {
    vi.spyOn(Math, "random").mockImplementation(lcg(11));
    const r = referenceLine(
      { heroCards: c("Ah Ad"), board: [], potBefore: 100, callAmount: 20, activeOpponents: 4 },
      2000,
    );
    expect(r.equity).toBeGreaterThan(0.45);
    expect(r.equity).toBeLessThan(0.65);
    expect(r).toMatchObject({ tendency: "call", confidence: "marginal" });
  });
  it("72o 对 1 人、无人下注：胜率 < 0.45 → check/strong", () => {
    vi.spyOn(Math, "random").mockImplementation(lcg(13));
    const r = referenceLine(
      { heroCards: c("7h 2d"), board: [], potBefore: 30, callAmount: 0, activeOpponents: 1 },
      2000,
    );
    expect(r.equity).toBeLessThan(0.45);
    expect(r).toMatchObject({ tendency: "check", confidence: "strong" });
  });
  it("72o 面对底池注：赔率不够 → fold/strong（降级）", () => {
    vi.spyOn(Math, "random").mockImplementation(lcg(17));
    const r = referenceLine(
      { heroCards: c("7h 2d"), board: [], potBefore: 100, callAmount: 100, activeOpponents: 1 },
      2000,
    );
    expect(r).toMatchObject({ tendency: "fold", confidence: "strong" });
  });
});

describe("referenceLine 翻后", () => {
  it("顶对顶踢脚（AsKs @ Kh7d2c）无人下注 → raise/strong", () => {
    vi.spyOn(Math, "random").mockImplementation(lcg(19));
    const r = referenceLine(
      {
        heroCards: c("As Ks"),
        board: c("Kh 7d 2c"),
        potBefore: 100,
        callAmount: 0,
        activeOpponents: 1,
      },
      2000,
    );
    expect(r.equity).toBeGreaterThan(0.8);
    expect(r).toMatchObject({ tendency: "raise", confidence: "strong" });
  });
  it("note 含胜率数值与理由", () => {
    vi.spyOn(Math, "random").mockImplementation(lcg(23));
    const r = referenceLine(
      { heroCards: c("7h 2d"), board: [], potBefore: 100, callAmount: 100, activeOpponents: 1 },
      2000,
    );
    expect(r.note).toMatch(/胜率/);
  });
});

// ---------------------------------------------------------------------------
// heroDecisionInput（从 HandRecord 重放推导决策点输入）
// ---------------------------------------------------------------------------

function makeHand(streets: StreetRecord[], overrides: Partial<HandRecord> = {}): HandRecord {
  return {
    id: "h1",
    timestamp: 0,
    players: [0, 1, 2, 3, 4, 5].map((seat) => ({
      seat,
      isHero: seat === 0,
      aiStyle: seat === 0 ? null : ("tag" as const),
      cards: seat === 0 ? c("As Kd") : null,
      profit: 0,
    })),
    heroSeat: 0,
    buttonSeat: 3, // 6 人桌：SB=4、BB=5、UTG=0（hero）
    smallBlind: 5,
    bigBlind: 10,
    ante: 0,
    streets,
    finalBoard: [],
    result: "win",
    profit: 0,
    showdown: false,
    ...overrides,
  };
}

const PREFLOP: StreetRecord = {
  street: "preflop",
  board: [],
  actions: [
    { seat: 0, action: { type: "call", amount: 10 } }, // hero（UTG）跟注
    { seat: 1, action: { type: "fold", amount: 0 } },
    { seat: 2, action: { type: "raise", amount: 30 } }, // 加注到 30
    { seat: 3, action: { type: "fold", amount: 0 } },
    { seat: 4, action: { type: "call", amount: 25 } }, // SB 已投 5，补 25
    { seat: 5, action: { type: "call", amount: 20 } }, // BB 已投 10，补 20
    { seat: 0, action: { type: "call", amount: 20 } }, // hero 再次决策
  ],
};
const FLOP: StreetRecord = {
  street: "flop",
  board: c("Qh 7d 2c"),
  actions: [
    { seat: 4, action: { type: "check", amount: 0 } },
    { seat: 5, action: { type: "bet", amount: 60 } },
    { seat: 0, action: { type: "call", amount: 60 } }, // hero 决策点
  ],
};

describe("heroDecisionInput 重放推导", () => {
  it("翻前 hero 二次决策：potBefore / callAmount / activeOpponents / position", () => {
    const input = heroDecisionInput(makeHand([PREFLOP]), 0, 6);
    expect(input).not.toBeNull();
    // 初始 15 + hero 10 + 加注增量 30 + SB 25 + BB 20 = 100
    expect(input!.potBefore).toBe(100);
    // 本街最高投入 30（座位2），hero 已投 10 → 跟注 20
    expect(input!.callAmount).toBe(20);
    // 座位 1、3 已弃牌 → 存活对手 = 2/4/5 共 3 人
    expect(input!.activeOpponents).toBe(3);
    expect(input!.board).toEqual([]);
    expect(input!.heroCards).toEqual(c("As Kd"));
    expect(input!.position).toBe("UTG");
  });

  it("跨街累计：flop hero 决策的 potBefore 含翻前全部投入", () => {
    const input = heroDecisionInput(makeHand([PREFLOP, FLOP]), 1, 2);
    expect(input).not.toBeNull();
    // 翻前结束 100 + hero 跟 20 = 120；flop check +0、bet 60 → 180
    expect(input!.potBefore).toBe(180);
    // 本街投入重置：hero 未投，最高 60 → 跟注 60
    expect(input!.callAmount).toBe(60);
    expect(input!.activeOpponents).toBe(3);
    expect(input!.board).toEqual(c("Qh 7d 2c"));
  });

  it("翻前 BB 位 hero 无人加注：盲注预置投入使 callAmount = 0", () => {
    const hand = makeHand(
      [
        {
          street: "preflop",
          board: [],
          actions: [
            { seat: 0, action: { type: "fold", amount: 0 } }, // 按钮弃牌
            { seat: 1, action: { type: "call", amount: 5 } }, // SB 补齐
            { seat: 2, action: { type: "check", amount: 0 } }, // BB（hero）
          ],
        },
      ],
      {
        players: [0, 1, 2].map((seat) => ({
          seat,
          isHero: seat === 2,
          aiStyle: seat === 2 ? null : ("tag" as const),
          cards: seat === 2 ? c("9h 8h") : null,
          profit: 0,
        })),
        heroSeat: 2,
        buttonSeat: 0, // 3 人桌：SB=1、BB=2
      },
    );
    const input = heroDecisionInput(hand, 0, 2);
    expect(input).not.toBeNull();
    expect(input!.callAmount).toBe(0); // 大盲已投 10，无需补
    expect(input!.potBefore).toBe(20); // 15 + SB 补 5
    expect(input!.activeOpponents).toBe(1); // 按钮已弃，仅剩 SB
    expect(input!.position).toBe("BB");
  });

  it("非 hero 动作 / showdown 街 / hero 底牌未知 → null", () => {
    const hand = makeHand([PREFLOP, FLOP]);
    expect(heroDecisionInput(hand, 0, 1)).toBeNull(); // 座位1的动作
    const showdownHand = makeHand(
      [{ street: "showdown", board: c("Qh 7d 2c 3s 4s"), actions: [] }],
      { showdown: true },
    );
    expect(heroDecisionInput(showdownHand, 0, 0)).toBeNull();
    const noCards = makeHand([PREFLOP], {
      players: makeHand([PREFLOP]).players.map((p) =>
        p.isHero ? { ...p, cards: null } : p,
      ),
    });
    expect(heroDecisionInput(noCards, 0, 6)).toBeNull();
  });
});
