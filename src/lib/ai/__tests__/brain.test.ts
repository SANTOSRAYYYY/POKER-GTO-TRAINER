/**
 * brain.ts（胜率驱动决策引擎）测试
 *
 * - 正确性：范围表翻前、equity 翻后、底池赔率、坚果/空气边界
 * - 风格相对关系：nit 紧 / maniac 松凶 / 跟注站被动等性格保留
 * - 合法性 fuzz：真实引擎随机局面下任何风格都返回合法动作
 * - 性能 benchmark：翻牌圈单挑平均决策耗时 < 120ms（min-of-3 抗负载尖刺；rangeMode 默认开启，含范围 MC）
 */
import { describe, expect, it } from "vitest";
import type { Card, ConcreteAIStyle, PlayerAction, Seat } from "@/lib/types";
import { brainDecide, brainStats } from "../brain";
import { buildPrompt } from "../prompt";
import { assertLegal, makeDecideInput } from "./helpers";
import { applyAction, createGame, legalActions } from "@/lib/poker/game";

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

/** 9 人桌固定 legal 集（盲注 5/10） */
const PF_OPEN_LEGAL: PlayerAction[] = [
  { type: "fold", amount: 0 },
  { type: "call", amount: 10 },
  { type: "raise", amount: 20 },
  { type: "allin", amount: 1000 },
];

describe("brainDecide 翻前范围表", () => {
  it("72o 在 UTG（9 人桌）开局：全部风格 100% 弃牌", () => {
    for (const style of ALL_STYLES) {
      const input = makeDecideInput({
        aiHole: ["7d", "2c"],
        playerCount: 9,
        aiSeat: 3, // 按钮 0：SB1 BB2 UTG3
        buttonSeat: 0,
        pot: 15,
        currentBet: 10,
        aiStack: 1000,
        callAmount: 10,
        legalActions: PF_OPEN_LEGAL,
        style,
      });
      for (let i = 0; i < 30; i++) {
        const r = brainDecide(input, style);
        assertLegal(r.action, input);
        expect(r.action.type).toBe("fold");
      }
    }
  });

  it("AA 翻前任何位置面对加注：任何风格都不弃牌", () => {
    for (let aiSeat = 0; aiSeat < 9; aiSeat++) {
      const streetBet = aiSeat === 1 ? 5 : aiSeat === 2 ? 10 : 0;
      const call = 30 - streetBet;
      for (const style of ALL_STYLES) {
        const input = makeDecideInput({
          aiHole: ["As", "Ad"],
          playerCount: 9,
          aiSeat,
          buttonSeat: 0,
          pot: 45,
          currentBet: 30,
          aiStreetBet: streetBet,
          aiStack: 1000 - streetBet,
          callAmount: call,
          legalActions: [
            { type: "fold", amount: 0 },
            { type: "call", amount: call },
            { type: "raise", amount: 60 },
            { type: "allin", amount: 1000 },
          ],
          style,
        });
        // 显式声明本街有人加注过（合成快照；SeatAction 带座位，F4 契约）
        input.state.streetActions = [
          { seat: ((aiSeat + 1) % 9) as Seat, action: { type: "raise", amount: 30 } },
        ];
        for (let i = 0; i < 5; i++) {
          const r = brainDecide(input, style);
          assertLegal(r.action, input);
          expect(r.action.type).not.toBe("fold");
        }
      }
    }
  });

  it("位置松紧：CO 位 K8o，lag 显著比 nit 更愿意开局", () => {
    // 6 人桌按钮 0：BTN0 SB1 BB2 UTG3 HJ4 CO5；K8o 在 BTN 表范围、不在 HJ/更紧表
    const mk = (style: ConcreteAIStyle) =>
      makeDecideInput({
        aiHole: ["Kd", "8c"],
        playerCount: 6,
        aiSeat: 5,
        buttonSeat: 0,
        pot: 15,
        currentBet: 10,
        aiStack: 1000,
        callAmount: 10,
        legalActions: PF_OPEN_LEGAL,
        style,
      });
    const N = 100;
    let nitFolds = 0;
    let lagRaises = 0;
    for (let i = 0; i < N; i++) {
      if (brainDecide(mk("nit"), "nit").action.type === "fold") nitFolds++;
      const rl = brainDecide(mk("lag"), "lag").action.type;
      if (rl === "raise" || rl === "allin") lagRaises++;
    }
    expect(nitFolds / N).toBeGreaterThan(0.9);
    expect(lagRaises / N).toBeGreaterThan(0.8);
  });

  it("BTN 位 J4o 垃圾牌：maniac 明显比 nit 玩得多", () => {
    const mk = (style: ConcreteAIStyle) =>
      makeDecideInput({
        aiHole: ["Jd", "4c"],
        playerCount: 6,
        aiSeat: 0, // 按钮位
        buttonSeat: 0,
        pot: 15,
        currentBet: 10,
        aiStack: 1000,
        callAmount: 10,
        legalActions: PF_OPEN_LEGAL,
        style,
      });
    const N = 100;
    let maniacPlays = 0;
    let nitPlays = 0;
    for (let i = 0; i < N; i++) {
      if (brainDecide(mk("maniac"), "maniac").action.type !== "fold") maniacPlays++;
      if (brainDecide(mk("nit"), "nit").action.type !== "fold") nitPlays++;
    }
    expect(maniacPlays / N).toBeGreaterThan(0.5);
    expect(nitPlays / N).toBeLessThan(0.1);
  });

  it("短筹码（<12bb）范围内手牌优先直接全下", () => {
    const input = makeDecideInput({
      aiHole: ["As", "Qd"],
      playerCount: 9,
      aiSeat: 6, // LJ
      buttonSeat: 0,
      pot: 15,
      currentBet: 10,
      aiStack: 90, // 9bb
      callAmount: 10,
      legalActions: [
        { type: "fold", amount: 0 },
        { type: "call", amount: 10 },
        { type: "raise", amount: 20 },
        { type: "allin", amount: 100 },
      ],
      style: "tag",
    });
    let allins = 0;
    for (let i = 0; i < 50; i++) {
      const r = brainDecide(input, "tag");
      assertLegal(r.action, input);
      if (r.action.type === "allin") allins++;
    }
    expect(allins / 50).toBeGreaterThan(0.9);
  });
});

