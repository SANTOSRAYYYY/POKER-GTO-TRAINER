/**
 * 范围推断（range-based equity）测试 —— range.ts + brain.ts 接入
 *
 * - inferFacingSpec：raisesSeen 基础表 / 多人池收紧 / 对手画像修正 / 钳制
 * - equityVsRange 合理性：88 葫芦 on 222A6 对紧范围胜率骤降；坚果 ≈1；
 *   topPct=1 退化为 ≈ 随机胜率；同 seed 可复现
 * - brain 集成：加注战局面（raisesSeen=1，被统治弱葫芦面对 raise）rangeMode
 *   下跟注/加注频率显著下降；rangeModeEnabled:false 逐比特恢复旧行为
 *   （与 rangeBlendRandom:1 深相等，且加注频率回到旧水平）
 */
import { describe, expect, it } from "vitest";
import type { Card, OpponentClass, OpponentModel, Seat, SeatAction } from "@/lib/types";
import { equityMulti } from "@/lib/poker/equity";
import { brainDecide, resetBrainCaches } from "../brain";
import { equityVsRange, equityVsRanges, inferFacingSpec, resetRangeCaches } from "../range";
import { createOpponentStats } from "../adapt";
import { assertLegal, makeDecideInput } from "./helpers";

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeModel(cls: OpponentClass, confidence: number, seat = 0): OpponentModel {
  return {
    seat,
    stats: {
      ...createOpponentStats(seat),
      hands: 50, vpipHands: 20, pfrHands: 10,
      postflopAggressive: 10, postflopPassive: 10, showdowns: 5, showdownsSeenFlop: 20,
    },
    vpip: 0.4, pfr: 0.2, af: 1, wtsd: 0.25, cls, confidence,
  };
}

describe("inferFacingSpec 范围估计", () => {
  it("raisesSeen 基础表（单挑）：0/1/2/3+ 逐级收紧", () => {
    expect(inferFacingSpec("flop", 0, 1)).toEqual({ topPct: 0.55, bluffPct: 0.15 });
    expect(inferFacingSpec("flop", 1, 1)).toEqual({ topPct: 0.30, bluffPct: 0.10 });
    expect(inferFacingSpec("turn", 2, 1)).toEqual({ topPct: 0.15, bluffPct: 0.05 });
    expect(inferFacingSpec("river", 3, 1)).toEqual({ topPct: 0.07, bluffPct: 0.02 });
    expect(inferFacingSpec("river", 9, 1)).toEqual({ topPct: 0.07, bluffPct: 0.02 });
  });

  it("多人池收紧：每个额外对手 topPct × 0.8（bluff 不变）", () => {
    const s = inferFacingSpec("flop", 0, 3);
    expect(s.topPct).toBeCloseTo(0.55 * 0.8 * 0.8, 10); // 0.352
    expect(s.bluffPct).toBe(0.15);
  });

  it("对手画像修正按 confidence 加权：nit 收紧 / maniac 放宽+加诈唬 / 跟注站减诈唬", () => {
    // nit conf=1：topPct ×0.7
    expect(inferFacingSpec("flop", 0, 1, makeModel("nit", 1)).topPct)
      .toBeCloseTo(0.55 * 0.7, 10);
    // nit conf=0.5：×(1 + (0.7-1)×0.5) = ×0.85
    expect(inferFacingSpec("flop", 0, 1, makeModel("nit", 0.5)).topPct)
      .toBeCloseTo(0.55 * 0.85, 10);
    // maniac conf=1：topPct ×1.5（0.825 → 钳到 0.8）、bluff ×2
    const m = inferFacingSpec("flop", 0, 1, makeModel("maniac", 1));
    expect(m.topPct).toBeCloseTo(0.8, 10);
    expect(m.bluffPct).toBeCloseTo(0.3, 10);
    // calling_station conf=1：bluff ×0.5
    expect(inferFacingSpec("flop", 0, 1, makeModel("calling_station", 1)).bluffPct)
      .toBeCloseTo(0.075, 10);
    // unknown / conf=0：零修正
    expect(inferFacingSpec("flop", 0, 1, makeModel("unknown", 1)))
      .toEqual({ topPct: 0.55, bluffPct: 0.15 });
    expect(inferFacingSpec("flop", 0, 1, makeModel("nit", 0)))
      .toEqual({ topPct: 0.55, bluffPct: 0.15 });
  });

  it("topPct 钳制下限 0.03（5bet+ 且多人池）", () => {
    const s = inferFacingSpec("river", 4, 5); // 0.07 × 0.8^4 ≈ 0.0287
    expect(s.topPct).toBe(0.03);
  });
});

