/**
 * 对手笔记本（hero 长期画像跨 session 持久化）测试
 *
 * 锁定语义：
 * - decayStats 纯函数：全部计数（含位置分桶）乘 λ^流逝手数；
 *   elapsed=0 / λ=1 / 负 elapsed 恒等；showdownsSeen 环形缓冲不衰减（引用前滚）；
 * - startTable 注入长期画像：hero 座位带样本开局（AI 座位照旧清零），
 *   AI 的 DecideInput.opponentModels 里 hero 模型置信度 >0（含分类推测）；
 * - finalizeHand 同步写笔记本（测试环境同步落盘，水位线随手数推进）；
 * - 加载衰减补偿：historyStore 总手数 − 水位线 = 流逝量；未加载按原值；
 * - resetNotebook 清空 localStorage + 当前桌 hero 统计（其他座位不受影响）；
 * - 存档与笔记本互不污染：resumeSession 用存档 tableStats 原样恢复并同步
 *   水位（不双重衰减）；clearSession 不动笔记本。
 *
 * 说明：localStorage 采用与 sessionPersistence.test.ts 相同的 window 存根；
 * store 模块加载于存根安装之前，故 gameStore 自动存档订阅器不安装，
 * 存档写入由测试显式 saveSession 完成。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecideInput, HandRecord, OpponentModel, OpponentStats } from "@/lib/types";
import {
  DEFAULT_RECENCY_LAMBDA,
  createOpponentStats,
  setAdaptRecencyLambda,
  type OpponentStatsWithShowdowns,
} from "@/lib/ai/adapt";
import { heuristicDecide } from "@/lib/ai/heuristic";
import { HERO_SEAT, useGameStore } from "@/lib/store/gameStore";
import { useHistoryStore } from "@/lib/store/historyStore";
import {
  NOTEBOOK_STORAGE_KEY,
  decayStats,
  loadDecayedHeroStats,
  loadNotebook,
} from "@/lib/store/notebook";
import { clearSession, saveSession } from "@/lib/store/sessionPersistence";

vi.mock("@/lib/ai/heuristic", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/ai/heuristic")>();
  return { ...mod, heuristicDecide: vi.fn(mod.heuristicDecide) };
});

const st = () => useGameStore.getState();
const decideSpy = vi.mocked(heuristicDecide);

let store: Record<string, string>;

function stubLocalStorage(): void {
  store = {};
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = String(v);
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    },
  });
}

beforeEach(() => {
  stubLocalStorage();
  decideSpy.mockClear();
  vi.spyOn(useHistoryStore.getState(), "addHand").mockImplementation(
    async (_h: HandRecord) => {},
  );
  // 笔记本 λ 与 adapt 模块旋钮同源：显式固定默认值，防串测试
  setAdaptRecencyLambda(DEFAULT_RECENCY_LAMBDA);
  useHistoryStore.setState({ hands: [], loaded: false });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useHistoryStore.setState({ hands: [], loaded: false });
  setAdaptRecencyLambda(DEFAULT_RECENCY_LAMBDA);
});

const CASH_CFG = {
  mode: "cash" as const,
  seats: 3,
  aiStyle: "tag" as const,
  cashBlinds: { sb: 1, bb: 2 },
  buyin: 200,
};

/** 构造一份「VPIP 0.5 / AF 0.25 → 跟注站」的 hero 长期画像（12 手有效样本） */
function heroStats(overrides: Partial<OpponentStats> = {}): OpponentStats {
  return {
    ...createOpponentStats(HERO_SEAT),
    hands: 12,
    vpipHands: 6,
    pfrHands: 3,
    postflopAggressive: 2,
    postflopPassive: 8,
    showdowns: 2,
    showdownsSeenFlop: 5,
    ...overrides,
  };
}

/** 直接往 localStorage 存根写一份笔记本（绕过 store，模拟历史遗留） */
function seedNotebook(stats: OpponentStats, handsRecorded = 12): void {
  store[NOTEBOOK_STORAGE_KEY] = JSON.stringify({
    version: 1,
    stats,
    updatedAt: Date.now(),
    handsRecorded,
  });
}

function fakeHands(n: number): HandRecord[] {
  return Array.from({ length: n }, () => ({}) as HandRecord);
}

/** hero 每手翻前弃牌，连打 n 手 */
async function playHeroFoldHands(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    if (!st().game!.handOver) {
      await st().act({ type: "fold", amount: 0 });
    }
    if (i < n - 1) await st().advanceToNextHand();
  }
}