describe("brainDecide 翻后 equity 驱动", () => {
  it("河牌坚果面对任何非 all-in 注：0 弃牌率", () => {
    for (const style of ALL_STYLES) {
      const input = makeDecideInput({
        aiHole: ["As", "Ks"],
        board: ["Qs", "Js", "Ts", "2d", "3c"],
        street: "river",
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
        style,
      });
      for (let i = 0; i < 20; i++) {
        const r = brainDecide(input, style);
        assertLegal(r.action, input);
        expect(r.action.type).not.toBe("fold");
      }
    }
  });

  it("河牌纯空气面对 1.5 池 all-in：gto/tag 弃牌率 > 90%", () => {
    for (const style of ["gto", "tag"] as const) {
      const input = makeDecideInput({
        aiHole: ["8d", "3c"],
        board: ["Ks", "Qh", "Jd", "4c", "2s"],
        street: "river",
        pot: 250,
        currentBet: 150,
        aiStack: 150,
        callAmount: 150,
        legalActions: [
          { type: "fold", amount: 0 },
          { type: "call", amount: 150 },
        ],
        style,
      });
      let folds = 0;
      const N = 30;
      for (let i = 0; i < N; i++) {
        const r = brainDecide(input, style);
        assertLegal(r.action, input);
        if (r.action.type === "fold") folds++;
      }
      expect(folds / N).toBeGreaterThan(0.9);
    }
  });

  it("底池赔率正确应用：equity≈22% 的顺子听，小注跟注、大注弃牌（gto）", () => {
    // JTo 在 Kh8d2c 翻牌：卡顺 + 两高张。rangeMode 纯范围口径（blend 0）下
    // 单挑 vs top55%+诈唬范围胜率 ≈0.22。小注 0.15 池（阈值 0.13+0.03=0.16，
    // 间距 ~2.9σ 按 400 次迭代缓存估计 σ≈0.021 计）跟注；1.5 池（阈值 0.63）弃牌。
    const base = {
      aiHole: ["Jd", "Tc"] as [Card, Card],
      board: ["Kh", "8d", "2c"] as Card[],
      street: "flop" as const,
      pot: 100,
      aiStack: 300,
      style: "gto" as const,
    };
    const small = makeDecideInput({
      ...base,
      currentBet: 15, // 0.15 池 → 所需胜率 13%
      callAmount: 15,
      legalActions: [
        { type: "fold", amount: 0 },
        { type: "call", amount: 15 },
        { type: "raise", amount: 30 },
        { type: "allin", amount: 300 },
      ],
    });
    const big = makeDecideInput({
      ...base,
      currentBet: 150, // 1.5 池 → 所需胜率 60%
      callAmount: 150,
      legalActions: [
        { type: "fold", amount: 0 },
        { type: "call", amount: 150 },
        { type: "raise", amount: 250 },
        { type: "allin", amount: 300 },
      ],
    });
    const N = 100;
    let smallCalls = 0;
    let bigFolds = 0;
    for (let i = 0; i < N; i++) {
      if (brainDecide(small, "gto").action.type === "call") smallCalls++;
      if (brainDecide(big, "gto").action.type === "fold") bigFolds++;
    }
    expect(smallCalls / N).toBeGreaterThan(0.9);
    expect(bigFolds / N).toBeGreaterThan(0.9);
  });

  it("河牌坚果无人下注：稳定价值下注（gto/tag）", () => {
    for (const style of ["gto", "tag"] as const) {
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
        style,
      });
      let bets = 0;
      const N = 30;
      for (let i = 0; i < N; i++) {
        const r = brainDecide(input, style);
        assertLegal(r.action, input);
        if (r.action.type === "bet" || r.action.type === "allin") bets++;
      }
      expect(bets / N).toBeGreaterThan(0.9);
    }
  });

  it("空气牌无人下注时的诈唬率：maniac > tag > nit", () => {
    const mk = () =>
      makeDecideInput({
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
      });
    const N = 400;
    const rate = (style: ConcreteAIStyle) => {
      let bets = 0;
      for (let i = 0; i < N; i++) {
        const t = brainDecide(mk(), style).action.type;
        if (t === "bet" || t === "allin") bets++;
      }
      return bets / N;
    };
    const maniac = rate("maniac");
    const tag = rate("tag");
    const nit = rate("nit");
    expect(maniac).toBeGreaterThan(0.5);
    expect(maniac).toBeGreaterThan(tag);
    expect(tag).toBeGreaterThan(nit);
  });
});

