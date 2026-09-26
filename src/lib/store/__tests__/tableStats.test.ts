/**
 * 对手建模（tableStats）的 store 集成测试
 *
 * - finalizeHand 用 HandRecord 对每个在座座位（含 hero）累积统计
 * - 真实牌局连打多手后统计正确累积（hero 每手翻前弃牌 → VPIP 恒 0）
 * - buildDecideInput 注入 opponentModels（含 hero 自身模型，AI 剥削 hero）
 * - startTable 新开局清零；现金局自动补码不清零（统计跨补码持续累积）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecideInput, HandRecord, StreetRecord } from "@/lib/types";
import {
  DEFAULT_RECENCY_LAMBDA,
  setAdaptRecencyLambda,
} from "@/lib/ai/adapt";
import { heuristicDecide } from "@/lib/ai/heuristic";
import { HERO_SEAT, useGameStore } from "@/lib/store/gameStore";
import { useHistoryStore } from "@/lib/store/historyStore";

vi.mock("@/lib/ai/heuristic", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/ai/heuristic")>();
  return { ...mod, heuristicDecide: vi.fn(mod.heuristicDecide) };
});

const st = () => useGameStore.getState();
const decideSpy = vi.mocked(heuristicDecide);

beforeEach(() => {
  decideSpy.mockClear();
  vi.spyOn(useHistoryStore.getState(), "addHand").mockImplementation(
    async (_h: HandRecord) => {},
  );
  // 本文件断言整数计数：显式关闭近因加权（λ=1 旧口径）；衰减数值由 adapt.test.ts 覆盖
  setAdaptRecencyLambda(1);
});

afterEach(() => {
  vi.restoreAllMocks();
  setAdaptRecencyLambda(DEFAULT_RECENCY_LAMBDA);
});

const CASH_CFG = {
  mode: "cash" as const,
  seats: 3,
  aiStyle: "tag" as const,
  cashBlinds: { sb: 1, bb: 2 },
  buyin: 200,
};

/** hero 每手翻前弃牌，连打 n 手 */
async function playHeroFoldHands(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    if (!st().game!.handOver) {
      expect(st().game!.currentSeat).toBe(HERO_SEAT);
      await st().act({ type: "fold", amount: 0 });
      expect(st().game!.handOver).toBe(true);
    }
    if (i < n - 1) await st().advanceToNextHand();
  }
}

