import { describe, expect, it } from "vitest";
import type { Card, GameState, PlayerAction } from "@/lib/types";
import {
  applyAction,
  createGame,
  legalActions,
  type RiggedDeckConfig,
} from "@/lib/poker/game";
import { newDeck } from "@/lib/poker/cards";

const CFG = {
  players: 2,
  smallBlind: 5,
  bigBlind: 10,
  stack: 100,
  buttonSeat: 0 as const,
};

/** deckPrefix 顺序 = 引擎 pop 顺序：按钮位底牌×2、非按钮位底牌×2、翻牌×3、转牌、河牌 */
const rigged = (deckPrefix: Card[]): RiggedDeckConfig => ({
  ...CFG,
  deckPrefix,
});

const totalChips = (s: GameState): number =>
  s.players[0].stack + s.players[1].stack + s.pot;

function expectConservation(s: GameState, total = 200): void {
  expect(totalChips(s)).toBe(total);
  if (!s.handOver) {
    expect(s.pot).toBe(s.players[0].handBet + s.players[1].handBet);
    expect(s.currentBet).toBe(
      Math.max(s.players[0].streetBet, s.players[1].streetBet),
    );
  }
}

describe("game: createGame", () => {
  it("发盲注、发底牌、初始化字段", () => {
    const s = createGame(CFG);
    expect(s.players[0].streetBet).toBe(5); // 按钮位 = 小盲
    expect(s.players[1].streetBet).toBe(10);
    expect(s.pot).toBe(15);
    expect(s.currentBet).toBe(10);
    expect(s.minRaise).toBe(10);
    expect(s.currentSeat).toBe(0); // 翻前按钮先行动
    expect(s.street).toBe("preflop");
    expect(s.deck).toHaveLength(48);
    expect(s.board).toHaveLength(0);
    expect(s.handNumber).toBe(1);
    expect(s.handOver).toBe(false);
    expect(s.players[0].holeCards).not.toBeNull();
    expect(s.players[1].holeCards).not.toBeNull();
    expectConservation(s);
  });

  it("按钮位为 1 时镜像成立", () => {
    const s = createGame({ ...CFG, buttonSeat: 1 });
    expect(s.players[1].streetBet).toBe(5);
    expect(s.players[0].streetBet).toBe(10);
    expect(s.currentSeat).toBe(1);
  });

  it("52 张牌无重复（底牌 + 牌堆）", () => {
    const s = createGame(CFG);
    const all = [
      ...s.deck,
      ...s.players[0].holeCards!,
      ...s.players[1].holeCards!,
    ];
    expect(new Set(all).size).toBe(52);
  });

  it("非法配置抛错", () => {
    expect(() => createGame({ ...CFG, smallBlind: 0 })).toThrow();
    expect(() => createGame({ ...CFG, smallBlind: 20 })).toThrow(); // sb > bb
    expect(() => createGame({ ...CFG, stack: 5 })).toThrow(); // stack < bb
  });
});

describe("game: legalActions", () => {
  const s0 = createGame(CFG);

  it("翻前按钮位：fold / call 5 / raise 最小 20 / allin 100", () => {
    const actions = legalActions(s0);
    expect(actions).toContainEqual({ type: "fold", amount: 0 });
    expect(actions).toContainEqual({ type: "call", amount: 5 });
    expect(actions).toContainEqual({ type: "raise", amount: 20 });
    expect(actions).toContainEqual({ type: "allin", amount: 100 });
    expect(actions.find((a) => a.type === "check")).toBeUndefined();
  });

  it("翻前大盲位（按钮 call 后）：可 check / raise", () => {
    const s1 = applyAction(s0, { type: "call", amount: 5 });
    const actions = legalActions(s1);
    expect(actions).toContainEqual({ type: "check", amount: 0 });
    expect(actions).toContainEqual({ type: "raise", amount: 20 });
    expect(actions).toContainEqual({ type: "allin", amount: 100 });
  });

  it("翻后先行动：check / bet 最小为大盲 / allin", () => {
    let s = applyAction(s0, { type: "call", amount: 5 });
    s = applyAction(s, { type: "check", amount: 0 });
    expect(s.street).toBe("flop");
    expect(s.currentSeat).toBe(1); // 翻后非按钮先行动
    const actions = legalActions(s);
    expect(actions).toContainEqual({ type: "check", amount: 0 });
    expect(actions).toContainEqual({ type: "bet", amount: 10 });
    // 翻前各投入 10，剩余 90；本街 streetBet=0，故 allin 的 bet-to 为 90
    expect(actions).toContainEqual({ type: "allin", amount: 90 });
  });

  it("handOver 后返回空数组", () => {
    const s = applyAction(s0, { type: "fold", amount: 0 });
    expect(s.handOver).toBe(true);
    expect(legalActions(s)).toEqual([]);
  });
});

