/**
 * 加注战护栏（warGuard）测试 —— L3/L1/L2 机制修复
 *
 * - L3 翻后：raisesSeen（本街攻击性动作数 - 1，bet 算第 1 次）升档价值再加注门槛，
 *   达到 warMaxRaises 后封顶（eq ≥ 0.97 坚果豁免）
 * - L1 翻前：被 4bet+ 时 premium 互加链封顶（pct ≥ 0.985 才继续，99-JJ 深筹码改跟注）
 * - L2 翻前：面对 3bet+ 的非 premium 跟注数额上限 25bb
 * - L2' 翻前：premium 的 25bb 跟注上限豁免收窄到 pct ≥ callVs3betPremiumExemptPct
 *   （0.985，KK+/AA 档）；99-JJ 档面对超额 3bet+ 跟注额同样弃牌
 * - warGuardEnabled:false 恢复旧行为（A/B 对照）
 * - 本文件测护栏机制本身：翻后 L3 用例固定 rangeModeEnabled:false
 *   （锁定 vs 随机范围的 equity 输入，隔离范围推断；护栏×范围推断的叠加见
 *   range.test.ts）
 */
import { describe, expect, it } from "vitest";
import type { Card, ConcreteAIStyle, Seat, SeatAction } from "@/lib/types";
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

/**
 * 河牌单挑：面对 currentBet / pot（所需胜率 ~27%+margin，中等牌稳定跟注）。
 * streetActions 为 SeatAction[]（F4 契约）；合成序列的加注增量需 ≥ 当时 minRaise
 * （引擎口径），否则 F6 回放只计完整加注，层级口径会变。
 */
function riverWarInput(
  hole: [Card, Card],
  board: Card[],
  streetActions: SeatAction[],
  opts: { pot?: number; currentBet?: number; stack?: number } = {},
) {
  const currentBet = opts.currentBet ?? 300;
  const stack = opts.stack ?? 2000; // stack/pot = 2.5，避开 SPR commit
  const input = makeDecideInput({
    aiHole: hole,
    board,
    street: "river",
    pot: opts.pot ?? 800,
    currentBet,
    aiStack: stack,
    callAmount: currentBet,
    legalActions: [
      { type: "fold", amount: 0 },
      { type: "call", amount: currentBet },
      { type: "raise", amount: currentBet * 2 },
      { type: "allin", amount: stack },
    ],
    style: "gto",
  });
  input.state.streetActions = streetActions;
  return input;
}

/** 带座位的动作（2 人桌：对手 = 座位 0，hero/AI = 座位 1） */
const SA = (seat: Seat, type: SeatAction["action"]["type"], amount: number): SeatAction => ({
  seat,
  action: { type, amount },
});

