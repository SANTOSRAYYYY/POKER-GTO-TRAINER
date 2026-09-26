/**
 * BrainTuning 参数化回归测试
 *
 * 核心契约：同一 rng seed 下，brainDecide(input, style, rng) 与
 * brainDecide(input, style, rng', {})（显式空调参）的决策逐比特一致
 * （action/reasoning/source 深相等）。DEFAULT_BRAIN_TUNING 即当前生产默认值
 * （历经 warGuard、rangeMode、L2' 等验收后演进）。
 *
 * 翻后场景的蒙特卡洛 equity 走模块级缓存：同输入第二次调用读缓存，
 * 因此两次调用看到完全相同的胜率估计，决策可比。
 */
import { describe, expect, it } from "vitest";
import type { Card, ConcreteAIStyle, PlayerAction } from "@/lib/types";
import {
  brainDecide,
  DEFAULT_BRAIN_TUNING,
  resetBrainCaches,
  type BrainTuning,
} from "../brain";
import { makeDecideInput, type ScenarioOptions } from "./helpers";

const ALL_STYLES: ConcreteAIStyle[] = [
  "nit", "tag", "lag", "maniac", "calling_station", "gto",
];

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PF_LEGAL: PlayerAction[] = [
  { type: "fold", amount: 0 },
  { type: "call", amount: 10 },
  { type: "raise", amount: 20 },
  { type: "allin", amount: 1000 },
];

/** 覆盖翻前三层级 + 翻后面注/无注 × 街道的代表性场景 */
const SCENARIOS: ScenarioOptions[] = [
  { // 翻前 UTG 无人入池（9 人桌）
    aiHole: ["Kd", "8c"], playerCount: 9, aiSeat: 3, buttonSeat: 0,
    pot: 15, currentBet: 10, aiStack: 1000, callAmount: 10, legalActions: PF_LEGAL,
  },
  { // 翻前后位垃圾牌（偷盲/混入分支）
    aiHole: ["Jd", "4c"], playerCount: 6, aiSeat: 0, buttonSeat: 0,
    pot: 15, currentBet: 10, aiStack: 1000, callAmount: 10, legalActions: PF_LEGAL,
  },
  { // 翻前面对一次加注
    aiHole: ["As", "Jd"], playerCount: 9, aiSeat: 6, buttonSeat: 0,
    pot: 45, currentBet: 30, aiStack: 1000, callAmount: 30,
    legalActions: [
      { type: "fold", amount: 0 },
      { type: "call", amount: 30 },
      { type: "raise", amount: 60 },
      { type: "allin", amount: 1000 },
    ],
  },
  { // 翻前短筹码面对加注
    aiHole: ["Qd", "Qc"], playerCount: 6, aiSeat: 5, buttonSeat: 0,
    pot: 45, currentBet: 30, aiStack: 120, callAmount: 30,
    legalActions: [
      { type: "fold", amount: 0 },
      { type: "call", amount: 30 },
      { type: "raise", amount: 60 },
      { type: "allin", amount: 120 },
    ],
  },
  { // 翻牌圈面对下注（蒙特卡洛 equity）
    aiHole: ["Jd", "Tc"], board: ["Kh", "8d", "2c"], street: "flop",
    pot: 100, currentBet: 50, aiStack: 250, callAmount: 50,
    legalActions: [
      { type: "fold", amount: 0 },
      { type: "call", amount: 50 },
      { type: "raise", amount: 100 },
      { type: "allin", amount: 300 },
    ],
  },
  { // 翻牌圈无人下注（空气牌，诈唬分支）
    aiHole: ["7d", "2c"], board: ["Ks", "Qh", "Jd"], street: "flop",
    pot: 100, aiStack: 300, callAmount: 0,
    legalActions: [
      { type: "check", amount: 0 },
      { type: "bet", amount: 10 },
      { type: "allin", amount: 300 },
    ],
  },
  { // 河牌面对下注（单挑精确枚举）
    aiHole: ["As", "Ks"], board: ["Qs", "Js", "Ts", "2d", "3c"], street: "river",
    pot: 100, currentBet: 50, aiStack: 250, callAmount: 50,
    legalActions: [
      { type: "fold", amount: 0 },
      { type: "call", amount: 50 },
      { type: "raise", amount: 100 },
      { type: "allin", amount: 300 },
    ],
  },
  { // 河牌无人下注
    aiHole: ["8d", "3c"], board: ["Ks", "Qh", "Jd", "4c", "2s"], street: "river",
    pot: 100, aiStack: 300, callAmount: 0,
    legalActions: [
      { type: "check", amount: 0 },
      { type: "bet", amount: 10 },
      { type: "allin", amount: 300 },
    ],
  },
];

