/**
 * 2026-09-23 AI 决策栈审计修复的回归测试
 *
 * - F1：callAmount 按 hero 实际可跟注额（stack）封顶——hero 20bb 面对 100bb 全下，
 *   AKs/JJ 按 ~19bb 计价跟注，不再被 callVs3betMaxBB(25bb) 上限误伤弃牌；
 *   对照组：未封顶的虚高 callAmount 下两手牌都会弃牌（证明测试确实覆盖封顶语义）
 * - F2：SPR commit 面注时改用混合胜率 eqF 且移到 warGuard 门槛之后——
 *   下注被 raise 回来（warSeen=1）且 eqF < warRaiseEq3bet 但随机 eq ≥ 0.60 的
 *   SPR<2 局面，修前直接全下、修后降级 call；无下注主动推进保持随机胜率全下
 * - F5：翻前面对加注按加注者位置调制门槛（UTG +0.04 ↔ BTN -0.04 线性插值）；
 *   同一手牌面对 UTG vs BTN 加注继续频率显著不同；单挑桌不生效；旋钮可关
 * - F6：不足最小加注额的 short all-in（跟注性质）不计入加注层级——
 *   翻前不升档到「面对 3bet+」分支，翻后不触发 warGuard 护栏升档
 */
import { describe, expect, it } from "vitest";
import type { Card, Seat, SeatAction } from "@/lib/types";
import { brainDecide, resetBrainCaches } from "../brain";
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

/** 带座位的动作（F4 契约） */
const SA = (seat: Seat, type: SeatAction["action"]["type"], amount: number): SeatAction => ({
  seat,
  action: { type, amount },
});

/** 以确定性 rng 补丁 Math.random（brain 蒙特卡洛 equity 用 Math.random），用完恢复 */
function withPatchedRandom<T>(seed: number, fn: () => T): T {
  const prev = Math.random;
  Math.random = mulberry32(seed);
  try {
    return fn();
  } finally {
    Math.random = prev;
  }
}

// ---------------------------------------------------------------------------
// F1：callAmount 按实际可跟注额封顶
// ---------------------------------------------------------------------------

describe("F1：callAmount 封顶后，hero 20bb 面对 100bb 全下按 ~19bb 计价", () => {
  // 6 人桌 hero BB（streetBet 10，stack 190，共 20bb）；CO 全下到 1000（100bb）。
  // 引擎 legalActions 此时只有 [fold, call 190]（跟注即全下，无加注空间）。
  // 单个 all-in 是完整加注（raises=1），但 sizeEst（cb 1000 > 4bb）把层级估到 2，
  // 走「面对 3bet+」分支——callVs3betMaxBB(25bb=250) 上限按 callAmount 计价：
  // 封顶 190 ≤ 250 → AKs/JJ 跟注；未封顶 990 > 250 → 两手牌都弃（旧 bug）。
  function allinWarInput(hole: [Card, Card], callAmount: number) {
    const input = makeDecideInput({
      aiHole: hole,
      playerCount: 6,
      aiSeat: 2, // BB
      buttonSeat: 0,
      pot: 1045,
      currentBet: 1000,
      aiStreetBet: 10,
      aiStack: 190,
      callAmount,
      legalActions: [
        { type: "fold", amount: 0 },
        { type: "call", amount: 190 },
      ],
      style: "gto",
    });
    input.state.streetActions = [SA(5, "allin", 1000)];
    return input;
  }

  it("AKs（pct≈0.958 ∈ callVs3bet 带）：封顶 190 后跟注（未封顶 990 会误弃）", () => {
    resetBrainCaches();
    const capped = allinWarInput(["As", "Ks"], 190);
    for (let i = 0; i < 10; i++) {
      const r = brainDecide(capped, "gto", mulberry32(i));
      assertLegal(r.action, capped);
      expect(r.action.type).toBe("call");
      expect(r.action.amount).toBe(190);
    }
    // 对照：未封顶的虚高 callAmount（990 > 25bb 上限）触发 L2 弃牌
    const uncapped = allinWarInput(["As", "Ks"], 990);
    const r = brainDecide(uncapped, "gto", mulberry32(1));
    expect(r.action.type).toBe("fold");
  });

  it("JJ（pct≈0.982 ∈ premium 但未达豁免档）：封顶 190 后跟注（未封顶会被 L2' 误弃）", () => {
    resetBrainCaches();
    const capped = allinWarInput(["Jh", "Jd"], 190);
    for (let i = 0; i < 10; i++) {
      const r = brainDecide(capped, "gto", mulberry32(i));
      assertLegal(r.action, capped);
      expect(r.action.type).toBe("call");
    }
    const uncapped = allinWarInput(["Jh", "Jd"], 990);
    const r = brainDecide(uncapped, "gto", mulberry32(1));
    expect(r.action.type).toBe("fold");
  });
});

