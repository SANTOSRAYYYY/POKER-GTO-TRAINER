import { describe, expect, it } from "vitest";
import type { Card, GameState, PlayerAction, PlayerState } from "@/lib/types";
import {
  applyAction,
  createGame,
  legalActions,
  nextActiveSeat,
} from "@/lib/poker/game";
import { newDeck } from "@/lib/poker/cards";

const mkPlayer = (seat: number, over: Partial<PlayerState>): PlayerState => ({
  seat,
  holeCards: null,
  stack: 0,
  streetBet: 0,
  handBet: 0,
  folded: false,
  allIn: false,
  hasActed: false,
  eliminated: false,
  ...over,
});

const mkState = (over: Partial<GameState>): GameState => ({
  deck: [],
  players: [],
  board: [],
  pot: 0,
  street: "preflop",
  currentSeat: null,
  buttonSeat: 0,
  smallBlind: 5,
  bigBlind: 10,
  ante: 0,
  minRaise: 10,
  currentBet: 0,
  streetActions: [],
  handNumber: 1,
  handOver: false,
  winners: null,
  showdown: false,
  ...over,
});

const totalChips = (s: GameState): number =>
  s.players.reduce((sum, p) => sum + p.stack, 0) + s.pot;

function expectConservation(s: GameState, total: number): void {
  expect(totalChips(s)).toBe(total);
  if (!s.handOver) {
    expect(s.pot).toBe(s.players.reduce((sum, p) => sum + p.handBet, 0));
    expect(s.currentBet).toBe(
      Math.max(...s.players.map((p) => p.streetBet)),
    );
  }
}

describe("game(N): nextActiveSeat 定位", () => {
  it("顺序环绕找下一个在局座位", () => {
    const s = createGame({
      players: 4, smallBlind: 5, bigBlind: 10, stack: 100, buttonSeat: 0,
    });
    expect(nextActiveSeat(s.players, 0)).toBe(1);
    expect(nextActiveSeat(s.players, 2)).toBe(3);
    expect(nextActiveSeat(s.players, 3)).toBe(0); // 环绕
  });

  it("跳过已淘汰座位；只剩 from 自己时返回 from；全灭返回 null", () => {
    const players = [
      mkPlayer(0, {}),
      mkPlayer(1, { eliminated: true }),
      mkPlayer(2, {}),
      mkPlayer(3, { eliminated: true }),
    ];
    expect(nextActiveSeat(players, 0)).toBe(2);
    expect(nextActiveSeat(players, 3)).toBe(0); // 1 被淘汰，环绕到 0
    expect(nextActiveSeat([mkPlayer(0, {}), mkPlayer(1, { eliminated: true })], 0)).toBe(0);
    expect(nextActiveSeat([mkPlayer(0, { eliminated: true })], 0)).toBeNull();
  });
});

describe("game(N): 行动顺序与盲注", () => {
  it("3 人桌：小盲=按钮左邻、大盲=小盲左邻、UTG 翻前先动、翻后按钮左邻先动", () => {
    let s = createGame({
      players: 3, smallBlind: 5, bigBlind: 10, stack: 100, buttonSeat: 0,
    });
    expect(s.players[1].streetBet).toBe(5); // SB
    expect(s.players[2].streetBet).toBe(10); // BB
    expect(s.players[0].streetBet).toBe(0);
    expect(s.pot).toBe(15);
    expect(s.currentSeat).toBe(0); // 3 人时 UTG 恰好是按钮位
    expect(s.deck).toHaveLength(52 - 6);
    expectConservation(s, 300);

    s = applyAction(s, { type: "call", amount: 10 }); // seat0
    expect(s.currentSeat).toBe(1);
    s = applyAction(s, { type: "call", amount: 5 }); // seat1 SB 补齐
    expect(s.currentSeat).toBe(2);
    s = applyAction(s, { type: "check", amount: 0 }); // seat2 BB → flop
    expect(s.street).toBe("flop");
    expect(s.board).toHaveLength(3);
    expect(s.currentSeat).toBe(1); // 翻后按钮(0)左邻第一个可行动者
    expectConservation(s, 300);
  });

  it("4 人桌：UTG ≠ 按钮，验证 UTG 为大盲左邻", () => {
    const s = createGame({
      players: 4, smallBlind: 5, bigBlind: 10, stack: 100, buttonSeat: 0,
    });
    expect(s.players[1].streetBet).toBe(5); // SB
    expect(s.players[2].streetBet).toBe(10); // BB
    expect(s.currentSeat).toBe(3); // UTG = BB 左邻，而不是按钮 0
  });

  it("按钮在末位时盲注环绕：button=2 的 3 人桌 SB=0、BB=1、UTG=2", () => {
    const s = createGame({
      players: 3, smallBlind: 5, bigBlind: 10, stack: 100, buttonSeat: 2,
    });
    expect(s.players[0].streetBet).toBe(5);
    expect(s.players[1].streetBet).toBe(10);
    expect(s.currentSeat).toBe(2);
  });

  it("多人桌中一人弃牌不结束牌局", () => {
    let s = createGame({
      players: 3, smallBlind: 5, bigBlind: 10, stack: 100, buttonSeat: 0,
    });
    s = applyAction(s, { type: "fold", amount: 0 }); // seat0 UTG 弃牌
    expect(s.handOver).toBe(false);
    expect(s.players[0].folded).toBe(true);
    expect(s.currentSeat).toBe(1);
    expectConservation(s, 300);
  });
});

