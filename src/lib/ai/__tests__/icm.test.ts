/**
 * Phase 7 锦标赛上下文（轻量 ICM 风格调整）测试
 *
 * - computeTournamentPhase：阶段划分边界（>0.6 early / >0.35 middle / >0.2 bubble / else final）
 * - brain：bubble/final 短码收紧跟注门槛（生效 / early 不生效 / icmEnabled:false 不生效）
 * - brain：bubble/final 大筹码主动诈唬频率上调（×icmBigStackPressure）
 * - prompt：buildSlimPrompt 锦标赛事实段渲染（有/无 tournament）
 */
import { describe, expect, it } from "vitest";
import type { Card, PlayerAction, TournamentContext } from "@/lib/types";
import { computeTournamentPhase } from "@/lib/types";
import { brainDecide, resetBrainCaches } from "../brain";
import { buildSlimPrompt } from "../prompt";
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

/** 构造一个 TournamentContext 的便捷工厂（缺省值可覆盖） */
function makeTourney(overrides: Partial<TournamentContext> = {}): TournamentContext {
  return {
    playersRemaining: 2,
    totalPlayers: 8,
    myRankByChips: 2,
    avgStackBB: 25,
    myStackBB: 12,
    blindLevelBB: 10,
    phase: "bubble",
    ...overrides,
  };
}

describe("computeTournamentPhase 阶段划分边界", () => {
  it(">0.6 early；>0.35 middle；>0.2 bubble；否则 final（含等值边界）", () => {
    expect(computeTournamentPhase(8, 8)).toBe("early"); // 1.0
    expect(computeTournamentPhase(5, 8)).toBe("early"); // 0.625
    expect(computeTournamentPhase(3, 5)).toBe("middle"); // 恰 0.6 → 不 early
    expect(computeTournamentPhase(4, 8)).toBe("middle"); // 0.5
    expect(computeTournamentPhase(3, 8)).toBe("middle"); // 0.375
    expect(computeTournamentPhase(7, 20)).toBe("bubble"); // 恰 0.35 → 不 middle
    expect(computeTournamentPhase(2, 8)).toBe("bubble"); // 0.25
    expect(computeTournamentPhase(1, 5)).toBe("final"); // 恰 0.2 → 不 bubble
    expect(computeTournamentPhase(1, 8)).toBe("final"); // 0.125
  });
});

describe("brain 锦标赛短码收紧（bubble/final 且 myStackBB < 15）", () => {
  // A3o 翻前百分位 = 114/168 ≈ 0.679：gto 面对一次加注的跟注门槛 0.66 → 默认跟注；
  // 收紧 +0.04 后门槛 0.70 → 弃牌（A3o 非同花/连张/对子，不会走诈唬 3bet 分支）
  // （icmEnabled 默认关闭——Phase 7 台架未过采纳线；以下生效分支均显式开启）
  // 本组针对旧百分位口径（preflopRangeModeEnabled:false；范围口径下 icm.callTighten
  // 同量叠加到对范围胜率门槛，机制一致，但此处沿用百分位场景做回归锚点）。
  const ICM_ON = { icmEnabled: true, preflopRangeModeEnabled: false } as const;
  const LEGACY = { preflopRangeModeEnabled: false } as const;
  const FACING_RAISE: PlayerAction[] = [
    { type: "fold", amount: 0 },
    { type: "call", amount: 30 },
    { type: "raise", amount: 60 },
    { type: "allin", amount: 120 },
  ];
  const mk = (tournament?: TournamentContext) => {
    const input = makeDecideInput({
      aiHole: ["Ah", "3d"],
      playerCount: 6,
      aiSeat: 4, // 6 人桌按钮 0：UTG3 HJ4 → 身后 4 人，无大盲关门折扣
      buttonSeat: 0,
      pot: 45,
      currentBet: 30,
      aiStack: 120,
      callAmount: 30,
      legalActions: FACING_RAISE,
      style: "gto",
    });
    return tournament ? { ...input, tournament } : input;
  };

  it("无 tournament（现金局口径）：A3o 面对一次加注 → 跟注", () => {
    for (let i = 0; i < 10; i++) {
      expect(brainDecide(mk(), "gto", mulberry32(i + 1), LEGACY).action.type).toBe("call");
    }
  });

  it("bubble 短码（12bb < 15bb）：同一手牌收紧为弃牌", () => {
    for (let i = 0; i < 10; i++) {
      expect(
        brainDecide(mk(makeTourney()), "gto", mulberry32(i + 1), ICM_ON).action.type,
      ).toBe("fold");
    }
  });

  it("icmEnabled 缺省（默认 false）：有 tournament 也不调整", () => {
    for (let i = 0; i < 5; i++) {
      expect(brainDecide(mk(makeTourney()), "gto", mulberry32(i + 1), LEGACY).action.type).toBe(
        "call",
      );
    }
  });

  it("early/middle 阶段零修正：仍是跟注", () => {
    for (const phase of ["early", "middle"] as const) {
      for (let i = 0; i < 5; i++) {
        expect(
          brainDecide(mk(makeTourney({ phase })), "gto", mulberry32(i + 1), ICM_ON)
            .action.type,
        ).toBe("call");
      }
    }
  });

  it("final 阶段同样收紧；icmEnabled:false 不生效；非短码（30bb）不收紧", () => {
    expect(
      brainDecide(mk(makeTourney({ phase: "final" })), "gto", mulberry32(7), ICM_ON)
        .action.type,
    ).toBe("fold");
    expect(
      brainDecide(mk(makeTourney()), "gto", mulberry32(7), {
        icmEnabled: false,
        preflopRangeModeEnabled: false,
      })
        .action.type,
    ).toBe("call");
    expect(
      brainDecide(mk(makeTourney({ myStackBB: 30 })), "gto", mulberry32(7), ICM_ON)
        .action.type,
    ).toBe("call");
  });

  it("收紧量旋钮化：icmBubbleCallTighten=0.01 时不足以弃掉 A3o", () => {
    expect(
      brainDecide(mk(makeTourney()), "gto", mulberry32(7), {
        icmEnabled: true,
        icmBubbleCallTighten: 0.01,
        preflopRangeModeEnabled: false,
      }).action.type,
    ).toBe("call");
  });
});

