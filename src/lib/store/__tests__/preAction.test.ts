/**
 * gameStore 预操作（preAction）测试。
 *
 * 锁定语义：
 * - resolvePreAction 纯函数：fold 恒合法；check 仅无跟注额合法；call 有注按
 *   引擎封顶额、无注降级 check；handOver 返回 null；
 * - 轮到 hero 时 setPreAction 立即自动执行（fold/call 合法路径）并清空；
 * - 非法预操作（有注预设 check）自动忽略：清空且仍等 hero 手动；
 * - runAiLoop 尾部钩子：AI 行动窗口内预设，轮到 hero 时自动执行；
 * - act() 手动执行后消费预操作；跨手（dealNextHand）清空。
 *
 * 说明：IS_TEST 下 AI 假延迟跳过，startTable/advance 的同步窗口内
 * （await 前）预设等价于「AI 思考中预设」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAction, createGame } from "@/lib/poker/game";
import type { HandRecord } from "@/lib/types";
import {
  HERO_SEAT,
  resolvePreAction,
  useGameStore,
} from "@/lib/store/gameStore";
import { useHistoryStore } from "@/lib/store/historyStore";

const st = () => useGameStore.getState();

/** 2 人现金桌：第 1 手 hero 坐按钮位（小盲），翻前 hero 先行动 */
const CASH2 = {
  mode: "cash",
  seats: 2,
  aiStyle: "tag",
  cashBlinds: { sb: 1, bb: 2 },
  buyin: 200,
} as const;

/** 6 人现金桌：第 1 手 hero 按钮位，翻前 UTG(座位 3) 先行动（AI 先动） */
const CASH6 = { ...CASH2, seats: 6 } as const;