// ---------------------------------------------------------------------------
// F2：SPR commit 面注时用 eqF 且在 warGuard 之后
// ---------------------------------------------------------------------------

describe("F2：SPR commit 不再绕过 warGuard", () => {
  // 88 on 222A6（弱葫芦）：vs 随机 eq≈0.79 ≥ sprCommitEqDefault(0.60)，
  // vs raisesSeen=1 推断范围（topPct 0.30）eqF≈0.37 < warRaiseEq3bet(0.78)。
  // stack 1500 ≤ 2×pot 1600（SPR 区内）：修前直接全下，修后降级 call 为主。
  function sprWarInput() {
    const input = makeDecideInput({
      aiHole: ["8h", "8d"],
      board: ["2h", "2d", "2c", "Ah", "6c"],
      street: "river",
      pot: 800,
      currentBet: 300,
      aiStack: 1500, // stack/pot = 1.875 < sprThreshold 2
      callAmount: 300,
      legalActions: [
        { type: "fold", amount: 0 },
        { type: "call", amount: 300 },
        { type: "raise", amount: 600 },
        { type: "allin", amount: 1500 },
      ],
      style: "gto",
    });
    input.state.streetActions = [SA(1, "bet", 80), SA(0, "raise", 300)];
    return input;
  }

  it("面注被 raise 回来（warSeen=1）+ eqF≈0.37 + SPR<2：不再全下，以跟注为主", () => {
    resetBrainCaches();
    const input = sprWarInput();
    const N = 40;
    const count = { call: 0, fold: 0, allin: 0, raise: 0 };
    withPatchedRandom(20260923, () => {
      const rng = mulberry32(777);
      for (let i = 0; i < N; i++) {
        const r = brainDecide(input, "gto", rng);
        assertLegal(r.action, input);
        count[r.action.type as keyof typeof count]++;
      }
    });
    expect(count.allin).toBe(0); // 修前此处必然全下（eq 0.79 ≥ 0.60 且 SPR<2）
    expect(count.call / N).toBeGreaterThanOrEqual(0.75); // 少量诈唬加注除外
  });

  it("面注坚果低 SPR：eqF=1 过护栏门槛，commit 全下仍然生效", () => {
    resetBrainCaches();
    const input = makeDecideInput({
      aiHole: ["As", "Ks"],
      board: ["Qs", "Js", "Ts", "2d", "3c"],
      street: "river",
      pot: 800,
      currentBet: 300,
      aiStack: 1500,
      callAmount: 300,
      legalActions: [
        { type: "fold", amount: 0 },
        { type: "call", amount: 300 },
        { type: "raise", amount: 600 },
        { type: "allin", amount: 1500 },
      ],
      style: "gto",
    });
    input.state.streetActions = [SA(1, "bet", 80), SA(0, "raise", 300)];
    withPatchedRandom(31337, () => {
      const rng = mulberry32(555);
      for (let i = 0; i < 20; i++) {
        const r = brainDecide(input, "gto", rng);
        assertLegal(r.action, input);
        expect(r.action.type).toBe("allin");
      }
    });
  });

  it("无下注的主动推进保持 vs 随机胜率：AA 翻牌圈低 SPR 直接全下", () => {
    resetBrainCaches();
    const input = makeDecideInput({
      aiHole: ["As", "Ad"],
      board: ["Kh", "8d", "2c"],
      street: "flop",
      pot: 100,
      aiStack: 150, // stack/pot = 1.5 < 2
      callAmount: 0,
      legalActions: [
        { type: "check", amount: 0 },
        { type: "bet", amount: 10 },
        { type: "allin", amount: 150 },
      ],
      style: "gto",
    });
    withPatchedRandom(4242, () => {
      const rng = mulberry32(99);
      for (let i = 0; i < 20; i++) {
        const r = brainDecide(input, "gto", rng);
        assertLegal(r.action, input);
        expect(r.action.type).toBe("allin");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// F6：short all-in（增量 < minRaise）不计入加注层级
// ---------------------------------------------------------------------------

describe("F6：short all-in 不误计加注层级", () => {
  it("翻前：open 30 + 短码 all-in 35（增量 5 < minRaise 20）按「面对一次加注」处理", () => {
    resetBrainCaches();
    // hero BB 持 KTs（pct≈0.869）：level 1 → callPct≈0.64 跟注；
    // 若短码 all-in 被误计为再加注（旧行为 level 2）→ callVs3betPct 0.90 → 弃牌
    const mk = (third: SeatAction) => {
      const input = makeDecideInput({
        aiHole: ["Kd", "Td"],
        playerCount: 6,
        aiSeat: 2, // BB
        buttonSeat: 0,
        pot: 80,
        currentBet: 35,
        aiStreetBet: 10,
        aiStack: 990,
        callAmount: 25,
        legalActions: [
          { type: "fold", amount: 0 },
          { type: "call", amount: 25 },
          { type: "raise", amount: 70 },
          { type: "allin", amount: 990 },
        ],
        style: "gto",
      });
      input.state.streetActions = [SA(5, "raise", 30), third];
      return input;
    };
    const shortAllin = mk(SA(3, "allin", 35)); // 增量 5 < minRaise 20：跟注性质
    for (let i = 0; i < 10; i++) {
      const r = brainDecide(shortAllin, "gto", mulberry32(i));
      assertLegal(r.action, shortAllin);
      expect(r.action.type).toBe("call");
    }
    // 对照：同样抬线但增量足够（raise 到 60，增量 30 ≥ 20）→ 计入层级 → 弃牌
    const fullRaise = mk(SA(3, "raise", 60));
    fullRaise.state.currentBet = 60;
    fullRaise.callAmount = 50;
    fullRaise.legalActions = [
      { type: "fold", amount: 0 },
      { type: "call", amount: 50 },
      { type: "raise", amount: 120 },
      { type: "allin", amount: 990 },
    ];
    for (let i = 0; i < 10; i++) {
      const r = brainDecide(fullRaise, "gto", mulberry32(i));
      assertLegal(r.action, fullRaise);
      expect(r.action.type).toBe("fold");
    }
  });

  it("翻后：hero bet 50 后对手 short all-in 55（增量 5 < minRaise 10）不触发护栏升档", () => {
    // 99 on Kd7c2d4s5h（河牌 eq≈0.73，锁 rangeModeEnabled:false 隔离范围推断）：
    // seen=0 → vr=0.62 → 80% 概率价值加注；若误计 seen=1 → vr=0.78 → 只能跟注
    resetBrainCaches();
    const hole: [Card, Card] = ["9h", "9d"];
    const board: Card[] = ["Kd", "7c", "2d", "4s", "5h"];
    const RANGE_OFF = { rangeModeEnabled: false } as const;
    const mk = (second: SeatAction, currentBet: number, callAmount: number) => {
      const input = makeDecideInput({
        aiHole: hole,
        board,
        street: "river",
        pot: 300,
        currentBet,
        aiStack: 2000, // stack/pot ≈ 6.7，避开 SPR commit
        callAmount,
        legalActions: [
          { type: "fold", amount: 0 },
          { type: "call", amount: callAmount },
          { type: "raise", amount: currentBet + 10 },
          { type: "allin", amount: 2000 },
        ],
        style: "gto",
      });
      input.state.streetActions = [SA(1, "bet", 50), second];
      return input;
    };
    const N = 40;
    const shortAllin = mk(SA(0, "allin", 55), 55, 5);
    let raiseA = 0;
    const rngA = mulberry32(2026);
    for (let i = 0; i < N; i++) {
      const r = brainDecide(shortAllin, "gto", rngA, RANGE_OFF);
      assertLegal(r.action, shortAllin);
      if (r.action.type === "raise" || r.action.type === "allin") raiseA++;
    }
    expect(raiseA / N).toBeGreaterThan(0.6); // 护栏未升档：照常价值加注

    // 对照：完整 raise 到 150（增量 100 ≥ 10）→ seen=1 → vr=0.78 → 以跟注为主
    const fullRaise = mk(SA(0, "raise", 150), 150, 100);
    let callB = 0;
    const rngB = mulberry32(2026);
    for (let i = 0; i < N; i++) {
      const r = brainDecide(fullRaise, "gto", rngB, RANGE_OFF);
      assertLegal(r.action, fullRaise);
      if (r.action.type === "call") callB++;
    }
    expect(callB / N).toBeGreaterThanOrEqual(0.7); // 仅剩 ~10% 诈唬加注
  });
});

// ---------------------------------------------------------------------------
// F5：翻前按加注者位置调制门槛
// ---------------------------------------------------------------------------

describe("F5：同一手牌面对 UTG 加注 vs BTN 加注，继续频率显著不同", () => {
  // 6 人桌 hero HJ（座位 4）持 JTo（pct≈0.6726）面对开局加注 30：
  // gto callVsRaisePct 0.66；UTG（座位 3）修正 +0.04 → 0.70 弃牌为主（仅 ~9% 诈唬 3bet）；
  // BTN（座位 0）修正 -0.04 → 0.62 稳定跟注。
  // 注意：posAdjust 机制在 preflopRangeModeEnabled 开启时失效（被范围口径吸收），
  // 本组测试针对旧百分位口径，全部显式锁 preflopRangeModeEnabled:false。
  const LEGACY = { preflopRangeModeEnabled: false } as const;
  function facingOpenInput(raiserSeat: Seat) {
    const input = makeDecideInput({
      aiHole: ["Jd", "Tc"],
      playerCount: 6,
      aiSeat: 4, // HJ
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
    input.state.streetActions = [SA(raiserSeat, "raise", 30)];
    return input;
  }

  const continueFreq = (raiserSeat: Seat, tuning?: Parameters<typeof brainDecide>[3]) => {
    resetBrainCaches();
    const N = 200;
    let cont = 0;
    const rng = mulberry32(20260923);
    const input = facingOpenInput(raiserSeat);
    for (let i = 0; i < N; i++) {
      const r = brainDecide(input, "gto", rng, tuning);
      assertLegal(r.action, input);
      if (r.action.type !== "fold") cont++;
    }
    return cont / N;
  };

  it("旋钮开启时：UTG 加注收紧 / BTN 加注放宽", () => {
    const ON = { ...LEGACY, preflopPosAdjustEnabled: true } as const;
    const vsUtg = continueFreq(3, ON); // UTG：behind=5 → +0.04
    const vsBtn = continueFreq(0, ON); // BTN：behind=2 → -0.04
    expect(vsBtn).toBeGreaterThan(0.9);
    expect(vsUtg).toBeLessThan(0.25);
    expect(vsBtn - vsUtg).toBeGreaterThan(0.6);
  });

  it("posAdjust 默认关闭（bench 配对未过采纳线）：UTG 加注同样跟注；显式关闭与缺省逐点一致", () => {
    // 旧口径下：JTo（pct≈0.6726）≥ gto callVsRaisePct 0.66 → 稳定跟注
    const def = continueFreq(3, LEGACY);
    expect(def).toBeGreaterThan(0.9);
    const off = continueFreq(3, { ...LEGACY, preflopPosAdjustEnabled: false });
    expect(off).toBeGreaterThan(0.9);
    // 逐点一致（同 seed 决策完全相同）
    const input = facingOpenInput(3);
    for (let i = 0; i < 30; i++) {
      expect(
        brainDecide(input, "gto", mulberry32(i), {
          ...LEGACY,
          preflopPosAdjustEnabled: false,
        }),
      ).toEqual(brainDecide(input, "gto", mulberry32(i), LEGACY));
    }
  });

  it("单挑桌不加该修正（极端旋钮下决策逐点一致）", () => {
    resetBrainCaches();
    // HU hero BB 面对按钮开局：结构上恒走 bb_defend 分支，F5 不参与
    const mk = () => {
      const input = makeDecideInput({
        aiHole: ["Jd", "Tc"],
        playerCount: 2,
        aiSeat: 1, // BB
        buttonSeat: 0,
        pot: 45,
        currentBet: 30,
        aiStack: 1000,
        callAmount: 20,
        legalActions: [
          { type: "fold", amount: 0 },
          { type: "call", amount: 20 },
          { type: "raise", amount: 60 },
          { type: "allin", amount: 1000 },
        ],
        style: "gto",
      });
      input.state.streetActions = [SA(0, "raise", 30)];
      return input;
    };
    const input = mk();
    for (let i = 0; i < 30; i++) {
      const def = brainDecide(input, "gto", mulberry32(i));
      // 开启旋钮 + 极端修正量：HU 结构性不走该分支，决策仍应逐点一致
      const extreme = brainDecide(input, "gto", mulberry32(i), {
        preflopPosAdjustEnabled: true,
        preflopPosAdjustUTG: 0.5,
        preflopPosAdjustBTN: -0.5,
      });
      expect(extreme).toEqual(def);
    }
  });
});
