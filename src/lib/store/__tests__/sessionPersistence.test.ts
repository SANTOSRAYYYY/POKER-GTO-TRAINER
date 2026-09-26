/**
 * 牌局会话持久化（sessionPersistence）与断点恢复（resumeSession）测试。
 *
 * 锁定语义：
 * - round-trip：翻牌圈中途存档 → 模拟卸载重置 → resumeSession 恢复，
 *   牌堆/底牌/筹码/按钮位/风格逐字节一致，且能继续打完这手——
 *   结果与「同一中断点用同一策略不间断打完」的引擎对照完全一致；
 * - 结算横幅态恢复后重新预约 AUTO_ADVANCE，到期自动推进；
 * - 存档时轮到 AI：恢复后 AI 循环自动续跑，推进到 hero 或本手结束；
 * - pendingHeroBust 决策横幅恢复后不自动推进，决策照常用；
 * - hero 观战 + 快进：恢复后推进链续跑直到冠军产生；
 * - 无存档 resume 返回 false；损坏存档被清除并返回 null。
 *
 * 说明：
 * - heuristicDecide 被 mock 为确定性策略（call > check > fold，不注入随机噪声），
 *   保证「中断恢复」与「不中断」两路结果可逐字对比；
 * - localStorage 采用与 aiEngine.test.ts 相同的 window 存根；
 *   store 模块加载于存根安装之前，故自动存档订阅器在测试中不安装，
 *   所有存档写入均由测试显式调用 saveSession 完成；
 * - 「模拟卸载」= useGameStore.setState(getInitialState(), true) 全量重置单例。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DecideInput,
  GameState,
  HandRecord,
  PlayerAction,
  Seat,
} from "@/lib/types";
import { applyAction, legalActions } from "@/lib/poker/game";
import { DEFAULT_TOURNAMENT } from "@/lib/poker/tournament";
import {
  AUTO_ADVANCE_MS,
  HERO_SEAT,
  useGameStore,
} from "@/lib/store/gameStore";
import {
  SESSION_STORAGE_KEY,
  buildSnapshot,
  clearSession,
  loadSession,
  saveSession,
  summarizeSession,
} from "@/lib/store/sessionPersistence";
import { useHistoryStore } from "@/lib/store/historyStore";

/** 确定性 AI 策略：优先跟注，其次过牌，最后弃牌（任何状态必可终止） */
function pickPolicy(legal: PlayerAction[]): PlayerAction {
  return (
    legal.find((a) => a.type === "call") ??
    legal.find((a) => a.type === "check") ??
    legal.find((a) => a.type === "fold") ?? { type: "fold", amount: 0 }
  );
}

vi.mock("@/lib/ai/heuristic", () => ({
  heuristicDecide: (input: DecideInput) => {
    const legal = input.legalActions;
    return {
      action:
        legal.find((a) => a.type === "call") ??
        legal.find((a) => a.type === "check") ??
        legal.find((a) => a.type === "fold") ?? { type: "fold" as const, amount: 0 },
      reasoning: "确定性测试策略",
      source: "heuristic" as const,
    };
  },
}));

const st = () => useGameStore.getState();

let savedHands: HandRecord[];
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

/** 模拟刷新/重开页面：内存态全量重置，localStorage 存档保留 */
function simulateReload(): void {
  useGameStore.setState(useGameStore.getInitialState(), true);
}

/** 伪造一手已结束的牌局（只改结算相关字段），供 finalize/advance 测试驱动 */
function craftHandOver(finalStacks: number[], winners: Seat[]): void {
  const g = st().game!;
  const done: GameState = {
    ...g,
    handOver: true,
    currentSeat: null,
    winners,
    pot: 0,
    showdown: false,
    players: g.players.map((p, j) => ({ ...p, stack: finalStacks[j] })),
  };
  useGameStore.setState({
    game: done,
    streetLog: [],
    pendingActions: [],
    handSettled: false,
    heroProfit: null,
  });
}

const CASH2 = {
  mode: "cash",
  seats: 2,
  aiStyle: "tag",
  cashBlinds: { sb: 1, bb: 2 },
  buyin: 200,
} as const;

beforeEach(() => {
  stubLocalStorage();
  savedHands = [];
  vi.spyOn(useHistoryStore.getState(), "addHand").mockImplementation(
    async (h) => {
      savedHands.push(h);
    },
  );
});