describe("game(N): 9 人桌打到河牌", () => {
  it("全员 check/call 到底，筹码守恒、牌不重复", () => {
    let s = createGame({
      players: 9, smallBlind: 5, bigBlind: 10, stack: 100, buttonSeat: 0,
    });
    expect(s.players[1].streetBet).toBe(5);
    expect(s.players[2].streetBet).toBe(10);
    expect(s.currentSeat).toBe(3); // UTG
    expect(s.deck).toHaveLength(52 - 18);

    // 翻前：UTG(3) 起到 seat0 依次跟注，SB 补 5，BB 过牌
    for (const seat of [3, 4, 5, 6, 7, 8, 0]) {
      expect(s.currentSeat).toBe(seat);
      s = applyAction(s, { type: "call", amount: 10 - s.players[seat].streetBet });
    }
    expect(s.currentSeat).toBe(1);
    s = applyAction(s, { type: "call", amount: 5 });
    expect(s.currentSeat).toBe(2);
    s = applyAction(s, { type: "check", amount: 0 });
    expect(s.street).toBe("flop");
    expect(s.pot).toBe(90);
    expectConservation(s, 900);

    // 翻后三条街：按钮左邻 seat1 先动，9 人依次 check
    for (const street of ["flop", "turn", "river"] as const) {
      expect(s.street).toBe(street);
      expect(s.currentSeat).toBe(1);
      for (let i = 0; i < 9; i++) {
        s = applyAction(s, { type: "check", amount: 0 });
      }
    }
    expect(s.handOver).toBe(true);
    expect(s.showdown).toBe(true);
    expect(s.board).toHaveLength(5);
    expect(s.pot).toBe(0);
    expect(s.winners).not.toBeNull();
    expect(s.winners!.length).toBeGreaterThanOrEqual(1);
    expect(totalChips(s)).toBe(900);
    expect(s.deck).toHaveLength(52 - 18 - 5);

    const all = [
      ...s.deck,
      ...s.board,
      ...s.players.flatMap((p) => p.holeCards!),
    ];
    expect(new Set(all).size).toBe(52);
  });
});

describe("game(N): 多人边池", () => {
  it("经典三层边池：A 全下 50、B 全下 120、C 全下 200", () => {
    // A: As Ah（赢主池）；B: Ks Kh（赢第二池）；C: Qs Qh（超额 80 退还）
    const boardCards: Card[] = ["2h", "3d", "4c", "5s", "9d"];
    // 引擎从牌堆末尾 pop：反转使 pop 顺序 = boardCards 声明顺序
    const deck: Card[] = [
      ...newDeck().filter((c) => !boardCards.includes(c) &&
        !(["As", "Ah", "Ks", "Kh", "Qs", "Qh"] as Card[]).includes(c)),
      ...boardCards.slice().reverse(),
    ];
    const state = mkState({
      deck,
      players: [
        mkPlayer(0, { holeCards: ["As", "Ah"], stack: 50 }),
        mkPlayer(1, { holeCards: ["Ks", "Kh"], stack: 120 }),
        mkPlayer(2, { holeCards: ["Qs", "Qh"], stack: 200 }),
      ],
      currentSeat: 0,
      pot: 0,
    });

    let s = applyAction(state, { type: "allin", amount: 50 }); // A
    expect(s.currentSeat).toBe(1);
    s = applyAction(s, { type: "allin", amount: 120 }); // B（完整加注，重开）
    expect(s.currentSeat).toBe(2);
    s = applyAction(s, { type: "allin", amount: 200 }); // C（完整加注）
    // 三人全下 → 直接摊牌跑完公共牌
    expect(s.handOver).toBe(true);
    expect(s.showdown).toBe(true);
    expect(s.board).toEqual(boardCards);

    // 第一层 50×3=150 归 A；第二层 70×2=140 归 B；第三层 80 退还 C
    expect(s.players[0].stack).toBe(150);
    expect(s.players[1].stack).toBe(140);
    expect(s.players[2].stack).toBe(80);
    expect(s.pot).toBe(0);
    // 退还层不算“获胜”：winners 只含真正赢到争夺池的座位
    expect(s.winners).toEqual([0, 1]);
    expect(totalChips(s)).toBe(370);
  });

  it("弃牌者/短码者的投入进入边池按层分配", () => {
    // A(AA) 全下 50，B(KK) 全下 100 压过，C 已投 5 再全下跟 25：
    // handBet A=50 / B=100 / C=30。层一 30×3=90、层二 20×2=40 均归 A；
    // 层三 50 退还 B。
    const boardCards: Card[] = ["2h", "3d", "4c", "5s", "9d"];
    const holes: Card[] = ["As", "Ah", "Ks", "Kh", "7h", "8h"];
    const deck: Card[] = [
      ...newDeck().filter((c) => ![...boardCards, ...holes].includes(c)),
      ...boardCards,
    ];
    const state = mkState({
      deck,
      players: [
        mkPlayer(0, { holeCards: ["As", "Ah"], stack: 50 }),
        mkPlayer(1, { holeCards: ["Ks", "Kh"], stack: 100 }),
        mkPlayer(2, { holeCards: ["7h", "8h"], stack: 25, streetBet: 5, handBet: 5 }),
      ],
      currentSeat: 0,
      pot: 5,
    });

    let s = applyAction(state, { type: "allin", amount: 50 });
    expect(s.currentSeat).toBe(1);
    s = applyAction(s, { type: "allin", amount: 100 }); // B 完整加注
    expect(s.currentSeat).toBe(2);
    // C 需补 95 但只有 25：全下跟注 25
    const actions = legalActions(s);
    expect(actions).toContainEqual({ type: "call", amount: 25 });
    s = applyAction(s, { type: "call", amount: 25 });
    // 全员 all-in → 摊牌
    expect(s.handOver).toBe(true);
    expect(s.players[0].stack).toBe(130); // 90 + 40
    expect(s.players[1].stack).toBe(50); // 退还层
    expect(s.players[2].stack).toBe(0);
    expect(s.winners).toEqual([0]);
    expect(totalChips(s)).toBe(180);
  });
});