describe("brain 锦标赛大筹码施压（bubble/final 前 1/3 且 >2×平均）", () => {
  // 72o 在 KQJ 翻牌面为纯空气：主动决策只可能走纯诈唬分支，
  // 概率 = bluffFreqEff × pureBluffK × bluffScale（单挑 bluffScale=1）
  const CAN_CHECK: PlayerAction[] = [
    { type: "check", amount: 0 },
    { type: "bet", amount: 10 },
    { type: "allin", amount: 300 },
  ];
  const mk = (tournament?: TournamentContext) => {
    const input = makeDecideInput({
      aiHole: ["7d", "2c"] as [Card, Card],
      board: ["Ks", "Qh", "Jd"] as Card[],
      street: "flop",
      pot: 100,
      aiStack: 300,
      callAmount: 0,
      legalActions: CAN_CHECK,
      style: "gto",
    });
    return tournament ? { ...input, tournament } : input;
  };
  const BIG_STACK = makeTourney({
    playersRemaining: 3,
    totalPlayers: 9,
    myRankByChips: 1, // 1×3 ≤ 3 → 前 1/3
    myStackBB: 80,
    avgStackBB: 30, // 80 > 60
  });

  function countBets(
    tournament: TournamentContext | undefined,
    tuning?: Parameters<typeof brainDecide>[3],
  ): number {
    const rng = mulberry32(7);
    let bets = 0;
    for (let i = 0; i < 800; i++) {
      const t = brainDecide(mk(tournament), "gto", rng, tuning).action.type;
      if (t === "bet" || t === "allin") bets++;
    }
    return bets;
  }

  it("大筹码诈唬频率上调（×1.3）：施压臂下注数显著高于基准臂", () => {
    resetBrainCaches(); // 两臂共享同一蒙特卡洛胜率缓存，决策可比
    const base = countBets(undefined);
    const pressured = countBets(BIG_STACK, { icmEnabled: true });
    expect(base).toBeGreaterThan(30); // 基准纯诈唬频率确实触发（≈0.18×800）
    expect(pressured).toBeGreaterThan(base); // 共享 rng 序列下差值确定性为正
  });

  it("icmEnabled:false / 缺省（默认关）与无 tournament 逐点一致；early 阶段零修正", () => {
    resetBrainCaches();
    const base = countBets(undefined);
    expect(countBets(BIG_STACK, { icmEnabled: false })).toBe(base);
    expect(countBets(BIG_STACK)).toBe(base); // 默认 icmEnabled:false
    expect(countBets({ ...BIG_STACK, phase: "early" }, { icmEnabled: true })).toBe(base);
  });

  it("排名不在前 1/3 或不深于 2×平均：不上调", () => {
    resetBrainCaches();
    const base = countBets(undefined);
    // 2×3 > 3 → 不在前 1/3
    expect(countBets({ ...BIG_STACK, myRankByChips: 2 }, { icmEnabled: true })).toBe(base);
    // 50 ≤ 60 → 不深于 2×平均
    expect(countBets({ ...BIG_STACK, myStackBB: 50 }, { icmEnabled: true })).toBe(base);
  });
});

describe("buildSlimPrompt 锦标赛事实段", () => {
  const base = makeDecideInput({
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

  it("有 tournament 时渲染一行事实段（只给事实不给说教）", () => {
    const { user } = buildSlimPrompt({
      ...base,
      tournament: makeTourney({
        playersRemaining: 5,
        totalPlayers: 8,
        myRankByChips: 2,
        myStackBB: 38.4,
        avgStackBB: 25,
        phase: "bubble",
      }),
    });
    expect(user).toContain("- 锦标赛：还剩 5/8 人，你的筹码排第 2（38bb，平均 25bb），阶段：泡沫期");
  });

  it("无 tournament 时不出现锦标赛段（现金局 prompt 逐字不变）", () => {
    const { system, user } = buildSlimPrompt(base);
    expect(system + user).not.toContain("锦标赛");
    expect(system + user).not.toContain("阶段");
  });

  it("各阶段中文名映射正确", () => {
    for (const [phase, cn] of [
      ["early", "早期"],
      ["middle", "中期"],
      ["bubble", "泡沫期"],
      ["final", "决赛期"],
    ] as const) {
      const { user } = buildSlimPrompt({ ...base, tournament: makeTourney({ phase }) });
      expect(user).toContain(`阶段：${cn}`);
    }
  });
});