describe("brainDecide 合法性 fuzz（真实引擎随机局面）", () => {
  it("任何局面都返回合法动作", () => {
    const rng = mulberry32(20260922);
    for (let hand = 0; hand < 20; hand++) {
      const players = 2 + Math.floor(rng() * 8); // 2-9 人
      let state = createGame({
        players,
        smallBlind: 5,
        bigBlind: 10,
        stack: 1000,
        buttonSeat: Math.floor(rng() * players),
      });
      let brainActs = 0;
      let guard = 0;
      while (!state.handOver && guard++ < 60 && brainActs < 6) {
        const seat = state.currentSeat!;
        const legal = legalActions(state);
        const me = state.players[seat];
        const callAmount = Math.max(0, state.currentBet - me.streetBet);
        const style = ALL_STYLES[Math.floor(rng() * ALL_STYLES.length)];
        const input = {
          state,
          legalActions: legal,
          callAmount,
          potOdds: callAmount > 0 ? callAmount / (state.pot + callAmount) : 0,
          style,
        };
        const r = brainDecide(input, style);
        assertLegal(r.action, input);
        brainActs++;
        // 一半用 brain 的动作推进，一半随机合法动作推进（覆盖更多局面）
        const next = rng() < 0.5
          ? r.action
          : legal[Math.floor(rng() * legal.length)];
        state = applyAction(state, next);
      }
    }
  }, 30_000);
});

