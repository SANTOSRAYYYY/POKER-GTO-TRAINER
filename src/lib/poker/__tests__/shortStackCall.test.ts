import { describe, expect, it } from "vitest";
import type { Card, GameState, PlayerState } from "@/lib/types";
import { applyAction, legalActions } from "@/lib/poker/game";
import { callDisplayInfo } from "@/lib/poker/callDisplay";
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

/** 手动构造底牌时的牌堆：公共牌按声明顺序被 pop（settleShowdown 发牌用）。 */
const mkDeck = (used: Card[], board: Card[]): Card[] => [
  ...newDeck().filter((c) => !used.includes(c)),
  ...board.slice().reverse(),
];

const totalChips = (s: GameState): number =>
  s.players.reduce((sum, p) => sum + p.stack, 0) + s.pot;

// 英雄（seat1，BB）持 AA；对手（seat0，按钮/SB）持 72o。公共牌无威胁。
const HERO_WINS_HOLES: Card[] = ["2c", "7d", "As", "Ah"];
const HERO_WINS_BOARD: Card[] = ["Ks", "Qd", "9c", "4h", "6s"];
// 对手 AA，英雄 KK。
const HERO_LOSES_HOLES: Card[] = ["As", "Ah", "Ks", "Kd"];
const HERO_LOSES_BOARD: Card[] = ["9c", "8d", "4h", "2s", "5c"];

/**
 * 单挑翻前：seat0（按钮/SB，streetBet 5）面对 seat1（BB，streetBet 10）。
 * heroStack 为 BB 的剩余筹码（不含已投盲注 10）。
 */
const huPreflop = (
  holes: Card[],
  board: Card[],
  villainStack: number,
  heroStack: number,
): GameState =>
  mkState({
    deck: mkDeck([...holes, ...board], board),
    players: [
      mkPlayer(0, {
        holeCards: [holes[0], holes[1]],
        stack: villainStack,
        streetBet: 5,
        handBet: 5,
      }),
      mkPlayer(1, {
        holeCards: [holes[2], holes[3]],
        stack: heroStack,
        streetBet: 10,
        handBet: 10,
      }),
    ],
    currentSeat: 0,
    currentBet: 10,
    pot: 15,
  });