describe("equityVsRange 蒙特卡洛合理性", () => {
  const board: Card[] = ["2h", "2d", "2c", "Ah", "6c"];

  it("88（弱葫芦）on 222A6：vs topPct 0.15 紧范围胜率骤降（vs 随机范围很高）", () => {
    resetRangeCaches();
    const hero: [Card, Card] = ["8h", "8d"];
    const wide = equityVsRange(hero, board, { topPct: 1, bluffPct: 0 }, 4000, mulberry32(1));
    const tight = equityVsRange(hero, board, { topPct: 0.15, bluffPct: 0.05 }, 4000, mulberry32(2));
    // 随机范围下 88 ≈ 0.79（warGuard 测试口径）；紧范围只剩 quads/222AA 级 → ≈0
    expect(wide).toBeGreaterThan(0.7);
    expect(tight).toBeLessThan(0.15);
    expect(tight).toBeLessThan(wide - 0.5);
  });

  it("皇家同花顺坚果 vs 任何范围 ≈ 1", () => {
    resetRangeCaches();
    const eq = equityVsRange(
      ["As", "Ks"],
      ["Qs", "Js", "Ts", "2d", "3c"],
      { topPct: 0.07, bluffPct: 0.02 },
      500,
      mulberry32(3),
    );
    expect(eq).toBe(1);
  });

  it("topPct=1 退化为 ≈ 随机范围胜率（equityMulti）", () => {
    resetRangeCaches();
    const hero: [Card, Card] = ["Jd", "Tc"];
    const b: Card[] = ["Kh", "8d", "2c"];
    const rangeEq = equityVsRange(hero, b, { topPct: 1, bluffPct: 0 }, 5000, mulberry32(4));
    const rand = equityMulti(hero, b, 1, 5000);
    const randomEq = rand.win + rand.tie / 2;
    expect(Math.abs(rangeEq - randomEq)).toBeLessThan(0.05);
  });

  it("同 seed 可复现", () => {
    resetRangeCaches();
    const hero: [Card, Card] = ["Jd", "Tc"];
    const b: Card[] = ["Kh", "8d", "2c"];
    const spec = { topPct: 0.3, bluffPct: 0.1 };
    const v1 = equityVsRange(hero, b, spec, 800, mulberry32(42));
    resetRangeCaches(); // 清缓存强制重算，排除缓存命中造成的假相等
    const v2 = equityVsRange(hero, b, spec, 800, mulberry32(42));
    expect(v2).toBe(v1);
  });

  it("多人池联合摊薄：对手越多胜率越低，且远低于单对手近似", () => {
    // Ah7h（中对 7）on Ks7d2c：对收紧范围（多人 topPct 0.28）抽单个对手 ≈0.51，
    // 联合 4 对手（需压过全部）≈0.14——旧单对手近似严重高估多人池胜率
    resetRangeCaches();
    const hero: [Card, Card] = ["Ah", "7h"];
    const b: Card[] = ["Ks", "7d", "2c"];
    const spec = inferFacingSpec("flop", 0, 4); // { topPct: 0.2816, bluffPct: 0.15 }
    const e1 = equityVsRange(hero, b, spec, 8000, mulberry32(11), 1);
    resetRangeCaches();
    const e2 = equityVsRange(hero, b, spec, 8000, mulberry32(12), 2);
    resetRangeCaches();
    const e4 = equityVsRange(hero, b, spec, 8000, mulberry32(13), 4);
    expect(e1).toBeGreaterThan(e2);
    expect(e2).toBeGreaterThan(e4);
    expect(e4).toBeLessThan(0.3);
    expect(e4).toBeLessThan(e1 - 0.2);
  });

  it("opponents=1 时与旧单对手口径逐比特一致（同 seed）", () => {
    resetRangeCaches();
    const hero: [Card, Card] = ["Jd", "Tc"];
    const b: Card[] = ["Kh", "8d", "2c"];
    const spec = { topPct: 0.3, bluffPct: 0.1 };
    const explicit = equityVsRange(hero, b, spec, 800, mulberry32(42), 1);
    resetRangeCaches();
    const implicit = equityVsRange(hero, b, spec, 800, mulberry32(42));
    expect(implicit).toBe(explicit);
  });
});

// ---------------------------------------------------------------------------
// equityVsRanges：逐角色多人池范围胜率（2026-09-29 新增）
// ---------------------------------------------------------------------------