describe("game(N): ante 前注", () => {
  it("ante 计入 pot/handBet，不计入 streetBet/currentBet", () => {
    const s = createGame({
      players: 3, smallBlind: 5, bigBlind: 10, ante: 10, stack: 100,
      buttonSeat: 0,
    });
    // 每人先投 10 ante；SB(seat1) 再投 5，BB(seat2) 再投 10
    expect(s.players[0].handBet).toBe(10);
    expect(s.players[1].handBet).toBe(15);
    expect(s.players[2].handBet).toBe(20);
    expect(s.players[1].streetBet).toBe(5);
    expect(s.players[2].streetBet).toBe(10);
    expect(s.pot).toBe(45);
    expect(s.ante).toBe(10);
    // 跟注线仍是大盲 10（ante 是死钱）：UTG(seat0) call 需补 10
    expect(s.currentBet).toBe(10);
    expect(s.currentSeat).toBe(0);
    const actions = legalActions(s);
    expect(actions).toContainEqual({ type: "call", amount: 10 });
    expect(actions).toContainEqual({ type: "raise", amount: 20 });
    // streetBet=0、stack=90（ante 已扣 10）→ 全下 bet-to 为 90
    expect(actions).toContainEqual({ type: "allin", amount: 90 });
    expectConservation(s, 300);
  });

  it("筹码不足以付 ante 时全下；盲注短码也不阻塞牌局", () => {
    let s = createGame({
      players: 3, smallBlind: 5, bigBlind: 10, ante: 6, stack: 10,
      buttonSeat: 0,
    });
    // 每人 ante 6 后只剩 4；SB/BB 都只能投 4 并全下
    expect(s.players[1].allIn).toBe(true);
    expect(s.players[2].allIn).toBe(true);
    expect(s.pot).toBe(26); // 6×3 + 4 + 4
    expect(s.currentBet).toBe(4);
    // UTG 剩 4：只能全下跟注或弃牌
    const actions = legalActions(s);
    expect(actions).toContainEqual({ type: "call", amount: 4 });
    expect(actions.find((a) => a.type === "raise")).toBeUndefined();

    s = applyAction(s, { type: "call", amount: 4 });
    expect(s.handOver).toBe(true); // 全员 all-in 直接摊牌
    expect(s.board).toHaveLength(5);
    expect(totalChips(s)).toBe(30);
  });
});

