/**
 * Phase 8 测试：摊牌学习（showdown-calibrated ranges）+ blocker 效应
 *
 * - updateStats 亮牌记录：showdownsSeen 环形缓冲（seat/bucket/handType/action、
 *   上限 30、非摊牌/弃牌不记、λ 衰减不影响环形缓冲）
 * - rangeWidthAdjustment：样本门槛（<5 → 1）/ 方向（弱牌占比 >0.3 放宽、全强 0.9 微收）
 *   / 钳制（上限 1.5）/ 桶隔离；showdownWidthMult 置信度缩放
 * - blocker：equityVsRange 第 7 参——hero 持 A♠ 时对手黑桃同花听降权（胜率方向性）、
 *   hero 对子点数在 board 时三条组合降权、无规则命中逐比特旧路径、旋钮关闭回归
 * - brain 接入：翻前面注宽度（百分位口径与 preflopRangeMode 口径各一组）、
 *   旋钮关闭/无亮牌数据时逐比特回归
 */
import { describe, expect, it } from "vitest";
import type {
  ActionType,
  Card,
  HandRecord,
  OpponentModel,
  OpponentStats,
  Seat,
  SeatAction,
  StreetRecord,
} from "@/lib/types";
import {
  buildModel,
  createOpponentStats,
  rangeWidthAdjustment,
  showdownRingOf,
  showdownWidthMult,
  SHOWDOWN_MIN_SAMPLE,
  updateStats,
  type OpponentStatsWithShowdowns,
  type PreflopBucket,
  type ShowdownAction,
  type ShowdownShown,
} from "../adapt";
import { brainDecide, resetBrainCaches } from "../brain";
import { equityVsRange, inferFacingSpec, resetRangeCaches } from "../range";
import { makeDecideInput } from "./helpers";

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function sa(seat: Seat, type: ActionType, amount = 0): SeatAction {
  return { seat, action: { type, amount } };
}

/** 带亮牌信息的手牌记录（cards 口径同生产：摊牌且未弃牌者非 null） */
function makeSdRecord(opts: {
  seats: Seat[];
  preflop?: SeatAction[];
  postflop?: StreetRecord[];
  showdown?: boolean;
  cards?: Record<number, [Card, Card] | null>;
  bigBlind?: number;
  buttonSeat?: Seat;
}): HandRecord {
  const bb = opts.bigBlind ?? 10;
  return {
    id: "test-sd",
    timestamp: 0,
    players: opts.seats.map((seat) => ({
      seat,
      isHero: false,
      aiStyle: "tag",
      cards: opts.cards?.[seat] ?? null,
      profit: 0,
    })),
    heroSeat: 0,
    buttonSeat: opts.buttonSeat ?? 0,
    smallBlind: bb / 2,
    bigBlind: bb,
    ante: 0,
    streets: [
      { street: "preflop", board: [], actions: opts.preflop ?? [] },
      ...(opts.postflop ?? []),
    ],
    finalBoard: [],
    result: "tie",
    profit: 0,
    showdown: opts.showdown ?? false,
  };
}

const shown = (
  bucket: PreflopBucket,
  handType: string,
  action: ShowdownAction = "open_raise",
  seat: Seat = 1,
): ShowdownShown => ({ seat, bucket, handType, action });

/** 直接挂亮牌环形缓冲的 stats（绕过 updateStats 的单测夹具） */
function statsWithRing(ring: ShowdownShown[], over: Partial<OpponentStats> = {}): OpponentStats {
  const base: OpponentStatsWithShowdowns = { ...createOpponentStats(1), ...over };
  base.showdownsSeen = ring;
  return base;
}

/** 满置信 tag 模型（hands=40、vpip 0.25、af 1；分桶为零 → 不触发位置敏感剥削） */
function modelWithRing(seat: Seat, ring: ShowdownShown[]): OpponentModel {
  return buildModel(
    statsWithRing(ring, {
      seat,
      hands: 40,
      vpipHands: 10,
      pfrHands: 7,
      postflopAggressive: 5,
      postflopPassive: 5,
    }),
  );
}