describe("finalizeHand 累积 tableStats", () => {
  it("用合成 HandRecord 精确更新各座位（hero 翻前弃牌不计 VPIP/WTSD）", async () => {
    await st().startTable({ ...CASH_CFG, cashBlinds: { sb: 5, bb: 10 }, buyin: 1000 });
    const g = st().game!;
    const streets: StreetRecord[] = [
      {
        street: "preflop",
        board: [],
        actions: [
          { seat: 0, action: { type: "fold", amount: 0 } }, // hero 弃牌
          { seat: 1, action: { type: "raise", amount: 30 } },
          { seat: 2, action: { type: "call", amount: 20 } },
        ],
      },
      {
        street: "flop",
        board: ["As", "Kd", "7c"],
        actions: [
          { seat: 2, action: { type: "check", amount: 0 } },
          { seat: 1, action: { type: "bet", amount: 20 } },
          { seat: 2, action: { type: "call", amount: 20 } },
        ],
      },
      {
        street: "turn",
        board: ["As", "Kd", "7c", "3h"],
        actions: [
          { seat: 2, action: { type: "check", amount: 0 } },
          { seat: 1, action: { type: "check", amount: 0 } },
        ],
      },
      {
        street: "river",
        board: ["As", "Kd", "7c", "3h", "9s"],
        actions: [
          { seat: 2, action: { type: "bet", amount: 50 } },
          { seat: 1, action: { type: "call", amount: 50 } },
        ],
      },
    ];
    useGameStore.setState({
      game: {
        ...g,
        handOver: true,
        currentSeat: null,
        winners: [2],
        pot: 0,
        showdown: true,
      },
      streetLog: streets,
      pendingActions: [],
      handSettled: false,
      heroProfit: null,
    });
    st().finalizeHand();

    const ts = st().tableStats;
    expect(ts).toHaveLength(3);
    // hero：翻前弃牌 → VPIP/WTSD 全 0
    expect(ts[0]).toMatchObject({
      hands: 1,
      vpipHands: 0,
      pfrHands: 0,
      postflopAggressive: 0,
      postflopPassive: 0,
      showdownsSeenFlop: 0,
      showdowns: 0,
    });
    // seat1：翻前加注（VPIP+PFR）；翻牌 bet + 河牌 call
    expect(ts[1]).toMatchObject({
      hands: 1,
      vpipHands: 1,
      pfrHands: 1,
      postflopAggressive: 1,
      postflopPassive: 1,
      showdownsSeenFlop: 1,
      showdowns: 1,
    });
    // seat2：翻前跟注（VPIP）；翻牌 call + 河牌 bet
    expect(ts[2]).toMatchObject({
      hands: 1,
      vpipHands: 1,
      pfrHands: 0,
      postflopAggressive: 1,
      postflopPassive: 1,
      showdownsSeenFlop: 1,
      showdowns: 1,
    });
  });

  it("真实牌局连打 6 手：每座 hands 累加；hero 全弃牌 VPIP 恒 0；maniac AI 有 VPIP/PFR", async () => {
    await st().startTable({ ...CASH_CFG, aiStyle: "maniac" });
    await playHeroFoldHands(6);
    const ts = st().tableStats;
    expect(ts).toHaveLength(3);
    for (const s of ts) expect(s.hands).toBe(6);
    expect(ts[HERO_SEAT].vpipHands).toBe(0);
    expect(ts[HERO_SEAT].pfrHands).toBe(0);
    // maniac 风格（vpip 0.65）：12 个 AI 手次全零的概率可忽略
    expect(ts[1].vpipHands + ts[2].vpipHands).toBeGreaterThan(0);
    expect(ts[1].pfrHands + ts[2].pfrHands).toBeGreaterThan(0);
  }, 30000);

  it("startTable 新开局清零（打法惯性只跨补码，不跨换桌）", async () => {
    await st().startTable({ ...CASH_CFG, aiStyle: "maniac" });
    await playHeroFoldHands(2);
    expect(st().tableStats.some((s) => s.hands > 0)).toBe(true);
    await st().startTable(CASH_CFG);
    expect(st().tableStats).toHaveLength(3);
    expect(
      st().tableStats.every((s) => s.hands === 0 && s.vpipHands === 0),
    ).toBe(true);
  }, 30000);
});

describe("buildDecideInput 注入 opponentModels", () => {
  it("每次 AI 决策都携带在局其他座位模型（含 hero）；第 2 手起 hero 模型有样本", async () => {
    await st().startTable(CASH_CFG);
    await playHeroFoldHands(3);

    expect(decideSpy).toHaveBeenCalled();
    for (const [input] of decideSpy.mock.calls) {
      const inp = input as DecideInput;
      expect(inp.opponentModels).toBeDefined();
      // 现金局无淘汰：模型数 = 玩家数 - 1，且不含决策座位自己
      expect(inp.opponentModels!).toHaveLength(inp.state.players.length - 1);
      expect(
        inp.opponentModels!.some((m) => m.seat === inp.state.currentSeat),
      ).toBe(false);
    }
    // 第 2 手起（按钮轮转后 AI 先行动）应携带 hero（引擎座位 0）的累积模型
    const heroModeled = decideSpy.mock.calls.some(([input]) =>
      (input as DecideInput).opponentModels!.some(
        (m) => m.seat === 0 && m.stats.hands >= 1,
      ),
    );
    expect(heroModeled).toBe(true);
  }, 30000);
});