describe("game(N): short all-in 不重开下注轮", () => {
  // seat0 加注到 30（已行动）；seat1 短码 all-in 到 35（增量 5 < minRaise 20）
  const build = (): GameState =>
    mkState({
      deck: newDeck(),
      players: [
        mkPlayer(0, { stack: 70, streetBet: 30, handBet: 30, hasActed: true }),
        mkPlayer(1, { stack: 30, streetBet: 5, handBet: 5 }),
        mkPlayer(2, { stack: 90, streetBet: 10, handBet: 10 }),
      ],
      currentSeat: 1,
      pot: 45,
      currentBet: 30,
      minRaise: 20,
    });

  it("已行动者面对 short all-in 只能跟注/弃牌；未行动者仍可加注", () => {
    let s = build();
    s = applyAction(s, { type: "allin", amount: 35 }); // seat1 short all-in
    expect(s.currentBet).toBe(35);
    expect(s.minRaise).toBe(20); // 未变
    expect(s.currentSeat).toBe(2);

    // seat2 本街尚未行动：加注空间照常开放
    const a2 = legalActions(s);
    expect(a2).toContainEqual({ type: "call", amount: 25 });
    expect(a2).toContainEqual({ type: "raise", amount: 55 });
    expect(a2).toContainEqual({ type: "allin", amount: 100 });

    s = applyAction(s, { type: "call", amount: 25 });
    expect(s.currentSeat).toBe(0);

    // seat0 已行动过、下注轮未被重开：只能跟 5 或弃牌
    const a0 = legalActions(s);
    expect(a0).toContainEqual({ type: "fold", amount: 0 });
    expect(a0).toContainEqual({ type: "call", amount: 5 });
    expect(a0.find((a) => a.type === "raise")).toBeUndefined();
    expect(a0.find((a) => a.type === "allin")).toBeUndefined();
    expect(() => applyAction(s, { type: "raise", amount: 70 })).toThrow();
    expect(() => applyAction(s, { type: "allin", amount: 100 })).toThrow();

    s = applyAction(s, { type: "call", amount: 5 });
    // 轮次关闭 → 进入 flop；seat1 全下，翻后 seat2（按钮 0 左邻起第一个可行动者）先动
    expect(s.street).toBe("flop");
    expect(s.currentSeat).toBe(2);
    expectConservation(s, 235);
  });

  it("完整加注照常重开下注轮（已行动者获得再加注权）", () => {
    const s0 = mkState({
      deck: newDeck(),
      players: [
        mkPlayer(0, { stack: 70, streetBet: 30, handBet: 30, hasActed: true }),
        mkPlayer(1, { stack: 90, streetBet: 5, handBet: 5 }),
        mkPlayer(2, { stack: 90, streetBet: 10, handBet: 10 }),
      ],
      currentSeat: 1,
      pot: 45,
      currentBet: 30,
      minRaise: 20,
    });
    let s = applyAction(s0, { type: "raise", amount: 60 }); // seat1 完整加注（增量 30 ≥ 20）
    expect(s.minRaise).toBe(30);
    expect(s.currentSeat).toBe(2);
    s = applyAction(s, { type: "call", amount: 50 });
    // seat0 的 hasActed 已被完整加注重置 → 可以再加注
    expect(s.currentSeat).toBe(0);
    const a0 = legalActions(s);
    expect(a0).toContainEqual({ type: "raise", amount: 90 });
  });
});

describe("game(N): 6 人桌 200 手随机对局不变式", () => {
  const mulberry32 = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it("筹码守恒、行动合法、纯函数", () => {
    const rng = mulberry32(20260922);
    for (let hand = 0; hand < 200; hand++) {
      let s = createGame({
        players: 6, smallBlind: 5, bigBlind: 10, stack: 100,
        buttonSeat: hand % 6,
      });
      let steps = 0;
      while (!s.handOver) {
        expectConservation(s, 600);
        const actions = legalActions(s);
        expect(actions.length).toBeGreaterThan(0);
        const pick = actions[Math.floor(rng() * actions.length)];
        let action: PlayerAction = pick;
        if (pick.type === "bet" || pick.type === "raise") {
          const seat = s.currentSeat!;
          const max = s.players[seat].streetBet + s.players[seat].stack;
          const span = max - pick.amount;
          action = {
            type: rng() < 0.5 && span > 0 ? "allin" : pick.type,
            amount:
              span > 0 && rng() < 0.5
                ? max
                : pick.amount + Math.floor(rng() * (span + 1)),
          };
          if (action.type === "allin") action.amount = max;
        }
        const before = s;
        s = applyAction(s, action);
        // 纯函数：入参未被修改
        expect(before.players.reduce((sum, p) => sum + p.handBet, 0)).toBe(
          before.pot,
        );
        steps++;
        expect(steps).toBeLessThan(300); // 兜底防死循环
      }
      expect(s.winners).not.toBeNull();
      expect(s.pot).toBe(0);
      expect(s.players.every((p) => p.stack >= 0)).toBe(true);
      expectConservation(s, 600);
      // 所有牌不重复
      const all = [
        ...s.deck,
        ...s.board,
        ...s.players.flatMap((p) => p.holeCards!),
      ];
      expect(new Set(all).size).toBe(52);
    }
  });
});