describe("短码 call-allin：对手下注 100，我方只剩 50", () => {
  // seat0 全下 100；seat1 已投盲注 10、只剩 40（总 50）
  const setup = (): GameState => {
    const s0 = huPreflop(HERO_WINS_HOLES, HERO_WINS_BOARD, 95, 40);
    const s = applyAction(s0, { type: "allin", amount: 100 });
    expect(s.currentSeat).toBe(1);
    expect(s.currentBet).toBe(100);
    return s;
  };

  it("legalActions 返回 call（amount=全部剩余筹码 40），无 raise/check", () => {
    const legal = legalActions(setup());
    expect(legal).toContainEqual({ type: "fold", amount: 0 });
    expect(legal).toContainEqual({ type: "call", amount: 40 });
    expect(legal.find((a) => a.type === "raise")).toBeUndefined();
    expect(legal.find((a) => a.type === "check")).toBeUndefined();
  });

  it("复现用户 bug：按 currentBet-streetBet 全额跟注（90）被引擎拒绝", () => {
    const s = setup();
    // ActionBar 修复前的算法：不截断到 stack，点击跟注即抛错、行动卡死
    const uiAmount = s.currentBet - s.players[1].streetBet;
    expect(uiAmount).toBe(90);
    expect(() => applyAction(s, { type: "call", amount: uiAmount })).toThrow(
      /call 的 amount/,
    );
  });

  it("摊牌结算·赢：主池按双方实际投入，对手超额 50 退还", () => {
    const end = applyAction(setup(), { type: "call", amount: 40 });
    expect(end.handOver).toBe(true);
    expect(end.showdown).toBe(true);
    expect(end.currentSeat).toBeNull();
    expect(end.board).toHaveLength(5);
    // 层一 50×2=100 归 AA；层二 50 单人退还对手（不算获胜）
    expect(end.players[1].stack).toBe(100);
    expect(end.players[0].stack).toBe(50);
    expect(end.winners).toEqual([1]);
    expect(end.pot).toBe(0);
    expect(totalChips(end)).toBe(150);
  });

  it("摊牌结算·输：短码方清零，对手收主池并拿回超额", () => {
    const s0 = huPreflop(HERO_LOSES_HOLES, HERO_LOSES_BOARD, 95, 40);
    let s = applyAction(s0, { type: "allin", amount: 100 });
    s = applyAction(s, { type: "call", amount: 40 });
    expect(s.handOver).toBe(true);
    expect(s.players[0].stack).toBe(150); // 100 主池 + 50 退还
    expect(s.players[1].stack).toBe(0);
    expect(s.winners).toEqual([0]);
    expect(totalChips(s)).toBe(150);
  });

  it("对手 raise（未全下）到 100：短码 call-allin 后下注轮结束，对手不能再行动", () => {
    // 对手深码 200：raise 到 100 而非 allin
    const s0 = huPreflop(HERO_WINS_HOLES, HERO_WINS_BOARD, 195, 40);
    let s = applyAction(s0, { type: "raise", amount: 100 });
    expect(s.currentSeat).toBe(1);
    expect(legalActions(s)).toContainEqual({ type: "call", amount: 40 });
    s = applyAction(s, { type: "call", amount: 40 });
    // 单挑：一方全下后直接摊牌跑完公共牌（handOver 且 currentSeat=null，
    // 对手无第三次行动机会）
    expect(s.handOver).toBe(true);
    expect(s.showdown).toBe(true);
    expect(s.currentSeat).toBeNull();
    expect(s.players[1].stack).toBe(100); // AA 赢层一
    expect(s.players[0].stack).toBe(150); // 剩 100 + 退还 50
    expect(totalChips(s)).toBe(250);
  });

  it("多人桌：A 全下 100、B 短码 call 45，C 仍可 call 90 或再加注，边池分层正确", () => {
    // 3 人翻前：seat0 按钮（未投）、seat1 SB=5（短码总 50）、seat2 BB=10（深码 200）
    const holes = HERO_WINS_HOLES.concat(["Ks", "Kd"] as Card[]);
    const board = HERO_LOSES_BOARD;
    const state = mkState({
      deck: mkDeck([...holes, ...board], board),
      players: [
        mkPlayer(0, { holeCards: ["2c", "7d"], stack: 100 }),
        mkPlayer(1, {
          holeCards: ["As", "Ah"],
          stack: 45,
          streetBet: 5,
          handBet: 5,
        }),
        mkPlayer(2, {
          holeCards: ["Ks", "Kd"],
          stack: 190,
          streetBet: 10,
          handBet: 10,
        }),
      ],
      currentSeat: 0,
      currentBet: 10,
      pot: 15,
    });

    let s = applyAction(state, { type: "allin", amount: 100 }); // A 全下（完整加注）
    expect(s.currentSeat).toBe(1);
    // B 短码：需补 95 但只剩 45 → call 即全下
    expect(legalActions(s)).toContainEqual({ type: "call", amount: 45 });
    s = applyAction(s, { type: "call", amount: 45 });
    // B 的短码 call 不结束 C 的行动权
    expect(s.handOver).toBe(false);
    expect(s.currentSeat).toBe(2);
    const legalC = legalActions(s);
    expect(legalC).toContainEqual({ type: "call", amount: 90 });
    expect(legalC).toContainEqual({ type: "raise", amount: 190 }); // minRaise=90

    s = applyAction(s, { type: "call", amount: 90 });
    expect(s.handOver).toBe(true);
    // 层一 50×3=150 归 B(AA)；层二 50×2=100 归 C(KK)
    expect(s.players[0].stack).toBe(0);
    expect(s.players[1].stack).toBe(150);
    expect(s.players[2].stack).toBe(200); // 剩 100 + 层二 100
    expect(s.winners).toEqual([1, 2]);
    expect(totalChips(s)).toBe(350);
  });
});

describe("callDisplayInfo（ActionBar 跟注按钮派生模型）", () => {
  const facedBet = (heroStack: number): GameState => {
    const s0 = huPreflop(HERO_WINS_HOLES, HERO_WINS_BOARD, 95, heroStack);
    return applyAction(s0, { type: "allin", amount: 100 });
  };

  it("短码：amount=全部剩余筹码，isAllIn=true", () => {
    expect(callDisplayInfo(facedBet(40), 1)).toEqual({
      amount: 40,
      isAllIn: true,
    });
  });

  it("恰好跟齐即全下（toCall == stack）：isAllIn=true", () => {
    expect(callDisplayInfo(facedBet(90), 1)).toEqual({
      amount: 90,
      isAllIn: true,
    });
  });

  it("筹码充足：amount=跟注增量，isAllIn=false", () => {
    expect(callDisplayInfo(facedBet(190), 1)).toEqual({
      amount: 90,
      isAllIn: false,
    });
  });

  it("非该座位回合或无需跟注时返回 null", () => {
    const s = facedBet(40);
    expect(callDisplayInfo(s, 0)).toBeNull(); // 不是 seat0 的回合
    const noBet = mkState({
      players: [mkPlayer(0, { stack: 100 }), mkPlayer(1, { stack: 100 })],
      currentSeat: 0,
      currentBet: 0,
    });
    expect(callDisplayInfo(noBet, 0)).toBeNull(); // 无人下注，只有 check/bet
    expect(callDisplayInfo({ ...s, handOver: true }, 1)).toBeNull();
  });
});
