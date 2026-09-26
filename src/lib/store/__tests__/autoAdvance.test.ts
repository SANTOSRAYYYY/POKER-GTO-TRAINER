/**
 * 结算自动推进（scheduleAutoAdvance）与 AI 动态 reasoning 契约测试。
 *
 * 锁定语义：
 * - 普通结算：scheduleAutoAdvance 预约 AUTO_ADVANCE_MS 后自动 advanceToNextHand；
 *   重复预约只保留最新一笔；cancelAutoAdvance / 开新手后旧预约作废；
 * - 交互决策情形不自动推进：hero 现金局破产提示（heroRebuyPrompt）、
 *   锦标赛重购决策（pendingHeroBust）、冠军结算（tournamentOver）、hero 观战；
 * - lastAiAction 在启发式来源下也带非空 reasoning（UI 不再按 source 过滤）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameState, HandRecord, Seat } from "@/lib/types";
import { DEFAULT_TOURNAMENT } from "@/lib/poker/tournament";
import {
  AUTO_ADVANCE_MS,
  HERO_SEAT,
  useGameStore,
} from "@/lib/store/gameStore";
import { useHistoryStore } from "@/lib/store/historyStore";

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
  st().cancelAutoAdvance(); // 防计时器泄漏到下一个用例
  vi.restoreAllMocks();
});

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
  aiStyle: "nit",
  cashBlinds: { sb: 1, bb: 2 },
  buyin: 200,
} as const;

describe("scheduleAutoAdvance（普通结算自动推进）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("AUTO_ADVANCE_MS 锁定为 5000（用户要求留足看摊牌时间）", () => {
    expect(AUTO_ADVANCE_MS).toBe(5000);
  });

  it("普通结算：预约后 AUTO_ADVANCE_MS 自动开下一手，且只触发一次", async () => {
    await st().startTable({ ...CASH2 });
    await st().act({ type: "fold", amount: 0 });
    expect(st().game!.handOver).toBe(true);
    expect(st().handSettled).toBe(true);

    st().scheduleAutoAdvance();
    expect(st().game!.handNumber).toBe(1); // 预约本身不推进

    await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_MS);
    expect(st().game!.handNumber).toBe(2); // 已开出新一手（hero 大盲可能拿 walk 直接结算）

    // 计时器一次性：继续推进时间不再跳转（新预约只能由 UI 重新发起）
    const handAfter = st().game!.handNumber;
    await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_MS * 3);
    expect(st().game!.handNumber).toBe(handAfter);
  });

  it("重复预约只保留最新一笔；cancelAutoAdvance 后不再推进", async () => {
    await st().startTable({ ...CASH2 });
    await st().act({ type: "fold", amount: 0 });

    st().scheduleAutoAdvance();
    st().scheduleAutoAdvance(); // 重置计时起点
    await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_MS - 1);
    expect(st().game!.handNumber).toBe(1); // 旧起点已作废，尚未到期
    await vi.advanceTimersByTimeAsync(1);
    expect(st().game!.handNumber).toBe(2);

    // 结算新手后预约再取消：不推进
    if (!st().game!.handOver) {
      // 第 2 手 hero 大盲可能拿到 walk 已自动结束；否则 hero 弃牌收尾
      if (st().game!.currentSeat === HERO_SEAT) {
        await st().act({ type: "fold", amount: 0 });
      }
    }
    expect(st().game!.handOver).toBe(true);
    st().scheduleAutoAdvance();
    st().cancelAutoAdvance();
    const handBefore = st().game!.handNumber;
    await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_MS * 2);
    expect(st().game!.handNumber).toBe(handBefore);
  });

  it("hero 现金局破产：自动推进被 heroRebuyPrompt 拦下，等用户决策", async () => {
    await st().startTable({ ...CASH2 });
    // 伪造：hero 只剩 1（不足大盲 2）
    craftHandOver([1, 399], [1]);
    st().finalizeHand();

    st().scheduleAutoAdvance();
    await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_MS * 2);
    const s = st();
    expect(s.game!.handNumber).toBe(1); // 未开新手
    expect(s.heroRebuyPrompt).toBe(true); // 转入交互决策

    // 提示存续期间预约直接无效
    st().scheduleAutoAdvance();
    await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_MS * 2);
    expect(st().game!.handNumber).toBe(1);

    // 用户决策后照常开下一手
    await st().resolveRebuy(true);
    expect(st().game!.handNumber).toBe(2);
  });

  it("锦标赛 hero 归零待决重购（pendingHeroBust）：不自动推进", async () => {
    await st().startTable({
      mode: "tournament",
      seats: 3,
      aiStyle: "tag",
      tournament: { ...DEFAULT_TOURNAMENT, rebuysAllowed: 1 },
    });
    craftHandOver([0, 3000, 1500], [1]);
    st().finalizeHand();
    expect(st().pendingHeroBust).not.toBeNull();

    st().scheduleAutoAdvance();
    await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_MS * 2);
    expect(st().game!.handNumber).toBe(1);
    expect(st().pendingHeroBust).not.toBeNull();

    await st().resolveTournamentRebuy(true);
    expect(st().game!.handNumber).toBe(2);
  });

  it("锦标赛冠军产生（tournamentOver）：不自动推进", async () => {
    await st().startTable({ mode: "tournament", seats: 2, aiStyle: "tag" });
    craftHandOver([3000, 0], [0]);
    st().finalizeHand();
    expect(st().tournamentOver).toBe(true);
    expect(st().championSeat).toBe(HERO_SEAT);

    st().scheduleAutoAdvance();
    await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_MS * 2);
    expect(st().game!.handNumber).toBe(1);
    expect(st().game!.handOver).toBe(true);
  });

  it("hero 观战中：scheduleAutoAdvance 不推进（观战由快进链驱动）", async () => {
    await st().startTable({ mode: "tournament", seats: 3, aiStyle: "tag" });
    craftHandOver([0, 1500, 3000], [2]);
    st().finalizeHand();
    // hero 淘汰即自动下桌观战并开快进（无弹窗）
    expect(st().heroSpectating).toBe(true);
    expect(st().fastForward).toBe(true);
    st().setFastForward(false); // 暂停快进链，隔离 scheduleAutoAdvance 行为

    st().scheduleAutoAdvance();
    await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_MS * 2);
    expect(st().game!.handNumber).toBe(1);
    expect(st().game!.handOver).toBe(true);
  });
});

describe("现金局 hero 破产下桌观战（spectateCash）", () => {
  it("下桌观战：hero 座位退出后续手，自动快进看 AI 互打且不写历史", async () => {
    await st().startTable({
      mode: "cash",
      seats: 3,
      aiStyle: "nit",
      cashBlinds: { sb: 1, bb: 2 },
      buyin: 100,
    });
    // 伪造：hero 归零破产
    craftHandOver([0, 150, 150], [1]);
    st().finalizeHand();
    expect(savedHands).toHaveLength(1); // hero 参与的手照常记录
    await st().advanceToNextHand(); // 触发破产决策（横幅态字段保留）
    expect(st().heroRebuyPrompt).toBe(true);
    expect(st().game!.handNumber).toBe(1);

    const p = st().spectateCash();
    // 决议体同步生效：下桌 + 自动快进；随即暂停以锁定断言现场
    expect(st().heroSpectating).toBe(true);
    expect(st().fastForward).toBe(true);
    st().setFastForward(false);
    await p;

    const s = st();
    expect(s.heroRebuyPrompt).toBe(false);
    expect(s.eliminated[0]).toBe(true); // hero 座位按淘汰压缩退出
    expect(s.tableStacks[0]).toBe(0);
    // 新一手只剩 2 个 AI（seatMap 不含 hero）
    expect(s.game!.handNumber).toBe(2);
    expect(s.game!.players).toHaveLength(2);
    expect(s.seatMap).toEqual([1, 2]);
    // 观战手不写历史（仍只有 hero 破产那一手）
    expect(savedHands).toHaveLength(1);
  });

  it("单挑现金局下桌观战：只剩 1 个 AI 无法开局，停住不崩溃", async () => {
    await st().startTable({ ...CASH2 });
    craftHandOver([0, 400], [1]);
    st().finalizeHand();
    await st().advanceToNextHand();
    expect(st().heroRebuyPrompt).toBe(true);

    await st().spectateCash();
    const s = st();
    expect(s.heroSpectating).toBe(true);
    expect(s.fastForward).toBe(false); // 无对手可打，快进自动停
    expect(s.game!.handNumber).toBe(1); // 未开新手，停留在完结手
    expect(s.lastError).toBeNull();
  });

  it("观战中的现金手不再触发 heroRebuyPrompt（AI 自动补码照常）", async () => {
    await st().startTable({
      mode: "cash",
      seats: 3,
      aiStyle: "nit",
      cashBlinds: { sb: 1, bb: 2 },
      buyin: 100,
    });
    craftHandOver([0, 150, 150], [1]);
    st().finalizeHand();
    await st().advanceToNextHand();
    const p = st().spectateCash();
    st().setFastForward(false);
    await p;
    // 观战后的推进：hero 已下桌，即使 tableStacks[0]=0 也不再弹破产提示
    expect(st().heroRebuyPrompt).toBe(false);
    if (st().game!.handOver) {
      await st().advanceToNextHand(); // fastForward 关，手动推一手
      expect(st().heroRebuyPrompt).toBe(false);
    }
  });
});

describe("lastAiAction reasoning 契约（不按来源过滤）", () => {
  it("启发式来源：每个 AI 行动都带非空中文 reasoning", async () => {
    // node 环境无 window → aiEngine 默认 heuristic（不碰网络）
    await st().startTable({ ...CASH2, aiStyle: "tag" });
    await st().act({ type: "call", amount: 1 }); // 轮到 AI 大盲行动

    const info = st().lastAiAction;
    expect(info).not.toBeNull();
    expect(info!.source).toBe("heuristic");
    expect(typeof info!.reasoning).toBe("string");
    expect(info!.reasoning.length).toBeGreaterThan(0);
  });

  it("多人桌整手打完：最终 lastAiAction 带非空 reasoning 与来源标记", async () => {
    await st().startTable({
      mode: "cash",
      seats: 6,
      aiStyle: "calling_station",
      cashBlinds: { sb: 1, bb: 2 },
      buyin: 100,
    });
    // hero 弃牌后 AI 自打到结束（测试环境无假延迟，循环在 act 内跑完）
    await st().act({ type: "fold", amount: 0 });
    expect(st().game!.handOver).toBe(true);
    const info = st().lastAiAction;
    expect(info).not.toBeNull();
    expect(info!.reasoning.length).toBeGreaterThan(0);
    expect(["llm", "heuristic"]).toContain(info!.source);
  });
});
