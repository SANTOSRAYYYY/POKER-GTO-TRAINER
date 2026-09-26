/**
 * 全下跑马（auto-runout）街道归档回归测试。
 *
 * 复现用户 bug：hero 推 all-in 被跟注后，引擎一次性发完剩余公共牌直达摊牌
 * （applyAction → settleShowdown，street 从当前街直接跳到 "showdown"），
 * applyTracked 每次动作只归档 prev.street 一条街，被跳过的空动作街
 * （flop/turn/river）不进 streetLog —— HandRecord.streets 缺后续街，
 * 回放与教练复盘都看不到转牌/河牌发了什么。
 *
 * 修复契约：HandRecord.streets 必须包含每一张发出的公共牌所在街的快照
 * （空动作街也要记，board 为该街发完后的快照：flop 3 / turn 4 / river 5），
 * finalBoard 完整。
 *
 * 测试用 AI 决策桩（永远 call/check）保证被跟注，流程确定可复现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Card, DecideInput, HandRecord, StreetRecord } from "@/lib/types";
import { useGameStore, withRunoutStreets } from "@/lib/store/gameStore";
import { useHistoryStore } from "@/lib/store/historyStore";

/** AI 决策桩：能跟注就跟注、能过牌就过牌（绝不弃牌/加注），保证 all-in 必被跟注 */
vi.mock("@/lib/ai/heuristic", () => ({
  heuristicDecide: (input: DecideInput) => {
    const action =
      input.legalActions.find((a) => a.type === "call") ??
      input.legalActions.find((a) => a.type === "check") ??
      input.legalActions[0] ?? { type: "fold" as const, amount: 0 };
    return { action, reasoning: "测试桩：永远跟注/过牌", source: "heuristic" as const };
  },
}));

const st = () => useGameStore.getState();

let savedHands: HandRecord[];

