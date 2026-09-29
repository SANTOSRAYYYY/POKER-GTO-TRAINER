/**
 * adapt.ts（对手建模与剥削性调整）测试 + brain.ts 剥削接入集成测试
 *
 * - updateStats：VPIP/PFR/AF/WTSD 计数语义（盲注不算 VPIP、limp 算 VPIP 不算 PFR、
 *   fold 不算、同手多次自愿投钱只算一次、allin 按下注线归类）+ 位置分桶计数
 * - 近因加权：λ 衰减数值、λ=1 退化为整数旧口径、confidence 用有效样本量
 * - classify / classifyPositional：样本不足 unknown；5 种分类阈值；桶校正
 *  （后位松前位紧不再误判为全面松）；confidence 10 手 0.3 → 40 手 1.0
 * - adjustments：各剥削规则、confidence 加权聚合、零置信度恒等、
 *   位置敏感剥削（偷盲狂盲位放宽 / maniac 前位收紧 / 旋钮关闭归零）
 * - brain 集成：对 calling_station 诈唬率骤降、对 nit 后位开局放宽、
 *   facingRaiseDelta 接入（盲位防守放宽 / maniac 前位收紧 / 旋钮关闭）、
 *   无模型/unknown 模型时行为与接入前逐比特一致（回归）
 */
import { afterEach, describe, expect, it } from "vitest";
import type {
  ActionType,
  Card,
  HandRecord,
  OpponentClass,
  OpponentModel,
  OpponentStats,
  PlayerAction,
  Seat,
  SeatAction,
  StreetRecord,
} from "@/lib/types";
import {
  adjustments,
  bucketOfPreflop,
  bucketVpip,
  buildModel,
  classify,
  classifyPositional,
  correctedVpip,
  createOpponentStats,
  DEFAULT_RECENCY_LAMBDA,
  IDENTITY_ADJUSTMENT,
  setAdaptRecencyLambda,
  updateStats,
  type AdjustmentContext,
} from "../adapt";
import { brainDecide } from "../brain";
import { buildPrompt } from "../prompt";
import { makeDecideInput } from "./helpers";

// 本文件按需显式设置 λ；每个用例结束后恢复默认，避免污染其他测试文件
afterEach(() => {
  setAdaptRecencyLambda(DEFAULT_RECENCY_LAMBDA);
});

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function sa(seat: Seat, type: ActionType, amount = 0): SeatAction {
  return { seat, action: { type, amount } };
}

function makeRecord(opts: {
  seats: Seat[];
  streets: StreetRecord[];
  showdown?: boolean;
  bigBlind?: number;
  buttonSeat?: Seat;
}): HandRecord {
  const bb = opts.bigBlind ?? 10;
  return {
    id: "test-hand",
    timestamp: 0,
    players: opts.seats.map((seat) => ({
      seat,
      isHero: seat === 0,
      aiStyle: seat === 0 ? null : "tag",
      cards: null,
      profit: 0,
    })),
    heroSeat: 0,
    buttonSeat: opts.buttonSeat ?? 0,
    smallBlind: bb / 2,
    bigBlind: bb,
    ante: 0,
    streets: opts.streets,
    finalBoard: [],
    result: "tie",
    profit: 0,
    showdown: opts.showdown ?? false,
  };
}

function makeStats(over: Partial<OpponentStats>): OpponentStats {
  return { ...createOpponentStats(1), ...over };
}

/** 直接指定 cls/confidence 的模型（adjustments() 单元测试用，不经 brain 重分类） */
function makeModel(
  seat: Seat,
  cls: OpponentClass,
  confidence: number,
): OpponentModel {
  return {
    seat,
    stats: createOpponentStats(seat),
    vpip: 0,
    pfr: 0,
    af: 0,
    wtsd: 0,
    cls,
    confidence,
  };
}

/**
 * 与目标分类一致的统计量（hands=40 → 满置信度；分桶为零 → 桶校正回退总体口径，
 * classify 与 classifyPositional 结果一致）。brain 集成测试用：默认
 * adaptPositionalEnabled 会对模型重分类，stats 必须能推出目标 cls。
 */
function statsForCls(cls: OpponentClass, seat: Seat): OpponentStats {
  switch (cls) {
    case "nit": // vpip 0.125 < 0.2，af 0.5 < 1.5
      return makeStats({ seat, hands: 40, vpipHands: 5, pfrHands: 4, postflopAggressive: 3, postflopPassive: 6 });
    case "lag": // vpip 0.35 ∈ [0.25,0.45]，af 3 > 2
      return makeStats({ seat, hands: 40, vpipHands: 14, pfrHands: 10, postflopAggressive: 9, postflopPassive: 3 });
    case "maniac": // vpip 0.55 > 0.4，af 5 > 2.5
      return makeStats({ seat, hands: 40, vpipHands: 22, pfrHands: 16, postflopAggressive: 15, postflopPassive: 3 });
    case "calling_station": // vpip 0.5 > 0.45，af 0.25 < 1
      return makeStats({ seat, hands: 40, vpipHands: 20, pfrHands: 2, postflopAggressive: 2, postflopPassive: 8 });
    case "tag": // vpip 0.25，af 1 → 中庸
      return makeStats({ seat, hands: 40, vpipHands: 10, pfrHands: 7, postflopAggressive: 5, postflopPassive: 5 });
    default:
      return createOpponentStats(seat);
  }
}

/** stats 支撑的真实画像模型（buildModel 输出；brain 重分类路径安全） */
function modelForCls(seat: Seat, cls: OpponentClass): OpponentModel {
  return buildModel(statsForCls(cls, seat));
}

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
// updateStats
// ---------------------------------------------------------------------------