describe("brainDecide 性能", () => {
  it("翻牌圈单挑 decide 平均 < 120ms（min-of-3 × 50 次冷缓存，含范围推断 MC）", () => {
    // min-of-3：跑 3 轮取 3 个平均值的最小值判定——消除 CI/本机负载尖刺把单轮
    // 平均值顶过阈值造成的误报；阈值保持 120ms 不变（考察的是引擎本身足够快）。
    // 每轮换种子：胜率/MC 结果有跨调用缓存，同种子会让后两轮变成纯缓存命中
    // （≈0ms），换种子保持每轮都是「冷缓存」负载。
    const runOnce = (seed: number): number => {
      const rng = mulberry32(seed);
      const deck = (): Card[] => {
        const suits = ["s", "h", "d", "c"] as const;
        const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"] as const;
        const d: Card[] = [];
        for (const s of suits) for (const r of ranks) d.push(`${r}${s}` as Card);
        // Fisher-Yates
        for (let i = d.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [d[i], d[j]] = [d[j], d[i]];
        }
        return d;
      };
      const times: number[] = [];
      for (let i = 0; i < 50; i++) {
        const d = deck();
        const hero: [Card, Card] = [d[0], d[1]];
        const board = d.slice(2, 5);
        const input = makeDecideInput({
          aiHole: hero,
          board,
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
        const t0 = performance.now();
        brainDecide(input, "gto");
        times.push(performance.now() - t0);
      }
      return times.reduce((a, b) => a + b, 0) / times.length;
    };
    const avgs = [runOnce(777), runOnce(778), runOnce(779)];
    const best = Math.min(...avgs);
    // eslint-disable-next-line no-console
    console.log(`[benchmark] 翻牌圈单挑 decide 平均耗时 best ${best.toFixed(1)}ms（min-of-3 × n=50：${avgs.map((a) => a.toFixed(1)).join(" / ")}，冷缓存，rangeMode 默认开启）`);
    expect(best).toBeLessThan(120);
  }, 60_000);
});

describe("brainStats + prompt 数据注入", () => {
  it("河牌坚果：胜率精确为 1，所需胜率按赔率计算", () => {
    const input = makeDecideInput({
      aiHole: ["As", "Ks"],
      board: ["Qs", "Js", "Ts", "2d", "3c"],
      street: "river",
      pot: 100,
      currentBet: 50,
      callAmount: 50,
      aiStack: 250,
      legalActions: [
        { type: "fold", amount: 0 },
        { type: "call", amount: 50 },
        { type: "raise", amount: 100 },
        { type: "allin", amount: 300 },
      ],
      style: "gto",
    });
    const s = brainStats(input);
    expect(s).not.toBeNull();
    expect(s!.equity).toBe(1);
    expect(s!.required).toBeCloseTo(50 / 150, 5);
    expect(s!.preflop).toBe(false);
    expect(s!.opponents).toBe(1);
  });

  it("buildPrompt 注入 stats 后包含胜率与所需胜率描述", () => {
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
    const stats = brainStats(input);
    const { user } = buildPrompt(input, stats);
    expect(user).toContain("数据参考");
    expect(user).toContain("胜率约");
    expect(user).toContain("所需胜率");
    // 不带 stats 的旧调用方式不展示该字段
    const plain = buildPrompt(input);
    expect(plain.user).not.toContain("数据参考");
  });

  it("F3：面注时 brainStats 增加 vs 推断范围口径（被统治手牌 equityVsRange < equity）", () => {
    // 88 on 222A6 面对加注链（raisesSeen=1）：vs 随机 eq≈0.79，vs 推断范围骤降
    const input = makeDecideInput({
      aiHole: ["8h", "8d"],
      board: ["2h", "2d", "2c", "Ah", "6c"],
      street: "river",
      pot: 800,
      currentBet: 300,
      aiStack: 2000,
      callAmount: 300,
      legalActions: [
        { type: "fold", amount: 0 },
        { type: "call", amount: 300 },
        { type: "raise", amount: 600 },
        { type: "allin", amount: 2000 },
      ],
      style: "gto",
    });
    input.state.streetActions = [
      { seat: 1 as Seat, action: { type: "bet", amount: 80 } },
      { seat: 0 as Seat, action: { type: "raise", amount: 300 } },
    ];
    const s = brainStats(input);
    expect(s).not.toBeNull();
    expect(s!.equityVsRange).not.toBeNull();
    expect(s!.equityVsRange!).toBeLessThan(s!.equity - 0.2);
    // prompt 双口径展示：随机范围胜率 + 对手隐含范围胜率
    const { user } = buildPrompt(input, s);
    expect(user).toContain("随机范围胜率约");
    expect(user).toContain("隐含范围的胜率约");
  });

  it("F3：无需跟注（未面注）时 equityVsRange 为 null，prompt 不展示范围口径", () => {
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
    const s = brainStats(input);
    expect(s).not.toBeNull();
    expect(s!.equityVsRange).toBeNull();
    const { user } = buildPrompt(input, s);
    expect(user).not.toContain("隐含范围");
  });

  it("无底牌信息时 brainStats 返回 null", () => {
    const input = makeDecideInput({
      aiHole: null,
      board: ["Qh", "Jh", "2c"],
      street: "flop",
      pot: 60,
      legalActions: [{ type: "check", amount: 0 }],
    });
    expect(brainStats(input)).toBeNull();
  });
});
