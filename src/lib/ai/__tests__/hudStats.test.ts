/**
 * hudStats.ts（个人数据中心统计聚合）测试
 *
 * 用 10 手 6-max 合成记录（hero 固定座位 0，按钮轮转覆盖 BTN/CO/HJ/UTG/BB/SB
 * 六个位置；前 5 手对手 tag、后 5 手对手 maniac），锁定：
 * - 核心指标：总手数/总盈亏/bb每百手/胜率（平局 0.5）/摊牌率
 * - hero 四指标 VPIP/PFR/AF/WTSD（与 adapt.updateStats 同口径，λ=1 整数累积）
 * - 翻前位置分桶（early/middle/late）手数与 VPIP/PFR
 * - 按位置盈亏表（BTN/CO/.../BB 顺序）、按风格盈亏表
 * - 盈亏曲线（输入乱序时按时间升序、累计值正确）
 * - computeHeroHud 内部临时把 λ 置 1，结束后恢复原值（不污染 adapt 的近因口径）
 */
import { afterEach, describe, expect, it } from "vitest";
import type {
  ActionType,
  ConcreteAIStyle,
  HandPlayerRecord,
  HandRecord,
  Seat,
  SeatAction,
  Street,
  StreetRecord,
} from "@/lib/types";
import { computeHeroHud } from "@/lib/ai/hudStats";
import {
  DEFAULT_RECENCY_LAMBDA,
  getAdaptRecencyLambda,
  setAdaptRecencyLambda,
} from "@/lib/ai/adapt";

afterEach(() => {
  setAdaptRecencyLambda(DEFAULT_RECENCY_LAMBDA);
});

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function sa(seat: Seat, type: ActionType, amount = 0): SeatAction {
  return { seat, action: { type, amount } };
}

function st(street: Street, actions: SeatAction[]): StreetRecord {
  return { street, board: [], actions };
}

function makeHand(opts: {
  id: string;
  ts: number;
  /** 按钮位（hero 座位 0；6-max 下 0=BTN 1=CO 2=HJ 3=UTG 4=BB 5=SB） */
  buttonSeat: Seat;
  opponentStyle?: ConcreteAIStyle;
  streets: StreetRecord[];
  profit: number;
  showdown?: boolean;
}): HandRecord {
  const players: HandPlayerRecord[] = Array.from({ length: 6 }, (_, seat) => ({
    seat,
    isHero: seat === 0,
    aiStyle: seat === 0 ? null : (opts.opponentStyle ?? "tag"),
    cards: null,
    profit: seat === 0 ? opts.profit : 0,
  }));
  return {
    id: opts.id,
    timestamp: opts.ts,
    players,
    heroSeat: 0,
    buttonSeat: opts.buttonSeat,
    smallBlind: 5,
    bigBlind: 10,
    ante: 0,
    streets: opts.streets,
    finalBoard: [],
    result: opts.profit > 0 ? "win" : opts.profit < 0 ? "lose" : "tie",
    profit: opts.profit,
    showdown: opts.showdown ?? false,
  };
}

/**
 * 10 手合成记录（hero 视角）：
 * h1 BTN 开加赢下盲注 +15；h2 CO limp 后弃牌 -10；h3 HJ 弃牌 0（平）；
 * h4 UTG 开加，flop bet / river call 打到摊牌 -120；h5 BB 跟注加注后弃牌 -30；
 * h6 SB 补齐，turn bet 赢下 +15；h7 BTN 开加赢下 +15；h8 CO 弃牌 0（平）；
 * h9 UTG 弃牌 0（平）；h10 BB 过牌跟注两条街打到摊牌赢下 +100。
 * 前 5 手对手全 tag，后 5 手对手全 maniac。
 */