// ---------------------------------------------------------------------------
// updateStats 亮牌记录
// ---------------------------------------------------------------------------

describe("updateStats 摊牌亮牌记录", () => {
  it("摊牌且未弃牌者记录 {seat,bucket,handType,action}；开局加注/跟注分档正确", () => {
    // 6 人桌按钮 0：CO(5) 开局加注（middle 桶），SB(1) 跟注（late 桶），摊牌
    const record = makeSdRecord({
      seats: [0, 1, 2, 3, 4, 5],
      showdown: true,
      cards: { 5: ["Js", "4d"], 1: ["Ah", "Qh"] },
      preflop: [
        sa(3, "fold"), sa(4, "fold"), sa(5, "raise", 30),
        sa(0, "fold"), sa(1, "call", 25), sa(2, "fold"),
      ],
      postflop: [
        { street: "flop", board: ["As", "Kd", "7c"], actions: [sa(1, "check"), sa(5, "check")] },
      ],
    });
    const s5 = updateStats(createOpponentStats(5), record, 5);
    expect(showdownRingOf(s5)).toEqual([
      { seat: 5, bucket: "middle", handType: "J4o", action: "open_raise" },
    ]);
    const s1 = updateStats(createOpponentStats(1), record, 1);
    expect(showdownRingOf(s1)).toEqual([
      { seat: 1, bucket: "late", handType: "AQs", action: "call" },
    ]);
  });

  it("three_bet / four_bet_plus / check 分档；allin 按下注线归类", () => {
    const record = makeSdRecord({
      seats: [0, 1, 2, 3, 4, 5],
      showdown: true,
      cards: { 3: ["Ah", "Ad"], 4: ["Kh", "Kd"], 5: ["Qh", "Qd"], 2: ["9s", "8s"] },
      preflop: [
        sa(3, "raise", 30), // UTG open（首个主动作 = open_raise）
        sa(4, "raise", 70), // HJ 3bet（首个主动作 = three_bet）
        sa(5, "raise", 150), // CO 4bet（首个主动作 = four_bet_plus）
        sa(0, "fold"), sa(1, "fold"),
        sa(2, "call", 140), // BB 跟注（首个主动作 = call）
        sa(3, "allin", 500), // 抬线 allin（首动作已记 open_raise，不受影响）
        sa(4, "call", 430), sa(5, "call", 350), sa(2, "call", 360), // 全员跟到摊牌
      ],
    });
    expect(showdownRingOf(updateStats(createOpponentStats(3), record, 3))[0].action).toBe("open_raise");
    expect(showdownRingOf(updateStats(createOpponentStats(4), record, 4))[0].action).toBe("three_bet");
    expect(showdownRingOf(updateStats(createOpponentStats(5), record, 5))[0].action).toBe("four_bet_plus");
    expect(showdownRingOf(updateStats(createOpponentStats(2), record, 2))[0].action).toBe("call");

    // 短码 allin 未抬线 → 记 call；limp 后 BB check → 记 check
    const limped = makeSdRecord({
      seats: [0, 1, 2],
      showdown: true,
      cards: { 0: ["Ts", "9s"], 1: ["7h", "6h"], 2: ["5c", "4c"] },
      preflop: [sa(0, "call", 10), sa(1, "allin", 8), sa(2, "check")],
    });
    expect(showdownRingOf(updateStats(createOpponentStats(1), limped, 1))[0].action).toBe("call");
    expect(showdownRingOf(updateStats(createOpponentStats(2), limped, 2))[0].action).toBe("check");
  });

  it("非摊牌 / 弃牌 / cards 为 null 均不记录；旧 stats 无字段时读取为空", () => {
    // 未摊牌：即使 cards 非 null（生产 hero 恒亮牌口径）也不记
    const noSd = makeSdRecord({
      seats: [0, 1],
      cards: { 0: ["As", "Kd"] },
      preflop: [sa(0, "raise", 30), sa(1, "fold")],
    });
    const s0 = updateStats(createOpponentStats(0), noSd, 0);
    expect(showdownRingOf(s0)).toEqual([]);
    expect((s0 as OpponentStatsWithShowdowns).showdownsSeen).toBeUndefined();

    // 摊牌但该座位翻前弃牌（cards null）→ 不记
    const folded = makeSdRecord({
      seats: [0, 1],
      showdown: true,
      cards: { 0: ["As", "Kd"] },
      preflop: [sa(1, "fold"), sa(0, "call", 10)],
      postflop: [
        { street: "flop", board: ["As", "Kd", "7c"], actions: [sa(0, "check")] },
      ],
    });
    expect(showdownRingOf(updateStats(createOpponentStats(1), folded, 1))).toEqual([]);
    expect(showdownRingOf(updateStats(createOpponentStats(0), folded, 0))).toHaveLength(1);
  });

  it("环形缓冲上限 30：超出丢弃最旧；无亮牌的手引用前滚；λ 衰减不动缓冲", () => {
    let s = createOpponentStats(0);
    // 2 人桌（按钮 0），座位 0 每手摊牌：偶数手 J4o、奇数手 T4o
    for (let h = 0; h < 35; h++) {
      const record = makeSdRecord({
        seats: [0, 1],
        buttonSeat: 0,
        showdown: true,
        cards: { 0: h % 2 === 0 ? ["Js", "4d"] : ["Ts", "4d"] },
        preflop: [sa(0, "raise", 30), sa(1, "call", 20)],
      });
      s = updateStats(s, record, 0, 0.5); // λ=0.5 强衰减
    }
    const ring = showdownRingOf(s);
    expect(ring).toHaveLength(30);
    expect(ring[0].handType).toBe("T4o"); // 第 5 手（奇）是最旧保留条目
    expect(ring[29].handType).toBe("J4o"); // 第 34 手（偶）最新
    // 再记一手无摊牌：缓冲原样前滚（不丢、不增）
    const plain = makeSdRecord({
      seats: [0, 1],
      preflop: [sa(0, "raise", 30), sa(1, "fold")],
    });
    const s2 = updateStats(s, plain, 0, 0.5);
    expect(showdownRingOf(s2)).toHaveLength(30);
    expect(showdownRingOf(s2)[0].handType).toBe("T4o");
  });
});