describe("warGuard 翻后加注战护栏（L3）", () => {
  // 99 on Kd7c2d4s5h：河牌单挑精确枚举 eq≈0.73；旧脑（0.65-0.03 门槛）80% 概率再加注
  // （rangeModeEnabled:false 锁定随机范围胜率输入，隔离范围推断机制）
  const hole: [Card, Card] = ["9h", "9d"];
  const board: Card[] = ["Kd", "7c", "2d", "4s", "5h"];
  const RANGE_OFF = { rangeModeEnabled: false } as const;

  it("raisesSeen=2（被 4bet+）、eq≈0.73：不再 raise，降级为 call", () => {
    resetBrainCaches();
    // bet 50 → raise 150 → raise 300（增量均 ≥ 当时 minRaise，引擎口径的完整加注）
    const input = riverWarInput(hole, board, [
      SA(0, "bet", 50),
      SA(1, "raise", 150),
      SA(0, "raise", 300),
    ]);
    for (let i = 0; i < 20; i++) {
      const r = brainDecide(input, "gto", mulberry32(i), RANGE_OFF);
      assertLegal(r.action, input);
      expect(r.action.type).toBe("call");
    }
  });

  it("raisesSeen=1（被 3bet）、eq≈0.73：低于 warRaiseEq3bet(0.78)，同样不再 raise", () => {
    resetBrainCaches();
    const input = riverWarInput(hole, board, [
      SA(1, "bet", 80),
      SA(0, "raise", 300),
    ]);
    for (let i = 0; i < 20; i++) {
      const r = brainDecide(input, "gto", mulberry32(i), RANGE_OFF);
      assertLegal(r.action, input);
      expect(r.action.type).toBe("call");
    }
  });

  it("raisesSeen=0（首次面对下注）、eq≈0.73：不触发护栏，仍按旧门槛价值加注", () => {
    resetBrainCaches();
    const input = riverWarInput(hole, board, [SA(0, "bet", 300)]);
    const rng = mulberry32(20260923);
    let raises = 0;
    const N = 30;
    for (let i = 0; i < N; i++) {
      const t = brainDecide(input, "gto", rng, RANGE_OFF).action.type;
      if (t === "raise" || t === "allin") raises++;
    }
    expect(raises / N).toBeGreaterThan(0.6);
  });

  it("raisesSeen ≥ warMaxRaises(3)：非坚果 eq 彻底封顶（call），坚果（eq=1）豁免仍可加注", () => {
    resetBrainCaches();
    // 4 次完整加注链（增量 100/150/300 均 ≥ 当时 minRaise），hero 面对 600
    const war4: SeatAction[] = [
      SA(1, "bet", 50),
      SA(0, "raise", 150),
      SA(1, "raise", 300),
      SA(0, "raise", 600),
    ];
    const capped = riverWarInput(hole, board, war4, { pot: 1500, currentBet: 600 });
    for (let i = 0; i < 20; i++) {
      const r = brainDecide(capped, "gto", mulberry32(1000 + i), RANGE_OFF);
      assertLegal(r.action, capped);
      expect(r.action.type).toBe("call");
    }
    // 皇家同花顺（河牌精确枚举 eq=1 ≥ warNutsEq 0.97）：突破封顶
    // （此用例不锁 rangeMode：坚果混合胜率仍为 1，顺带覆盖护栏×范围推断叠加）
    const nuts = riverWarInput(
      ["As", "Ks"],
      ["Qs", "Js", "Ts", "2d", "3c"],
      war4,
      { pot: 1500, currentBet: 600 },
    );
    const rng = mulberry32(555);
    let raises = 0;
    const N = 30;
    for (let i = 0; i < N; i++) {
      const t = brainDecide(nuts, "gto", rng).action.type;
      if (t === "raise" || t === "allin") raises++;
    }
    expect(raises / N).toBeGreaterThan(0.6);
  });

  it("真实漏勺场景：88 on 222A6（eq≈0.79 低葫芦）被 4bet 后不再再加注", () => {
    resetBrainCaches();
    const input = riverWarInput(
      ["8h", "8d"],
      ["2h", "2d", "2c", "Ah", "6c"],
      [SA(0, "bet", 50), SA(1, "raise", 150), SA(0, "raise", 300)],
    );
    for (let i = 0; i < 20; i++) {
      const r = brainDecide(input, "gto", mulberry32(2000 + i), RANGE_OFF);
      assertLegal(r.action, input);
      expect(r.action.type).toBe("call");
    }
  });

  it("warGuardEnabled:false 恢复旧行为（raisesSeen=2、eq≈0.73 照常再加注）", () => {
    resetBrainCaches();
    const input = riverWarInput(hole, board, [
      SA(0, "bet", 50),
      SA(1, "raise", 150),
      SA(0, "raise", 300),
    ]);
    const rng = mulberry32(777);
    let raises = 0;
    const N = 30;
    for (let i = 0; i < N; i++) {
      const t = brainDecide(input, "gto", rng, {
        warGuardEnabled: false,
        rangeModeEnabled: false,
      }).action.type;
      if (t === "raise" || t === "allin") raises++;
    }
    expect(raises / N).toBeGreaterThan(0.6);
  });
});