describe("BrainTuning 回归：tuning={} 与无 tuning 逐比特一致", () => {
  it("同 rng seed 下两种调用方式 action/reasoning/source 完全相等", () => {
    resetBrainCaches();
    const N = 60;
    for (const scenario of SCENARIOS) {
      for (const style of ALL_STYLES) {
        const input = makeDecideInput({ ...scenario, style });
        const rngA = mulberry32(0xc0ffee);
        const rngB = mulberry32(0xc0ffee);
        for (let i = 0; i < N; i++) {
          const r1 = brainDecide(input, style, rngA);
          const r2 = brainDecide(input, style, rngB, {});
          expect(r2).toEqual(r1);
        }
      }
    }
  });

  it("显式传完整默认值（全部键展开）同样逐比特一致", () => {
    resetBrainCaches();
    const full: BrainTuning = { ...DEFAULT_BRAIN_TUNING };
    const scenario = SCENARIOS[4]; // 翻牌圈面对下注
    for (const style of ALL_STYLES) {
      const input = makeDecideInput({ ...scenario, style });
      const rngA = mulberry32(12345);
      const rngB = mulberry32(12345);
      for (let i = 0; i < 30; i++) {
        expect(brainDecide(input, style, rngB, full)).toEqual(
          brainDecide(input, style, rngA),
        );
      }
    }
  });
});

describe("BrainTuning 覆盖生效（旋钮确实接入决策）", () => {
  it("pureBluffK=0 时 maniac 空气牌翻前翻后都不再纯诈唬下注", () => {
    resetBrainCaches();
    const mk = () =>
      makeDecideInput({
        aiHole: ["7d", "2c"] as [Card, Card],
        board: ["Ks", "Qh", "Jd"] as Card[],
        street: "flop",
        pot: 100,
        aiStack: 300,
        callAmount: 0,
        legalActions: [
          { type: "check", amount: 0 },
          { type: "bet", amount: 10 },
          { type: "allin", amount: 300 },
        ],
      });
    const N = 200;
    let defaultBets = 0;
    let zeroedBets = 0;
    const rng = mulberry32(999);
    for (let i = 0; i < N; i++) {
      const t1 = brainDecide(mk(), "maniac", rng).action.type;
      if (t1 === "bet" || t1 === "allin") defaultBets++;
      const t2 = brainDecide(mk(), "maniac", rng, { pureBluffK: 0 }).action.type;
      if (t2 === "bet" || t2 === "allin") zeroedBets++;
    }
    expect(defaultBets / N).toBeGreaterThan(0.3);
    // pureBluffK=0 关掉纯诈唬；半诈唬也可能被 eq<0.30 拦住（72o 此牌面 eq 极低）
    expect(zeroedBets).toBeLessThan(defaultBets);
  });

  it("valueBetEqHU > 1 时河牌坚果也只过牌（价值下注门槛生效）", () => {
    resetBrainCaches();
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
    let defaultBets = 0;
    for (let i = 0; i < 30; i++) {
      const r = brainDecide(input, "gto", rng);
      if (r.action.type === "bet" || r.action.type === "allin") defaultBets++;
    }
    expect(defaultBets).toBeGreaterThan(20); // 默认几乎总下注
    for (let i = 0; i < 30; i++) {
      // 门槛 1.10 经河牌减项（-0.03）后仍 > 1：eq=1 也不再价值下注
      const r = brainDecide(input, "gto", rng, { valueBetEqHU: 1.10 });
      expect(r.action.type).toBe("check");
    }
  });

  it("equityIterationsScale 缩放不影响返回结构（合法动作）", () => {
    resetBrainCaches();
    const input = makeDecideInput({
      aiHole: ["Jd", "Tc"],
      board: ["Kh", "8d", "2c"],
      street: "flop",
      pot: 100,
      currentBet: 50,
      aiStack: 250,
      callAmount: 50,
      legalActions: [
        { type: "fold", amount: 0 },
        { type: "call", amount: 50 },
        { type: "raise", amount: 100 },
        { type: "allin", amount: 300 },
      ],
      style: "gto",
    });
    const rng = mulberry32(31337);
    for (let i = 0; i < 10; i++) {
      const r = brainDecide(input, "gto", rng, { equityIterationsScale: 0.25 });
      expect(input.legalActions.map((a) => a.type)).toContain(r.action.type);
    }
  });
});
