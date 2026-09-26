import { describe, expect, it } from "vitest";
import type { ConcreteAIStyle, PlayerAction } from "@/lib/types";
import {
  chenScore,
  estimateStrength,
  heuristicDecide,
  heuristicDecideRng,
} from "../heuristic";
import { assertLegal, makeDecideInput } from "./helpers";

const ALL_STYLES: ConcreteAIStyle[] = [
  "nit", "tag", "lag", "maniac", "calling_station", "gto",
];

const FACING_SMALL_RAISE: PlayerAction[] = [
  { type: "fold", amount: 0 },
  { type: "call", amount: 20 },
  { type: "raise", amount: 60 },
  { type: "allin", amount: 200 },
];

const FACING_BIG_BET: PlayerAction[] = [
  { type: "fold", amount: 0 },
  { type: "call", amount: 100 },
  { type: "raise", amount: 200 },
  { type: "allin", amount: 300 },
];

const CAN_CHECK: PlayerAction[] = [
  { type: "check", amount: 0 },
  { type: "bet", amount: 10 },
  { type: "allin", amount: 300 },
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

describe("手牌强度估计", () => {
  it("Chen 公式排序合理：AA > AKs > 72o", () => {
    expect(chenScore("As", "Ad")).toBeGreaterThan(chenScore("Ah", "Kh"));
    expect(chenScore("Ah", "Kh")).toBeGreaterThan(chenScore("7d", "2c"));
    expect(chenScore("As", "Ad")).toBe(20);
  });

  it("翻前/翻后强度刻度合理", () => {
    expect(estimateStrength(["As", "Ad"], [], "preflop")).toBe(1);
    expect(estimateStrength(["7d", "2c"], [], "preflop")).toBeLessThan(0.1);
    // 同花
    expect(
      estimateStrength(["As", "Ks"], ["Qs", "Js", "2s", "7d", "3c"], "river"),
    ).toBeGreaterThanOrEqual(0.88);
    // 顶对
    const topPair = estimateStrength(["Kd", "Qh"], ["Ks", "7d", "2c"], "flop");
    expect(topPair).toBeGreaterThan(0.45);
    expect(topPair).toBeLessThan(0.6);
    // 空气
    expect(
      estimateStrength(["7d", "2c"], ["Ks", "Qh", "Jd"], "flop"),
    ).toBeLessThan(0.25);
    // 同花听牌有加分
    const fd = estimateStrength(["Ah", "2h"], ["Kh", "9h", "4d"], "flop");
    expect(fd).toBeGreaterThan(0.25);
  });
});

describe("heuristicDecide 极端局面", () => {
  it("翻前 AA 面对小加注：任何风格都不弃牌", () => {
    for (const style of ALL_STYLES) {
      const input = makeDecideInput({
        aiHole: ["As", "Ad"],
        pot: 40,
        currentBet: 30,
        aiStreetBet: 10,
        aiStack: 190,
        callAmount: 20,
        legalActions: FACING_SMALL_RAISE,
        style,
      });
      for (let i = 0; i < 100; i++) {
        const r = heuristicDecide(input, style);
        assertLegal(r.action, input);
        expect(r.action.type).not.toBe("fold");
        expect(r.source).toBe("heuristic");
        expect(r.reasoning.length).toBeGreaterThan(0);
      }
    }
  });

  it("河牌坚果同花面对小注：不弃牌且激进风格经常加注", () => {
    let raises = 0;
    const N = 200;
    for (let i = 0; i < N; i++) {
      const input = makeDecideInput({
        aiHole: ["As", "Ks"],
        board: ["Qs", "Js", "Ts", "2d", "3c"],
        street: "river",
        pot: 100,
        currentBet: 10,
        aiStack: 290,
        callAmount: 10,
        legalActions: [
          { type: "fold", amount: 0 },
          { type: "call", amount: 10 },
          { type: "raise", amount: 30 },
          { type: "allin", amount: 300 },
        ],
        style: "tag",
      });
      const r = heuristicDecide(input, "tag");
      assertLegal(r.action, input);
      expect(r.action.type).not.toBe("fold");
      if (r.action.type === "raise" || r.action.type === "allin") raises++;
    }
    expect(raises / N).toBeGreaterThan(0.5);
  });

  it("纯空气面对大注：nit 绝大多数弃牌", () => {
    const mk = (style: ConcreteAIStyle) =>
      makeDecideInput({
        aiHole: ["7d", "2c"],
        board: ["Ks", "Qh", "Jd"],
        street: "flop",
        pot: 100,
        currentBet: 100,
        aiStack: 300,
        callAmount: 100,
        legalActions: FACING_BIG_BET,
        style,
      });
    const N = 400;
    let nitFolds = 0;
    for (let i = 0; i < N; i++) {
      if (heuristicDecide(mk("nit"), "nit").action.type === "fold") nitFolds++;
    }
    expect(nitFolds / N).toBeGreaterThan(0.85);
  });

  it("同花听牌面对大注：跟注站比 nit 显著更愿意继续", () => {
    // 4 张红桃的纯同花听（无成牌，vs 随机 equity≈0.47，rangeMode 混合后 ≈0.43），
    // 面对约 0.7 池注（所需胜率 0.41）：数学上介于 nit 的 +8% 边际（阈值 0.49，弃牌）
    // 与跟注站的 -4% 边际（阈值 0.37，跟注）之间。注额 70 是混合胜率下的稳健分隔点
    // （两侧距混合胜率均 ≥2.5σ，避免缓存化的蒙特卡洛噪声翻转整组断言）。
    const FACING_070_POT: PlayerAction[] = [
      { type: "fold", amount: 0 },
      { type: "call", amount: 70 },
      { type: "raise", amount: 140 },
      { type: "allin", amount: 300 },
    ];
    const mk = (style: ConcreteAIStyle) =>
      makeDecideInput({
        aiHole: ["7h", "2h"],
        board: ["Ks", "Qh", "4h"],
        street: "flop",
        pot: 100,
        currentBet: 70,
        aiStack: 300,
        callAmount: 70,
        legalActions: FACING_070_POT,
        style,
      });
    const N = 400;
    let nitFolds = 0;
    let stationFolds = 0;
    for (let i = 0; i < N; i++) {
      if (heuristicDecide(mk("nit"), "nit").action.type === "fold") nitFolds++;
      if (heuristicDecide(mk("calling_station"), "calling_station").action.type === "fold")
        stationFolds++;
    }
    expect(nitFolds / N).toBeGreaterThan(0.85);
    expect(stationFolds / N).toBeLessThan(nitFolds / N - 0.2);
  });

  it("无人下注的空气牌：maniac 主动下注率显著高于 nit", () => {
    const mk = () =>
      makeDecideInput({
        aiHole: ["7d", "2c"],
        board: ["Ks", "Qh", "Jd"],
        street: "flop",
        pot: 100,
        aiStack: 300,
        callAmount: 0,
        legalActions: CAN_CHECK,
      });
    const N = 400;
    let maniacBets = 0;
    let nitBets = 0;
    for (let i = 0; i < N; i++) {
      if (heuristicDecide(mk(), "maniac").action.type === "bet") maniacBets++;
      if (heuristicDecide(mk(), "nit").action.type === "bet") nitBets++;
    }
    expect(maniacBets / N).toBeGreaterThan(0.4);
    expect(nitBets / N).toBeLessThan(maniacBets / N);
  });

  it("确定性随机源下输出可复现", () => {
    const input = makeDecideInput({
      aiHole: ["Kh", "Jh"],
      board: ["Kd", "4h", "9h"],
      street: "flop",
      pot: 60,
      aiStack: 200,
      callAmount: 0,
      legalActions: CAN_CHECK,
    });
    const r1 = heuristicDecideRng(input, "tag", mulberry32(42));
    const r2 = heuristicDecideRng(input, "tag", mulberry32(42));
    expect(r1).toEqual(r2);
  });

  it("兜底链：仅剩 allin/fold 时也返回合法动作", () => {
    const input = makeDecideInput({
      aiHole: ["As", "Ad"],
      pot: 1000,
      currentBet: 500,
      aiStreetBet: 0,
      aiStack: 100,
      callAmount: 500, // 跟不起
      legalActions: [
        { type: "fold", amount: 0 },
        { type: "allin", amount: 100 },
      ],
    });
    for (const style of ALL_STYLES) {
      for (let i = 0; i < 50; i++) {
        const r = heuristicDecide(input, style);
        assertLegal(r.action, input);
      }
    }
  });
});

describe("heuristicDecide 多人底池收紧", () => {
  // 同一边缘牌（中对 A7）面对约 0.65 池下注。rangeMode 多人池联合口径下
  // （rangeMultiwayJoint 默认开，每轮抽 N 个不共牌范围对手、hero 需压过全部）：
  // 单挑范围胜率 ≈0.65（阈值 0.43 → 稳定继续）；4 对手 ≈0.14（阈值 0.52 →
  // 稳定弃牌，间距 ~10σ）。注额 65 与两种场面的阈值间距都足够大，避免缓存化
  // 的蒙特卡洛估计噪声翻转整组断言。
  const mk = (playerCount: number, foldedSeats: number[] = []) => {
    const opponentOverrides: Record<number, { folded: boolean }> = {};
    for (const s of foldedSeats) opponentOverrides[s] = { folded: true };
    return makeDecideInput({
      aiHole: ["Ah", "7h"],
      board: ["Ks", "7d", "2c"],
      street: "flop",
      pot: 100,
      currentBet: 65,
      aiStack: 250,
      callAmount: 65,
      playerCount,
      aiSeat: playerCount - 1,
      buttonSeat: 0,
      opponentOverrides,
      legalActions: [
        { type: "fold", amount: 0 },
        { type: "call", amount: 65 },
        { type: "raise", amount: 130 },
        { type: "allin", amount: 300 },
      ],
      style: "tag",
    });
  };

  it("同一手牌：1 名对手稳定继续，4 名对手倾向弃牌", () => {
    const N = 400;
    let folds1 = 0;
    let continues1 = 0;
    let folds4 = 0;
    for (let i = 0; i < N; i++) {
      const r1 = heuristicDecide(mk(2), "tag");
      assertLegal(r1.action, mk(2));
      if (r1.action.type === "fold") folds1++;
      else continues1++;
      const r4 = heuristicDecide(mk(5), "tag"); // 4 名对手在局
      assertLegal(r4.action, mk(5));
      if (r4.action.type === "fold") folds4++;
    }
    // 单挑时中对 A 踢脚稳定继续（跟注或价值加注）
    expect(folds1 / N).toBeLessThan(0.1);
    expect(continues1 / N).toBeGreaterThan(0.9);
    // 4 名对手时胜率被摊薄到阈值之下，弃牌率显著上升
    expect(folds4 / N).toBeGreaterThan(folds1 / N + 0.3);
  });

  it("已弃牌的对手不计入收紧（3 人弃牌后等同单挑）", () => {
    const N = 400;
    let folds = 0;
    for (let i = 0; i < N; i++) {
      const r = heuristicDecide(mk(5, [1, 2, 3]), "tag");
      if (r.action.type === "fold") folds++;
    }
    expect(folds / N).toBeLessThan(0.2);
  });

  it("多人池诈唬率显著降低：空气牌主动下注率随对手数下降", () => {
    const CAN_CHECK_MULTI: PlayerAction[] = [
      { type: "check", amount: 0 },
      { type: "bet", amount: 10 },
      { type: "allin", amount: 300 },
    ];
    const mkBluff = (playerCount: number) =>
      makeDecideInput({
        aiHole: ["7d", "2c"],
        board: ["Ks", "Qh", "Jd"],
        street: "flop",
        pot: 100,
        aiStack: 300,
        callAmount: 0,
        playerCount,
        aiSeat: playerCount - 1,
        buttonSeat: 0,
        legalActions: CAN_CHECK_MULTI,
        style: "maniac",
      });
    const N = 600;
    let bets1 = 0;
    let bets4 = 0;
    for (let i = 0; i < N; i++) {
      if (heuristicDecide(mkBluff(2), "maniac").action.type === "bet") bets1++;
      if (heuristicDecide(mkBluff(5), "maniac").action.type === "bet") bets4++;
    }
    expect(bets4 / N).toBeLessThan(bets1 / N - 0.1);
  });
});