function fixtureHands(): HandRecord[] {
  const hands: HandRecord[] = [
    makeHand({
      id: "h1", ts: 1000, buttonSeat: 0, profit: 15,
      streets: [st("preflop", [sa(3, "fold"), sa(4, "fold"), sa(5, "fold"), sa(0, "raise", 30), sa(1, "fold"), sa(2, "fold")])],
    }),
    makeHand({
      id: "h2", ts: 2000, buttonSeat: 1, profit: -10,
      streets: [
        st("preflop", [sa(4, "fold"), sa(5, "fold"), sa(0, "call", 10), sa(2, "fold"), sa(3, "check")]),
        st("flop", [sa(3, "bet", 20), sa(0, "fold")]),
      ],
    }),
    makeHand({
      id: "h3", ts: 3000, buttonSeat: 2, profit: 0,
      streets: [st("preflop", [sa(5, "fold"), sa(0, "fold")])],
    }),
    makeHand({
      id: "h4", ts: 4000, buttonSeat: 3, profit: -120, showdown: true,
      streets: [
        st("preflop", [sa(0, "raise", 30), sa(1, "call", 30), sa(2, "fold"), sa(4, "fold"), sa(5, "fold")]),
        st("flop", [sa(0, "bet", 40), sa(1, "call", 40)]),
        st("turn", [sa(0, "check"), sa(1, "check")]),
        st("river", [sa(0, "check"), sa(1, "bet", 50), sa(0, "call", 50)]),
      ],
    }),
    makeHand({
      id: "h5", ts: 5000, buttonSeat: 4, profit: -30,
      streets: [
        st("preflop", [sa(1, "raise", 30), sa(2, "fold"), sa(3, "fold"), sa(5, "fold"), sa(0, "call", 20)]),
        st("flop", [sa(0, "check"), sa(1, "bet", 30), sa(0, "fold")]),
      ],
    }),
    makeHand({
      id: "h6", ts: 6000, buttonSeat: 5, opponentStyle: "maniac", profit: 15,
      streets: [
        st("preflop", [sa(2, "fold"), sa(3, "fold"), sa(4, "fold"), sa(0, "call", 5), sa(1, "check")]),
        st("flop", [sa(0, "check"), sa(1, "check")]),
        st("turn", [sa(0, "bet", 20), sa(1, "fold")]),
      ],
    }),
    makeHand({
      id: "h7", ts: 7000, buttonSeat: 0, opponentStyle: "maniac", profit: 15,
      streets: [st("preflop", [sa(3, "fold"), sa(4, "fold"), sa(5, "fold"), sa(0, "raise", 30), sa(1, "fold"), sa(2, "fold")])],
    }),
    makeHand({
      id: "h8", ts: 8000, buttonSeat: 1, opponentStyle: "maniac", profit: 0,
      streets: [st("preflop", [sa(4, "fold"), sa(5, "fold"), sa(0, "fold")])],
    }),
    makeHand({
      id: "h9", ts: 9000, buttonSeat: 3, opponentStyle: "maniac", profit: 0,
      streets: [st("preflop", [sa(0, "fold")])],
    }),
    makeHand({
      id: "h10", ts: 10000, buttonSeat: 4, opponentStyle: "maniac", profit: 100, showdown: true,
      streets: [
        st("preflop", [sa(1, "call", 10), sa(2, "fold"), sa(3, "fold"), sa(5, "fold"), sa(0, "check")]),
        st("flop", [sa(0, "check"), sa(1, "bet", 20), sa(0, "call", 20)]),
        st("turn", [sa(0, "check"), sa(1, "bet", 40), sa(0, "call", 40)]),
      ],
    }),
  ];
  // 故意按时间倒序传入，验证内部按 timestamp 升序重排
  return hands.reverse();
}

describe("computeHeroHud 核心指标", () => {
  const hud = computeHeroHud(fixtureHands());

  it("总手数 / 总盈亏 / bb每百手 / 胜率（平局 0.5）/ 摊牌率", () => {
    expect(hud.totalHands).toBe(10);
    expect(hud.totalProfit).toBe(-15);
    // Σ(profit/bb) = 1.5-1+0-12-3+1.5+1.5+0+0+10 = -1.5bb → /10手×100 = -15 bb/100
    expect(hud.bbPer100).toBeCloseTo(-15, 5);
    // 胜 4（h1/h6/h7/h10）+ 平 3（h3/h8/h9）×0.5 = 5.5 → 0.55
    expect(hud.winRate).toBeCloseTo(0.55, 5);
    // h4/h10 摊牌 → 2/10
    expect(hud.showdownRate).toBeCloseTo(0.2, 5);
  });

  it("hero 四指标：VPIP 0.6 / PFR 0.3 / AF 2/3 / WTSD 0.4", () => {
    // VPIP：h1,h2,h4,h5,h6,h7 = 6/10（h10 翻前 check 不算，弃牌三手不算）
    expect(hud.vpip).toBeCloseTo(0.6, 5);
    // PFR：h1,h4,h7 = 3/10
    expect(hud.pfr).toBeCloseTo(0.3, 5);
    // AF：进攻 2（h4 flop bet、h6 turn bet）/ 被动 3（h4 river call、h10 flop/turn call）
    expect(hud.af).toBeCloseTo(2 / 3, 5);
    // WTSD：见翻牌 5（h2,h4,h5,h6,h10），到摊牌 2（h4,h10）
    expect(hud.wtsd).toBeCloseTo(0.4, 5);
  });
});