// ---------------------------------------------------------------------------
// rangeWidthAdjustment / showdownWidthMult
// ---------------------------------------------------------------------------

describe("rangeWidthAdjustment 宽度调整", () => {
  it("样本门槛：该桶亮牌 < 5 条 → 1（弱牌再多也不动）", () => {
    const ring = Array.from({ length: SHOWDOWN_MIN_SAMPLE - 1 }, () =>
      shown("late", "72o"),
    );
    expect(rangeWidthAdjustment(statsWithRing(ring), "late")).toBe(1);
  });

  it("方向与钳制：全弱牌 → 上限 1.5；弱牌占比 0.5 → ≈1.143；全强牌 → 0.9", () => {
    const allWeak = Array.from({ length: 5 }, () => shown("late", "J4o"));
    expect(rangeWidthAdjustment(statsWithRing(allWeak), "late")).toBe(1.5);

    // 10 条 5 弱 → 占比 0.5：1 + (0.5-0.3) × (0.5/0.7) ≈ 1.1429
    const half = [
      ...Array.from({ length: 5 }, () => shown("middle", "J4o")),
      ...Array.from({ length: 5 }, () => shown("middle", "AA")),
    ];
    expect(rangeWidthAdjustment(statsWithRing(half), "middle")).toBeCloseTo(1 + 0.2 * (0.5 / 0.7), 10);

    const allStrong = Array.from({ length: 8 }, () => shown("early", "AKs"));
    expect(rangeWidthAdjustment(statsWithRing(allStrong), "early")).toBe(0.9);
  });

  it("阈值边界：弱牌占比恰为 0.3 不放宽（>0.3 才放）", () => {
    const at30 = [
      ...Array.from({ length: 3 }, () => shown("late", "72o")),
      ...Array.from({ length: 7 }, () => shown("late", "AQo")),
    ];
    expect(rangeWidthAdjustment(statsWithRing(at30), "late")).toBe(1);
    const over30 = [
      ...Array.from({ length: 4 }, () => shown("late", "72o")),
      ...Array.from({ length: 6 }, () => shown("late", "AQo")),
    ];
    expect(rangeWidthAdjustment(statsWithRing(over30), "late")).toBeGreaterThan(1);
  });

  it("桶隔离：late 桶的弱亮牌不影响 early 桶；强度百分位边界（J5s=0.5 算强，Q5o 算弱）", () => {
    const lateWeak = Array.from({ length: 6 }, () => shown("late", "J4o"));
    const s = statsWithRing(lateWeak);
    expect(rangeWidthAdjustment(s, "late")).toBeGreaterThan(1);
    expect(rangeWidthAdjustment(s, "early")).toBe(1);
    expect(rangeWidthAdjustment(s, "middle")).toBe(1);

    // J5s 百分位恰 0.5 → 非弱牌（<0.5 才算）：5 条 J5s 视为全强 → 0.9
    const j5s = Array.from({ length: 5 }, () => shown("late", "J5s"));
    expect(rangeWidthAdjustment(statsWithRing(j5s), "late")).toBe(0.9);
    // Q5o 百分位 ≈0.494 < 0.5 → 弱牌：5 条触发上限放宽
    const q5o = Array.from({ length: 5 }, () => shown("late", "Q5o"));
    expect(rangeWidthAdjustment(statsWithRing(q5o), "late")).toBe(1.5);
  });

  it("showdownWidthMult：按模型置信度缩放；无模型/零置信/无调整精确为 1", () => {
    const weakRing = Array.from({ length: 5 }, () => shown("late", "J4o"));
    const full = modelWithRing(2, weakRing);
    expect(showdownWidthMult(full, "late")).toBe(1.5); // conf=1
    expect(showdownWidthMult({ ...full, confidence: 0.5 }, "late")).toBeCloseTo(1.25, 10);
    expect(showdownWidthMult({ ...full, confidence: 0 }, "late")).toBe(1);
    expect(showdownWidthMult(undefined, "late")).toBe(1);
    // 全强牌 0.9 同样按置信度缩放
    const strongRing = Array.from({ length: 5 }, () => shown("early", "AKs"));
    const strongModel = modelWithRing(2, strongRing);
    expect(showdownWidthMult(strongModel, "early")).toBe(0.9);
    expect(showdownWidthMult({ ...strongModel, confidence: 0.5 }, "early")).toBeCloseTo(0.95, 10);
  });
});