describe("updateStats 翻前 VPIP/PFR 计数", () => {
  it("limp 算 VPIP 不算 PFR；加注算两者；fold 不算；同手多次投钱只算一次", () => {
    // 6 人桌（按钮 0）：SB1 BB2 UTG3 HJ4 CO5
    const record = makeRecord({
      seats: [0, 1, 2, 3, 4, 5],
      streets: [
        {
          street: "preflop",
          board: [],
          actions: [
            sa(3, "fold"), // UTG 弃牌
            sa(4, "call", 10), // HJ limp
            sa(5, "raise", 30), // CO 加注
            sa(0, "fold"),
            sa(1, "call", 25), // SB 跟注
            sa(2, "call", 20), // BB 跟注
            sa(4, "call", 20), // HJ limp 后再跟加注：仍只算 1 次 VPIP
          ],
        },
      ],
    });
    const at = (seat: Seat) =>
      updateStats(createOpponentStats(seat), record, seat);
    expect(at(3)).toMatchObject({ hands: 1, vpipHands: 0, pfrHands: 0 });
    expect(at(4)).toMatchObject({ hands: 1, vpipHands: 1, pfrHands: 0 });
    expect(at(5)).toMatchObject({ hands: 1, vpipHands: 1, pfrHands: 1 });
    expect(at(0)).toMatchObject({ hands: 1, vpipHands: 0, pfrHands: 0 });
    expect(at(1)).toMatchObject({ hands: 1, vpipHands: 1, pfrHands: 0 });
    expect(at(2)).toMatchObject({ hands: 1, vpipHands: 1, pfrHands: 0 });
  });

  it("盲注不算 VPIP：全员弃牌到大盲 / 未加注时大盲 check", () => {
    // 全员弃牌：大盲无任何动作记录（盲注是强制投入且不产生动作）
    const walk = makeRecord({
      seats: [0, 1, 2],
      streets: [
        {
          street: "preflop",
          board: [],
          actions: [sa(0, "fold"), sa(1, "fold")],
        },
      ],
    });
    expect(updateStats(createOpponentStats(2), walk, 2)).toMatchObject({
      hands: 1,
      vpipHands: 0,
    });

    // 按钮 limp、小盲补全、大盲 check：check 不算自愿投钱
    const limped = makeRecord({
      seats: [0, 1, 2],
      streets: [
        {
          street: "preflop",
          board: [],
          actions: [sa(0, "call", 10), sa(1, "call", 5), sa(2, "check")],
        },
      ],
    });
    expect(updateStats(createOpponentStats(0), limped, 0).vpipHands).toBe(1);
    expect(updateStats(createOpponentStats(1), limped, 1).vpipHands).toBe(1);
    expect(updateStats(createOpponentStats(2), limped, 2)).toMatchObject({
      vpipHands: 0,
      pfrHands: 0,
    });
  });

  it("翻前 allin 按下注线归类：抬高下注线算 PFR，否则只算 VPIP", () => {
    const record = makeRecord({
      seats: [0, 1, 2],
      streets: [
        {
          street: "preflop",
          board: [],
          actions: [
            sa(0, "raise", 30),
            sa(1, "allin", 100), // 抬高下注线（>30）→ PFR
            sa(2, "allin", 20), // 未抬高（<30，短码跟注性全下）→ 仅 VPIP
            sa(0, "call", 70),
          ],
        },
      ],
    });
    expect(updateStats(createOpponentStats(1), record, 1)).toMatchObject({
      vpipHands: 1,
      pfrHands: 1,
    });
    expect(updateStats(createOpponentStats(2), record, 2)).toMatchObject({
      vpipHands: 1,
      pfrHands: 0,
    });
  });

  it("该座位未参与本手时原样返回", () => {
    const record = makeRecord({
      seats: [0, 1],
      streets: [{ street: "preflop", board: [], actions: [sa(0, "fold")] }],
    });
    const stats = createOpponentStats(7);
    expect(updateStats(stats, record, 7)).toBe(stats);
  });
});