afterEach(() => {
  st().cancelAutoAdvance(); // 防计时器泄漏到下一个用例
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("持久化 round-trip（中途存档 → 恢复 → 结果与未中断对照一致）", () => {
  it("翻牌圈存档恢复后继续打完：牌面/筹码/胜负/行动序列与引擎对照逐字一致", async () => {
    await st().startTable({ ...CASH2 });
    expect(st().game!.currentSeat).toBe(HERO_SEAT);

    // 翻前 hero（按钮/小盲）跟注 → AI 大盲过牌 → 进翻牌圈，AI（大盲先动）过牌 → 轮到 hero
    await st().act({ type: "call", amount: 1 });
    const mid = st().game!;
    expect(mid.street).toBe("flop");
    expect(mid.currentSeat).toBe(HERO_SEAT);
    // 翻牌圈已有人行动过（AI 的过牌记录在 pendingActions）
    expect(st().pendingActions.length).toBeGreaterThan(0);

    // 存档 + 锁定中断点现场（中断前已发生的完整动作序列）
    saveSession(st());
    const midJson = JSON.stringify(mid);
    const preMidActions = [
      ...st().streetLog.flatMap((s) => s.actions),
      ...st().pendingActions,
    ];

    // 模拟卸载重建：内存全清，仅从同一存档恢复
    simulateReload();
    expect(st().game).toBeNull();
    await expect(st().resumeSession()).resolves.toBe(true);

    // 恢复出的牌局与中断点逐字节一致（牌堆/底牌/筹码/行动方/街道全含）
    expect(JSON.stringify(st().game)).toBe(midJson);
    expect(st().handSettled).toBe(false);
    expect([...st().streetLog.flatMap((s) => s.actions), ...st().pendingActions]).toEqual(
      preMidActions,
    );

    // 恢复后继续打完：hero 回合按同一策略行动，AI 段由恢复后的循环自驱
    for (let i = 0; i < 60 && !st().game!.handOver; i++) {
      const g = st().game!;
      expect(g.currentSeat).toBe(HERO_SEAT); // 循环自驱后必然停在 hero 或结束
      await st().act(pickPolicy(legalActions(g)));
    }
    expect(st().game!.handOver).toBe(true);
    expect(st().handSettled).toBe(true);

    // 引擎对照：从中断点克隆状态，用同一策略不间断打完
    const replayLog: { seat: Seat; action: PlayerAction }[] = [];
    let g: GameState = JSON.parse(midJson) as GameState;
    while (!g.handOver) {
      const a = pickPolicy(legalActions(g));
      replayLog.push({ seat: g.currentSeat!, action: a });
      g = applyAction(g, a);
    }
    expect(st().game!.players.map((p) => p.stack)).toEqual(
      g.players.map((p) => p.stack),
    );
    expect(st().game!.winners).toEqual(g.winners);
    expect(st().game!.showdown).toBe(g.showdown);
    expect(st().game!.board).toEqual(g.board);

    // HandRecord 连续完整：中断前动作 + 恢复后动作 = 对照全程动作
    expect(savedHands).toHaveLength(1);
    const rec = savedHands[0];
    expect(rec.streets.flatMap((s) => s.actions)).toEqual([
      ...preMidActions,
      ...replayLog,
    ]);
    expect(rec.profit).toBe(g.players[HERO_SEAT].stack - 200);
    expect(st().heroProfit).toBe(rec.profit);
    expect(st().session.handsPlayed).toBe(1);
  });
});

describe("刷新模拟（存档恢复后关键字段不变）", () => {
  it("6 人锦标赛中途恢复：AI 底牌/牌堆/筹码/按钮位/风格/盲注级别/桌面状态不变", async () => {
    await st().startTable({ mode: "tournament", seats: 6, aiStyle: "random" });
    // 打满第一手（hero 弃牌）再开第二手，制造「筹码已结转、按钮已轮转」的现场
    if (!st().game!.handOver) {
      expect(st().game!.currentSeat).toBe(HERO_SEAT);
      await st().act({ type: "fold", amount: 0 });
    }
    await st().advanceToNextHand();
    // 第二手进行到现场（可能已是翻牌圈；hero 在局中或已行动均由 AI 段自驱）
    const before = st();
    expect(before.game).not.toBeNull();

    saveSession(before);
    simulateReload();
    await expect(st().resumeSession()).resolves.toBe(true);

    const after = st();
    // 引擎状态逐字段一致：AI 底牌与剩余牌堆不变（修复「刷新后手牌变了」的核心断言）
    expect(after.game).toEqual(before.game);
    expect(after.game!.deck).toEqual(before.game!.deck);
    for (let j = 0; j < before.game!.players.length; j++) {
      expect(after.game!.players[j].holeCards).toEqual(
        before.game!.players[j].holeCards,
      );
      expect(after.game!.players[j].stack).toBe(before.game!.players[j].stack);
    }
    expect(after.game!.buttonSeat).toBe(before.game!.buttonSeat);
    expect(after.game!.handNumber).toBe(before.game!.handNumber);
    // 桌面级状态不变（风格不重抽、筹码结转、盲注级别、淘汰/名次、建模统计）
    expect(after.seatStyles).toEqual(before.seatStyles);
    expect(after.tableStacks).toEqual(before.tableStacks);
    expect(after.seatMap).toEqual(before.seatMap);
    expect(after.eliminated).toEqual(before.eliminated);
    expect(after.finishPlaces).toEqual(before.finishPlaces);
    expect(after.blindLevel).toBe(before.blindLevel);
    expect(after.handsPlayedAtLevel).toBe(before.handsPlayedAtLevel);
    expect(after.levelHandsLeft).toBe(before.levelHandsLeft);
    expect(after.tableStats).toEqual(before.tableStats);
    expect(after.session).toEqual(before.session);
    expect(after.stacks).toEqual(before.stacks);
    expect(after.tournamentConfig).toEqual(before.tournamentConfig);
    // 瞬态字段复位
    expect(after.aiThinking).toBe(false);
    expect(after.lastError).toBeNull();
    expect(after.levelUpEvent).toBeNull();
  });
});

describe("断点续跑（状态机重入）", () => {
  it("存档时轮到 AI：恢复后 AI 循环自动续跑，推进到 hero 或本手结束", async () => {
    await st().startTable({ ...CASH2 });
    // 人工构造「轮到 AI 大盲」现场：测试环境 AI 循环同步跑完，
    // 无法自然停在此态，故直接挪行动指针（引擎按 currentSeat 计算合法动作，状态自洽）
    const g = st().game!;
    expect(g.currentSeat).toBe(HERO_SEAT);
    expect(g.streetActions).toHaveLength(0);
    useGameStore.setState({ game: { ...g, currentSeat: 1 as Seat } });
    saveSession(st());

    simulateReload();
    await expect(st().resumeSession()).resolves.toBe(true);

    const cur = st().game!;
    // AI 大盲已按策略行动（过牌），行动序列确曾推进
    expect(cur.streetActions.length).toBeGreaterThan(0);
    if (!cur.handOver) {
      expect(cur.currentSeat).toBe(HERO_SEAT); // 循环停在 hero 回合
    }
  });

  it("普通结算横幅态：恢复后重新预约 AUTO_ADVANCE，到期自动推进下一手", async () => {
    vi.useFakeTimers();
    try {
      await st().startTable({ ...CASH2 });
      await st().act({ type: "fold", amount: 0 });
      expect(st().game!.handOver).toBe(true);
      expect(st().handSettled).toBe(true);
      saveSession(st());

      simulateReload();
      await expect(st().resumeSession()).resolves.toBe(true);
      expect(st().game!.handNumber).toBe(1); // 恢复本身不推进

      await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_MS);
      expect(st().game!.handNumber).toBe(2); // 预约到期自动开出新一手
    } finally {
      vi.useRealTimers();
    }
  });

  it("pendingHeroBust 决策横幅：恢复后不自动推进，重购决策照常用", async () => {
    vi.useFakeTimers();
    try {
      await st().startTable({
        mode: "tournament",
        seats: 3,
        aiStyle: "tag",
        tournament: { ...DEFAULT_TOURNAMENT, rebuysAllowed: 1 },
      });
      craftHandOver([0, 3000, 1500], [1]);
      st().finalizeHand();
      expect(st().pendingHeroBust).toEqual({ place: 3, championSeat: null });
      saveSession(st());

      simulateReload();
      await expect(st().resumeSession()).resolves.toBe(true);
      // 横幅原样等待：预约无效，计时到期也不推进
      expect(st().pendingHeroBust).toEqual({ place: 3, championSeat: null });
      await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_MS * 2);
      expect(st().game!.handNumber).toBe(1);

      // 用户决策（重购继续）后照常开下一手
      await st().resolveTournamentRebuy(true);
      expect(st().pendingHeroBust).toBeNull();
      expect(st().rebuysUsed[0]).toBe(1);
      expect(st().game!.handNumber).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hero 观战 + 快进：恢复后推进链续跑直到冠军产生", async () => {
    await st().startTable({ mode: "tournament", seats: 3, aiStyle: "tag" });
    // hero 清零淘汰 → 自动下桌观战并开快进；finalize 由测试直接触发，
    // 推进链尚未启动——正是「刷新落在 handOver 且未推进」的现场
    craftHandOver([0, 10, 4490], [2]);
    st().finalizeHand();
    expect(st().heroSpectating).toBe(true);
    expect(st().fastForward).toBe(true);
    saveSession(st());

    simulateReload();
    await expect(st().resumeSession()).resolves.toBe(true);

    for (let i = 0; i < 600 && !st().tournamentOver; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(st().tournamentOver).toBe(true);
    expect(st().championSeat).not.toBeNull();
    expect(st().finishPlaces[st().championSeat!]).toBe(1);
    // 观战手不写历史（仍只有 hero 出局那一手）
    expect(savedHands).toHaveLength(1);
    st().setFastForward(false);
  }, 30000);

  it("heroRebuyPrompt 破产横幅：恢复后原样等待，重置买入照常", async () => {
    await st().startTable({ ...CASH2, seats: 3 });
    craftHandOver([1, 200, 199], [1]);
    st().finalizeHand();
    await st().advanceToNextHand(); // 触发破产提示，停在第 1 手
    expect(st().heroRebuyPrompt).toBe(true);
    expect(st().game!.handNumber).toBe(1);
    saveSession(st());

    simulateReload();
    await expect(st().resumeSession()).resolves.toBe(true);
    expect(st().heroRebuyPrompt).toBe(true);
    expect(st().game!.handNumber).toBe(1);

    await st().resolveRebuy(true);
    expect(st().heroRebuyPrompt).toBe(false);
    expect(st().game!.handNumber).toBe(2);
    expect(st().stacks[HERO_SEAT]).toBe(200);
  });
});

describe("存档读取与回退", () => {
  it("无存档：resumeSession 返回 false（调用方安全回退开新局）", async () => {
    simulateReload(); // 清掉前序用例残留的内存态，模拟全新打开页面
    await expect(st().resumeSession()).resolves.toBe(false);
    expect(st().game).toBeNull(); // 状态未被改动
  });

  it("损坏存档：loadSession 返回 null 并清除坏档", () => {
    store[SESSION_STORAGE_KEY] = "{ 这不是合法 JSON";
    expect(loadSession()).toBeNull();
    expect(store[SESSION_STORAGE_KEY]).toBeUndefined();
  });

  it("结构非法存档（字段缺失/长度不符）：拒绝并清除", async () => {
    await st().startTable({ ...CASH2 });
    saveSession(st());
    const snap = loadSession();
    expect(snap).not.toBeNull();
    // 篡改：eliminated 长度与 seats 不符
    store[SESSION_STORAGE_KEY] = JSON.stringify({
      ...snap,
      eliminated: [false],
    });
    expect(loadSession()).toBeNull();
    expect(store[SESSION_STORAGE_KEY]).toBeUndefined();
  });

  it("clearSession 后无存档可读；无牌局时 saveSession 不写", async () => {
    await st().startTable({ ...CASH2 });
    saveSession(st());
    expect(loadSession()).not.toBeNull();
    clearSession();
    expect(loadSession()).toBeNull();

    simulateReload(); // game/config 均为 null
    saveSession(st());
    expect(store[SESSION_STORAGE_KEY]).toBeUndefined();
  });

  it("buildSnapshot 记录桌面级按钮位；summarizeSession 输出大厅卡片字段", async () => {
    await st().startTable({ ...CASH2 });
    await st().act({ type: "fold", amount: 0 }); // 第 1 手 hero 弃牌（小盲 -1）
    saveSession(st());

    const snap = loadSession();
    expect(snap).not.toBeNull();
    expect(snap!.version).toBe(1);
    expect(snap!.buttonSeat).toBe(st().seatMap[st().game!.buttonSeat]);

    const sum = summarizeSession(snap!);
    expect(sum).toMatchObject({
      mode: "cash",
      seats: 2,
      handsPlayed: 1,
      heroProfit: -1,
      handNumber: 1,
      heroSpectating: false,
    });
  });

  it("锦标赛打完（tournamentOver）的终局快照可恢复出冠军弹窗态，不再推进", async () => {
    await st().startTable({ mode: "tournament", seats: 2, aiStyle: "tag" });
    craftHandOver([3000, 0], [0]);
    st().finalizeHand();
    expect(st().tournamentOver).toBe(true);
    saveSession(st());

    simulateReload();
    await expect(st().resumeSession()).resolves.toBe(true);
    const s = st();
    expect(s.tournamentOver).toBe(true);
    expect(s.championSeat).toBe(HERO_SEAT);
    expect(s.game!.handOver).toBe(true);
    // 终局态不推进
    await s.advanceToNextHand();
    expect(st().game!.handNumber).toBe(1);
  });
});
