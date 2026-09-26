/**
 * 近期手牌回顾（recentHands / summarizeHand）测试：
 * LLM 决策的上下文携带量功能（设置页 contextHands）依赖这层数据。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HandRecord } from "@/lib/types";
import {
  HERO_SEAT,
  summarizeHand,
  useGameStore,
} from "@/lib/store/gameStore";
import { useHistoryStore } from "@/lib/store/historyStore";
import { buildSnapshot } from "@/lib/store/sessionPersistence";

const st = () => useGameStore.getState();

function stubLocalStorage(): void {
  const store: Record<string, string> = {};
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    },
  });
}

beforeEach(() => {
  stubLocalStorage();
  vi.spyOn(useHistoryStore.getState(), "addHand").mockImplementation(async () => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** hero 轮到时弃牌并等 AI 打完本手 */
async function heroFoldOut(): Promise<void> {
  const s = st();
  if (!s.game || s.game.handOver) return;
  if (s.game.currentSeat === HERO_SEAT) await s.act({ type: "fold", amount: 0 });
}

function makeRecord(overrides: Partial<HandRecord> = {}): HandRecord {
  return {
    id: "h1",
    timestamp: Date.now(),
    players: [
      { seat: 0, isHero: true, aiStyle: null, cards: ["Ah", "Kd"], profit: 120 },
      { seat: 1, isHero: false, aiStyle: "tag", cards: ["Qs", "Qh"], profit: -120 },
    ],
    heroSeat: 0,
    buttonSeat: 0,
    smallBlind: 1,
    bigBlind: 2,
    ante: 0,
    streets: [
      {
        street: "preflop",
        board: [],
        actions: [
          { seat: 0, action: { type: "raise", amount: 6 } },
          { seat: 1, action: { type: "fold", amount: 0 } },
        ],
      },
    ],
    finalBoard: [],
    result: "win",
    profit: 120,
    showdown: false,
    ...overrides,
  };
}

describe("summarizeHand", () => {
  it("包含底牌、位置、hero 动作、盈亏与赢家", () => {
    const s = summarizeHand(makeRecord(), (x) => x);
    expect(s).toContain("AhKd");
    expect(s).toContain("BTN");
    expect(s).toContain("翻前加注");
    expect(s).toContain("+120");
    expect(s).toContain("赢家 你");
  });

  it("hero 输且摊牌时标注赢家底牌与风格", () => {
    const s = summarizeHand(
      makeRecord({
        result: "lose",
        profit: -50,
        showdown: true,
        players: [
          { seat: 0, isHero: true, aiStyle: null, cards: ["Ah", "Kd"], profit: -50 },
          { seat: 1, isHero: false, aiStyle: "tag", cards: ["Qs", "Qh"], profit: 50 },
        ],
      }),
      (x) => x,
    );
    expect(s).toContain("-50");
    expect(s).toContain("赢家 座位1（tag）");
    expect(s).toContain("亮出 Qs Qh");
  });
});

describe("recentHands 累积", () => {
  it("每打完一手追加一条，最新在前；开新桌清空；存档包含该字段", async () => {
    await st().startTable({
      mode: "cash",
      seats: 3,
      aiStyle: "nit",
      cashBlinds: { sb: 1, bb: 2 },
      buyin: 100,
    });
    expect(st().recentHands).toEqual([]);

    await heroFoldOut();
    expect(st().recentHands.length).toBe(1);
    expect(st().recentHands[0]).toContain("翻前弃牌");
    expect(st().recentHands[0]).toContain("结果");

    await st().advanceToNextHand();
    await heroFoldOut();
    expect(st().recentHands.length).toBe(2);

    // 存档包含 recentHands（刷新恢复后 LLM 上下文不丢）
    const snap = buildSnapshot(st());
    expect(snap.recentHands?.length).toBe(2);

    await st().startTable({
      mode: "cash",
      seats: 3,
      aiStyle: "nit",
      cashBlinds: { sb: 1, bb: 2 },
      buyin: 100,
    });
    expect(st().recentHands).toEqual([]);
  });
});
