/**
 * filterCompare.ts（/stats 筛选与对比）测试
 *
 * - filterHands：局型筛选（isTournamentHand 口径）、时间倒序截取、range=0 全量
 * - compareSegments：最近 N 手 vs 之前 N 手；样本不足返回 null
 * - buildMetricDeltas：差值符号、polarity 标记、null 传播
 */
import { describe, expect, it } from "vitest";
import type { HandRecord, HandPlayerRecord } from "@/lib/types";
import {
  buildMetricDeltas,
  compareSegments,
  filterHands,
  type HudMetricSlice,
} from "../filterCompare";

let seq = 0;

function mkHand(
  timestamp: number,
  opts: { tournament?: boolean; profit?: number; mode?: "cash" | "tournament" } = {},
): HandRecord {
  seq += 1;
  const players: HandPlayerRecord[] = [
    {
      seat: 0,
      isHero: true,
      aiStyle: null,
      cards: ["As", "Kh"],
      profit: opts.profit ?? 0,
      ...(opts.tournament ? { finishPlace: 1 } : {}),
    },
    {
      seat: 1,
      isHero: false,
      aiStyle: "tag",
      cards: null,
      profit: -(opts.profit ?? 0),
      ...(opts.tournament ? { finishPlace: 2 } : {}),
    },
  ];
  return {
    id: `h${seq}`,
    timestamp,
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    players,
    heroSeat: 0,
    buttonSeat: 0,
    smallBlind: 50,
    bigBlind: 100,
    ante: 0,
    streets: [],
    finalBoard: [],
    result: (opts.profit ?? 0) > 0 ? "win" : (opts.profit ?? 0) < 0 ? "lose" : "tie",
    profit: opts.profit ?? 0,
    showdown: true,
  };
}

describe("filterHands", () => {
  const hands = [
    mkHand(1000, { tournament: true }),
    mkHand(3000, { tournament: false }),
    mkHand(2000, { tournament: true }),
    mkHand(4000, { tournament: false }),
  ];

  it("按局型过滤（锦标赛判定 = 任一玩家带最终名次）", () => {
    expect(filterHands(hands, "tournament", 0).every((h) => h.players.some((p) => p.finishPlace != null))).toBe(true);
    expect(filterHands(hands, "cash", 0)).toHaveLength(2);
    expect(filterHands(hands, "all", 0)).toHaveLength(4);
  });

  it("时间范围按倒序截取最近 N 手（输入乱序也安全）", () => {
    const recent1 = filterHands(hands, "all", 50).map((h) => h.timestamp);
    expect(recent1).toEqual([4000, 3000, 2000, 1000]);
    // range 用 50/100 两档；构造 120 手验证截取
    const many = Array.from({ length: 120 }, (_, i) => mkHand(i * 1000));
    expect(filterHands(many, "all", 50)).toHaveLength(50);
    expect(filterHands(many, "all", 50)[0].timestamp).toBe(119_000);
    expect(filterHands(many, "all", 100)).toHaveLength(100);
    expect(filterHands(many, "all", 0)).toHaveLength(120);
  });

  it("混合模式数据集：mode='tournament' 的前期手（无 finishPlace）归入锦标赛筛选", () => {
    // 审计 A1：锦标赛前期手不带 finishPlace，旧口径被「仅现金局」筛入、
    // 被「仅锦标赛」漏掉；mode 字段修复后应正确归类
    const mixed = [
      mkHand(1000, { mode: "cash" }), // 现金手
      mkHand(2000, { mode: "tournament" }), // 锦标赛前期手（无 finishPlace）
      mkHand(3000, { mode: "tournament" }),
      mkHand(4000, { tournament: true }), // 旧记录：finishPlace 启发式
      mkHand(5000, { mode: "cash" }),
    ];
    expect(filterHands(mixed, "cash", 0).map((h) => h.timestamp)).toEqual([5000, 1000]);
    expect(filterHands(mixed, "tournament", 0).map((h) => h.timestamp)).toEqual([
      4000, 3000, 2000,
    ]);
    expect(filterHands(mixed, "all", 0)).toHaveLength(5);
  });
});

describe("compareSegments", () => {
  it("recent = 最新 N 手，previous = 再之前 N 手", () => {
    // 120 手，时间戳即序号；最近 50 手 profit=+100，之前 50 手 profit=-100
    const hands = Array.from({ length: 120 }, (_, i) =>
      mkHand(i * 1000, { profit: i >= 70 ? 100 : -100 }),
    );
    const cmp = compareSegments(hands, 50);
    expect(cmp).not.toBeNull();
    expect(cmp!.recentCount).toBe(50);
    expect(cmp!.previousCount).toBe(50);
    expect(cmp!.recent.totalProfit).toBe(5000);
    expect(cmp!.previous.totalProfit).toBe(-5000);
  });

  it("样本不足（之前段为空）返回 null", () => {
    expect(compareSegments([], 50)).toBeNull();
    expect(compareSegments(Array.from({ length: 50 }, (_, i) => mkHand(i)), 50)).toBeNull();
  });
});

describe("buildMetricDeltas", () => {
  const recent: HudMetricSlice = { vpip: 0.3, pfr: 0.2, af: 2.5, wtsd: 0.25, bbPer100: 5 };
  const previous: HudMetricSlice = { vpip: 0.25, pfr: 0.22, af: 2.0, wtsd: 0.3, bbPer100: -3 };

  it("差值 = recent − previous，含符号", () => {
    const deltas = buildMetricDeltas(recent, previous);
    const byKey = Object.fromEntries(deltas.map((d) => [d.key, d]));
    expect(byKey.vpip.delta).toBeCloseTo(0.05);
    expect(byKey.pfr.delta).toBeCloseTo(-0.02);
    expect(byKey.af.delta).toBeCloseTo(0.5);
    expect(byKey.wtsd.delta).toBeCloseTo(-0.05);
    expect(byKey.bb100.delta).toBeCloseTo(8);
  });

  it("polarity：WTSD 为中性，其余为 good-up", () => {
    const deltas = buildMetricDeltas(recent, previous);
    const byKey = Object.fromEntries(deltas.map((d) => [d.key, d]));
    expect(byKey.wtsd.polarity).toBe("neutral");
    for (const k of ["vpip", "pfr", "af", "bb100"] as const) {
      expect(byKey[k].polarity).toBe("good-up");
    }
  });

  it("任一端为 null 时差值为 null（如无 bb/100 样本）", () => {
    const deltas = buildMetricDeltas(
      { ...recent, bbPer100: null },
      previous,
    );
    const bb = deltas.find((d) => d.key === "bb100")!;
    expect(bb.recent).toBeNull();
    expect(bb.delta).toBeNull();
  });

  it("输出固定五项且带展示格式", () => {
    const deltas = buildMetricDeltas(recent, previous);
    expect(deltas.map((d) => d.key)).toEqual(["vpip", "pfr", "af", "wtsd", "bb100"]);
    expect(deltas.find((d) => d.key === "vpip")!.format).toBe("pct");
    expect(deltas.find((d) => d.key === "bb100")!.format).toBe("num");
  });
});