describe("game: 翻前直接弃牌", () => {
  it("按钮位 fold，大盲收下底池，不摊牌", () => {
    const s = applyAction(createGame(CFG), { type: "fold", amount: 0 });
    expect(s.handOver).toBe(true);
    expect(s.winners).toEqual([1]);
    expect(s.showdown).toBe(false);
    expect(s.street).toBe("preflop"); // 保留弃牌发生的街道
    expect(s.currentSeat).toBeNull();
    expect(s.players[0].stack).toBe(95);
    expect(s.players[1].stack).toBe(105);
    expect(s.pot).toBe(0);
    expectConservation(s);
  });

  it("加注后弃牌", () => {
    let s = applyAction(createGame(CFG), { type: "raise", amount: 20 });
    expect(s.currentSeat).toBe(1);
    s = applyAction(s, { type: "fold", amount: 0 });
    expect(s.winners).toEqual([0]);
    expect(s.players[0].stack).toBe(110); // 80 剩余 + 30 底池
    expect(s.players[1].stack).toBe(90);
    expectConservation(s);
  });
});

describe("game: 最小加注约束", () => {
  it("低于最小加注被拒绝", () => {
    const s = createGame(CFG);
    expect(() => applyAction(s, { type: "raise", amount: 19 })).toThrow();
    expect(() => applyAction(s, { type: "raise", amount: 20 })).not.toThrow();
  });

  it("加注更新 minRaise 为本次增量", () => {
    let s = applyAction(createGame(CFG), { type: "raise", amount: 20 });
    expect(s.minRaise).toBe(10); // 增量 = 20 - 10
    // BB 最小加注 = 20 + 10 = 30；加到 25 非法
    expect(() => applyAction(s, { type: "raise", amount: 25 })).toThrow();
    s = applyAction(s, { type: "raise", amount: 40 });
    expect(s.minRaise).toBe(20); // 增量 = 40 - 20
    expect(s.currentBet).toBe(40);
    // BTN 需重新行动
    expect(s.currentSeat).toBe(0);
    expect(() => applyAction(s, { type: "raise", amount: 59 })).toThrow();
    expect(() => applyAction(s, { type: "raise", amount: 60 })).not.toThrow();
  });

  it("bet 至少一个大盲；已有下注时只能 raise", () => {
    let s = applyAction(createGame(CFG), { type: "call", amount: 5 });
    s = applyAction(s, { type: "check", amount: 0 });
    expect(() => applyAction(s, { type: "bet", amount: 5 })).toThrow();
    s = applyAction(s, { type: "bet", amount: 10 });
    expect(s.minRaise).toBe(10);
    expect(() => applyAction(s, { type: "bet", amount: 20 })).toThrow(); // 只能 raise
    expect(() => applyAction(s, { type: "raise", amount: 20 })).not.toThrow();
  });
});

describe("game: 非法动作拒绝", () => {
  it("check 有未跟齐下注时抛错", () => {
    expect(() =>
      applyAction(createGame(CFG), { type: "check", amount: 0 }),
    ).toThrow();
  });

  it("call 金额不符抛错", () => {
    expect(() =>
      applyAction(createGame(CFG), { type: "call", amount: 6 }),
    ).toThrow();
  });

  it("金额超出筹码抛错", () => {
    expect(() =>
      applyAction(createGame(CFG), { type: "raise", amount: 101 }),
    ).toThrow();
  });

  it("allin 必须恰好全下", () => {
    expect(() =>
      applyAction(createGame(CFG), { type: "allin", amount: 50 }),
    ).toThrow();
  });

  it("fold 带非零金额抛错", () => {
    expect(() =>
      applyAction(createGame(CFG), { type: "fold", amount: 1 }),
    ).toThrow();
  });

  it("handOver 后任何动作抛错", () => {
    const s = applyAction(createGame(CFG), { type: "fold", amount: 0 });
    expect(() => applyAction(s, { type: "fold", amount: 0 })).toThrow();
  });
});

describe("game: 纯函数性", () => {
  it("applyAction 不修改入参", () => {
    const s0 = createGame(CFG);
    const snapshot = JSON.stringify(s0);
    applyAction(s0, { type: "call", amount: 5 });
    expect(JSON.stringify(s0)).toBe(snapshot);
  });
});