// ---------------------------------------------------------------------------
// inferFacingSpec 宽度乘数接入
// ---------------------------------------------------------------------------

describe("inferFacingSpec 摊牌宽度乘数（第 5 参）", () => {
  it("widthMult 作用于 topPct（乘后钳制 0.8）；缺省/1 不变", () => {
    expect(inferFacingSpec("flop", 0, 1, undefined, 1.5).topPct).toBeCloseTo(0.8, 10); // 0.55×1.5 钳顶
    expect(inferFacingSpec("flop", 0, 1, undefined, 0.9).topPct).toBeCloseTo(0.495, 10);
    expect(inferFacingSpec("flop", 0, 1, undefined, 1)).toEqual({ topPct: 0.55, bluffPct: 0.15 });
    expect(inferFacingSpec("flop", 0, 1)).toEqual({ topPct: 0.55, bluffPct: 0.15 });
  });
});

// ---------------------------------------------------------------------------
// blocker 效应（equityVsRange 第 7 参）
// ---------------------------------------------------------------------------

describe("equityVsRange blocker 权重", () => {
  it("hero 持 A♠（board 两黑桃）：对手同花听降权 → hero 胜率上升", () => {
    // AsKd on Ks7s2d：hero 顶对 K + 坚果同花 blocker；对手黑桃-黑桃组合
    // （同花听，对顶对约 35-40% 胜率）×0.55 → hero 胜率上升
    const hero: [Card, Card] = ["As", "Kd"];
    const board: Card[] = ["Ks", "7s", "2d"];
    const spec = { topPct: 0.55, bluffPct: 0.15 };
    resetRangeCaches();
    const off = equityVsRange(hero, board, spec, 6000, mulberry32(11), 1, false);
    resetRangeCaches();
    const on = equityVsRange(hero, board, spec, 6000, mulberry32(11), 1, true);
    console.log(`[blocker-flush] off=${off.toFixed(4)} on=${on.toFixed(4)}`);
    expect(on).toBeGreaterThan(off + 0.005);
  });

  it("hero 对子点数在 board（8♠8♥ on 8♦K♣2♠）：对手三条组合降权 → hero 胜率上升", () => {
    // hero 三条 8（kicker 弱）；对手唯一剩余 8♣X 组合（三条）×0.5
    const hero: [Card, Card] = ["8s", "8h"];
    const board: Card[] = ["8d", "Kc", "2s"];
    const spec = { topPct: 0.6, bluffPct: 0.1 };
    resetRangeCaches();
    const off = equityVsRange(hero, board, spec, 6000, mulberry32(12), 1, false);
    resetRangeCaches();
    const on = equityVsRange(hero, board, spec, 6000, mulberry32(12), 1, true);
    console.log(`[blocker-trips] off=${off.toFixed(4)} on=${on.toFixed(4)}`);
    expect(on).toBeGreaterThan(off);
  });

  it("无规则命中（hero 无 A 无对子）→ 均匀池退回旧公式路径，与关闭逐比特一致", () => {
    const hero: [Card, Card] = ["Jd", "Tc"];
    const board: Card[] = ["Kh", "8d", "2c"];
    const spec = { topPct: 0.3, bluffPct: 0.1 };
    resetRangeCaches();
    const off = equityVsRange(hero, board, spec, 800, mulberry32(42), 1, false);
    resetRangeCaches();
    const on = equityVsRange(hero, board, spec, 800, mulberry32(42), 1, true);
    expect(on).toBe(off); // 同 seed 精确相等（均匀池共享旧采样公式）
  });

  it("旋钮回归：blockerEnabled 缺省与显式 false 逐比特一致", () => {
    const hero: [Card, Card] = ["As", "Qd"]; // 即使会命中规则，false 侧不走权重
    const board: Card[] = ["Ks", "7s", "2d"];
    const spec = { topPct: 0.3, bluffPct: 0.1 };
    resetRangeCaches();
    const implicit = equityVsRange(hero, board, spec, 800, mulberry32(7));
    resetRangeCaches();
    const explicit = equityVsRange(hero, board, spec, 800, mulberry32(7), 1, false);
    expect(explicit).toBe(implicit);
    // 且关闭侧不受 hero  blocker 影响：与「hero 无 A」同结构同 seed 不同牌无需相等，
    // 但 false 路径必须与 hero 牌面无关地走均匀公式（缓存 key 区分 blk0/1）
    resetRangeCaches();
    const again = equityVsRange(hero, board, spec, 800, mulberry32(7), 1, false);
    expect(again).toBe(implicit);
  });
});