/** 翻前 6 人桌 3bet+ 局面 */
function preflopWarInput(
  hole: [Card, Card],
  streetActions: SeatAction[],
  currentBet: number,
  stack: number,
  style: ConcreteAIStyle = "gto",
) {
  const input = makeDecideInput({
    aiHole: hole,
    playerCount: 6,
    aiSeat: 4,
    buttonSeat: 0,
    pot: currentBet + 200,
    currentBet,
    aiStack: stack,
    callAmount: currentBet,
    legalActions: [
      { type: "fold", amount: 0 },
      { type: "call", amount: currentBet },
      { type: "raise", amount: currentBet * 2 },
      { type: "allin", amount: stack },
    ],
    style,
  });
  input.state.streetActions = streetActions;
  return input;
}

describe("warGuard 翻前 premium 互加链封顶（L1）", () => {
  // JJ pct≈0.982 ∈ [premiumPct 0.965, premium5betPct 0.985)；4bet 链：open/3bet/4bet
  // （座位 5/0 交替：open CO → 3bet BTN → 4bet CO；增量均 ≥ 当时 minRaise）
  const hole: [Card, Card] = ["Jh", "Jd"];
  const fourBetChain: SeatAction[] = [
    SA(5, "raise", 30),
    SA(0, "raise", 90),
    SA(5, "raise", 200),
  ];

  it("JJ 深筹码（200bb）面对 4bet：封顶降级为 call，不再 ×2.2 互加", () => {
    const input = preflopWarInput(hole, fourBetChain, 200, 2000);
    for (let i = 0; i < 10; i++) {
      const r = brainDecide(input, "gto", mulberry32(i));
      assertLegal(r.action, input);
      expect(r.action.type).toBe("call");
    }
  });

  it("KK（pct≈0.994 ≥ premium5betPct）面对 4bet：不受影响，继续加注", () => {
    const input = preflopWarInput(["Kh", "Kd"], fourBetChain, 200, 2000);
    const r = brainDecide(input, "gto", mulberry32(1));
    assertLegal(r.action, input);
    expect(r.action.type).toBe("raise");
    expect(r.action.amount).toBe(440); // 旧逻辑 currentBet × fourBetMult(2.2)
  });

  it("JJ 浅筹码（18bb < premiumAllinBB 30bb）面对 4bet：维持旧的全下逻辑", () => {
    const input = preflopWarInput(hole, fourBetChain, 200, 180);
    const r = brainDecide(input, "gto", mulberry32(1));
    assertLegal(r.action, input);
    expect(r.action.type).toBe("allin");
  });

  it("warGuardEnabled:false 时 JJ 深筹码面对 4bet 恢复旧行为（×2.2 再加注）", () => {
    const input = preflopWarInput(hole, fourBetChain, 200, 2000);
    const r = brainDecide(input, "gto", mulberry32(1), { warGuardEnabled: false });
    assertLegal(r.action, input);
    expect(r.action.type).toBe("raise");
    expect(r.action.amount).toBe(440);
  });

  it("JJ 面对 3bet（raisesSeen=1，未达 4bet 档）：不封顶，按旧逻辑 4bet", () => {
    const input = preflopWarInput(hole, [SA(5, "raise", 30), SA(0, "raise", 90)], 90, 2000);
    const r = brainDecide(input, "gto", mulberry32(1));
    assertLegal(r.action, input);
    expect(r.action.type).toBe("raise");
    expect(r.action.amount).toBe(198); // 90 × 2.2
  });
});