describe("game: 完整打到摊牌", () => {
  // BTN: Ah Kd；BB: Qc Jd；board: 2h 3d 4c 5s 9h → BTN 高牌 A 胜
  const s0 = createGame(rigged([
    "Ah", "Kd", "Qc", "Jd", "2h", "3d", "4c", "5s", "9h",
  ]));

  it("四街 check/call 到底，摊牌比大小", () => {
    let s = s0;
    s = applyAction(s, { type: "call", amount: 5 }); // 翻前 BTN 跟注
    s = applyAction(s, { type: "check", amount: 0 }); // BB 过牌 → flop
    expect(s.street).toBe("flop");
    expect(s.board).toEqual(["2h", "3d", "4c"]);
    expect(s.players[0].streetBet).toBe(0); // 换街归零
    expect(s.streetActions).toEqual([]);

    s = applyAction(s, { type: "check", amount: 0 });
    s = applyAction(s, { type: "check", amount: 0 }); // → turn
    expect(s.street).toBe("turn");
    expect(s.board).toHaveLength(4);

    s = applyAction(s, { type: "check", amount: 0 });
    s = applyAction(s, { type: "check", amount: 0 }); // → river
    expect(s.street).toBe("river");
    expect(s.board).toHaveLength(5);

    s = applyAction(s, { type: "check", amount: 0 });
    s = applyAction(s, { type: "check", amount: 0 }); // → showdown
    expect(s.handOver).toBe(true);
    expect(s.showdown).toBe(true);
    expect(s.street).toBe("showdown");
    expect(s.winners).toEqual([0]); // A 高牌胜
    expect(s.players[0].stack).toBe(110);
    expect(s.players[1].stack).toBe(90);
    expectConservation(s);
  });

  it("公共牌为顺子时平分底池", () => {
    // board: T J Q K A 彩虹面，双方玩公共牌
    let s = createGame(rigged([
      "2h", "3d", "7c", "8d", "Th", "Jd", "Qc", "Ks", "Ah",
    ]));
    s = applyAction(s, { type: "call", amount: 5 });
    s = applyAction(s, { type: "check", amount: 0 });
    for (let i = 0; i < 3; i++) {
      s = applyAction(s, { type: "check", amount: 0 });
      s = applyAction(s, { type: "check", amount: 0 });
    }
    expect(s.handOver).toBe(true);
    expect(s.winners).toEqual([0, 1]);
    expect(s.players[0].stack).toBe(100);
    expect(s.players[1].stack).toBe(100);
    expectConservation(s);
  });
});