// ---------------------------------------------------------------------------
// brain 接入：摊牌学习宽度 + 旋钮回归
// ---------------------------------------------------------------------------

/** 6 人桌 SB（seat 1）开局加注 30，hero 在 BB（seat 2）持 Q5s（百分位 0.595） */
function mkBB(models?: OpponentModel[]) {
  const input = makeDecideInput({
    aiHole: ["Qd", "5d"],
    playerCount: 6,
    aiSeat: 2,
    buttonSeat: 0,
    pot: 40,
    currentBet: 30,
    aiStreetBet: 10,
    aiStack: 990,
    callAmount: 20,
    legalActions: [
      { type: "fold", amount: 0 },
      { type: "call", amount: 20 },
      { type: "raise", amount: 60 },
      { type: "allin", amount: 1000 },
    ],
    style: "gto",
  });
  input.state.streetActions = [{ seat: 1, action: { type: "raise", amount: 30 } }];
  return models ? { ...input, opponentModels: models } : input;
}

const weakLateRing = (seat: Seat) =>
  Array.from({ length: 10 }, () => shown("late", "J4o", "open_raise", seat));

describe("brain 摊牌学习接入：翻前百分位口径（preflopRangeModeEnabled:false）", () => {
  const N = 100;
  it("SB 亮牌全弱 → BB 防守放宽（边缘牌弃转跟）；旋钮关闭恢复弃牌", () => {
    const model = modelWithRing(1, weakLateRing(1));
    // 旋钮关闭（旧行为，对照）：0.595 < 0.60 → 弃牌为主（9% 诈唬 3bet 噪声）
    let offFolds = 0;
    // 显式开启：width 1.5 → 继续范围 0.40×1.5=0.60 → 门槛 0.40 → 跟注
    let onCalls = 0;
    for (let i = 0; i < N; i++) {
      const off = brainDecide(mkBB([model]), "gto", mulberry32(1000 + i), {
        preflopRangeModeEnabled: false,
        showdownLearnEnabled: false,
      }).action.type;
      if (off === "fold") offFolds++;
      const on = brainDecide(mkBB([model]), "gto", mulberry32(1000 + i), {
        preflopRangeModeEnabled: false,
        showdownLearnEnabled: true,
      }).action.type;
      if (on === "call") onCalls++;
    }
    expect(offFolds / N).toBeGreaterThan(0.85);
    expect(onCalls / N).toBeGreaterThan(0.9);
  });

  it("旋钮回归：关闭 + 富亮牌 ≡ 开启 + 无亮牌（同 seed 逐比特）", () => {
    const rich = modelWithRing(1, weakLateRing(1));
    const fresh = modelWithRing(1, []);
    for (let seed = 1; seed <= 30; seed++) {
      const off = brainDecide(mkBB([rich]), "gto", mulberry32(seed), {
        preflopRangeModeEnabled: false,
        showdownLearnEnabled: false,
      });
      const noData = brainDecide(mkBB([fresh]), "gto", mulberry32(seed), {
        preflopRangeModeEnabled: false,
        showdownLearnEnabled: true,
      });
      expect(noData).toEqual(off);
    }
  });
});

