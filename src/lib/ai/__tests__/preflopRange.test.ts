/**
 * 翻前范围推断闭环（F5 真闭环，preflopRangeModeEnabled）测试
 *
 * 覆盖：
 * - range.ts preflopRaiserRangePct 的身后人数 → 范围宽度分档映射
 * - PREFLOP_VS_RANGE_EQUITY 静态表：单调性（同牌型随范围变宽不减）与边界
 *   （AA 对任何范围 ≥ 0.77、72o 对 15% 范围 ≤ 0.35）、中对子缩水效应、最近档映射
 * - brain 闭环行为：同一手牌对 UTG/BTN 加注的继续率分化、价值 3bet 绝对口径、
 *   风格增量叠加、大盲关门折扣保留、旧旋钮 preflopPosAdjustEnabled 失效（不叠加）、
 *   旋钮关闭逐比特回旧口径
 */
import { describe, expect, it } from "vitest";
import type { Card, ConcreteAIStyle, DecideInput, PlayerAction, Seat } from "@/lib/types";
import { brainDecide, resetBrainCaches, type BrainTuning } from "../brain";
import {
  PREFLOP_RANGE_TIERS,
  preflopEquityVsOpenRange,
  preflopRaiserRangePct,
} from "../range";
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

const FACING_RAISE_LEGAL: PlayerAction[] = [
  { type: "fold", amount: 0 },
  { type: "call", amount: 30 },
  { type: "raise", amount: 60 },
  { type: "allin", amount: 1000 },
];

/**
 * 6 人桌 hero HJ（seat 4）面对开局加注 30。
 * 按钮 0 时行动序 [BTN0,SB1,BB2,UTG3,HJ4,CO5]：raiserSeat 3 = UTG（身后 5 → 0.20 档），
 * raiserSeat 0 = BTN（身后 2 → 0.28 档）。
 */
function facingOpen(raiserSeat: Seat, hole: [Card, Card], style: ConcreteAIStyle = "gto") {
  const input = makeDecideInput({
    aiHole: hole,
    playerCount: 6,
    aiSeat: 4,
    buttonSeat: 0,
    pot: 45,
    currentBet: 30,
    aiStack: 1000,
    callAmount: 30,
    legalActions: FACING_RAISE_LEGAL,
    style,
  });
  input.state.streetActions = [{ seat: raiserSeat, action: { type: "raise", amount: 30 } }];
  return input;
}

function continueFreq(
  input: DecideInput,
  style: ConcreteAIStyle = "gto",
  tuning?: Partial<BrainTuning>,
  N = 200,
): number {
  resetBrainCaches();
  const rng = mulberry32(20260926);
  let cont = 0;
  for (let i = 0; i < N; i++) {
    const r = brainDecide(input, style, rng, tuning);
    assertLegal(r.action, input);
    if (r.action.type !== "fold") cont++;
  }
  return cont / N;
}

describe("preflopRaiserRangePct 身后人数分档", () => {
  it("≥6→0.15 / 4-5→0.20 / 2-3→0.28 / 1→0.40 / 0→0.55", () => {
    expect(preflopRaiserRangePct(8)).toBe(0.15);
    expect(preflopRaiserRangePct(6)).toBe(0.15);
    expect(preflopRaiserRangePct(5)).toBe(0.2);
    expect(preflopRaiserRangePct(4)).toBe(0.2);
    expect(preflopRaiserRangePct(3)).toBe(0.28);
    expect(preflopRaiserRangePct(2)).toBe(0.28);
    expect(preflopRaiserRangePct(1)).toBe(0.4);
    expect(preflopRaiserRangePct(0)).toBe(0.55);
  });
});