describe("game: all-in 与边池", () => {
  it("对称筹码翻前 all-in 跑马摊牌", () => {
    // BTN: As Ah；BB: Ks Kh；board 干净 → AA 胜
    let s = createGame(rigged([
      "As", "Ah", "Ks", "Kh", "2h", "3d", "4c", "5s", "9h",
    ]));
    s = applyAction(s, { type: "allin", amount: 100 });
    expect(s.handOver).toBe(false);
    expect(s.currentSeat).toBe(1);
    // BB 只能 fold 或 call 90（跟注即全下）
    const actions = legalActions(s);
    expect(actions).toContainEqual({ type: "call", amount: 90 });
    expect(actions.find((a) => a.type === "raise")).toBeUndefined();

    s = applyAction(s, { type: "call", amount: 90 });
    expect(s.handOver).toBe(true);
    expect(s.showdown).toBe(true);
    expect(s.board).toHaveLength(5); // 自动跑完公共牌
    expect(s.winners).toEqual([0]);
    expect(s.players[0].stack).toBe(200);
    expect(s.players[1].stack).toBe(0);
    expectConservation(s);
  });

  it("非对称筹码：超额部分退还（边池语义）", () => {
    // 手工构造：p0 深筹码 100+5，p1 短码 30+10（本手总筹码 145）
    const dead: Card[] = ["As", "Ks", "8h", "9d", "3c", "4d", "5h", "6s", "7c"];
    const deck: Card[] = [
      ...newDeck().filter((c) => !dead.includes(c)),
      "3c", "4d", "5h", "6s", "7c", // 引擎 pop 顺序：翻牌×3、转、河
    ];
    const state: GameState = {
      deck,
      players: [
        {
          seat: 0, holeCards: ["As", "Ks"], stack: 100, streetBet: 5,
          handBet: 5, folded: false, allIn: false, hasActed: false,
          eliminated: false,
        },
        {
          seat: 1, holeCards: ["8h", "9d"], stack: 30, streetBet: 10,
          handBet: 10, folded: false, allIn: false, hasActed: false,
          eliminated: false,
        },
      ],
      board: [],
      pot: 15,
      street: "preflop",
      currentSeat: 0,
      buttonSeat: 0,
      smallBlind: 5,
      bigBlind: 10,
      ante: 0,
      minRaise: 10,
      currentBet: 10,
      streetActions: [],
      handNumber: 1,
      handOver: false,
      winners: null,
      showdown: false,
    };

    // p0 全下 105（bet-to），p1 只有 30 可补
    let s = applyAction(state, { type: "allin", amount: 105 });
    expect(s.currentBet).toBe(105);
    const actions = legalActions(s);
    expect(actions).toContainEqual({ type: "call", amount: 30 }); // 全下跟注

    s = applyAction(s, { type: "call", amount: 30 });
    expect(s.handOver).toBe(true);
    expect(s.showdown).toBe(true);
    // board 3c 4d 5h 6s 7c：p0 玩公共牌 7 高顺；p1 8h9d 组成 9 高顺 → p1 胜
    expect(s.winners).toEqual([1]);
    // p1 只能赢自己跟得起的 40×2=80；p0 超出的 65 退还
    expect(s.players[1].stack).toBe(80);
    expect(s.players[0].stack).toBe(65);
    expect(totalChips(s)).toBe(145);
  });

  it("短码跟注全下后自动跑完公共牌", () => {
    const dead: Card[] = ["As", "Ah", "Ks", "Kh", "2h", "3d", "4c", "5s", "9h"];
    const deck: Card[] = [
      ...newDeck().filter((c) => !dead.includes(c)),
      "2h", "3d", "4c", "5s", "9h",
    ];
    const state: GameState = {
      deck,
      players: [
        {
          seat: 0, holeCards: ["As", "Ah"], stack: 95, streetBet: 5,
          handBet: 5, folded: false, allIn: false, hasActed: false,
          eliminated: false,
        },
        {
          seat: 1, holeCards: ["Ks", "Kh"], stack: 8, streetBet: 10,
          handBet: 10, folded: false, allIn: false, hasActed: false,
          eliminated: false,
        },
      ],
      board: [],
      pot: 15,
      street: "preflop",
      currentSeat: 0,
      buttonSeat: 0,
      smallBlind: 5,
      bigBlind: 10,
      ante: 0,
      minRaise: 10,
      currentBet: 10,
      streetActions: [],
      handNumber: 1,
      handOver: false,
      winners: null,
      showdown: false,
    };

    let s = applyAction(state, { type: "raise", amount: 20 });
    // p1 跟注需 10 但只剩 8：只能 fold 或全下跟 8
    const actions = legalActions(s);
    expect(actions).toContainEqual({ type: "fold", amount: 0 });
    expect(actions).toContainEqual({ type: "call", amount: 8 });
    expect(actions.find((a) => a.type === "raise")).toBeUndefined();

    s = applyAction(s, { type: "call", amount: 8 });
    // p1 全下且未跟齐（18 < 20）：p0 无行动可做，直接摊牌
    expect(s.handOver).toBe(true);
    expect(s.showdown).toBe(true);
    expect(s.board).toHaveLength(5);
    expect(s.winners).toEqual([0]); // AA 胜 KK
    // p0 超出部分 2 退还，底池 36 归 p0
    expect(s.players[0].stack).toBe(80 + 2 + 36);
    expect(s.players[1].stack).toBe(0);
    expect(totalChips(s)).toBe(118); // 本手总筹码 100 + 18
  });
});

describe("game: 随机多手牌筹码守恒", () => {
  // 可复现随机源
  const mulberry32 = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it("200 手随机对局，不变式全程成立", () => {
    const rng = mulberry32(20260922);
    for (let hand = 0; hand < 200; hand++) {
      let s = createGame({ ...CFG, buttonSeat: (hand % 2) as 0 | 1 });
      let steps = 0;
      while (!s.handOver) {
        expectConservation(s);
        const actions = legalActions(s);
        expect(actions.length).toBeGreaterThan(0);
        const pick = actions[Math.floor(rng() * actions.length)];
        let action: PlayerAction = pick;
        // bet/raise 给的是最小额，随机上浮（不超过 allin 额）
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
        expect(before.players[0].handBet + before.players[1].handBet).toBe(
          before.pot,
        );
        steps++;
        expect(steps).toBeLessThan(100); // 兜底防死循环
      }
      expect(s.winners).not.toBeNull();
      expect(s.pot).toBe(0);
      expectConservation(s);
    }
  });
});