describe("brain 摊牌学习接入：preflopRangeMode 口径（topPct 直接乘）", () => {
  // UTG（seat 3，behind 5 → 开局宽度档 0.2）加注，hero CO（seat 5）持 A3s：
  // vs 20% 范围胜率 0.401 < 0.45 → 弃牌；亮牌全弱 → 宽度 ×1.5 → 0.3 吸附 0.28 档
  // → 胜率 0.453 ≥ 0.45 → 跟注
  // 注意：preflopRangeModeEnabled 默认关闭（Phase 8 配对验收未过采纳线），
  // 本组用例显式开启；showdownLearnEnabled 同理显式（默认 false，见同报告）。
  const RANGE_ON = { preflopRangeModeEnabled: true, showdownLearnEnabled: true } as const;
  const mkCO = (models?: OpponentModel[]) => {
    const input = makeDecideInput({
      aiHole: ["As", "3s"], // A3s（同花）：vs 20% 档 0.401 < 0.45；vs 28% 档 0.453 ≥ 0.45
      playerCount: 6,
      aiSeat: 5,
      buttonSeat: 0,
      pot: 45,
      currentBet: 30,
      aiStack: 1000,
      callAmount: 30,
      legalActions: [
        { type: "fold", amount: 0 },
        { type: "call", amount: 30 },
        { type: "raise", amount: 60 },
        { type: "allin", amount: 1000 },
      ],
      style: "gto",
    });
    input.state.streetActions = [{ seat: 3, action: { type: "raise", amount: 30 } }];
    return models ? { ...input, opponentModels: models } : input;
  };
  const weakEarlyRing = (seat: Seat) =>
    Array.from({ length: 10 }, () => shown("early", "J4o", "open_raise", seat));

  it("UTG 亮牌全弱 → CO 跟注放宽；旋钮关闭恢复弃牌", () => {
    const model = modelWithRing(3, weakEarlyRing(3));
    const N = 100;
    let offFolds = 0;
    let onCalls = 0;
    for (let i = 0; i < N; i++) {
      const off = brainDecide(mkCO([model]), "gto", mulberry32(2000 + i), {
        ...RANGE_ON,
        showdownLearnEnabled: false,
      }).action.type;
      if (off === "fold") offFolds++;
      const on = brainDecide(mkCO([model]), "gto", mulberry32(2000 + i), RANGE_ON).action.type;
      if (on === "call") onCalls++;
    }
    expect(offFolds / N).toBeGreaterThan(0.85); // 仅 ~9% 诈唬 3bet 噪声
    expect(onCalls / N).toBeGreaterThan(0.9);
  });

  it("亮牌全强（0.9 微收）方向相反或不变：宽度 0.2×0.9=0.18 吸附 0.2 档（档位粒度内无变化）", () => {
    // 档位吸附的保守性：0.18 最近档仍是 0.2 → 决策不变（逐比特）
    const strongModel = modelWithRing(
      3,
      Array.from({ length: 10 }, () => shown("early", "AKs", "open_raise", 3)),
    );
    for (let seed = 1; seed <= 20; seed++) {
      const on = brainDecide(mkCO([strongModel]), "gto", mulberry32(seed), RANGE_ON);
      const off = brainDecide(mkCO([strongModel]), "gto", mulberry32(seed), {
        ...RANGE_ON,
        showdownLearnEnabled: false,
      });
      expect(on).toEqual(off);
    }
  });
});