describe("PREFLOP_VS_RANGE_EQUITY 静态表口径", () => {
  it("边界：AA 对任何范围 ≥ 0.77；72o 对 15% 范围 ≤ 0.35", () => {
    for (const t of PREFLOP_RANGE_TIERS) {
      expect(preflopEquityVsOpenRange("AA", t)).toBeGreaterThanOrEqual(0.77);
    }
    expect(preflopEquityVsOpenRange("72o", 0.15)).toBeLessThanOrEqual(0.35);
  });

  it("单调性：同一牌型的胜率随范围变宽（变弱）不减", () => {
    for (const label of ["AA", "KK", "AKs", "99", "77", "A8s", "JTs", "JTo", "QJs", "72o"]) {
      let prev = -1;
      for (const t of PREFLOP_RANGE_TIERS) {
        const e = preflopEquityVsOpenRange(label, t);
        expect(e).toBeGreaterThanOrEqual(prev);
        prev = e;
      }
    }
  });

  it("中对子对紧范围缩水（对随机百分位表无法表达的口径差异）", () => {
    // 77 的对随机百分位 ≈ 0.946，但对 15% 紧范围真实胜率不足 50%，且低于 AKs
    expect(preflopEquityVsOpenRange("77", 0.15)).toBeLessThan(0.5);
    expect(preflopEquityVsOpenRange("77", 0.15)).toBeLessThan(
      preflopEquityVsOpenRange("AKs", 0.15),
    );
  });

  it("rangePct 映射最近档；未知牌型兜底 0.3", () => {
    expect(preflopEquityVsOpenRange("AA", 0.17)).toBe(preflopEquityVsOpenRange("AA", 0.15));
    expect(preflopEquityVsOpenRange("AA", 0.26)).toBe(preflopEquityVsOpenRange("AA", 0.28));
    expect(preflopEquityVsOpenRange("XX", 0.28)).toBe(0.3);
  });
});