describe("equityVsRanges 逐角色多人池范围胜率", () => {
  // 用户实报手牌：顶两对 T♥9♥ 在 6♣8♥8♣9♦（转牌面对第二枪）
  const hero: [Card, Card] = ["Th", "9h"];
  const board: Card[] = ["6c", "8h", "8c", "9d"];
  const strong = { topPct: 0.45, bluffPct: 0.15 }; // 下注者（第二枪者）
  const capped = { topPct: 0.65, bluffPct: 0.2 }; // 翻牌圈只跟注的封顶范围

  it("specs 长度 1：与 equityVsRange(..., opponents=1) 同 seed 逐比特一致", () => {
    resetRangeCaches();
    const a = equityVsRanges(hero, board, [strong], 800, mulberry32(42));
    resetRangeCaches();
    const b = equityVsRange(hero, board, strong, 800, mulberry32(42), 1);
    expect(a).toBe(b);
  });

  it("specs 全相同 ×3：与 equityVsRange 同 spec+opponents=3 统计一致（宽容区间）", () => {
    resetRangeCaches();
    const joint = equityVsRanges(hero, board, [strong, strong, strong], 6000, mulberry32(7));
    resetRangeCaches();
    const legacy = equityVsRange(hero, board, strong, 6000, mulberry32(7), 3);
    expect(Math.abs(joint - legacy)).toBeLessThan(0.02);
  });

  it("逐角色混合：跟注者封顶显著抬高胜率（介于「全强」与「全封顶」之间）", () => {
    resetRangeCaches();
    const allStrong = equityVsRanges(hero, board, [strong, strong, strong], 8000, mulberry32(11));
    resetRangeCaches();
    const mixed = equityVsRanges(hero, board, [strong, capped, capped], 8000, mulberry32(12));
    resetRangeCaches();
    const allCapped = equityVsRanges(hero, board, [capped, capped, capped], 8000, mulberry32(13));
    // 实测：allStrong ≈0.25 / mixed ≈0.30 / allCapped ≈0.33
    expect(mixed).toBeGreaterThan(allStrong + 0.02);
    expect(mixed).toBeLessThan(allCapped - 0.01);
  });

  it("specs 长度 2（三人池）：摊薄更少，胜率高于同组合四人池", () => {
    resetRangeCaches();
    const threeWay = equityVsRanges(hero, board, [strong, capped], 8000, mulberry32(14));
    resetRangeCaches();
    const fourWay = equityVsRanges(hero, board, [strong, capped, capped], 8000, mulberry32(15));
    // 实测：threeWay ≈0.43 / fourWay ≈0.30
    expect(threeWay).toBeGreaterThan(fourWay + 0.05);
    expect(threeWay).toBeGreaterThan(0);
    expect(threeWay).toBeLessThan(1);
  });

  it("河牌（公共牌已齐）混合 spec：坚果对任何 spec 组合恒胜", () => {
    resetRangeCaches();
    const eq = equityVsRanges(
      ["As", "Ks"],
      ["Qs", "Js", "Ts", "2d", "3c"],
      [strong, capped, capped],
      500,
      mulberry32(16),
    );
    expect(eq).toBe(1);
  });

  it("错误参数：specs 空 / 超 3 个 / 元素非法 / board 非法 / iterations 非法 → throw", () => {
    expect(() => equityVsRanges(hero, board, [], 100)).toThrow();
    expect(() => equityVsRanges(hero, board, [strong, strong, strong, strong], 100)).toThrow();
    expect(() => equityVsRanges(hero, board, [{ topPct: NaN, bluffPct: 0.1 }], 100)).toThrow();
    expect(() => equityVsRanges(hero, board, [{ topPct: 0.5, bluffPct: Infinity }], 100)).toThrow();
    expect(() => equityVsRanges(hero, ["Ah", "Kh"], [strong], 100)).toThrow();
    expect(() => equityVsRanges(hero, board, [strong], 0)).toThrow();
    expect(() => equityVsRanges(hero, board, [strong], 1.5)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// brain 集成：加注战局面新旧行为对比
// ---------------------------------------------------------------------------

/**
 * 河牌单挑被统治弱葫芦：88 on 222A6。
 * vs 随机 eq≈0.79；vs 紧范围胜率骤降（实测 spec0.30→≈0.37，spec0.15→≈0.08）。
 * streetActions 为 SeatAction[]（F4 契约；2 人桌：对手座位 0，hero/AI 座位 1）；
 * 加注增量均 ≥ 当时 minRaise（F6 回放只计完整加注）。
 */
const SA = (seat: Seat, type: SeatAction["action"]["type"], amount: number): SeatAction => ({
  seat,
  action: { type, amount },
});

function riverWar88Input(opts: {
  pot: number;
  currentBet: number;
  stack: number;
  streetActions: SeatAction[];
}) {
  const input = makeDecideInput({
    aiHole: ["8h", "8d"],
    board: ["2h", "2d", "2c", "Ah", "6c"],
    street: "river",
    pot: opts.pot,
    currentBet: opts.currentBet,
    aiStack: opts.stack,
    callAmount: opts.currentBet,
    legalActions: [
      { type: "fold", amount: 0 },
      { type: "call", amount: opts.currentBet },
      { type: "raise", amount: opts.currentBet * 2 },
      { type: "allin", amount: opts.stack },
    ],
    style: "gto",
  });
  input.state.streetActions = opts.streetActions;
  return input;
}

/** raisesSeen=1（bet + raise 回来），bet 200 / pot 800（所需胜率 ~23%） */
function raisesSeen1Input() {
  return riverWar88Input({
    pot: 800,
    currentBet: 200,
    stack: 2000, // stack/pot = 2.5，避开 SPR commit
    streetActions: [
      SA(1, "bet", 80),
      SA(0, "raise", 200),
    ],
  });
}

/** raisesSeen=2（被 4bet），bet 600 / pot 1200（所需胜率 ~36%） */
function raisesSeen2Input() {
  return riverWar88Input({
    pot: 1200,
    currentBet: 600,
    stack: 3000, // stack/pot = 2.5，避开 SPR commit
    streetActions: [
      SA(0, "bet", 100),
      SA(1, "raise", 300),
      SA(0, "raise", 600),
    ],
  });
}

function freqTable(
  input: ReturnType<typeof raisesSeen1Input>,
  seed: number,
  N: number,
  tuning?: Parameters<typeof brainDecide>[3],
) {
  const rng = mulberry32(seed);
  const count = { fold: 0, call: 0, raise: 0 };
  for (let i = 0; i < N; i++) {
    const r = brainDecide(input, "gto", rng, tuning);
    assertLegal(r.action, input);
    if (r.action.type === "raise" || r.action.type === "allin") count.raise++;
    else if (r.action.type === "call") count.call++;
    else if (r.action.type === "fold") count.fold++;
  }
  return { fold: count.fold / N, call: count.call / N, raise: count.raise / N };
}

describe("rangeMode 接入 brain：加注战被统治手牌（88 弱葫芦 on 222A6）", () => {
  it("raisesSeen=1：价值再加注消失（加注频率 80% → ≤20%），降级为跟注为主", () => {
    resetBrainCaches();
    const legacy = freqTable(raisesSeen1Input(), 777, 40, { rangeModeEnabled: false });
    // 旧行为：vs 随机 eq≈0.79 ≥ warRaiseEq3bet 0.78 → 80% 概率价值加注
    expect(legacy.raise).toBeGreaterThan(0.6);

    resetBrainCaches();
    const ranged = freqTable(raisesSeen1Input(), 20260923, 40);
    // 新行为（默认 blend 0 = 纯范围胜率）：vs topPct0.30 范围胜率 ≈0.37，
    // 低于 warRaiseEq3bet → 不再加注（仅剩 ~10% 诈唬加注），
    // 仍高于跟注门槛 ~0.23（间距 ~4σ，按 210 次迭代缓存估计 σ≈0.033 计）→ 以跟注为主
    expect(ranged.raise).toBeLessThanOrEqual(0.2);
    expect(ranged.call).toBeGreaterThanOrEqual(0.6);
  });

  it("raisesSeen=2（更大注额）：跟注频率 ~100% → 以弃牌为主", () => {
    resetBrainCaches();
    const legacy = freqTable(raisesSeen2Input(), 555, 40, { rangeModeEnabled: false });
    // 旧行为：护栏压住再加注（vr 0.90），但 eq≈0.79 远超跟注门槛 → 稳定跟注
    expect(legacy.call).toBeGreaterThan(0.8);

    resetBrainCaches();
    const ranged = freqTable(raisesSeen2Input(), 888, 40);
    // 新行为（默认 blend 0）：vs topPct0.15 紧范围胜率 ≈0.08 < 跟注门槛 0.36 → 弃牌为主
    expect(ranged.fold).toBeGreaterThanOrEqual(0.7);
    expect(ranged.raise).toBeLessThanOrEqual(0.2);
  });

  it("rangeModeEnabled:false 恢复旧行为（raisesSeen=1，照常价值加注）", () => {
    resetBrainCaches();
    const input = raisesSeen1Input();
    const rng = mulberry32(777);
    const N = 40;
    let raises = 0;
    for (let i = 0; i < N; i++) {
      const t = brainDecide(input, "gto", rng, { rangeModeEnabled: false }).action.type;
      if (t === "raise" || t === "allin") raises++;
    }
    expect(raises / N).toBeGreaterThan(0.6);
  });

  it("逐比特恢复：rangeModeEnabled:false 与 rangeBlendRandom:1 深相等（同 seed）", () => {
    resetBrainCaches();
    const input = raisesSeen1Input();
    const rngA = mulberry32(0xc0ffee);
    const rngB = mulberry32(0xc0ffee);
    for (let i = 0; i < 20; i++) {
      const off = brainDecide(input, "gto", rngA, { rangeModeEnabled: false });
      const blend1 = brainDecide(input, "gto", rngB, { rangeBlendRandom: 1 });
      expect(blend1).toEqual(off);
    }
  });

  it("带对手画像时决策仍合法（maniac 画像放宽范围）", () => {
    resetBrainCaches();
    const input = raisesSeen1Input();
    input.opponentModels = [makeModel("maniac", 1, 0)];
    for (let i = 0; i < 10; i++) {
      const r = brainDecide(input, "gto", mulberry32(5000 + i));
      assertLegal(r.action, input);
    }
  });

  it("多人池口径旋钮：rangeMultiwayJoint 默认开时 4 对手稳定弃牌，关闭退回旧近似则继续", () => {
    // Ah7h（中对 7）on Ks7d2c 面对 0.3 池小注、4 名对手：
    // 联合口径胜率 ≈0.14 << 阈值 0.36 → 弃牌；旧单对手近似 ≈0.51 > 0.36 → 跟注。
    // 两侧间距 ≥3.5σ（按 brain 决策的 175 次迭代缓存估计 σ≈0.038 计）。
    const mk = () => {
      const input = makeDecideInput({
        aiHole: ["Ah", "7h"],
        board: ["Ks", "7d", "2c"],
        street: "flop",
        pot: 100,
        currentBet: 30,
        aiStack: 250,
        callAmount: 30,
        playerCount: 5,
        aiSeat: 4,
        buttonSeat: 0,
        legalActions: [
          { type: "fold", amount: 0 },
          { type: "call", amount: 30 },
          { type: "raise", amount: 60 },
          { type: "allin", amount: 250 },
        ],
        style: "tag",
      });
      input.state.streetActions = [SA(0, "bet", 30)];
      return input;
    };
    const N = 40;
    resetBrainCaches();
    let jointFolds = 0;
    const rngA = mulberry32(4242);
    for (let i = 0; i < N; i++) {
      const r = brainDecide(mk(), "tag", rngA); // 默认 rangeMultiwayJoint: true
      assertLegal(r.action, mk());
      if (r.action.type === "fold") jointFolds++;
    }
    expect(jointFolds / N).toBeGreaterThanOrEqual(0.9);

    resetBrainCaches();
    let legacyContinues = 0;
    const rngB = mulberry32(4242);
    for (let i = 0; i < N; i++) {
      const r = brainDecide(mk(), "tag", rngB, { rangeMultiwayJoint: false });
      assertLegal(r.action, mk());
      if (r.action.type !== "fold") legacyContinues++;
    }
    expect(legacyContinues / N).toBeGreaterThanOrEqual(0.8);
  });

  it("无人下注的主动决策不受范围推断影响（无 streetActions 时仍按随机胜率下注）", () => {
    resetBrainCaches();
    // 河牌坚果无人下注：新旧配置都应价值下注
    const input = makeDecideInput({
      aiHole: ["As", "Ks"],
      board: ["Qs", "Js", "Ts", "2d", "3c"],
      street: "river",
      pot: 100,
      aiStack: 300,
      callAmount: 0,
      legalActions: [
        { type: "check", amount: 0 },
        { type: "bet", amount: 10 },
        { type: "allin", amount: 300 },
      ],
      style: "gto",
    });
    const rng = mulberry32(77);
    for (let i = 0; i < 20; i++) {
      const t = brainDecide(input, "gto", rng).action.type;
      expect(t === "bet" || t === "allin").toBe(true);
    }
  });
});