describe("brain 旋钮回归：翻后面注（blocker + 摊牌学习）", () => {
  // hero JdTc（无 A 无对子 → blocker 均匀池），对手模型无亮牌 → 两旋钮开启 ≡ 关闭
  const mk = (models?: OpponentModel[]) => {
    const input = makeDecideInput({
      aiHole: ["Jd", "Tc"],
      board: ["Kh", "8d", "2c"],
      street: "flop",
      pot: 100,
      currentBet: 25,
      aiStack: 300,
      callAmount: 25,
      legalActions: [
        { type: "fold", amount: 0 },
        { type: "call", amount: 25 },
        { type: "raise", amount: 50 },
        { type: "allin", amount: 300 },
      ],
      style: "gto",
    });
    input.state.streetActions = [{ seat: 0, action: { type: "bet", amount: 25 } }];
    return models ? { ...input, opponentModels: models } : input;
  };

  it("无亮牌数据且 hero 无 blocker 命中：显式开启与显式关闭逐比特一致", () => {
    const plain = modelWithRing(0, []);
    const ON = { showdownLearnEnabled: true, blockerEnabled: true } as const;
    resetBrainCaches();
    brainDecide(mk([plain]), "gto", mulberry32(1), ON); // 预热 equity 缓存（MC 用 Math.random）
    for (let seed = 1; seed <= 20; seed++) {
      const on = brainDecide(mk([plain]), "gto", mulberry32(seed), ON);
      const off = brainDecide(mk([plain]), "gto", mulberry32(seed), {
        showdownLearnEnabled: false,
        blockerEnabled: false,
      });
      expect(off).toEqual(on);
    }
  });
});
