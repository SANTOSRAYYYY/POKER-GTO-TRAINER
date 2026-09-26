/**
 * handReferenceLines（教练 prompt 决策点参考数据注入）测试。
 *
 * 锁定注入契约：
 * - 每个 hero 决策点恰好一行（含街道、面对跟注额/底池、实算胜率、
 *   面对下注时含保本所需胜率、参考倾向与置信度）；
 * - 非 hero 动作 / 空动作跑马街 / hero 底牌缺失 / showdown 街 → 从略；
 * - 无人下注的决策点不输出「所需胜率」。
 * （Math.random 用种子桩替换，胜率可复现；少量迭代保证测试速度。）
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Card, HandRecord, StreetRecord } from "@/lib/types";
import { handReferenceLines } from "../reference";

/** 线性同余种子 rng（测试可复现） */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const c = (s: string) => s.split(" ") as Card[];

/**
 * 单挑手：hero（座位0，BTN/SB）翻前跟注 1，BB 过牌；
 * 翻牌 BB 下注 10、hero 跟注；转牌双双过牌（hero 的 check 也是决策点）；
 * 河牌为空动作跑马街（双方转牌全下后补录的情形用空 actions 模拟）。
 */
function makeHand(overrides: Partial<HandRecord> = {}): HandRecord {
  const streets: StreetRecord[] = [
    {
      street: "preflop",
      board: [],
      actions: [
        { seat: 0, action: { type: "call", amount: 1 } }, // hero 决策点 1（面对跟注额 1）
        { seat: 1, action: { type: "check", amount: 0 } },
      ],
    },
    {
      street: "flop",
      board: c("Qh 7d 2c"),
      actions: [
        { seat: 1, action: { type: "bet", amount: 10 } },
        { seat: 0, action: { type: "call", amount: 10 } }, // hero 决策点 2（面对跟注额 10）
      ],
    },
    {
      street: "turn",
      board: c("Qh 7d 2c 5s"),
      actions: [
        { seat: 1, action: { type: "check", amount: 0 } },
        { seat: 0, action: { type: "check", amount: 0 } }, // hero 决策点 3（无人下注）
      ],
    },
    { street: "river", board: c("Qh 7d 2c 5s 9h"), actions: [] }, // 跑马街：无决策点
  ];
  return {
    id: "h1",
    timestamp: 0,
    players: [
      { seat: 0, isHero: true, aiStyle: null, cards: c("As Kd"), profit: 0 },
      { seat: 1, isHero: false, aiStyle: "tag", cards: null, profit: 0 },
    ],
    heroSeat: 0,
    buttonSeat: 0,
    smallBlind: 1,
    bigBlind: 2,
    ante: 0,
    streets,
    finalBoard: c("Qh 7d 2c 5s 9h"),
    result: "win",
    profit: 0,
    showdown: true,
    ...overrides,
  };
}

describe("handReferenceLines 决策点参考数据注入", () => {
  it("每个 hero 决策点恰好一行；非 hero 动作与空动作跑马街不产生行", () => {
    vi.spyOn(Math, "random").mockImplementation(lcg(31));
    const lines = handReferenceLines(makeHand(), 500);
    expect(lines).toHaveLength(3); // 翻前跟注 / 翻牌跟注 / 转牌过牌
    for (const line of lines) {
      expect(line).toMatch(/^- /);
      expect(line).toContain("实算胜率");
      expect(line).toContain("参考倾向：");
    }
  });

  it("面对下注的决策点：含跟注额、底池、实算胜率与保本所需胜率", () => {
    vi.spyOn(Math, "random").mockImplementation(lcg(31));
    const lines = handReferenceLines(makeHand(), 500);
    // 翻前：初始底池 3（1+2），hero 需补 1 → 所需胜率 1/(3+1)=25.0%
    expect(lines[0]).toContain("翻前");
    expect(lines[0]).toContain("面对跟注额 1（底池 3）");
    expect(lines[0]).toContain("所需胜率 25.0%");
    // 翻牌：翻前底池 4 + BB 下注 10 → 底池 14，跟注 10 → 10/24≈41.7%
    expect(lines[1]).toContain("翻牌圈");
    expect(lines[1]).toContain("面对跟注额 10（底池 14）");
    expect(lines[1]).toContain("所需胜率 41.7%");
    expect(lines[1]).toMatch(/实算胜率 \d+\.\d%/);
  });

  it("无人下注的决策点：不含「所需胜率」，仍给参考倾向", () => {
    vi.spyOn(Math, "random").mockImplementation(lcg(31));
    const lines = handReferenceLines(makeHand(), 500);
    expect(lines[2]).toContain("转牌圈");
    expect(lines[2]).toContain("无人下注");
    expect(lines[2]).toContain("底池 24");
    expect(lines[2]).not.toContain("所需胜率");
  });

  it("hero 底牌未知 → 全部从略（空数组）", () => {
    const hand = makeHand({
      players: makeHand().players.map((p) =>
        p.isHero ? { ...p, cards: null } : p,
      ),
    });
    expect(handReferenceLines(hand, 100)).toEqual([]);
  });

  it("参考倾向措辞为中文动作 + 明确/边际置信度", () => {
    vi.spyOn(Math, "random").mockImplementation(lcg(31));
    const lines = handReferenceLines(makeHand(), 500);
    for (const line of lines) {
      expect(line).toMatch(/参考倾向：(加注\/下注|跟注|弃牌|过牌)（(明确|边际)）/);
    }
  });
});