beforeEach(() => {
  savedHands = [];
  vi.spyOn(useHistoryStore.getState(), "addHand").mockImplementation(
    async (h) => {
      savedHands.push(h);
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function startHeadsUp(): Promise<void> {
  await st().startTable({
    mode: "cash",
    seats: 2,
    aiStyle: "nit",
    cashBlinds: { sb: 1, bb: 2 },
    buyin: 200,
  });
  // 单挑第 1 手：hero 坐按钮位（=小盲），翻前先行动
  expect(st().game!.currentSeat).toBe(0);
  expect(st().game!.street).toBe("preflop");
}

describe("全下跑马街道归档（HandRecord.streets 完整性）", () => {
  it("复现：单挑 hero 翻前 all-in 被跟注 → streets 必须含 flop/turn/river 空动作街", async () => {
    await startHeadsUp();
    // hero（按钮/小盲，已投 1）全下到 200
    await st().act({ type: "allin", amount: 200 });
    expect(st().game!.handOver).toBe(true);
    expect(st().game!.showdown).toBe(true);

    expect(savedHands).toHaveLength(1);
    const rec = savedHands[0];
    expect(rec.showdown).toBe(true);
    expect(rec.finalBoard).toHaveLength(5);

    // 修复核心断言：四条街齐全（此前只有 preflop 一条）
    expect(rec.streets.map((s) => s.street)).toEqual([
      "preflop",
      "flop",
      "turn",
      "river",
    ]);
    // 翻前街保留真实动作序列（hero 全下 + AI 跟注）
    expect(rec.streets[0].board).toEqual([]);
    expect(rec.streets[0].actions.map((a) => a.action.type)).toEqual([
      "allin",
      "call",
    ]);
    // 空动作街：board 为该街发完后的快照，actions 为空
    expect(rec.streets[1].actions).toEqual([]);
    expect(rec.streets[1].board).toHaveLength(3);
    expect(rec.streets[2].actions).toEqual([]);
    expect(rec.streets[2].board).toHaveLength(4);
    expect(rec.streets[3].actions).toEqual([]);
    expect(rec.streets[3].board).toHaveLength(5);
    // 快照与 finalBoard 前缀一致（同一次发牌）
    expect(rec.streets[1].board).toEqual(rec.finalBoard.slice(0, 3));
    expect(rec.streets[2].board).toEqual(rec.finalBoard.slice(0, 4));
    expect(rec.streets[3].board).toEqual(rec.finalBoard.slice(0, 5));
    // 摊牌亮出对手底牌（未弃牌者）
    expect(rec.players[1].cards).toHaveLength(2);
  });

  it("转牌 all-in 被跟注 → 只补录河牌一条街，已有街不重录", async () => {
    await startHeadsUp();
    await st().act({ type: "call", amount: 1 }); // hero 跟注，AI 过牌 → 翻牌
    expect(st().game!.street).toBe("flop");
    await st().act({ type: "check", amount: 0 }); // AI 先过牌，hero 过牌 → 转牌
    expect(st().game!.street).toBe("turn");
    // 转牌：AI 过牌后 hero 全下 198，AI 跟注 → 摊牌
    await st().act({ type: "allin", amount: 198 });
    expect(st().game!.handOver).toBe(true);

    expect(savedHands).toHaveLength(1);
    const rec = savedHands[0];
    expect(rec.streets.map((s) => s.street)).toEqual([
      "preflop",
      "flop",
      "turn",
      "river",
    ]);
    // 已有动作的三街保持原样
    expect(rec.streets[0].actions.map((a) => a.action.type)).toEqual(["call", "check"]);
    expect(rec.streets[1].actions.map((a) => a.action.type)).toEqual(["check", "check"]);
    expect(rec.streets[2].actions.map((a) => a.action.type)).toEqual([
      "check",
      "allin",
      "call",
    ]);
    // 仅河牌为补录的空动作街
    expect(rec.streets[3].actions).toEqual([]);
    expect(rec.streets[3].board).toEqual(rec.finalBoard.slice(0, 5));
  });

  it("无全下的常规摊牌（全程过牌）：四街本就有动作，不补录不重复", async () => {
    await startHeadsUp();
    await st().act({ type: "call", amount: 1 });
    await st().act({ type: "check", amount: 0 }); // flop
    await st().act({ type: "check", amount: 0 }); // turn
    await st().act({ type: "check", amount: 0 }); // river → 摊牌
    expect(st().game!.handOver).toBe(true);

    expect(savedHands).toHaveLength(1);
    const rec = savedHands[0];
    expect(rec.showdown).toBe(true);
    expect(rec.streets.map((s) => s.street)).toEqual([
      "preflop",
      "flop",
      "turn",
      "river",
    ]);
    for (const s of rec.streets) {
      expect(s.actions).toHaveLength(2); // 各有真实动作，无空动作补录
    }
    expect(rec.finalBoard).toHaveLength(5);
  });

  it("提前 fold 收场（翻牌圈弃牌）：不补录未发出的街", async () => {
    await startHeadsUp();
    await st().act({ type: "call", amount: 1 });
    expect(st().game!.street).toBe("flop");
    // 翻牌圈 AI 过牌后 hero 直接弃牌（无注可弃，引擎允许 fold）
    await st().act({ type: "fold", amount: 0 });
    expect(st().game!.handOver).toBe(true);
    expect(st().game!.showdown).toBe(false);

    const rec = savedHands[0];
    expect(rec.streets.map((s) => s.street)).toEqual(["preflop", "flop"]);
    expect(rec.finalBoard).toHaveLength(3); // 只发到翻牌
  });
});

describe("withRunoutStreets 纯函数补录", () => {
  const board = ["As", "Kd", "Qh", "7c", "2s"] as Card[];

  it("空 log + 完整 board：补 preflop/flop/turn/river 四条（开局即全下的极端情形）", () => {
    const out = withRunoutStreets([], board);
    expect(out.map((s) => s.street)).toEqual(["preflop", "flop", "turn", "river"]);
    expect(out[0].board).toEqual([]);
    expect(out[1].board).toEqual(board.slice(0, 3));
    expect(out[2].board).toEqual(board.slice(0, 4));
    expect(out[3].board).toEqual(board.slice(0, 5));
    expect(out.every((s) => s.actions.length === 0)).toBe(true);
  });

  it("log 到 preflop + board 5 张：补 flop/turn/river", () => {
    const out = withRunoutStreets(
      [{ street: "preflop", board: [], actions: [{ seat: 0, action: { type: "allin", amount: 200 } }] }],
      board,
    );
    expect(out.map((s) => s.street)).toEqual(["preflop", "flop", "turn", "river"]);
    expect(out[0].actions).toHaveLength(1); // 原记录不动
    expect(out.slice(1).every((s) => s.actions.length === 0)).toBe(true);
  });

  it("log 到 river + board 5 张：原样返回（不重复补录）", () => {
    const full: StreetRecord[] = [
      { street: "preflop", board: [], actions: [] },
      { street: "flop", board: board.slice(0, 3), actions: [] },
      { street: "turn", board: board.slice(0, 4), actions: [] },
      { street: "river", board: board.slice(0, 5), actions: [] },
    ];
    const out = withRunoutStreets(full, board);
    expect(out).toHaveLength(4);
  });

  it("fold 在翻牌圈（board 3 张）：不补 turn/river", () => {
    const out = withRunoutStreets(
      [
        { street: "preflop", board: [], actions: [] },
        { street: "flop", board: board.slice(0, 3), actions: [] },
      ],
      board.slice(0, 3),
    );
    expect(out.map((s) => s.street)).toEqual(["preflop", "flop"]);
  });

  it("不修改入参数组", () => {
    const log = [{ street: "preflop" as const, board: [], actions: [] }];
    withRunoutStreets(log, board);
    expect(log).toHaveLength(1);
  });
});