describe("computeHeroHud 位置与风格拆分", () => {
  const hud = computeHeroHud(fixtureHands());

  it("翻前位置分桶：early 2 手 / middle 5 手 / late 3 手", () => {
    expect(hud.buckets.early.hands).toBe(2); // UTG：h4,h9
    expect(hud.buckets.early.vpip).toBeCloseTo(0.5, 5); // h4
    expect(hud.buckets.early.pfr).toBeCloseTo(0.5, 5);
    expect(hud.buckets.middle.hands).toBe(5); // BTN/CO/HJ：h1,h2,h3,h7,h8
    expect(hud.buckets.middle.vpip).toBeCloseTo(0.6, 5); // h1,h2,h7
    expect(hud.buckets.middle.pfr).toBeCloseTo(0.4, 5); // h1,h7
    expect(hud.buckets.late.hands).toBe(3); // SB/BB：h5,h6,h10
    expect(hud.buckets.late.vpip).toBeCloseTo(2 / 3, 5); // h5,h6
    expect(hud.buckets.late.pfr).toBe(0);
  });

  it("按位置表现表：BTN→CO→…→BB 顺序，手数/盈亏/胜率正确", () => {
    expect(hud.byPosition.map((r) => r.position)).toEqual([
      "BTN", "CO", "HJ", "UTG", "BB", "SB",
    ]);
    const byPos = Object.fromEntries(hud.byPosition.map((r) => [r.position, r]));
    expect(byPos.BTN).toMatchObject({ hands: 2, profit: 30 });
    expect(byPos.BTN.winRate).toBeCloseTo(1, 5);
    expect(byPos.CO).toMatchObject({ hands: 2, profit: -10 });
    expect(byPos.CO.winRate).toBeCloseTo(0.25, 5); // 0 胜 1 平
    expect(byPos.HJ).toMatchObject({ hands: 1, profit: 0 });
    expect(byPos.HJ.winRate).toBeCloseTo(0.5, 5); // 平局 0.5
    expect(byPos.UTG).toMatchObject({ hands: 2, profit: -120 });
    expect(byPos.UTG.winRate).toBeCloseTo(0.25, 5);
    expect(byPos.BB).toMatchObject({ hands: 2, profit: 70 });
    expect(byPos.BB.winRate).toBeCloseTo(0.5, 5);
    expect(byPos.SB).toMatchObject({ hands: 1, profit: 15 });
    expect(byPos.SB.winRate).toBeCloseTo(1, 5);
  });

  it("按对手风格表现表：tag 亏 / maniac 盈", () => {
    expect(hud.byStyle.map((r) => r.style)).toEqual(["tag", "maniac"]);
    const [tag, maniac] = hud.byStyle;
    expect(tag).toMatchObject({ hands: 5, profit: -145 });
    expect(tag.winRate).toBeCloseTo(0.3, 5); // 1 胜 1 平 → 1.5/5
    expect(maniac).toMatchObject({ hands: 5, profit: 130 });
    expect(maniac.winRate).toBeCloseTo(0.8, 5); // 3 胜 2 平 → 4/5
  });
});

describe("computeHeroHud 盈亏曲线与 λ 恢复", () => {
  it("曲线按时间升序、累计盈亏逐手正确", () => {
    const hud = computeHeroHud(fixtureHands());
    expect(hud.curve).toHaveLength(10);
    expect(hud.curve.map((p) => p.handNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(hud.curve.map((p) => p.timestamp)).toEqual(
      [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000],
    );
    expect(hud.curve.map((p) => p.cumulative)).toEqual(
      [15, 5, 5, -115, -145, -130, -115, -115, -115, -15],
    );
  });

  it("聚合结束后恢复 adapt 的近因衰减 λ（不污染对手建模口径）", () => {
    setAdaptRecencyLambda(0.77);
    computeHeroHud(fixtureHands());
    expect(getAdaptRecencyLambda()).toBeCloseTo(0.77, 10);
  });

  it("空数组：全部归零，bbPer100 为 null", () => {
    const hud = computeHeroHud([]);
    expect(hud.totalHands).toBe(0);
    expect(hud.totalProfit).toBe(0);
    expect(hud.bbPer100).toBeNull();
    expect(hud.winRate).toBe(0);
    expect(hud.showdownRate).toBe(0);
    expect(hud.vpip).toBe(0);
    expect(hud.curve).toEqual([]);
    expect(hud.byPosition).toEqual([]);
    expect(hud.byStyle).toEqual([]);
    expect(hud.buckets.early).toEqual({ hands: 0, vpip: null, pfr: null });
  });
});