describe("warGuard 翻前 3bet+ 跟注数额上限（L2）", () => {
  // AKs pct≈0.958：≥ callVs3betPct(gto 0.90) 但 < premiumPct(0.965)
  const hole: [Card, Card] = ["As", "Ks"];
  const threeBet: SeatAction[] = [SA(5, "raise", 30), SA(0, "raise", 120)];

  it("AKs 面对 3bet、跟注额 30bb > 25bb 上限：弃牌", () => {
    const input = preflopWarInput(hole, threeBet, 300, 2000);
    const r = brainDecide(input, "gto", mulberry32(1));
    assertLegal(r.action, input);
    expect(r.action.type).toBe("fold");
  });

  it("AKs 面对 3bet、跟注额 20bb ≤ 25bb 上限：照旧跟注", () => {
    const input = preflopWarInput(hole, threeBet, 200, 2000);
    const r = brainDecide(input, "gto", mulberry32(1));
    assertLegal(r.action, input);
    expect(r.action.type).toBe("call");
  });

  it("AA（premium 档豁免）面对超额 3bet：不弃牌", () => {
    const input = preflopWarInput(["As", "Ad"], threeBet, 300, 2000);
    const r = brainDecide(input, "gto", mulberry32(1));
    assertLegal(r.action, input);
    expect(r.action.type).not.toBe("fold");
  });

  it("warGuardEnabled:false 时 AKs 跟注 30bb 恢复旧行为（跟注）", () => {
    const input = preflopWarInput(hole, threeBet, 300, 2000);
    const r = brainDecide(input, "gto", mulberry32(1), { warGuardEnabled: false });
    assertLegal(r.action, input);
    expect(r.action.type).toBe("call");
  });
});

describe("warGuard 翻前 premium 跟注上限豁免收窄（L2'）", () => {
  // 99 pct≈0.970 ∈ [premiumPct 0.965, callVs3betPremiumExemptPct 0.985)：
  // 跟注额超 25bb 上限时不再豁免。open 30 / 3bet 90 / 4bet 400（40bb 跟注额）
  const fourBetChain40bb: SeatAction[] = [
    SA(5, "raise", 30),
    SA(0, "raise", 90),
    SA(5, "raise", 400),
  ];

  it("99 深筹码（200bb）面对 4bet 链、跟注额 40bb > 25bb 上限：弃牌", () => {
    const input = preflopWarInput(["9h", "9d"], fourBetChain40bb, 400, 2000);
    for (let i = 0; i < 10; i++) {
      const r = brainDecide(input, "gto", mulberry32(i));
      assertLegal(r.action, input);
      expect(r.action.type).toBe("fold");
    }
  });

  it("AA（pct=1 ≥ 豁免档）面对同样 40bb 4bet 链：不弃牌（继续 ×2.2 加注）", () => {
    const input = preflopWarInput(["As", "Ad"], fourBetChain40bb, 400, 2000);
    const r = brainDecide(input, "gto", mulberry32(1));
    assertLegal(r.action, input);
    expect(r.action.type).toBe("raise");
    expect(r.action.amount).toBe(880); // 400 × fourBetMult(2.2)
  });

  it("KK（pct≈0.994 ≥ 豁免档）面对 40bb 4bet 链：豁免，继续加注", () => {
    const input = preflopWarInput(["Kh", "Kd"], fourBetChain40bb, 400, 2000);
    const r = brainDecide(input, "gto", mulberry32(1));
    assertLegal(r.action, input);
    expect(r.action.type).toBe("raise");
    expect(r.action.amount).toBe(880);
  });

  it("99 浅筹码（18bb < 25bb 上限）面对 4bet 链：不受影响，维持全下", () => {
    const input = preflopWarInput(
      ["9h", "9d"],
      [SA(5, "raise", 30), SA(0, "raise", 90), SA(5, "raise", 150)],
      150,
      180,
    );
    const r = brainDecide(input, "gto", mulberry32(1));
    assertLegal(r.action, input);
    expect(r.action.type).toBe("allin");
  });

  it("callVs3betPremiumExemptPct:0（=全部 premium 豁免，旧行为）时 99 面对 40bb 恢复跟注", () => {
    const input = preflopWarInput(["9h", "9d"], fourBetChain40bb, 400, 2000);
    const r = brainDecide(input, "gto", mulberry32(1), { callVs3betPremiumExemptPct: 0 });
    assertLegal(r.action, input);
    expect(r.action.type).toBe("call");
  });

  it("warGuardEnabled:false 时 99 面对 40bb 恢复 L1 前旧行为（×2.2 再加注）", () => {
    const input = preflopWarInput(["9h", "9d"], fourBetChain40bb, 400, 2000);
    const r = brainDecide(input, "gto", mulberry32(1), { warGuardEnabled: false });
    assertLegal(r.action, input);
    expect(r.action.type).toBe("raise");
    expect(r.action.amount).toBe(880);
  });
});