describe("updateStats 翻后 AF 与 WTSD", () => {
  it("AF：bet/raise 记进攻、call 记被动；allin 按下注线归类（按动作次数）", () => {
    const record = makeRecord({
      seats: [0, 1],
      showdown: true,
      streets: [
        {
          street: "preflop",
          board: [],
          actions: [sa(0, "call", 10), sa(1, "check")],
        },
        {
          street: "flop",
          board: ["As", "Kd", "7c"],
          actions: [sa(1, "bet", 20), sa(0, "call", 20)],
        },
        {
          street: "turn",
          board: ["As", "Kd", "7c", "3h"],
          actions: [sa(1, "bet", 40), sa(0, "allin", 80), sa(1, "call", 40)],
        },
        {
          street: "river",
          board: ["As", "Kd", "7c", "3h", "9s"],
          actions: [sa(1, "bet", 50), sa(0, "allin", 30)], // 短码跟注性全下
        },
      ],
    });
    // seat1：flop/turn/river 三次 bet = 3 次进攻；turn 跟 allin = 1 次被动
    expect(updateStats(createOpponentStats(1), record, 1)).toMatchObject({
      postflopAggressive: 3,
      postflopPassive: 1,
    });
    // seat0：flop call = 1 被动；turn 加注性 allin = 1 进攻；river 跟注性 allin = 1 被动
    expect(updateStats(createOpponentStats(0), record, 0)).toMatchObject({
      postflopAggressive: 1,
      postflopPassive: 2,
    });
  });

  it("WTSD：看到翻牌且打到摊牌才记分子；翻前弃牌/未到翻牌不计分母", () => {
    // seat1 翻前弃牌；seat0/seat2 打到摊牌
    const sd = makeRecord({
      seats: [0, 1, 2],
      showdown: true,
      streets: [
        {
          street: "preflop",
          board: [],
          actions: [sa(1, "fold"), sa(0, "call", 10), sa(2, "check")],
        },
        {
          street: "flop",
          board: ["As", "Kd", "7c"],
          actions: [sa(2, "check"), sa(0, "check")],
        },
      ],
    });
    expect(updateStats(createOpponentStats(0), sd, 0)).toMatchObject({
      showdownsSeenFlop: 1,
      showdowns: 1,
    });
    expect(updateStats(createOpponentStats(2), sd, 2)).toMatchObject({
      showdownsSeenFlop: 1,
      showdowns: 1,
    });
    expect(updateStats(createOpponentStats(1), sd, 1)).toMatchObject({
      showdownsSeenFlop: 0,
      showdowns: 0,
    });

    // 本手翻前结束：无人看到翻牌
    const preEnd = makeRecord({
      seats: [0, 1],
      streets: [
        {
          street: "preflop",
          board: [],
          actions: [sa(0, "raise", 30), sa(1, "fold")],
        },
      ],
    });
    expect(updateStats(createOpponentStats(0), preEnd, 0)).toMatchObject({
      showdownsSeenFlop: 0,
      showdowns: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// classify / confidence / buildModel
// ---------------------------------------------------------------------------

describe("classify 分类与置信度", () => {
  it("样本不足（<10 手）：unknown 且 confidence 为 0", () => {
    for (const hands of [0, 5, 9]) {
      const r = classify(makeStats({ hands, vpipHands: hands, postflopAggressive: 9 }));
      expect(r.cls).toBe("unknown");
      expect(r.confidence).toBe(0);
    }
  });

  it("五种分类阈值（20 手样本）", () => {
    // nit：VPIP 0.15 < 0.2 且 AF 0.5 < 1.5
    expect(
      classify(makeStats({ hands: 20, vpipHands: 3, postflopAggressive: 2, postflopPassive: 4 })).cls,
    ).toBe("nit");
    // calling_station：VPIP 0.5 > 0.45 且 AF 0.5 < 1
    expect(
      classify(makeStats({ hands: 20, vpipHands: 10, postflopAggressive: 2, postflopPassive: 4 })).cls,
    ).toBe("calling_station");
    // maniac：VPIP 0.45 > 0.4 且 AF 5 > 2.5
    expect(
      classify(makeStats({ hands: 20, vpipHands: 9, postflopAggressive: 15, postflopPassive: 3 })).cls,
    ).toBe("maniac");
    // lag：VPIP 0.35 ∈ [0.25,0.45] 且 AF 2.25 > 2
    expect(
      classify(makeStats({ hands: 20, vpipHands: 7, postflopAggressive: 9, postflopPassive: 4 })).cls,
    ).toBe("lag");
    // tag：VPIP 0.3 但 AF 1.0 ≤ 2 → 中庸归 tag
    expect(
      classify(makeStats({ hands: 20, vpipHands: 6, postflopAggressive: 3, postflopPassive: 3 })).cls,
    ).toBe("tag");
  });

  it("confidence 从 10 手 0.3 线性升到 40 手 1.0，之后保持 1.0", () => {
    const base = { vpipHands: 0, postflopAggressive: 0, postflopPassive: 1 };
    expect(classify(makeStats({ ...base, hands: 10 })).confidence).toBeCloseTo(0.3, 10);
    expect(classify(makeStats({ ...base, hands: 25 })).confidence).toBeCloseTo(0.65, 10);
    expect(classify(makeStats({ ...base, hands: 40 })).confidence).toBe(1);
    expect(classify(makeStats({ ...base, hands: 100 })).confidence).toBe(1);
  });

  it("buildModel 衍生指标口径：VPIP/PFR 按手、AF 分母至少 1、WTSD 按见过翻牌的手", () => {
    const m = buildModel(
      makeStats({
        hands: 20,
        vpipHands: 10,
        pfrHands: 4,
        postflopAggressive: 6,
        postflopPassive: 3,
        showdowns: 5,
        showdownsSeenFlop: 12,
      }),
    );
    expect(m.vpip).toBeCloseTo(0.5, 10);
    expect(m.pfr).toBeCloseTo(0.2, 10);
    expect(m.af).toBeCloseTo(2, 10);
    expect(m.wtsd).toBeCloseTo(5 / 12, 10);
    // 无翻后动作样本：AF = 0/max(1,0) = 0，不除零
    expect(buildModel(makeStats({ hands: 20 })).af).toBe(0);
    expect(buildModel(makeStats({ hands: 20 })).wtsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// adjustments
// ---------------------------------------------------------------------------

const CTX: AdjustmentContext = { isPreflop: true, position: "CO", activeOpponents: 1 };

describe("adjustments 剥削规则聚合", () => {
  it("对 calling_station：诈唬 ×0.25、价值下注门槛 -5%", () => {
    const adj = adjustments([makeModel(2, "calling_station", 1)], CTX);
    expect(adj.bluffMult).toBeCloseTo(0.25, 10);
    expect(adj.valueBetDelta).toBeCloseTo(-0.05, 10);
    expect(adj.callMarginDelta).toBe(0);
    expect(adj.openRangeShift).toBe(0);
  });

  it("对 nit：诈唬 ×1.5；翻前后位开局放宽一档", () => {
    const adj = adjustments([makeModel(2, "nit", 1)], CTX);
    expect(adj.bluffMult).toBeCloseTo(1.5, 10);
    expect(adj.openRangeShift).toBeCloseTo(-1, 10);
  });

  it("对 nit 的放宽只在翻前后位生效：前位/翻后不移档", () => {
    const early = adjustments([makeModel(2, "nit", 1)], { ...CTX, position: "UTG" });
    expect(early.openRangeShift).toBe(0);
    expect(early.bluffMult).toBeCloseTo(1.5, 10);
    const post = adjustments([makeModel(2, "nit", 1)], { ...CTX, isPreflop: false });
    expect(post.openRangeShift).toBe(0);
  });

  it("对 maniac：跟注边际 -4%、诈唬 ×0.5、价值门槛 -3%", () => {
    const adj = adjustments([makeModel(2, "maniac", 1)], CTX);
    expect(adj.callMarginDelta).toBeCloseTo(-0.04, 10);
    expect(adj.bluffMult).toBeCloseTo(0.5, 10);
    expect(adj.valueBetDelta).toBeCloseTo(-0.03, 10);
  });

  it("对 lag：跟注边际 -2%；tag 零修正", () => {
    expect(
      adjustments([makeModel(2, "lag", 1)], CTX).callMarginDelta,
    ).toBeCloseTo(-0.02, 10);
    expect(adjustments([makeModel(2, "tag", 1)], CTX)).toEqual(IDENTITY_ADJUSTMENT);
  });

  it("confidence=0 / unknown / 空列表 → 恒等修正（单例）", () => {
    expect(adjustments([], CTX)).toBe(IDENTITY_ADJUSTMENT);
    expect(adjustments([makeModel(2, "nit", 0)], CTX)).toBe(IDENTITY_ADJUSTMENT);
    expect(adjustments([makeModel(2, "unknown", 0.5)], CTX)).toBe(IDENTITY_ADJUSTMENT);
  });

  it("多对手按 confidence 加权平均（station 满置信 + nit 半置信）", () => {
    const adj = adjustments(
      [makeModel(2, "calling_station", 1), makeModel(3, "nit", 0.5)],
      CTX,
    );
    // bluffMult = (1×0.25 + 0.5×1.5) / 1.5 = 2/3
    expect(adj.bluffMult).toBeCloseTo(2 / 3, 10);
    // valueBetDelta = (1×-0.05 + 0) / 1.5
    expect(adj.valueBetDelta).toBeCloseTo(-0.05 / 1.5, 10);
    // openRangeShift = (0.5×-1) / 1.5 = -1/3
    expect(adj.openRangeShift).toBeCloseTo(-1 / 3, 10);
  });
});

// ---------------------------------------------------------------------------
// 位置分桶计数（Phase 6）
// ---------------------------------------------------------------------------

describe("updateStats 位置分桶计数", () => {
  it("分桶口径：early=身后≥5 / middle=2-4 / late≤1；单挑全归 late", () => {
    // 6 人桌按钮 0：SB1 BB2 UTG3 HJ4 CO5
    expect(bucketOfPreflop(3, 0, 6)).toBe("early"); // UTG 身后 5
    expect(bucketOfPreflop(4, 0, 6)).toBe("middle"); // HJ 身后 4
    expect(bucketOfPreflop(5, 0, 6)).toBe("middle"); // CO 身后 3
    expect(bucketOfPreflop(0, 0, 6)).toBe("middle"); // BTN 身后 2
    expect(bucketOfPreflop(1, 0, 6)).toBe("late"); // SB 身后 1
    expect(bucketOfPreflop(2, 0, 6)).toBe("late"); // BB 身后 0
    // 9 人桌：UTG..LJ（身后 ≥5）→ early；HJ（身后 4）→ middle
    expect(bucketOfPreflop(3, 0, 9)).toBe("early");
    expect(bucketOfPreflop(6, 0, 9)).toBe("early");
    expect(bucketOfPreflop(7, 0, 9)).toBe("middle");
    // 单挑特殊处理：按钮（先动）与大盲都归 late
    expect(bucketOfPreflop(0, 0, 2)).toBe("late");
    expect(bucketOfPreflop(1, 0, 2)).toBe("late");
    // 3 人桌：UTG 环绕回按钮（BTN 身后 2 → middle；SB/BB → late）
    expect(bucketOfPreflop(0, 0, 3)).toBe("middle");
    expect(bucketOfPreflop(1, 0, 3)).toBe("late");
    expect(bucketOfPreflop(2, 0, 3)).toBe("late");
  });

  it("VPIP/PFR 按桶拆开累积，总量口径保持兼容", () => {
    // 按钮 0 的 6 人桌：UTG(3) fold、HJ(4) limp、CO(5) raise、BTN(0) fold、SB(1) call、BB(2) call
    const record = makeRecord({
      seats: [0, 1, 2, 3, 4, 5],
      buttonSeat: 0,
      streets: [
        {
          street: "preflop",
          board: [],
          actions: [
            sa(3, "fold"),
            sa(4, "call", 10),
            sa(5, "raise", 30),
            sa(0, "fold"),
            sa(1, "call", 25),
            sa(2, "call", 20),
          ],
        },
      ],
    });
    const at = (seat: Seat) => updateStats(createOpponentStats(seat), record, seat);
    // UTG → early 桶：样本 +1，无 VPIP
    expect(at(3)).toMatchObject({
      pfBucketHands: { early: 1, middle: 0, late: 0 },
      pfBucketVpip: { early: 0, middle: 0, late: 0 },
    });
    // HJ → middle 桶 limp（VPIP 无 PFR）
    expect(at(4)).toMatchObject({
      pfBucketHands: { early: 0, middle: 1, late: 0 },
      pfBucketVpip: { early: 0, middle: 1, late: 0 },
      pfBucketPfr: { early: 0, middle: 0, late: 0 },
    });
    // CO → middle 桶加注（VPIP+PFR）
    expect(at(5)).toMatchObject({
      pfBucketVpip: { early: 0, middle: 1, late: 0 },
      pfBucketPfr: { early: 0, middle: 1, late: 0 },
    });
    // SB/BB → late 桶跟注
    expect(at(1)).toMatchObject({
      pfBucketHands: { early: 0, middle: 0, late: 1 },
      pfBucketVpip: { early: 0, middle: 0, late: 1 },
    });
    expect(at(2)).toMatchObject({
      pfBucketVpip: { early: 0, middle: 0, late: 1 },
      pfBucketPfr: { early: 0, middle: 0, late: 0 },
    });
    // 总量口径不变
    expect(at(5)).toMatchObject({ hands: 1, vpipHands: 1, pfrHands: 1 });
  });

  it("旧版无分桶字段的 stats 对象：归一化后继续累积不炸", () => {
    const legacy = {
      seat: 1, hands: 5, vpipHands: 2, pfrHands: 1,
      postflopAggressive: 1, postflopPassive: 2, showdowns: 1, showdownsSeenFlop: 3,
    } as unknown as OpponentStats;
    const record = makeRecord({
      seats: [0, 1],
      streets: [{ street: "preflop", board: [], actions: [sa(0, "call", 10), sa(1, "check")] }],
    });
    const next = updateStats(legacy, record, 1);
    expect(next.hands).toBeCloseTo(5 * DEFAULT_RECENCY_LAMBDA + 1, 10);
    expect(next.pfBucketHands.late).toBe(1); // 单挑归 late 桶
  });
});

// ---------------------------------------------------------------------------
// 近因加权（recency weighting）
// ---------------------------------------------------------------------------

describe("updateStats 近因加权", () => {
  const limpHand = () =>
    makeRecord({
      seats: [0, 1],
      streets: [
        { street: "preflop", board: [], actions: [sa(0, "call", 10), sa(1, "check")] },
      ],
    });

  it("λ=0.5：每手更新前旧计数减半（hands/vpipHands: 1 → 1.5 → 1.75）", () => {
    setAdaptRecencyLambda(0.5);
    let s = createOpponentStats(0);
    s = updateStats(s, limpHand(), 0);
    expect(s.hands).toBe(1);
    expect(s.vpipHands).toBe(1);
    s = updateStats(s, limpHand(), 0);
    expect(s.hands).toBe(1.5);
    expect(s.vpipHands).toBe(1.5);
    s = updateStats(s, limpHand(), 0);
    expect(s.hands).toBe(1.75);
    // 分桶同步衰减（单挑归 late）
    expect(s.pfBucketHands.late).toBe(1.75);
    expect(s.pfBucketVpip).toMatchObject({ late: 1.75 });
    // 未 VPIP 的座位：vpipHands 恒 0
    let s1 = createOpponentStats(1);
    s1 = updateStats(s1, limpHand(), 1);
    expect(s1.hands).toBe(1);
    expect(s1.vpipHands).toBe(0);
  });

  it("λ=1.0：关闭近因加权，退化为整数累加旧口径", () => {
    setAdaptRecencyLambda(1);
    let s = createOpponentStats(0);
    for (let i = 0; i < 3; i++) s = updateStats(s, limpHand(), 0);
    expect(s.hands).toBe(3);
    expect(s.vpipHands).toBe(3);
    expect(s.pfBucketHands.late).toBe(3);
  });

  it("confidence 用衰减后的有效样本量：λ=0.9 打 13 手仍未达 10 手门槛", () => {
    setAdaptRecencyLambda(0.9);
    let s = createOpponentStats(0);
    for (let i = 0; i < 13; i++) s = updateStats(s, limpHand(), 0);
    // 有效样本 = (1-0.9^13)/0.1 ≈ 7.46 < 10 → unknown / confidence 0
    expect(s.hands).toBeLessThan(10);
    expect(classify(s).confidence).toBe(0);
    // λ=1 对照：13 个真实手 → confidence > 0
    setAdaptRecencyLambda(1);
    let s2 = createOpponentStats(0);
    for (let i = 0; i < 13; i++) s2 = updateStats(s2, limpHand(), 0);
    expect(s2.hands).toBe(13);
    expect(classify(s2).confidence).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// classifyPositional 位置桶校正
// ---------------------------------------------------------------------------

describe("classifyPositional 位置桶校正", () => {
  it("后位松 + 前位紧不再误判为跟注站（总体口径会误判）", () => {
    // 40 手：early 2/12（≈17%）、middle 5/14（≈36%）、late 13/14（≈93%）
    const s = makeStats({
      hands: 40,
      vpipHands: 20,
      postflopAggressive: 2,
      postflopPassive: 8,
      pfBucketHands: { early: 12, middle: 14, late: 14 },
      pfBucketVpip: { early: 2, middle: 5, late: 13 },
      pfBucketPfr: { early: 1, middle: 3, late: 5 },
    });
    // 总体口径：VPIP 0.5 > 0.45 且 AF 0.25 < 1 → calling_station
    expect(classify(s).cls).toBe("calling_station");
    // 桶校正：超额 ≈ 12×(−0.003)+14×(+0.057)+14×(+0.429) ≈ +0.169
    // corrected ≈ 0.28 + 0.169 = 0.449 < 0.45 → tag（不再误判）
    expect(correctedVpip(s)).toBeCloseTo(0.449, 2);
    expect(classifyPositional(s).cls).toBe("tag");
  });

  it("全面真松不会被桶校正救回：early 也松 → 仍判 calling_station", () => {
    const s = makeStats({
      hands: 40,
      vpipHands: 24,
      postflopAggressive: 2,
      postflopPassive: 8,
      pfBucketHands: { early: 12, middle: 14, late: 14 },
      pfBucketVpip: { early: 5, middle: 7, late: 12 },
      pfBucketPfr: { early: 1, middle: 2, late: 3 },
    });
    expect(classify(s).cls).toBe("calling_station");
    expect(classifyPositional(s).cls).toBe("calling_station");
  });

  it("分桶样本不足时回退总体口径（与 classify 一致）", () => {
    const s = makeStats({
      hands: 40,
      vpipHands: 20,
      postflopAggressive: 2,
      postflopPassive: 8,
    });
    expect(correctedVpip(s)).toBeCloseTo(0.5, 10);
    expect(classifyPositional(s).cls).toBe(classify(s).cls);
  });

  it("bucketVpip：无样本桶为 null", () => {
    const s = makeStats({
      hands: 10,
      pfBucketHands: { early: 0, middle: 6, late: 4 },
      pfBucketVpip: { early: 0, middle: 2, late: 3 },
    });
    expect(bucketVpip(s)).toEqual({ early: null, middle: 1 / 3, late: 0.75 });
    expect(buildModel(s).bucketVpip).toEqual({ early: null, middle: 1 / 3, late: 0.75 });
  });
});

// ---------------------------------------------------------------------------
// adjustments 位置敏感剥削（Phase 6）
// ---------------------------------------------------------------------------

describe("adjustments 位置敏感剥削", () => {
  // 偷盲狂加注者：40 手满置信 tag，late 桶 VPIP 10/14 ≈ 0.714 > 0.5 + 0.15
  const stealHeavy = () =>
    buildModel(
      makeStats({
        seat: 2,
        hands: 40,
        vpipHands: 17,
        pfrHands: 12,
        postflopAggressive: 5,
        postflopPassive: 5,
        pfBucketHands: { early: 12, middle: 14, late: 14 },
        pfBucketVpip: { early: 2, middle: 5, late: 10 },
        pfBucketPfr: { early: 1, middle: 3, late: 6 },
      }),
    );
  const BB_CTX: AdjustmentContext = {
    isPreflop: true,
    position: "BB",
    activeOpponents: 1,
    positionalEnabled: true,
    raiser: { seat: 2, behind: 1 },
  };

  it("加注者 late 桶偷盲频率超基线 → 盲位防守放宽（facingRaiseDelta 负向）", () => {
    expect(adjustments([stealHeavy()], BB_CTX).facingRaiseDelta).toBeCloseTo(-0.04, 10);
  });

  it("旋钮关闭（positionalEnabled false/缺省）→ 零修正", () => {
    expect(
      adjustments([stealHeavy()], { ...BB_CTX, positionalEnabled: false }).facingRaiseDelta,
    ).toBe(0);
    const noFlag: AdjustmentContext = {
      isPreflop: true, position: "BB", activeOpponents: 1, raiser: { seat: 2, behind: 1 },
    };
    expect(adjustments([stealHeavy()], noFlag).facingRaiseDelta).toBe(0);
  });

  it("late 桶 VPIP 正常（= 基线）→ 不放宽", () => {
    const normal = buildModel(
      makeStats({
        seat: 2,
        hands: 40,
        vpipHands: 12,
        pfrHands: 8,
        postflopAggressive: 5,
        postflopPassive: 5,
        pfBucketHands: { early: 12, middle: 14, late: 14 },
        pfBucketVpip: { early: 2, middle: 3, late: 7 }, // late 0.5 = 基线
        pfBucketPfr: { early: 1, middle: 2, late: 4 },
      }),
    );
    expect(adjustments([normal], BB_CTX).facingRaiseDelta).toBe(0);
  });

  it("raiser 不在模型列表中 → 零修正", () => {
    expect(
      adjustments([stealHeavy()], { ...BB_CTX, raiser: { seat: 9, behind: 1 } }).facingRaiseDelta,
    ).toBe(0);
  });

  it("maniac 在 early 位加注 → 收紧给尊重（正向）", () => {
    const adj = adjustments([modelForCls(3, "maniac")], {
      isPreflop: true,
      position: "CO",
      activeOpponents: 1,
      positionalEnabled: true,
      raiser: { seat: 3, behind: 5 },
    });
    expect(adj.facingRaiseDelta).toBeCloseTo(0.04, 10);
  });

  it("maniac 在 late 位加注 → 不触发尊重（只进常规 maniac 修正）", () => {
    const adj = adjustments([modelForCls(3, "maniac")], {
      isPreflop: true,
      position: "BB",
      activeOpponents: 1,
      positionalEnabled: true,
      raiser: { seat: 3, behind: 1 },
    });
    expect(adj.facingRaiseDelta).toBe(0);
    expect(adj.callMarginDelta).toBeCloseTo(-0.04, 10); // 常规 maniac 修正不受影响
  });

  it("置信度缩放：半置信偷盲狂 → 放宽量减半", () => {
    const half: OpponentModel = { ...stealHeavy(), confidence: 0.5 };
    expect(adjustments([half], BB_CTX).facingRaiseDelta).toBeCloseTo(-0.02, 10);
  });
});

// ---------------------------------------------------------------------------
// brain.ts 剥削接入集成
// ---------------------------------------------------------------------------

/** 翻后纯诈唬场景：72o 在 KsQhJd 翻牌、无人下注（tag） */
function bluffScenario(models?: OpponentModel[]) {
  const input = makeDecideInput({
    aiHole: ["7d", "2c"],
    board: ["Ks", "Qh", "Jd"],
    street: "flop",
    pot: 100,
    aiStack: 300,
    callAmount: 0,
    legalActions: [
      { type: "check", amount: 0 },
      { type: "bet", amount: 10 },
      { type: "allin", amount: 300 },
    ],
    style: "tag",
  });
  return models ? { ...input, opponentModels: models } : input;
}

describe("brain 剥削接入：对 calling_station 诈唬骤降", () => {
  it("同一局面：station 模型的诈唬率显著低于 unknown/无模型", () => {
    const N = 600;
    const rate = (models?: OpponentModel[]) => {
      let bets = 0;
      const input = bluffScenario(models);
      for (let i = 0; i < N; i++) {
        const t = brainDecide(input, "tag").action.type;
        if (t === "bet" || t === "allin") bets++;
      }
      return bets / N;
    };
    const base = rate(); // 无模型（回归基线 ≈ 0.2×0.6 = 12%）
    const unknown = rate([makeModel(0, "unknown", 0)]);
    const station = rate([modelForCls(0, "calling_station")]); // ×0.25 → ≈3%
    expect(base).toBeGreaterThan(0.06);
    expect(unknown).toBeGreaterThan(0.06);
    expect(station).toBeLessThan(base / 2);
    expect(station).toBeLessThan(0.08);
  });
});

describe("brain 剥削接入：对 nit 后位开局放宽", () => {
  // 6 人桌 CO 位（按钮 0、座位 5）K4s：CO 表弃牌、BTN 表开局
  const mk = (models?: OpponentModel[]) => {
    const input = makeDecideInput({
      aiHole: ["Kh", "4h"],
      playerCount: 6,
      aiSeat: 5,
      buttonSeat: 0,
      pot: 15,
      currentBet: 10,
      aiStack: 1000,
      callAmount: 10,
      legalActions: [
        { type: "fold", amount: 0 },
        { type: "call", amount: 10 },
        { type: "raise", amount: 20 },
        { type: "allin", amount: 1000 },
      ],
      style: "tag",
    });
    return models ? { ...input, opponentModels: models } : input;
  };
  const NIT_TABLE = [0, 1, 2, 3, 4].map((s) => modelForCls(s, "nit"));
  const STATION_TABLE = [0, 1, 2, 3, 4].map((s) => modelForCls(s, "calling_station"));

  it("无模型：K4s 在 CO 表 100% 弃牌（回归基线）", () => {
    for (let i = 0; i < 30; i++) {
      expect(brainDecide(mk(), "tag").action.type).toBe("fold");
    }
  });

  it("全桌 nit 模型（满置信）：放宽一档用 BTN 表，K4s 转为开局加注", () => {
    let raises = 0;
    for (let i = 0; i < 30; i++) {
      const t = brainDecide(mk(NIT_TABLE), "tag").action.type;
      if (t === "raise" || t === "allin") raises++;
    }
    expect(raises / 30).toBeGreaterThan(0.95);
  });

  it("全桌 station 模型：不放宽范围（诈唬型剥削≠范围剥削），仍弃牌", () => {
    for (let i = 0; i < 30; i++) {
      expect(brainDecide(mk(STATION_TABLE), "tag").action.type).toBe("fold");
    }
  });
});

describe("brain 剥削接入：位置敏感 facingRaiseDelta", () => {
  // 本组针对旧百分位口径（facingRaiseDelta 叠加到 callVsRaisePct/value3betPct）；
  // 范围口径（preflopRangeModeEnabled）下同量叠加到对范围胜率门槛，机制一致，
  // 此处锁 LEGACY 做回归锚点。
  const LEGACY = { preflopRangeModeEnabled: false } as const;
  // 偷盲狂模型（seat 1）：40 手满置信 tag，late 桶 VPIP 10/14 ≈ 0.714 超基线
  const stealModel = () =>
    buildModel(
      makeStats({
        seat: 1,
        hands: 40,
        vpipHands: 17,
        pfrHands: 12,
        postflopAggressive: 5,
        postflopPassive: 5,
        pfBucketHands: { early: 12, middle: 14, late: 14 },
        pfBucketVpip: { early: 2, middle: 5, late: 10 },
        pfBucketPfr: { early: 1, middle: 3, late: 6 },
      }),
    );

  // 场景 A：6 人桌，SB（seat 1）开局加注到 30，hero 在 BB（seat 2）持 Q5s
  // （翻前百分位 ≈ 0.595；gto 跟注门槛 0.66 − BB 折扣 0.06 = 0.60 → 微不及）
  const mkBB = (models?: OpponentModel[]) => {
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
  };

  it("对偷盲狂：BB 防守放宽（边缘牌从弃牌转跟注）；旋钮关闭恢复弃牌", () => {
    // 决策 rng 用固定种子 mulberry32（2026-09-29 审计 C2：未播种时弃牌率真值
    // 0.91 距断言阈 0.85 仅 ~2.1σ，实测 ~6.7%/轮 恰好 85/100 翻转；播种后零成本
    // 彻底确定——同种子下 base/off 两臂落点固定且过阈，见下方断言）
    const rng = mulberry32(20260929);
    const N = 100;
    let baseFolds = 0;
    let adjFolds = 0;
    let offFolds = 0;
    for (let i = 0; i < N; i++) {
      if (brainDecide(mkBB(), "gto", rng, LEGACY).action.type === "fold") baseFolds++;
      if (brainDecide(mkBB([stealModel()]), "gto", rng, LEGACY).action.type === "fold") adjFolds++;
      if (
        brainDecide(mkBB([stealModel()]), "gto", rng, {
          ...LEGACY,
          adaptPositionalEnabled: false,
        }).action.type === "fold"
      ) {
        offFolds++;
      }
    }
    expect(baseFolds / N).toBeGreaterThan(0.85); // 0.595 < 0.60 → 弃牌（9% 诈唬 3bet 噪声）
    expect(adjFolds / N).toBeLessThan(0.1); // 放宽 -0.04 后 0.595 ≥ 0.56 → 跟注
    expect(offFolds / N).toBeGreaterThan(0.85); // 旋钮关闭 = 旧行为
  });

  // 场景 B：UTG（seat 3，maniac 模型）开局加注，hero 在 CO（seat 5）持 K4s
  // （百分位 ≈ 0.661；gto 跟注门槛 0.66 → 微过线）
  const mkVsUTG = (models?: OpponentModel[]) => {
    const input = makeDecideInput({
      aiHole: ["Ks", "4s"],
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

  it("maniac 在 early 位加注：收紧给尊重（边缘牌从跟注转弃牌）；旋钮关闭恢复", () => {
    const maniac = modelForCls(3, "maniac");
    const N = 100;
    let baseContinues = 0;
    let adjFolds = 0;
    let offContinues = 0;
    for (let i = 0; i < N; i++) {
      const t0 = brainDecide(mkVsUTG(), "gto", Math.random, LEGACY).action.type;
      if (t0 !== "fold") baseContinues++;
      if (brainDecide(mkVsUTG([maniac]), "gto", Math.random, LEGACY).action.type === "fold") adjFolds++;
      const t2 = brainDecide(mkVsUTG([maniac]), "gto", Math.random, {
        ...LEGACY,
        adaptPositionalEnabled: false,
      }).action.type;
      if (t2 !== "fold") offContinues++;
    }
    expect(baseContinues / N).toBeGreaterThan(0.85); // 0.661 ≥ 0.66 → 跟注
    expect(adjFolds / N).toBeGreaterThan(0.85); // +0.04 → 门槛 0.70 > 0.661 → 弃牌
    expect(offContinues / N).toBeGreaterThan(0.85); // 旋钮关闭 → 恢复跟注
  });
});

describe("brain 剥削接入：无模型回归（行为逐比特一致）", () => {
  const scenarios: (() => ReturnType<typeof makeDecideInput>)[] = [
    // 翻前开局边缘牌
    () =>
      makeDecideInput({
        aiHole: ["Kd", "8c"],
        playerCount: 6,
        aiSeat: 5,
        buttonSeat: 0,
        pot: 15,
        currentBet: 10,
        aiStack: 1000,
        callAmount: 10,
        legalActions: [
          { type: "fold", amount: 0 },
          { type: "call", amount: 10 },
          { type: "raise", amount: 20 },
          { type: "allin", amount: 1000 },
        ],
        style: "lag",
      }),
    // 翻后面对下注
    () =>
      makeDecideInput({
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
      }),
    // 翻后无人下注诈唬点
    () => bluffScenario() as ReturnType<typeof makeDecideInput>,
  ];

  it("undefined / 空数组 / 全 unknown 模型：同一随机源下决策完全相同", () => {
    for (const mk of scenarios) {
      for (let seed = 1; seed <= 20; seed++) {
        const a = brainDecide(mk(), mk().style, mulberry32(seed)).action;
        const b = brainDecide({ ...mk(), opponentModels: [] }, mk().style, mulberry32(seed)).action;
        const c = brainDecide(
          { ...mk(), opponentModels: [makeModel(0, "unknown", 0)] },
          mk().style,
          mulberry32(seed),
        ).action;
        expect(b).toEqual(a);
        expect(c).toEqual(a);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// prompt.ts 对手画像段
// ---------------------------------------------------------------------------

describe("buildPrompt 对手画像段", () => {
  const mkInput = (models?: OpponentModel[]) => {
    const input = makeDecideInput({
      aiHole: ["As", "Kd"],
      board: ["Qh", "Jh", "2c"],
      street: "flop",
      pot: 60,
      currentBet: 30,
      callAmount: 30,
      legalActions: [
        { type: "fold", amount: 0 },
        { type: "call", amount: 30 },
        { type: "raise", amount: 60 },
        { type: "allin", amount: 200 },
      ],
      style: "gto",
    });
    return models ? { ...input, opponentModels: models } : input;
  };

  it("有置信度模型时输出画像：统计行 + 分类推测 + 剥削建议", () => {
    const station: OpponentModel = {
      ...makeModel(0, "calling_station", 0.8),
      stats: makeStats({ seat: 0, hands: 30 }),
      vpip: 0.48,
      pfr: 0.12,
      af: 0.6,
      wtsd: 0.55,
    };
    const { user } = buildPrompt(mkInput([station]));
    expect(user).toContain("对手画像");
    expect(user).toContain("座位 0：30 手样本");
    expect(user).toContain("VPIP 48%/PFR 12%/AF 0.6/摊牌率 55%");
    expect(user).toContain("推测：跟注站");
    expect(user).toContain("少诈唬，价值下注可以更薄");
  });

  it("全部 unknown（零置信度）/ 无模型：不输出画像段", () => {
    expect(buildPrompt(mkInput([makeModel(0, "unknown", 0)])).user).not.toContain("对手画像");
    expect(buildPrompt(mkInput()).user).not.toContain("对手画像");
  });

  it("置信度足够且有分桶数据时展示位置拆分 VPIP", () => {
    const m = buildModel(
      makeStats({
        seat: 0,
        hands: 30,
        vpipHands: 12,
        pfrHands: 5,
        postflopAggressive: 5,
        postflopPassive: 5,
        pfBucketHands: { early: 10, middle: 10, late: 10 },
        pfBucketVpip: { early: 2, middle: 3, late: 7 },
        pfBucketPfr: { early: 1, middle: 1, late: 3 },
      }),
    );
    const { user } = buildPrompt(mkInput([m]));
    expect(user).toContain("位置拆分 VPIP");
    expect(user).toContain("前位 20% / 中位 30% / 后位 70%");
    // 无分桶数据的模型不展示拆分（回归兼容）
    const { user: plain } = buildPrompt(mkInput([modelForCls(0, "nit")]));
    expect(plain).toContain("对手画像");
    expect(plain).not.toContain("位置拆分");
  });

  it("混合：有置信度模型输出画像段时，unknown 座位标注样本不足", () => {
    const nit: OpponentModel = {
      ...makeModel(0, "nit", 0.5),
      stats: makeStats({ seat: 0, hands: 15 }),
      vpip: 0.15,
      pfr: 0.1,
      af: 1.0,
      wtsd: 0.3,
    };
    const unknown = { ...makeModel(1, "unknown", 0), stats: makeStats({ seat: 1, hands: 4 }) };
    const input = makeDecideInput({
      aiHole: ["As", "Kd"],
      playerCount: 3,
      aiSeat: 2,
      board: ["Qh", "Jh", "2c"],
      street: "flop",
      pot: 60,
      currentBet: 30,
      callAmount: 30,
      legalActions: [
        { type: "fold", amount: 0 },
        { type: "call", amount: 30 },
        { type: "raise", amount: 60 },
        { type: "allin", amount: 200 },
      ],
      style: "gto",
    });
    const { user } = buildPrompt({ ...input, opponentModels: [nit, unknown] });
    expect(user).toContain("对手画像");
    expect(user).toContain("推测：紧弱岩石");
    expect(user).toContain("座位 1：样本不足（仅 4 手）");
  });
});