describe("decayStats 纯函数", () => {
  it("全部计数（含位置分桶）乘 λ^elapsed；showdownsSeen 引用前滚不衰减", () => {
    const ring = [
      { seat: 0 as const, bucket: "late" as const, handType: "J4o", action: "open_raise" as const },
    ];
    const s: OpponentStats = {
      ...heroStats(),
      pfBucketHands: { early: 2, middle: 4, late: 6 },
      pfBucketVpip: { early: 1, middle: 2, late: 3 },
      pfBucketPfr: { early: 0, middle: 1, late: 2 },
    };
    (s as OpponentStatsWithShowdowns).showdownsSeen = ring;
    const f = 0.92 ** 3;
    const d = decayStats(s, 3, 0.92);
    expect(d.hands).toBeCloseTo(12 * f, 10);
    expect(d.vpipHands).toBeCloseTo(6 * f, 10);
    expect(d.pfrHands).toBeCloseTo(3 * f, 10);
    expect(d.postflopAggressive).toBeCloseTo(2 * f, 10);
    expect(d.postflopPassive).toBeCloseTo(8 * f, 10);
    expect(d.showdowns).toBeCloseTo(2 * f, 10);
    expect(d.showdownsSeenFlop).toBeCloseTo(5 * f, 10);
    expect(d.pfBucketHands).toEqual({
      early: expect.closeTo(2 * f, 10),
      middle: expect.closeTo(4 * f, 10),
      late: expect.closeTo(6 * f, 10),
    });
    expect(d.pfBucketVpip.late).toBeCloseTo(3 * f, 10);
    expect(d.pfBucketPfr.middle).toBeCloseTo(1 * f, 10);
    // 亮牌环形缓冲自带近因性：不衰减、原引用前滚
    expect((d as OpponentStatsWithShowdowns).showdownsSeen).toBe(ring);
    // 原对象不被修改
    expect(s.hands).toBe(12);
  });

  it("elapsed=0 / λ=1 / 负 elapsed 时原样返回（引用不变）", () => {
    const s = heroStats();
    expect(decayStats(s, 0, 0.92)).toBe(s);
    expect(decayStats(s, 5, 1)).toBe(s);
    expect(decayStats(s, -3, 0.92)).toBe(s);
  });

  it("λ 钳制 [0.5,1]；旧对象缺分桶字段时归一化为零桶再衰减", () => {
    const legacy = {
      seat: 0,
      hands: 10,
      vpipHands: 5,
      pfrHands: 2,
      postflopAggressive: 4,
      postflopPassive: 4,
      showdowns: 1,
      showdownsSeenFlop: 3,
    } as OpponentStats;
    const d = decayStats(legacy, 1, 0.1); // 0.1 钳到 0.5
    expect(d.hands).toBeCloseTo(5, 10);
    expect(d.pfBucketHands).toEqual({ early: 0, middle: 0, late: 0 });
    expect(d.pfBucketVpip).toEqual({ early: 0, middle: 0, late: 0 });
  });
});

describe("startTable 注入长期画像", () => {
  it("hero 座位带笔记本样本开局（AI 座位清零），AI 决策拿到置信度 >0 的 hero 模型", async () => {
    seedNotebook(heroStats());
    await st().startTable(CASH_CFG);

    // historyStore 未加载 → 不做衰减补偿，原值注入
    const ts = st().tableStats;
    expect(ts).toHaveLength(3);
    expect(ts[HERO_SEAT].hands).toBeCloseTo(12, 10);
    expect(ts[HERO_SEAT].vpipHands).toBeCloseTo(6, 10);
    expect(ts[1].hands).toBe(0);
    expect(ts[2].hands).toBe(0);

    // 第 1 手：AI 决策携带的是未打折扣的长期画像（finalize 前 stats 不更新）
    await st().act({ type: "fold", amount: 0 });
    expect(decideSpy).toHaveBeenCalled();
    const firstHandModels = decideSpy.mock.calls
      .map(
        ([input]) =>
          (input as DecideInput).opponentModels?.find((m) => m.seat === 0),
      )
      .filter((m): m is OpponentModel => !!m);
    expect(firstHandModels.length).toBeGreaterThan(0);
    for (const m of firstHandModels) {
      expect(m.confidence).toBeGreaterThan(0);
      expect(m.cls).toBe("calling_station"); // VPIP 0.5 / AF 0.25 的长期画像
    }

    // 再打 2 手：hero 模型置信度持续 >0（长期样本 + 本桌累积）
    decideSpy.mockClear();
    await playHeroFoldHands(2);
    expect(decideSpy).toHaveBeenCalled();
    let checked = 0;
    for (const [input] of decideSpy.mock.calls) {
      const m = (input as DecideInput).opponentModels?.find(
        (mm) => mm.seat === 0,
      );
      if (!m) continue;
      checked += 1;
      expect(m.confidence).toBeGreaterThan(0);
    }
    expect(checked).toBeGreaterThan(0);
  }, 30000);

  it("无笔记本时 hero 座位同样从零开始（行为与旧版一致）", async () => {
    await st().startTable(CASH_CFG);
    expect(
      st().tableStats.every((s) => s.hands === 0 && s.vpipHands === 0),
    ).toBe(true);
  }, 30000);
});