beforeEach(() => {
  vi.spyOn(useHistoryStore.getState(), "addHand").mockImplementation(
    async () => {},
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolvePreAction（预操作合法性解析）", () => {
  // 2 人桌翻前开局：hero(0) 按钮/小盲先行动，currentBet=2、hero.streetBet=1
  const CFG = {
    players: 2,
    smallBlind: 1,
    bigBlind: 2,
    stack: 200,
    buttonSeat: 0 as const,
  };

  it("fold 恒合法", () => {
    expect(resolvePreAction(createGame(CFG), "fold")).toEqual({
      type: "fold",
      amount: 0,
    });
  });

  it("有跟注额时 check → null（忽略）", () => {
    expect(resolvePreAction(createGame(CFG), "check")).toBeNull();
  });

  it("有跟注额时 call → 引擎 legalActions 的 call（amount 已封顶）", () => {
    expect(resolvePreAction(createGame(CFG), "call")).toEqual({
      type: "call",
      amount: 1,
    });
  });

  it("无跟注额时 call → 降级 check；check → check", () => {
    // hero 跟注后轮到大盲：currentBet=2、大盲 streetBet=2 → toCall=0
    const g = applyAction(createGame(CFG), { type: "call", amount: 1 });
    expect(g.currentSeat).toBe(1);
    expect(resolvePreAction(g, "call")).toEqual({ type: "check", amount: 0 });
    expect(resolvePreAction(g, "check")).toEqual({ type: "check", amount: 0 });
    expect(resolvePreAction(g, "fold")).toEqual({ type: "fold", amount: 0 });
  });

  it("handOver / 无行动座位 → null", () => {
    let g = createGame(CFG);
    g = applyAction(g, { type: "fold", amount: 0 });
    expect(g.handOver).toBe(true);
    expect(resolvePreAction(g, "fold")).toBeNull();
  });
});

describe("预操作自动执行（轮到 hero）", () => {
  it("预设 fold：轮到 hero 立即自动弃牌，preAction 清空，本手打完", async () => {
    await st().startTable(CASH2);
    expect(st().game?.currentSeat).toBe(HERO_SEAT);
    st().setPreAction("fold");
    expect(st().preAction).toBeNull(); // 同步消费
    await vi.waitFor(() => expect(st().game?.handOver).toBe(true));
    expect(st().game?.players[HERO_SEAT].folded).toBe(true);
  });

  it("预设 call：有注时按引擎额自动跟注（翻前小盲补 1），preAction 清空", async () => {
    await st().startTable(CASH2);
    expect(st().game?.currentSeat).toBe(HERO_SEAT);
    expect(st().callAmount).toBe(1);
    st().setPreAction("call");
    expect(st().preAction).toBeNull();
    await vi.waitFor(() =>
      expect(st().game?.players[HERO_SEAT].streetBet).toBe(2),
    );
    expect(st().game?.players[HERO_SEAT].folded).toBe(false);
  });

  it("非法忽略：有注预设 check → 清空且不执行，仍等 hero 手动", async () => {
    await st().startTable(CASH2);
    expect(st().game?.currentSeat).toBe(HERO_SEAT);
    st().setPreAction("check");
    // 同步路径：无异步动作发出
    expect(st().preAction).toBeNull();
    expect(st().game?.handOver).toBe(false);
    expect(st().game?.currentSeat).toBe(HERO_SEAT);
    expect(st().game?.players[HERO_SEAT].streetBet).toBe(1); // 未行动
  });

  it("无注降级：预设 call 但无需跟注 → 自动执行 check", async () => {
    await st().startTable(CASH2);
    // 造真实翻牌圈局面：hero 跟注 → 大盲过牌 → 翻牌圈大盲先过牌 → 轮到 hero，currentBet=0
    let g = st().game!;
    g = applyAction(g, { type: "call", amount: 1 });
    g = applyAction(g, { type: "check", amount: 0 });
    g = applyAction(g, { type: "check", amount: 0 });
    expect(g.street).toBe("flop");
    expect(g.currentSeat).toBe(HERO_SEAT);
    expect(g.currentBet).toBe(0);
    useGameStore.setState({
      game: g,
      streetLog: [],
      pendingActions: [...g.streetActions],
      streetStartBoard: [...g.board],
    });
    st().setPreAction("call");
    expect(st().preAction).toBeNull();
    // hero 的自动动作应为 check（本手此前 hero 只 call 过，任何 hero check 即自动执行）
    await vi.waitFor(() => {
      const s = st();
      const heroChecked =
        s.pendingActions.some(
          (a) => a.seat === HERO_SEAT && a.action.type === "check",
        ) ||
        s.streetLog.some((r) =>
          r.actions.some(
            (a) => a.seat === HERO_SEAT && a.action.type === "check",
          ),
        );
      expect(heroChecked).toBe(true);
    });
  });

  it("runAiLoop 尾部钩子：AI 行动窗口内预设 fold，轮到 hero 自动执行", async () => {
    // 6 人桌第 1 手：UTG(3)→…→hero(按钮) ；AI 全部先行动，hero 必然有行动机会
    const p = st().startTable(CASH6);
    // startTable 同步段已开局（preAction 复位 null），AI 正处于思考窗口
    st().setPreAction("fold");
    expect(st().preAction).toBe("fold"); // 轮不到 hero，保持预设
    await p;
    await vi.waitFor(() =>
      expect(st().game?.players[HERO_SEAT].folded).toBe(true),
    );
    expect(st().preAction).toBeNull();
  });

  it("act() 手动执行后消费预操作（防跨街残留）", async () => {
    await st().startTable(CASH2);
    useGameStore.setState({ preAction: "call" }); // 模拟已排队的预操作
    await st().act({ type: "fold", amount: 0 });
    expect(st().preAction).toBeNull();
    expect(st().game?.handOver).toBe(true);
  });

  it("跨手清空：dealNextHand 复位 preAction", async () => {
    await st().startTable(CASH2);
    await st().act({ type: "fold", amount: 0 }); // 结束第 1 手
    useGameStore.setState({ preAction: "fold" }); // 结算间隙残留
    await st().advanceToNextHand(); // 第 2 手
    expect(st().preAction).toBeNull();
    expect(st().game?.handNumber).toBe(2);
  });
});
