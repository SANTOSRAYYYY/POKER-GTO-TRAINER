/**
 * gameStore v2 集成验收测试（2-9 人桌 + 锦标赛 SNG 升盲）。
 *
 * 锁定语义：
 * - 盈亏 = 结算后 stack − 开手前 stack（引擎终局已把底池计入胜者 stack 并清零 pot）；
 * - startTable 开桌契约（9 人锦标赛：1500 筹码 / 10/20 起 / 每 8 手升级）；
 * - 升盲触发、淘汰与名次、按钮轮转跳过淘汰者、筹码守恒、HandRecord 新字段；
 * - 现金局 AI 不足大盲自动补码、hero 不足大盲的重置提示；
 * - hero 淘汰后观战快进直到冠军产生（观战手不写历史）。
 *
 * 说明：store 在 vitest 环境下跳过 AI 假延迟（IS_TEST），测试可连续打完多手。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameState, HandRecord, Seat } from "@/lib/types";
import { DEFAULT_BLIND_LEVELS } from "@/lib/types";
import { applyAction, createGame } from "@/lib/poker/game";
import {
  DEFAULT_TOURNAMENT,
  extendLevelsInfinite,
  INFINITE_TOTAL_LEVELS,
} from "@/lib/poker/tournament";
import {
  cappedCallAmount,
  computeHeroProfit,
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
  vi.restoreAllMocks();
});

/** 当前手轮到 hero 时弃牌，并等待 AI 把本手打完 */
async function heroFoldOut(): Promise<void> {
  const s = st();
  if (!s.game || s.game.handOver) return;
  expect(s.game.currentSeat).toBe(HERO_SEAT);
  await s.act({ type: "fold", amount: 0 });
  expect(st().game!.handOver).toBe(true);
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

describe("computeHeroProfit（结算入账语义）", () => {
  const CFG = { players: 2, smallBlind: 1, bigBlind: 2, stack: 200, buttonSeat: 0 as Seat };

  it("hero 赢得底池：profit = 结算后 stack 差额（pot 已被引擎清零）", () => {
    let s = createGame(CFG);
    s = applyAction(s, { type: "call", amount: 1 }); // 按钮位（hero）跟注
    s = applyAction(s, { type: "fold", amount: 0 }); // 大盲弃牌
    expect(s.handOver).toBe(true);
    expect(s.winners).toEqual([0]);
    expect(s.pot).toBe(0);
    expect(s.players[0].stack).toBe(202);
    expect(computeHeroProfit(s, 0, [200, 200])).toBe(2);
  });

  it("hero 弃牌输掉：profit = -本手投入，筹码守恒", () => {
    let s = createGame(CFG);
    s = applyAction(s, { type: "fold", amount: 0 });
    expect(s.winners).toEqual([1]);
    expect(s.players[0].stack).toBe(199);
    expect(s.players[1].stack).toBe(201);
    expect(computeHeroProfit(s, 0, [200, 200])).toBe(-1);
    expect(s.players[0].stack + s.players[1].stack + s.pot).toBe(400);
  });

  it("摊牌平局（牌面成皇家同花顺）：profit = 0", () => {
    let s = createGame({
      ...CFG,
      // pop 顺序：按钮底牌×2、大盲底牌×2、flop×3、turn、river
      deckPrefix: ["2c", "3d", "4c", "5d", "As", "Ks", "Qs", "Js", "Ts"],
    });
    s = applyAction(s, { type: "call", amount: 1 });
    s = applyAction(s, { type: "check", amount: 0 });
    for (let i = 0; i < 3; i++) {
      s = applyAction(s, { type: "check", amount: 0 });
      s = applyAction(s, { type: "check", amount: 0 });
    }
    expect(s.handOver).toBe(true);
    expect(s.showdown).toBe(true);
    expect(s.winners).toEqual([0, 1]);
    expect(computeHeroProfit(s, 0, [200, 200])).toBe(0);
    expect(s.players[0].stack + s.players[1].stack).toBe(400);
  });
});

describe("F1：cappedCallAmount 按实际可跟注额封顶", () => {
  const CFG = { players: 2, smallBlind: 1, bigBlind: 2, stack: 200, buttonSeat: 0 as Seat };

  it("对手 bet-to 超过 hero 剩余筹码：按 stack 封顶（与引擎 legalActions 的 call 一致）", () => {
    let s = createGame(CFG);
    s = applyAction(s, { type: "call", amount: 1 }); // hero（按钮/小盲）跟注
    // 构造「对手全下 200，hero 剩 199」的深打浅现场
    const rigged: GameState = {
      ...s,
      currentBet: 200,
      players: s.players.map((p, j) =>
        j === 0 ? { ...p, streetBet: 2, stack: 198 } : { ...p, streetBet: 200 },
      ),
    };
    // 未封顶口径会得出 198... 这里差额 = 200 - 2 = 198 ≤ stack 198（恰好够）；
    // 再构造真正超额的情形：hero 只剩 100
    const shallow: GameState = {
      ...rigged,
      players: rigged.players.map((p, j) =>
        j === 0 ? { ...p, streetBet: 2, stack: 100 } : p,
      ),
    };
    expect(cappedCallAmount(rigged, HERO_SEAT)).toBe(198); // 未超额：全额补差
    expect(cappedCallAmount(shallow, HERO_SEAT)).toBe(100); // 超额：按 stack 封顶
    expect(cappedCallAmount(shallow, 1 as Seat)).toBe(0); // 对手无待跟注差额
  });

  it("无需跟注 / 观战口径：check 场景为 0", () => {
    const s = createGame(CFG);
    // 翻前 hero 需补 1（小盲差额）
    expect(cappedCallAmount(s, HERO_SEAT)).toBe(1);
    // 大盲无人加注时无需补
    expect(cappedCallAmount(s, 1 as Seat)).toBe(0);
  });
});

describe("startTable 开桌", () => {
  it("9 人锦标赛开局：座位/盲注/筹码/风格/级别均符合契约", async () => {
    await st().startTable({ mode: "tournament", seats: 9, aiStyle: "tag" });
    const s = st();
    const g = s.game!;
    expect(g.players).toHaveLength(9);
    expect(s.seatMap).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(g.buttonSeat).toBe(0); // 第 1 手 hero 坐按钮位
    expect(g.handNumber).toBe(1);
    // DEFAULT_TOURNAMENT 第 0 级 10/20，ante = 大盲 20
    expect(g.smallBlind).toBe(10);
    expect(g.bigBlind).toBe(20);
    expect(g.ante).toBe(20);
    // 盲注落在按钮左邻两座；每人另付 ante 20（死钱）
    expect(g.players[1].stack).toBe(1470); // 1500 − 20 ante − 10 小盲
    expect(g.players[2].stack).toBe(1460); // 1500 − 20 ante − 20 大盲
    // 筹码守恒：Σ stack + pot === 9 × 1500
    const total =
      g.players.reduce((sum, p) => sum + p.stack, 0) + g.pot;
    expect(total).toBe(9 * DEFAULT_TOURNAMENT.startStack);
    // AI 风格：8 个 AI 座位全员 tag；hero 不在其中
    expect(s.seatStyles).toHaveLength(8);
    expect(s.seatStyles.every((x) => x === "tag")).toBe(true);
    // 升盲状态
    expect(s.blindLevel).toBe(0);
    expect(s.handsPlayedAtLevel).toBe(0);
    expect(s.levelHandsLeft).toBe(DEFAULT_TOURNAMENT.handsPerLevel);
    expect(s.tableStacks).toEqual(Array(9).fill(1500));
    // 轮到 hero 行动（tag AI 不会在本手直接结束）
    expect(g.currentSeat).toBe(HERO_SEAT);
    expect(g.players[HERO_SEAT].holeCards).toHaveLength(2);
  });

  it("aiStyle=random：每座独立抽取具体风格（保密，不含 'random'）", async () => {
    await st().startTable({ mode: "cash", seats: 6, aiStyle: "random", cashBlinds: { sb: 1, bb: 2 }, buyin: 100 });
    const s = st();
    expect(s.seatStyles).toHaveLength(5);
    const valid = ["nit", "tag", "lag", "maniac", "calling_station", "gto"];
    for (const x of s.seatStyles) expect(valid).toContain(x);
  });
});

describe("BBA 大盲 ante 锦标赛（anteMode='bb'）", () => {
  it("开局（单挑）：仅大盲位投一份 ante，pot = SB + BB + ante，筹码守恒", async () => {
    await st().startTable({
      mode: "tournament",
      seats: 2,
      aiStyle: "tag",
      tournament: { ...DEFAULT_TOURNAMENT, anteMode: "bb" },
    });
    const s = st();
    const g = s.game!;
    expect(s.tournamentConfig!.anteMode).toBe("bb");
    // 第 0 级 10/20，ante 20（BBA：仅大盲位投）；
    // 单挑 hero 按钮=小盲且翻前先行动，AI 尚未动作，快照确定
    expect(g.ante).toBe(20);
    expect(g.currentSeat).toBe(HERO_SEAT);
    expect(g.players[0].handBet).toBe(10); // hero 小盲：不投 ante
    expect(g.players[0].stack).toBe(1490);
    expect(g.players[1].handBet).toBe(40); // AI 大盲：ante 20 + 大盲 20
    expect(g.players[1].stack).toBe(1460);
    expect(g.pot).toBe(10 + 20 + 20); // 全桌只有 1 份 ante
    expect(g.players[0].stack + g.players[1].stack + g.pot).toBe(
      2 * DEFAULT_TOURNAMENT.startStack,
    );
  });

  it("筹码不对称的次手：correctStacks 只向大盲位折算 ante，短码非盲位不被误收", async () => {
    await st().startTable({
      mode: "tournament",
      seats: 4,
      aiStyle: "tag",
      tournament: { ...DEFAULT_TOURNAMENT, anteMode: "bb" },
    });
    // 伪造第 1 手结果：hero 大赢，桌面座位 1 只剩 25（下把手坐按钮位）
    craftHandOver([3225, 25, 1500, 1250], [0]);
    st().finalizeHand();
    await st().advanceToNextHand();

    const g = st().game!;
    expect(g.handNumber).toBe(2);
    // 按钮 0→1：SB=引擎座位2、BB=引擎座位3、UTG=hero（座位0，先行动故无 AI 抢先）
    expect(g.buttonSeat).toBe(1);
    expect(g.players[1].handBet).toBe(0); // 按钮短码：BBA 下不投 ante
    expect(g.players[1].stack).toBe(25);
    expect(g.players[2].handBet).toBe(10); // SB：仅小盲
    expect(g.players[2].stack).toBe(1490);
    expect(g.players[3].handBet).toBe(40); // BB：ante 20 + 大盲 20
    expect(g.players[3].stack).toBe(1210);
    expect(g.pot).toBe(10 + 20 + 20);
    expect(
      g.players.reduce((sum, p) => sum + p.stack, 0) + g.pot,
    ).toBe(4 * DEFAULT_TOURNAMENT.startStack);
    expect(g.currentSeat).toBe(HERO_SEAT); // hero UTG 先行动，未被 ante 误伤
    expect(g.players[HERO_SEAT].handBet).toBe(0);
  });
});

describe("HandRecord 新契约（players[]/heroSeat/buttonSeat/ante）", () => {
  it("单挑 hero 弃牌：记录字段完整、aiStyle 按座位归属、对手底牌保密", async () => {
    await st().startTable({
      mode: "cash",
      seats: 2,
      aiStyle: "nit",
      cashBlinds: { sb: 1, bb: 2 },
      buyin: 200,
    });
    expect(st().game!.currentSeat).toBe(0);
    await st().act({ type: "fold", amount: 0 });

    const s = st();
    expect(s.game!.handOver).toBe(true);
    expect(s.handSettled).toBe(true);
    expect(s.heroProfit).toBe(-1);
    expect(s.session.handsPlayed).toBe(1);
    expect(s.session.heroProfit).toBe(-1);
    expect(s.game!.players[0].stack + s.game!.players[1].stack).toBe(400);

    expect(savedHands).toHaveLength(1);
    const rec = savedHands[0];
    expect(rec.players).toHaveLength(2);
    expect(rec.players[0]).toMatchObject({
      seat: 0,
      isHero: true,
      aiStyle: null,
      profit: -1,
    });
    expect(rec.players[0].cards).toHaveLength(2);
    expect(rec.players[1]).toMatchObject({
      seat: 1,
      isHero: false,
      aiStyle: "nit",
      profit: 1,
    });
    expect(rec.players[1].cards).toBeNull(); // 未摊牌保密
    expect(rec.heroSeat).toBe(0);
    expect(rec.buttonSeat).toBe(0);
    expect(rec.ante).toBe(0);
    expect(rec.mode).toBe("cash");
    expect(rec.tournamentSeats).toBeUndefined(); // 现金局不记开赛人数
    expect(rec.result).toBe("lose");
    expect(rec.profit).toBe(-1);
    expect(rec.showdown).toBe(false);
    expect(rec.streets).toHaveLength(1);
    expect(rec.streets[0].actions).toEqual([
      { seat: 0, action: { type: "fold", amount: 0 } },
    ]);
  });
});

describe("多人桌一手完整流转", () => {
  it("6 人现金局：hero 弃牌后 AI 自打到结束，筹码守恒且盈亏零和", async () => {
    await st().startTable({
      mode: "cash",
      seats: 6,
      aiStyle: "calling_station",
      cashBlinds: { sb: 1, bb: 2 },
      buyin: 100,
    });
    expect(st().game!.players).toHaveLength(6);
    await heroFoldOut();

    const g = st().game!;
    expect(g.handOver).toBe(true);
    expect(g.winners!.length).toBeGreaterThanOrEqual(1);
    expect(g.players.reduce((sum, p) => sum + p.stack, 0)).toBe(600);

    expect(savedHands).toHaveLength(1);
    const rec = savedHands[0];
    expect(rec.players).toHaveLength(6);
    expect(rec.players.reduce((sum, p) => sum + p.profit, 0)).toBe(0);
    expect(rec.players[HERO_SEAT].profit).toBe(rec.profit);

    // 推进下一手：按钮轮转 0 → 1，筹码结转
    // （现金局 AI 筹码 < 大盲会自动补码回 buyin，补码会增加总筹码，按规则预先计算）
    const stacksAfterHand1 = st().game!.players.map((p) => p.stack);
    const rebuys = stacksAfterHand1
      .slice(1)
      .filter((s) => s < 2).length;
    const expectedTotal = 600 + rebuys * 100;
    await st().advanceToNextHand();
    const s2 = st();
    expect(s2.game!.handNumber).toBe(2);
    expect(s2.game!.buttonSeat).toBe(1);
    expect(s2.game!.players).toHaveLength(6);
    expect(s2.handSettled).toBe(false);
    expect(s2.heroProfit).toBeNull();
    // 开手筹码记录与桌面状态一致
    expect(s2.stacks.reduce((sum, s) => sum + s, 0)).toBe(expectedTotal);
    expect(
      s2.game!.players.reduce((sum, p) => sum + p.stack, 0) + s2.game!.pot,
    ).toBe(expectedTotal);
  });
});

describe("锦标赛升盲", () => {
  it("每 8 手升一级：第 8 手结束触发 levelUpEvent，第 9 手用新盲注", async () => {
    await st().startTable({ mode: "tournament", seats: 9, aiStyle: "nit" });
    // 以 session.handsPlayed 为准驱动前 8 手（hero 大盲拿到 walk 时本手
    // 可能在 advance 内自动打完，按计数而不是循环次数断言）
    while (st().session.handsPlayed < 8) {
      expect(st().blindLevel).toBe(0);
      expect(st().game!.smallBlind).toBe(10);
      if (!st().game!.handOver) {
        expect(st().game!.currentSeat).toBe(HERO_SEAT);
        await st().act({ type: "fold", amount: 0 });
        expect(st().game!.handOver).toBe(true);
      }
      if (st().session.handsPlayed < 8) await st().advanceToNextHand();
    }
    // 第 8 手结算完毕：升盲触发，计数重置，事件待播
    expect(st().handsPlayedAtLevel).toBe(0);
    expect(st().blindLevel).toBe(1);
    expect(st().levelHandsLeft).toBe(8);
    expect(st().levelUpEvent).toEqual({
      level: 1,
      blinds: { smallBlind: 15, bigBlind: 30, ante: 30 },
    });
    // 第 9 手：用新盲注 15/30，事件在开手时清除
    if (st().game!.handOver) await st().advanceToNextHand();
    expect(st().blindLevel).toBe(1);
    expect(st().handsPlayedAtLevel).toBe(0);
    expect(st().levelUpEvent).toBeNull();
    expect(st().game!.smallBlind).toBe(15);
    expect(st().game!.bigBlind).toBe(30);
  }, 30000);
});

describe("锦标赛淘汰与名次", () => {
  it("stack=0 玩家淘汰并记名次（剩余人数+1），HandRecord 带 finishPlace", async () => {
    await st().startTable({ mode: "tournament", seats: 4, aiStyle: "tag" });
    // 伪造：引擎座位 3（桌面 3）清零出局
    craftHandOver([1450, 3050, 1500, 0], [1]);
    const rec = st().finalizeHand();

    const s = st();
    expect(s.eliminated).toEqual([false, false, false, true]);
    expect(s.finishPlaces).toEqual([null, null, null, 4]);
    expect(s.bustEvents).toEqual([{ seat: 3, place: 4 }]);
    expect(s.heroSpectating).toBe(false);
    expect(s.tournamentOver).toBe(false);
    expect(s.tableStacks).toEqual([1450, 3050, 1500, 0]);

    expect(rec).not.toBeNull();
    expect(rec!.mode).toBe("tournament");
    expect(rec!.tournamentSeats).toBe(4); // 开赛人数（config.seats），非本手在座人数
    expect(rec!.players[3]).toMatchObject({ profit: -1500, finishPlace: 4 });
    expect(rec!.players[1].profit).toBe(1550);
    expect(rec!.profit).toBe(-50); // hero：1450 − 1500
    // 升盲计数照常推进
    expect(s.handsPlayedAtLevel).toBe(1);
    expect(s.levelHandsLeft).toBe(7);

    // 推进：3 人继续，按钮 0 → 1
    await s.advanceToNextHand();
    const s2 = st();
    expect(s2.game!.players).toHaveLength(3);
    expect(s2.seatMap).toEqual([0, 1, 2]);
    expect(s2.game!.buttonSeat).toBe(1);
    expect(
      s2.game!.players.reduce((sum, p) => sum + p.stack, 0) + s2.game!.pot,
    ).toBe(6000);
  });

  it("按钮轮转跳过已淘汰座位", async () => {
    await st().startTable({ mode: "tournament", seats: 4, aiStyle: "tag" });
    // 桌面座位 1 淘汰（引擎座位与桌面座位在第 1 手一致）
    craftHandOver([3000, 0, 1500, 1500], [0]);
    st().finalizeHand();
    expect(st().eliminated).toEqual([false, true, false, false]);

    await st().advanceToNextHand();
    const s = st();
    // 桌面按钮 0 → 下一个在局座位是 2（跳过 1）；引擎座位压缩后 indexOf(2)=1
    expect(s.seatMap).toEqual([0, 2, 3]);
    expect(s.game!.buttonSeat).toBe(1);
    expect(s.game!.players).toHaveLength(3);
    // 结转筹码：桌面 [3000, -, 1500, 1500]
    expect(s.stacks).toEqual([3000, 1500, 1500]);
  });

  it("只剩 1 人时产生冠军并结束锦标赛", async () => {
    await st().startTable({ mode: "tournament", seats: 4, aiStyle: "tag" });
    // 伪造：hero 通吃，三家同手出局（开手筹码相同，名次按座位顺序）
    craftHandOver([6000, 0, 0, 0], [0]);
    const rec = st().finalizeHand();

    const s = st();
    expect(s.tournamentOver).toBe(true);
    expect(s.championSeat).toBe(0);
    expect(s.finishPlaces).toEqual([1, 4, 3, 2]);
    expect(s.bustEvents).toHaveLength(3);
    expect(rec!.players[0].finishPlace).toBe(1);
    expect(rec!.profit).toBe(4500);

    // 锦标赛结束后不再开新手
    await s.advanceToNextHand();
    expect(st().game!.handOver).toBe(true);
    expect(st().game!.handNumber).toBe(1);
  });

  it("hero 淘汰 → 自动下桌观战并快进：AI 自打直到冠军产生，观战手不写历史", async () => {
    await st().startTable({ mode: "tournament", seats: 3, aiStyle: "nit" });
    // 伪造：hero 清零出局（第 3 名），桌面座位 1 只剩 10（下把必险）
    craftHandOver([0, 10, 4490], [2]);
    st().finalizeHand();
    // 不弹窗：直接 heroSpectating + 自动开启快进
    expect(st().heroSpectating).toBe(true);
    expect(st().fastForward).toBe(true);
    expect(st().finishPlaces[0]).toBe(3);
    expect(savedHands).toHaveLength(1); // hero 参与的手照常记录

    // 快进推进链自驱（finalize 由测试直接触发，首步手动推进一次启动链）
    await st().advanceToNextHand();
    for (let i = 0; i < 600 && !st().tournamentOver; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(st().tournamentOver).toBe(true);
    expect(st().championSeat).not.toBeNull();
    expect(st().finishPlaces[st().championSeat!]).toBe(1);
    // 观战期间手牌不写历史（仍只有 hero 出局那一手）
    expect(savedHands).toHaveLength(1);
    st().setFastForward(false);
  }, 30000);
});

describe("现金局补码与重置提示", () => {
  it("AI 筹码不足大盲（含归零）自动补码回 buyin；hero 不足大盲时提示，重置后继续", async () => {
    await st().startTable({
      mode: "cash",
      seats: 3,
      aiStyle: "nit",
      cashBlinds: { sb: 1, bb: 2 },
      buyin: 100,
    });
    // 伪造：引擎座位 1（桌面 1）归零
    craftHandOver([50, 0, 250], [2]);
    st().finalizeHand();

    // 推进：AI 1 自动补码回 100，hero 50 ≥ bb 不提示
    await st().advanceToNextHand();
    let s = st();
    expect(s.heroRebuyPrompt).toBe(false);
    expect(s.game!.handNumber).toBe(2);
    expect(s.game!.buttonSeat).toBe(1);
    // 开手筹码记录证明补码与结转（本手可能因 hero 大盲拿 walk 已自动打完，
    // tableStacks 会变，故断言确定性的 stacks）
    expect(s.stacks).toEqual([50, 100, 250]);

    // 伪造：AI 1 只剩 1（不足大盲 2，同样触发补码——阈值为 stack < bb）
    craftHandOver([50, 1, 249], [2]);
    st().finalizeHand();
    await st().advanceToNextHand();
    s = st();
    expect(s.heroRebuyPrompt).toBe(false);
    expect(s.stacks).toEqual([50, 100, 249]);

    // 伪造：hero 只剩 1（不足大盲）
    craftHandOver([1, 100, 199], [1]);
    st().finalizeHand();
    await st().advanceToNextHand();
    s = st();
    expect(s.heroRebuyPrompt).toBe(true);
    expect(s.game!.handNumber).toBe(3); // 未开新手，等待决策

    // 重置买入：hero 回到 100，记一次 stackResets
    await s.resolveRebuy(true);
    s = st();
    expect(s.heroRebuyPrompt).toBe(false);
    expect(s.session.stackResets).toBe(1);
    expect(s.game!.handNumber).toBe(4);
    expect(s.stacks[HERO_SEAT]).toBe(100); // 开手筹码已重置回 buyin
  });

  it("hero 短码可选择继续（不重置）", async () => {
    await st().startTable({
      mode: "cash",
      seats: 2,
      aiStyle: "nit",
      cashBlinds: { sb: 1, bb: 2 },
      buyin: 100,
    });
    // 伪造：hero 只剩 1（不足大盲 2）
    craftHandOver([1, 199], [1]);
    st().finalizeHand();
    await st().advanceToNextHand();
    expect(st().heroRebuyPrompt).toBe(true);

    await st().resolveRebuy(false);
    const s = st();
    expect(s.session.stackResets).toBe(0);
    expect(s.game!.handNumber).toBe(2);
    // hero 以 1 筹码短码入座（开手筹码记录为 1；投盲即全下）
    expect(s.stacks[HERO_SEAT]).toBe(1);
  });
});

describe("锦标赛重购（rebuy）", () => {
  const REBUY2 = { ...DEFAULT_TOURNAMENT, rebuysAllowed: 2 };

  it("rebuys=2：hero 首次归零弹重购提示，确认后筹码=起始筹码且 rebuysUsed=1", async () => {
    await st().startTable({
      mode: "tournament",
      seats: 3,
      aiStyle: "tag",
      tournament: REBUY2,
    });
    // 伪造：hero 归零（开手筹码 1500 全输光）
    craftHandOver([0, 3000, 1500], [1]);
    st().finalizeHand();

    let s = st();
    // 不立即淘汰：等待重购决策（名次为「若认输」的预计算结果）
    expect(s.pendingHeroBust).toEqual({ place: 3, championSeat: null });
    expect(s.eliminated).toEqual([false, false, false]);
    expect(s.heroSpectating).toBe(false);
    expect(s.rebuysUsed).toEqual([0, 0, 0]);
    expect(s.bustEvents).toEqual([]);
    // 待决期间 advance 不推进
    await s.advanceToNextHand();
    expect(st().game!.handNumber).toBe(1);

    // 确认重购：买回起始筹码，消耗 1 次，开下一手
    await st().resolveTournamentRebuy(true);
    s = st();
    expect(s.pendingHeroBust).toBeNull();
    expect(s.rebuysUsed[0]).toBe(1);
    // 开手筹码记录 = 重购后的起始筹码（桌面筹码可能因新一手自动打完
    // 而变化，故断言确定性的 stacks 而非 tableStacks）
    expect(s.stacks[HERO_SEAT]).toBe(1500);
    expect(s.game!.handNumber).toBe(2);
    expect(s.eliminated).toEqual([false, false, false]);
    // 筹码守恒基准计入重购注入：3×1500 + 1500（手间流转不改变总额）
    expect(s.tableStacks.reduce((a, b) => a + b, 0)).toBe(4 * 1500);
  });

  it("用完次数后 hero 归零 = 正式淘汰记名次（此前两次重购均生效）", async () => {
    await st().startTable({
      mode: "tournament",
      seats: 3,
      aiStyle: "tag",
      tournament: REBUY2,
    });
    // 第 1、2 次归零：均提示并重购成功
    for (let i = 0; i < 2; i++) {
      craftHandOver([0, 3000, 1500], [1]);
      st().finalizeHand();
      expect(st().pendingHeroBust).not.toBeNull();
      await st().resolveTournamentRebuy(true);
      expect(st().rebuysUsed[0]).toBe(i + 1);
      // 开手筹码记录 = 起始筹码（tableStacks 可能因新一手自动打完而变化）
      expect(st().stacks[HERO_SEAT]).toBe(1500);
    }
    // 第 3 次归零：次数用完，直接淘汰记名次，无提示；自动下桌观战并快进
    craftHandOver([0, 4000, 2000], [1]);
    st().finalizeHand();
    const s = st();
    expect(s.pendingHeroBust).toBeNull();
    expect(s.eliminated).toEqual([true, false, false]);
    expect(s.finishPlaces[0]).toBe(3);
    expect(s.bustEvents).toEqual([{ seat: 0, place: 3 }]);
    expect(s.heroSpectating).toBe(true);
    expect(s.fastForward).toBe(true); // 不弹窗，自动快进观战
    expect(s.rebuysUsed[0]).toBe(2);
  });

  it("hero 归零选择认输观战：按预记账淘汰，自动进入快进观战（不弹窗）", async () => {
    await st().startTable({
      mode: "tournament",
      seats: 3,
      aiStyle: "tag",
      tournament: REBUY2,
    });
    craftHandOver([0, 3000, 1500], [1]);
    st().finalizeHand();
    expect(st().pendingHeroBust).toEqual({ place: 3, championSeat: null });

    const p = st().resolveTournamentRebuy(false);
    // 决议体同步生效：认输即下桌观战并自动开快进
    expect(st().heroSpectating).toBe(true);
    expect(st().fastForward).toBe(true);
    st().setFastForward(false); // 停止推进链，锁定断言现场
    await p;

    const s = st();
    expect(s.pendingHeroBust).toBeNull();
    expect(s.eliminated).toEqual([true, false, false]);
    expect(s.finishPlaces[0]).toBe(3);
    expect(s.heroSpectating).toBe(true);
    expect(s.rebuysUsed[0]).toBe(0); // 认输不消耗次数
    expect(s.bustEvents).toEqual([{ seat: 0, place: 3 }]);
    expect(s.tournamentOver).toBe(false);
    expect(s.game!.handNumber).toBe(1); // 快进已暂停，未推进
  });

  it("AI 归零自动重购（不淘汰、无播报），守恒计入注入筹码", async () => {
    await st().startTable({
      mode: "tournament",
      seats: 3,
      aiStyle: "tag",
      tournament: REBUY2,
    });
    // 伪造：AI 1（引擎座位 1）归零
    craftHandOver([1450, 0, 3050], [2]);
    st().finalizeHand();

    const s = st();
    expect(s.eliminated).toEqual([false, false, false]);
    expect(s.bustEvents).toEqual([]);
    expect(s.pendingHeroBust).toBeNull();
    expect(s.rebuysUsed).toEqual([0, 1, 0]);
    expect(s.tableStacks).toEqual([1450, 1500, 3050]); // AI 1 买回 1500

    await s.advanceToNextHand();
    const s2 = st();
    expect(s2.game!.players).toHaveLength(3); // 无人淘汰，不压缩座位
    // 开手筹码记录含 AI 重购注入的 1500：基准 3×1500 + 1500
    expect(s2.stacks.reduce((a, b) => a + b, 0)).toBe(4 * 1500);
    expect(
      s2.game!.players.reduce((sum, p) => sum + p.stack, 0) + s2.game!.pot,
    ).toBe(4 * 1500);
  });

  it("重购期外（第 5 级起）归零 = 正常淘汰，AI 不重购", async () => {
    // handsPerLevel=1：每手结束即升盲，4 手后进入 blindLevel 4（第 5 级）
    const tc = { ...DEFAULT_TOURNAMENT, handsPerLevel: 1, rebuysAllowed: 2 };
    await st().startTable({ mode: "tournament", seats: 3, aiStyle: "tag", tournament: tc });
    for (let i = 0; i < 4; i++) {
      craftHandOver([1500, 1500, 1500], [0]); // 无人归零的伪平局
      st().finalizeHand();
    }
    expect(st().blindLevel).toBe(4); // 已出重购期

    craftHandOver([1500, 0, 3000], [2]);
    st().finalizeHand();
    const s = st();
    expect(s.eliminated).toEqual([false, true, false]);
    expect(s.bustEvents).toEqual([{ seat: 1, place: 3 }]);
    expect(s.rebuysUsed).toEqual([0, 0, 0]);
    expect(s.tableStacks).toEqual([1500, 0, 3000]);
  });

  it("rebuys=0（默认）：归零即淘汰，无重购提示，自动下桌观战（回归）", async () => {
    await st().startTable({ mode: "tournament", seats: 3, aiStyle: "tag" });
    expect(st().tournamentConfig!.rebuysAllowed).toBe(0);
    craftHandOver([0, 3000, 1500], [1]);
    st().finalizeHand();
    const s = st();
    expect(s.pendingHeroBust).toBeNull();
    expect(s.rebuysUsed).toEqual([0, 0, 0]);
    expect(s.eliminated).toEqual([true, false, false]);
    expect(s.finishPlaces[0]).toBe(3);
    expect(s.heroSpectating).toBe(true);
    expect(s.fastForward).toBe(true); // 淘汰即自动快进观战
  });
});

describe("act 错误兜底（lastError）", () => {
  it("非法动作不抛出、不破坏牌局：lastError 置错，clearError 清除，随后可正常行动", async () => {
    await st().startTable({
      mode: "cash",
      seats: 2,
      aiStyle: "nit",
      cashBlinds: { sb: 1, bb: 2 },
      buyin: 200,
    });
    expect(st().game!.currentSeat).toBe(HERO_SEAT);
    expect(st().lastError).toBeNull();
    const before = st().game!;

    // hero（按钮/小盲）面对大盲只需跟 1；call 99 越界，applyAction 抛错
    await st().act({ type: "call", amount: 99 });
    const s = st();
    expect(s.lastError).toContain("动作执行失败");
    expect(s.lastError).toContain("call");
    // applyAction 是纯函数且先于 set 执行：抛错时状态完全未变，仍是 hero 回合
    expect(s.game).toBe(before);
    expect(s.game!.currentSeat).toBe(HERO_SEAT);
    expect(s.handSettled).toBe(false);
    expect(s.aiThinking).toBe(false);
    expect(savedHands).toHaveLength(0);

    s.clearError();
    expect(st().lastError).toBeNull();

    // 正常动作仍可用：弃牌后本手正常结算
    await st().act({ type: "fold", amount: 0 });
    expect(st().game!.handOver).toBe(true);
    expect(st().handSettled).toBe(true);
    expect(st().lastError).toBeNull();
    expect(savedHands).toHaveLength(1);
  });

  it("startTable 重置 lastError", async () => {
    await st().startTable({
      mode: "cash",
      seats: 2,
      aiStyle: "nit",
      cashBlinds: { sb: 1, bb: 2 },
      buyin: 200,
    });
    await st().act({ type: "call", amount: 99 });
    expect(st().lastError).not.toBeNull();
    await st().startTable({
      mode: "cash",
      seats: 2,
      aiStyle: "nit",
      cashBlinds: { sb: 1, bb: 2 },
      buyin: 200,
    });
    expect(st().lastError).toBeNull();
  });
});

describe("重购期判定以出局手所在级别为准", () => {
  it("出局手恰好触发升盲：第 4 级（重购期最后一级）归零的 AI 仍自动重购，随后照常升盲", async () => {
    // handsPerLevel=1：每手结束即升盲；3 手后 blindLevel=3（第 4 级）
    const tc = { ...DEFAULT_TOURNAMENT, handsPerLevel: 1, rebuysAllowed: 2 };
    await st().startTable({ mode: "tournament", seats: 3, aiStyle: "tag", tournament: tc });
    for (let i = 0; i < 3; i++) {
      craftHandOver([1500, 1500, 1500], [0]); // 无人归零的伪平局
      st().finalizeHand();
    }
    expect(st().blindLevel).toBe(3);

    // 第 4 手（仍属第 4 级）：AI 1 归零。重购判定用升盲前级别（3 < 4），
    // 同一 finalize 内再升入第 5 级（blindLevel=4）
    craftHandOver([1500, 0, 3000], [2]);
    st().finalizeHand();
    const s = st();
    expect(s.rebuysUsed).toEqual([0, 1, 0]); // AI 1 自动重购
    expect(s.eliminated).toEqual([false, false, false]);
    expect(s.bustEvents).toEqual([]);
    expect(s.tableStacks).toEqual([1500, 1500, 3000]); // AI 1 买回起始筹码
    expect(s.blindLevel).toBe(4);
    expect(s.levelUpEvent?.level).toBe(4);
  });

  it("出局手恰好触发升盲：hero 在第 4 级归零仍弹重购提示（而非直接淘汰）", async () => {
    const tc = { ...DEFAULT_TOURNAMENT, handsPerLevel: 1, rebuysAllowed: 1 };
    await st().startTable({ mode: "tournament", seats: 3, aiStyle: "tag", tournament: tc });
    for (let i = 0; i < 3; i++) {
      craftHandOver([1500, 1500, 1500], [0]);
      st().finalizeHand();
    }
    expect(st().blindLevel).toBe(3);

    craftHandOver([0, 3000, 1500], [1]);
    st().finalizeHand();
    const s = st();
    expect(s.pendingHeroBust).not.toBeNull();
    expect(s.eliminated).toEqual([false, false, false]);
    expect(s.heroSpectating).toBe(false);
    expect(s.blindLevel).toBe(4); // 升盲与待决重购并存

    await s.resolveTournamentRebuy(true);
    expect(st().rebuysUsed[0]).toBe(1);
    expect(st().stacks[HERO_SEAT]).toBe(1500);
    expect(st().eliminated).toEqual([false, false, false]);
  });
});

describe("自定义重购期级数（rebuyPeriodLevels）", () => {
  it("前 N 级可重购、第 N+1 级起不可：N=2 时第 1/2 级归零自动重购，第 3 级归零淘汰", async () => {
    // handsPerLevel=1：每手结束即升盲；rebuysAllowed 给到 5 以隔离次数因素
    const tc = {
      ...DEFAULT_TOURNAMENT,
      handsPerLevel: 1,
      rebuysAllowed: 5,
      rebuyPeriodLevels: 2,
    };
    await st().startTable({ mode: "tournament", seats: 3, aiStyle: "tag", tournament: tc });
    expect(st().blindLevel).toBe(0);

    // 第 1 级（索引 0 < 2）：AI 1 归零 → 自动重购
    craftHandOver([1500, 0, 3000], [2]);
    st().finalizeHand();
    let s = st();
    expect(s.blindLevel).toBe(1); // 每手必升
    expect(s.rebuysUsed).toEqual([0, 1, 0]);
    expect(s.eliminated).toEqual([false, false, false]);
    expect(s.tableStacks).toEqual([1500, 1500, 3000]);

    // 第 2 级（索引 1 < 2）：仍在重购期，AI 1 再次归零仍自动重购
    craftHandOver([1500, 0, 4500], [2]);
    st().finalizeHand();
    s = st();
    expect(s.blindLevel).toBe(2);
    expect(s.rebuysUsed).toEqual([0, 2, 0]);
    expect(s.eliminated).toEqual([false, false, false]);
    expect(s.tableStacks).toEqual([1500, 1500, 4500]);

    // 第 3 级（索引 2 ≥ 2）：重购期结束，AI 1 归零 = 正常淘汰（次数仍有剩余也不救）
    craftHandOver([1500, 0, 6000], [2]);
    st().finalizeHand();
    s = st();
    expect(s.blindLevel).toBe(3);
    expect(s.rebuysUsed).toEqual([0, 2, 0]); // 不再消耗次数
    expect(s.eliminated).toEqual([false, true, false]);
    expect(s.finishPlaces[1]).toBe(3);
    expect(s.bustEvents).toEqual([{ seat: 1, place: 3 }]);
    expect(s.tableStacks).toEqual([1500, 0, 6000]);
  });

  it("hero 归零在自定义重购期内同样弹重购提示（N=1，第 1 级）", async () => {
    const tc = {
      ...DEFAULT_TOURNAMENT,
      handsPerLevel: 1,
      rebuysAllowed: 1,
      rebuyPeriodLevels: 1,
    };
    await st().startTable({ mode: "tournament", seats: 3, aiStyle: "tag", tournament: tc });
    // 第 1 级（索引 0 < 1）：hero 归零 → 提示重购而非淘汰
    craftHandOver([0, 3000, 1500], [1]);
    st().finalizeHand();
    expect(st().pendingHeroBust).not.toBeNull();
    expect(st().eliminated).toEqual([false, false, false]);
    await st().resolveTournamentRebuy(true);
    expect(st().rebuysUsed[0]).toBe(1);

    // 第 2 级（索引 1 ≥ 1）：重购期已过，hero 归零 = 直接淘汰观战
    craftHandOver([0, 3000, 1500], [1]);
    st().finalizeHand();
    const s = st();
    expect(s.pendingHeroBust).toBeNull();
    expect(s.eliminated).toEqual([true, false, false]);
    expect(s.finishPlaces[0]).toBe(3);
    expect(s.heroSpectating).toBe(true);
    expect(s.fastForward).toBe(true);
  });

  it("rebuyPeriodLevels=0：全程不可重购（次数再多也直接淘汰）；负数归一化为 0", async () => {
    const tc = {
      ...DEFAULT_TOURNAMENT,
      rebuysAllowed: 5,
      rebuyPeriodLevels: -3, // 非法：归一化钳到 0
    };
    await st().startTable({ mode: "tournament", seats: 3, aiStyle: "tag", tournament: tc });
    expect(st().tournamentConfig!.rebuyPeriodLevels).toBe(0);

    // 第 1 级即无重购期：AI 1 归零直接淘汰
    craftHandOver([1500, 0, 3000], [2]);
    st().finalizeHand();
    const s = st();
    expect(s.rebuysUsed).toEqual([0, 0, 0]);
    expect(s.eliminated).toEqual([false, true, false]);
    expect(s.bustEvents).toEqual([{ seat: 1, place: 3 }]);
    expect(s.tableStacks).toEqual([1500, 0, 3000]);
  });
});

describe("重购注入不污染盈亏记账", () => {
  it("出局手按本手开手筹码记 profit；下一手以重购后筹码为基准，两手各自零和", async () => {
    await st().startTable({
      mode: "tournament",
      seats: 3,
      aiStyle: "tag",
      tournament: { ...DEFAULT_TOURNAMENT, rebuysAllowed: 1 },
    });
    // 第 1 手：AI 1（引擎座位 1）开手 1500 全输光 → 结算时自动重购
    craftHandOver([1450, 0, 3050], [2]);
    const rec1 = st().finalizeHand();
    // 盈亏基准是本手开手筹码（1500）：AI 1 恰好 -1500，重购注入不影响本手记录
    expect(rec1!.players[1].profit).toBe(-1500);
    expect(rec1!.players[0].profit).toBe(-50);
    expect(rec1!.players[2].profit).toBe(1550);
    expect(rec1!.players.reduce((sum, p) => sum + p.profit, 0)).toBe(0);
    expect(st().rebuysUsed).toEqual([0, 1, 0]);

    // 第 2 手：开手筹码基准含 AI 重购注入的 1500
    await st().advanceToNextHand();
    expect(st().stacks).toEqual([1450, 1500, 3050]);
    craftHandOver([1550, 1400, 3050], [0]);
    const rec2 = st().finalizeHand();
    expect(rec2!.profit).toBe(100); // hero：1550 − 1450
    expect(rec2!.players[1].profit).toBe(-100); // 基准是重购后的 1500，而非出局时的 0
    expect(rec2!.players[2].profit).toBe(0);
    expect(rec2!.players.reduce((sum, p) => sum + p.profit, 0)).toBe(0);
    // 会话累计盈亏与逐手记录一致（advance 后若 hero 大盲拿 walk 会自动多记一手，
    // 故按 savedHands 汇总而非固定数值断言）
    expect(st().session.heroProfit).toBe(
      savedHands.reduce((sum, h) => sum + h.profit, 0),
    );
  });
});

describe("盲注超过全场筹码的强制全下跑马（BUG-E1/E2 软锁修复）", () => {
  /** 驱动整桌打到冠军：轮到 hero 就弃牌；观战快进链在测试环境零延迟自跑到冠军 */
  async function driveToChampion(maxHands: number): Promise<void> {
    for (let i = 0; i < maxHands && !st().tournamentOver; i++) {
      const s = st();
      if (!s.game) break;
      if (s.pendingHeroBust) {
        await s.resolveTournamentRebuy(false);
        continue;
      }
      if (s.game.handOver) {
        await s.advanceToNextHand();
        continue;
      }
      if (s.game.currentSeat === HERO_SEAT) {
        await s.act({ type: "fold", amount: 0 });
        continue;
      }
      break; // 防御：AI 循环在测试环境同步跑完，不应停在 AI 回合
    }
  }

  it("BUG-E1：升盲后 max(stacks) < 大盲不再卡死——短码强制 all-in，锦标赛打到冠军", async () => {
    // 审计 B3 复现：第 2 级 bb=2000 超过全场总筹码 300
    await st().startTable({
      mode: "tournament",
      seats: 3,
      aiStyle: "tag",
      tournament: {
        startStack: 100,
        handsPerLevel: 1,
        levels: [
          { smallBlind: 5, bigBlind: 10, ante: 0 },
          { smallBlind: 1000, bigBlind: 2000, ante: 0 },
        ],
      },
    });
    // 第 1 手：hero（按钮=UTG）弃牌，AI 打完
    expect(st().game!.currentSeat).toBe(HERO_SEAT);
    await st().act({ type: "fold", amount: 0 });
    expect(st().game!.handOver).toBe(true);
    expect(st().blindLevel).toBe(1); // 升入 bb=2000 级

    // 修复前：createGame 校验抛错被吞成 lastError，handNumber 永远停在 1
    await st().advanceToNextHand();
    expect(st().lastError).toBeNull();
    expect(st().game!.handNumber).toBe(2);

    // 之后每手都是短码/全员强制跑马：数手内必出冠军，筹码守恒
    await driveToChampion(20);
    const s = st();
    expect(s.lastError).toBeNull();
    expect(s.tournamentOver).toBe(true);
    expect(s.championSeat).not.toBeNull();
    expect(s.finishPlaces[s.championSeat!]).toBe(1);
    expect(s.tableStacks.reduce((a, b) => a + b, 0)).toBe(3 * 100);
  });

  it("BUG-E1 端到端：8 人无限升盲打到冠军（≤600 手）", async () => {
    await st().startTable({
      mode: "tournament",
      seats: 8,
      aiStyle: "tag",
      tournament: {
        startStack: 1500,
        handsPerLevel: 8,
        levels: extendLevelsInfinite(DEFAULT_BLIND_LEVELS, INFINITE_TOTAL_LEVELS),
      },
    });
    await driveToChampion(600);
    const s = st();
    expect(s.lastError).toBeNull();
    expect(s.tournamentOver).toBe(true);
    expect(s.championSeat).not.toBeNull();
    expect(s.finishPlaces[s.championSeat!]).toBe(1);
    // 名次互不相同且恰好覆盖 1..8
    expect([...s.finishPlaces].sort((a, b) => a! - b!)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    // 筹码守恒：无重购注入，总额恒为 8×1500
    expect(s.tableStacks.reduce((a, b) => a + b, 0)).toBe(8 * 1500);
    expect(s.game!.handNumber).toBeLessThanOrEqual(600);
  }, 60000);

  it("BUG-E2：correctStacks 修正后全员全下 → 开局即摊牌跑马，不抛错卡死", async () => {
    // 审计 B4 复现：级别 50/100/ante100，筹码 [200,100,150]，按钮在桌座 1——
    // 对称局（stack=200+）UTG 可行动，按真实筹码修正后全员被 ante/盲注吃光
    await st().startTable({
      mode: "tournament",
      seats: 3,
      aiStyle: "tag",
      tournament: {
        startStack: 150,
        handsPerLevel: 1,
        levels: [
          { smallBlind: 5, bigBlind: 10, ante: 0 },
          { smallBlind: 50, bigBlind: 100, ante: 100 },
        ],
      },
    });
    craftHandOver([200, 100, 150], [0]);
    st().finalizeHand();
    expect(st().blindLevel).toBe(1);

    // 修复前：correctStacks 抛错被吞成 lastError，handNumber 永远停在 1
    await st().advanceToNextHand();
    const s = st();
    expect(s.lastError).toBeNull();
    expect(s.game!.handNumber).toBe(2);
    // 全员 ante+盲注后全下：开局即摊牌，公共牌一次发完并结算
    expect(s.game!.handOver).toBe(true);
    expect(s.game!.showdown).toBe(true);
    expect(s.game!.board).toHaveLength(5);
    expect(s.handSettled).toBe(true);
    // 筹码守恒：pot 清零，450 全在各座筹码中
    expect(s.game!.players.reduce((sum, p) => sum + p.stack, 0)).toBe(450);

    // 不卡死：继续推进直到冠军
    await driveToChampion(20);
    expect(st().lastError).toBeNull();
    expect(st().tournamentOver).toBe(true);
    expect(st().tableStacks.reduce((a, b) => a + b, 0)).toBe(3 * 150);
  });
});

describe("hero 待决淘汰名次与同手出局者同一规则（开手筹码少者名次靠后）", () => {
  /**
   * 构造「hero（开手 200）与桌座 2（开手 1500）同手归零」：
   * 第 1 手重排筹码并预消耗桌座 2 的重购次数（归零自动重购），
   * 第 2 手双出局。返回时 finalize 已跑、hero 处 pendingHeroBust 待决态。
   */
  async function setupHeroShortDoubleBust(): Promise<void> {
    await st().startTable({
      mode: "tournament",
      seats: 4,
      aiStyle: "tag",
      tournament: { ...DEFAULT_TOURNAMENT, rebuysAllowed: 1 },
    });
    craftHandOver([200, 2900, 0, 2900], [1]);
    st().finalizeHand();
    // 桌座 2 归零但在重购期：自动重购消耗其唯一次数，不淘汰
    expect(st().rebuysUsed[2]).toBe(1);
    expect(st().tableStacks).toEqual([200, 2900, 1500, 2900]);
    await st().advanceToNextHand();
    // 第 2 手开手筹码（名次排序基准）
    expect(st().stacks).toEqual([200, 2900, 1500, 2900]);
    craftHandOver([0, 4600, 0, 2900], [1]);
    st().finalizeHand();
  }

  it("hero 开手最少 → 拒绝重购拿最差名次，更深的同手出局者顺移一位", async () => {
    await setupHeroShortDoubleBust();
    // 桌座 2 先按「hero 幸存」假定记第 4；hero 待决名次按同一规则应为第 4
    expect(st().finishPlaces[2]).toBe(4);
    expect(st().pendingHeroBust).toEqual({ place: 4, championSeat: null });

    const p = st().resolveTournamentRebuy(false);
    st().setFastForward(false); // 冻结观战推进链，锁定断言现场
    await p;
    const s = st();
    expect(s.finishPlaces[0]).toBe(4); // hero 开手最少 → 名次最靠后
    expect(s.finishPlaces[2]).toBe(3); // 桌座 2 顺移一位，名次不撞车
    expect(s.eliminated).toEqual([true, false, true, false]);
    expect(s.bustEvents).toContainEqual({ seat: 0, place: 4 });
  });

  it("hero 开手最少但选择重购：同手出局者名次保持，hero 不占名次", async () => {
    await setupHeroShortDoubleBust();
    expect(st().finishPlaces[2]).toBe(4);

    await st().resolveTournamentRebuy(true);
    const s = st();
    expect(s.pendingHeroBust).toBeNull();
    expect(s.rebuysUsed[0]).toBe(1);
    expect(s.finishPlaces[0]).toBeNull(); // hero 重购继续，无名次
    // 幸存 3 人（含重购的 hero），桌座 2 第 4 恰为正确，不顺移
    expect(s.finishPlaces[2]).toBe(4);
    expect(s.eliminated).toEqual([false, false, true, false]);
  });

  it("hero 开手更深 → 拿同手出局者中最好名次，同桌出局者不顺移", async () => {
    await st().startTable({
      mode: "tournament",
      seats: 4,
      aiStyle: "tag",
      tournament: { ...DEFAULT_TOURNAMENT, rebuysAllowed: 1 },
    });
    // 第 1 手：桌座 3 归零并自动重购（预消耗次数）
    craftHandOver([1600, 2300, 2000, 0], [1]);
    st().finalizeHand();
    expect(st().rebuysUsed[3]).toBe(1);
    expect(st().tableStacks).toEqual([1600, 2300, 2000, 1500]);
    await st().advanceToNextHand();
    // 第 2 手：hero（开手 1600）与桌座 3（开手 1500）同手归零
    expect(st().stacks).toEqual([1600, 2300, 2000, 1500]);
    craftHandOver([0, 4100, 3300, 0], [1]);
    st().finalizeHand();
    // 桌座 3 开手更少 → 第 4；hero 更深 → 同手出局者中最好（第 3）
    expect(st().finishPlaces[3]).toBe(4);
    expect(st().pendingHeroBust).toEqual({ place: 3, championSeat: null });

    const p = st().resolveTournamentRebuy(false);
    st().setFastForward(false);
    await p;
    const s = st();
    expect(s.finishPlaces[0]).toBe(3);
    expect(s.finishPlaces[3]).toBe(4); // 1500 < 1600：不劣于 hero 不成立，不顺移
    expect(s.eliminated).toEqual([true, false, false, true]);
  });
});