describe("brain 闭环：同一手牌对 UTG 加注 vs BTN 加注继续率分化", () => {
  // 机制默认关闭（Phase 8 验收未过采纳线）；以下行为用例全部显式开启旋钮
  const RANGE_ON = { preflopRangeModeEnabled: true } as const;

  it("A8s：对 UTG（20% 范围，胜率 0.428 < 0.45）弃牌为主；对 BTN（28%，0.501 ≥ 0.45）稳定跟注", () => {
    const vsUtg = continueFreq(facingOpen(3, ["As", "8s"]), "gto", RANGE_ON);
    const vsBtn = continueFreq(facingOpen(0, ["As", "8s"]), "gto", RANGE_ON);
    expect(vsUtg).toBeLessThan(0.2); // 仅 ~9% 诈唬 3bet（gto bluffFreq 0.3 × 0.3）
    expect(vsBtn).toBeGreaterThan(0.95);
    expect(vsBtn - vsUtg).toBeGreaterThan(0.7);
  });

  it("合成快照（无行动序列）按中位 28% 档近似：KTo 弃牌；旋钮关闭逐比特回旧口径跟注", () => {
    // KTo 对 28% 范围胜率 0.429 < 0.45 且非可玩牌型（K-T 间隔 3，无诈唬 3bet 资格）
    // → 确定性弃牌；旧口径 KTo 百分位 0.798 ≥ gto 0.66 → 确定性跟注
    const mk = () =>
      makeDecideInput({
        aiHole: ["Kd", "Tc"],
        playerCount: 6,
        aiSeat: 4,
        buttonSeat: 0,
        pot: 45,
        currentBet: 30,
        aiStack: 1000,
        callAmount: 30,
        legalActions: FACING_RAISE_LEGAL,
        style: "gto",
      });
    resetBrainCaches();
    for (let i = 0; i < 20; i++) {
      expect(brainDecide(mk(), "gto", mulberry32(i), RANGE_ON).action.type).toBe("fold");
      expect(
        brainDecide(mk(), "gto", mulberry32(i), { preflopRangeModeEnabled: false })
          .action.type,
      ).toBe("call");
    }
  });

  it("价值 3bet 绝对口径：QQ 对 UTG（9 人桌，15% 范围，胜率 0.668 ≥ 0.62）稳定 3bet；AKs（0.606 < 0.62）稳定跟注", () => {
    // 9 人桌按钮 0：行动序 [BTN0,SB1,BB2,UTG3,...]；raiser UTG seat 3 身后 8 → 0.15 档；
    // hero LJ seat 6（身后 5，无大盲折扣）
    const mk = (hole: [Card, Card]) => {
      const input = makeDecideInput({
        aiHole: hole,
        playerCount: 9,
        aiSeat: 6,
        buttonSeat: 0,
        pot: 45,
        currentBet: 30,
        aiStack: 1000,
        callAmount: 30,
        legalActions: FACING_RAISE_LEGAL,
        style: "gto",
      });
      input.state.streetActions = [{ seat: 3, action: { type: "raise", amount: 30 } }];
      return input;
    };
    resetBrainCaches();
    for (let i = 0; i < 20; i++) {
      expect(brainDecide(mk(["Qd", "Qc"]), "gto", mulberry32(i), RANGE_ON).action.type).toBe("raise");
      expect(brainDecide(mk(["As", "Ks"]), "gto", mulberry32(i), RANGE_ON).action.type).toBe("call");
    }
  });

  it("风格增量继续叠加：QJs 对 BTN 加注，maniac（门槛 0.42）全跟注、nit（0.48）几乎全弃牌", () => {
    // QJs 对 28% 范围胜率 0.448：maniac 0.448 ≥ 0.42 → 跟注；
    // nit 0.448 < 0.48 → 弃牌（诈唬 3bet 概率仅 0.05×0.3 ≈ 1.5%）
    const vsManiac = continueFreq(facingOpen(0, ["Qs", "Js"], "maniac"), "maniac", RANGE_ON);
    const vsNit = continueFreq(facingOpen(0, ["Qs", "Js"], "nit"), "nit", RANGE_ON);
    expect(vsManiac).toBeGreaterThan(0.95);
    expect(vsNit).toBeLessThan(0.1);
  });

  it("大盲关门折扣在范围口径下保留：A4s 对 BTN 加注，BB 跟注为主、HJ 弃牌为主", () => {
    // A4s 对 28% 范围胜率 0.446：BB（behind=0）门槛 0.45-0.06=0.39 → 跟注；
    // HJ（behind=3，无折扣）0.446 < 0.45 → 弃牌为主（诈唬 3bet ~9%）
    const bb = makeDecideInput({
      aiHole: ["Ad", "4d"],
      playerCount: 6,
      aiSeat: 2,
      buttonSeat: 0,
      pot: 45,
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
    bb.state.streetActions = [{ seat: 0, action: { type: "raise", amount: 30 } }];
    const bbFreq = continueFreq(bb, "gto", RANGE_ON);
    const hjFreq = continueFreq(facingOpen(0, ["Ad", "4d"]), "gto", RANGE_ON);
    expect(bbFreq).toBeGreaterThan(0.95);
    expect(hjFreq).toBeLessThan(0.2);
  });

  it("范围口径开启时 preflopPosAdjustEnabled 失效（极端修正量与关闭逐点一致，不叠加）", () => {
    resetBrainCaches();
    const input = facingOpen(3, ["Jd", "Tc"]);
    for (let i = 0; i < 30; i++) {
      const extreme = brainDecide(input, "gto", mulberry32(i), {
        preflopRangeModeEnabled: true,
        preflopPosAdjustEnabled: true,
        preflopPosAdjustUTG: 0.5,
        preflopPosAdjustBTN: -0.5,
      });
      const off = brainDecide(input, "gto", mulberry32(i), RANGE_ON);
      expect(extreme).toEqual(off);
    }
  });

  it("旋钮关闭回旧口径：JTo 对 UTG 加注恢复跟注为主（旧百分位 0.673 ≥ 0.66）；开启时弃牌为主", () => {
    const legacy = continueFreq(facingOpen(3, ["Jd", "Tc"]), "gto", {
      preflopRangeModeEnabled: false,
    });
    expect(legacy).toBeGreaterThan(0.9);
    const ranged = continueFreq(facingOpen(3, ["Jd", "Tc"]), "gto", RANGE_ON);
    expect(ranged).toBeLessThan(0.2); // 对 20% 范围胜率 0.364 < 0.45
  });
});