describe("finalizeHand 同步笔记本", () => {
  it("hero 每手结算后写笔记本：统计含本手（λ 衰减累加），水位线 +1", async () => {
    seedNotebook(heroStats(), 12);
    await st().startTable(CASH_CFG);
    await st().act({ type: "fold", amount: 0 }); // 第 1 手：hero 翻前弃牌

    const nb = loadNotebook();
    expect(nb).not.toBeNull();
    // 默认 λ=0.92：hands = 12×0.92+1；hero 弃牌 VPIP 只衰减不累加
    expect(nb!.stats.hands).toBeCloseTo(12 * 0.92 + 1, 10);
    expect(nb!.stats.vpipHands).toBeCloseTo(6 * 0.92, 10);
    // historyStore 未加载 → 水位线 = 前水位 + 1
    expect(nb!.handsRecorded).toBe(13);
  }, 30000);
});

describe("加载衰减补偿", () => {
  it("流逝量 = historyStore 总手数 − 水位线；水位 ≥ 总手数时不衰减", () => {
    seedNotebook(heroStats(), 5);
    useHistoryStore.setState({ hands: fakeHands(8), loaded: true });
    const s = loadDecayedHeroStats(0.92)!;
    expect(s.hands).toBeCloseTo(12 * 0.92 ** 3, 10); // 流逝 3 手
    expect(s.vpipHands).toBeCloseTo(6 * 0.92 ** 3, 10);

    seedNotebook(heroStats(), 8); // 水位 ≥ 总手数（如历史被清空后）
    const s2 = loadDecayedHeroStats(0.92)!;
    expect(s2.hands).toBeCloseTo(12, 10);
  });

  it("historyStore 未加载时按原值返回（不做衰减补偿）", () => {
    seedNotebook(heroStats(), 5);
    const s = loadDecayedHeroStats(0.92)!;
    expect(s.hands).toBeCloseTo(12, 10);
  });

  it("损坏/版本不符的笔记本被清除并返回 null", () => {
    store[NOTEBOOK_STORAGE_KEY] = "{not json";
    expect(loadNotebook()).toBeNull();
    expect(store[NOTEBOOK_STORAGE_KEY]).toBeUndefined();

    store[NOTEBOOK_STORAGE_KEY] = JSON.stringify({ version: 999 });
    expect(loadNotebook()).toBeNull();
    expect(store[NOTEBOOK_STORAGE_KEY]).toBeUndefined();
  });
});

describe("resetNotebook", () => {
  it("清空 localStorage 笔记本并清零当前桌 hero 统计（其他座位不受影响）", async () => {
    seedNotebook(heroStats());
    await st().startTable(CASH_CFG);
    expect(st().tableStats[HERO_SEAT].hands).toBeGreaterThan(0);

    st().resetNotebook();

    expect(loadNotebook()).toBeNull();
    expect(store[NOTEBOOK_STORAGE_KEY]).toBeUndefined();
    const ts = st().tableStats;
    expect(ts).toHaveLength(3);
    expect(ts[HERO_SEAT]).toMatchObject({
      hands: 0,
      vpipHands: 0,
      pfrHands: 0,
      postflopAggressive: 0,
      postflopPassive: 0,
    });
    // 清空后再开新桌：hero 也从零开始
    await st().startTable(CASH_CFG);
    expect(st().tableStats[HERO_SEAT].hands).toBe(0);
  }, 30000);
});

describe("存档与笔记本互不污染", () => {
  it("startTable 注入幂等（不累积衰减）；resumeSession 原样恢复并抬水位（不双重衰减）", async () => {
    seedNotebook(heroStats(), 12);
    useHistoryStore.setState({ hands: fakeHands(15), loaded: true }); // 流逝 3

    await st().startTable(CASH_CFG);
    const injected = st().tableStats[HERO_SEAT].hands;
    expect(injected).toBeCloseTo(12 * 0.92 ** 3, 10); // 注入时衰减一次

    // startTable 只读不写笔记本 → 再次开桌按同一流逝量衰减（幂等，不复合）
    await st().startTable(CASH_CFG);
    expect(st().tableStats[HERO_SEAT].hands).toBeCloseTo(injected, 10);

    // 模拟刷新：存档 tableStats 原样恢复（不经笔记本再衰减）
    saveSession(st());
    const before = st().tableStats[HERO_SEAT].hands;
    useGameStore.setState(useGameStore.getInitialState(), true);
    const ok = await st().resumeSession();
    expect(ok).toBe(true);
    expect(st().tableStats[HERO_SEAT].hands).toBeCloseTo(before, 10);

    // resumeSession 同步笔记本：统计不变，水位抬到历史总手数 → 之后加载不再衰减
    const nb = loadNotebook()!;
    expect(nb.stats.hands).toBeCloseTo(before, 10);
    expect(nb.handsRecorded).toBe(15);
    const again = loadDecayedHeroStats(0.92)!;
    expect(again.hands).toBeCloseTo(before, 10);
  }, 30000);

  it("clearSession 清除会话存档但不动笔记本", () => {
    seedNotebook(heroStats());
    clearSession();
    expect(loadNotebook()).not.toBeNull();
  });
});
