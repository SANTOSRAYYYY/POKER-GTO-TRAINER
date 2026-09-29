/**
 * turnQuiz.ts（转牌圈出题器）测试
 *
 * - 发牌：6 张互不重复、hero 2 + board 4；种子 rng 可复现；子题型合法
 * - 判定边界：第二枪 55% 进攻线 / 35% 半诈唬下限（±0.01 卡点），
 *   面对第二枪 68% 加注线 / 30% 跟注线（±0.01 卡点）
 * - 实算回归：超对继续第二枪、组合听半诈唬、空气弃牌等
 * - 混合场景：50 题内两种子题型都出现、答案分布不止一种
 * - 点评文案含胜率数字
 */
import { describe, expect, it } from "vitest";
import type { Card } from "@/lib/types";
import {
  dealTurnScenario,
  drawTurnLine,
  generateTurnQuiz,
  heroRoleForTurn,
  isTooObvious,
  judgeTurn,
  TURN_BARREL_EQUITY_THRESHOLD,
  TURN_BARREL_SEMIBLUFF_MIN,
  TURN_BETTOR_3BET_RANGE_SPEC,
  TURN_BETTOR_RANGE_SPEC,
  TURN_CALLER_RANGE_SPEC,
  TURN_DEFENSE_CALL_THRESHOLD,
  TURN_DEFENSE_RAISE_THRESHOLD,
  turnQuizComment,
  turnRangeSpecFor,
  type TurnQuiz,
} from "../turnQuiz";
import { analyzeDraws, isStrongDraw } from "../postflopQuiz";
import { turnDefenseCallLine, turnDefenseRaiseLine } from "../multiway";
import { heroRangeLabels } from "../heroRange";
import { cardsToHandType } from "../pushfold";
import { equityVsRange, resetRangeCaches } from "@/lib/ai/range";

/** 线性同余种子 rng（测试可复现） */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const c = (s: string) => s.split(" ") as Card[];

describe("dealTurnScenario 发牌", () => {
  it("6 张牌互不重复，hero 2 张 + 公共牌 4 张", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = dealTurnScenario(lcg(seed));
      const all = [...s.hero, ...s.board];
      expect(new Set(all).size).toBe(6);
      expect(s.hero).toHaveLength(2);
      expect(s.board).toHaveLength(4);
      for (const card of all) expect(card).toMatch(/^[2-9TJQKA][shdc]$/);
      expect(["barrel", "defense"]).toContain(s.type);
    }
  });

  it("同一种子 rng 发同样的牌（可复现）", () => {
    expect(dealTurnScenario(lcg(42))).toEqual(dealTurnScenario(lcg(42)));
  });
});

describe("judgeTurn 判定边界（±0.01 卡点）", () => {
  it("第二枪：对跟注者范围 ≥55% 进攻（含 0.55 边界），否则过牌", () => {
    expect(judgeTurn(0.56, "barrel")).toBe("aggressive");
    expect(judgeTurn(TURN_BARREL_EQUITY_THRESHOLD, "barrel")).toBe("aggressive");
    expect(judgeTurn(0.54, "barrel")).toBe("passive");
  });

  it("第二枪：35-55% 且强听牌 → 半诈唬进攻（含 0.35 边界）", () => {
    const draw = { flushDraw: true, straightOuts: 0 };
    expect(judgeTurn(0.45, "barrel", draw)).toBe("aggressive");
    expect(judgeTurn(TURN_BARREL_SEMIBLUFF_MIN, "barrel", draw)).toBe("aggressive");
    expect(judgeTurn(0.34, "barrel", draw)).toBe("passive");
  });

  it("第二枪：35-55% 无强听牌仍过牌（防误放宽）", () => {
    const noDraw = { flushDraw: false, straightOuts: 0 };
    expect(judgeTurn(0.45, "barrel", noDraw)).toBe("passive");
    expect(judgeTurn(0.45, "barrel")).toBe("passive");
  });

  it("面对第二枪：≥68% 加注（含 0.68 边界）", () => {
    expect(judgeTurn(0.69, "defense")).toBe("aggressive");
    expect(judgeTurn(TURN_DEFENSE_RAISE_THRESHOLD, "defense")).toBe("aggressive");
    expect(judgeTurn(0.67, "defense")).toBe("passive");
  });

  it("面对第二枪：≥30% 跟注（含 0.30 边界），否则弃牌", () => {
    expect(judgeTurn(0.31, "defense")).toBe("passive");
    expect(judgeTurn(TURN_DEFENSE_CALL_THRESHOLD, "defense")).toBe("passive");
    expect(judgeTurn(0.29, "defense")).toBe("fold");
    expect(judgeTurn(0.05, "defense")).toBe("fold");
  });

  it("第二枪题只进攻或过牌，不弃牌（没人下注无可弃）", () => {
    expect(judgeTurn(0.05, "barrel")).toBe("passive");
  });
});

describe("generateTurnQuiz 实算回归", () => {
  it("超对 AA 在干燥面继续第二枪（对跟注者范围 ~81% ≥ 55%）", () => {
    const hero = c("As Ah") as [Card, Card];
    const board = c("Ts 9d 2c 4h");
    const eq = equityVsRange(hero, board, TURN_CALLER_RANGE_SPEC, 4000, lcg(7));
    expect(eq).toBeGreaterThanOrEqual(TURN_BARREL_EQUITY_THRESHOLD);
    expect(judgeTurn(eq, "barrel", analyzeDraws(hero, board))).toBe("aggressive");
  });

  it("组合听 J♣T♣ 在 9♣8♣2♦4♥：对跟注者范围 ~44% + 强听牌 → 半诈唬第二枪", () => {
    const hero = c("Jc Tc") as [Card, Card];
    const board = c("9c 8c 2d 4h");
    const draws = analyzeDraws(hero, board);
    expect(isStrongDraw(draws)).toBe(true);
    const eq = equityVsRange(hero, board, TURN_CALLER_RANGE_SPEC, 4000, lcg(7));
    expect(eq).toBeGreaterThanOrEqual(TURN_BARREL_SEMIBLUFF_MIN);
    expect(eq).toBeLessThan(TURN_BARREL_EQUITY_THRESHOLD);
    expect(judgeTurn(eq, "barrel", draws)).toBe("aggressive");
  });

  it("空气 7♣2♦ 在 A♠K♥Q♦9♣ 面对第二枪 → 弃牌（~3% < 30%）", () => {
    const hero = c("7c 2d") as [Card, Card];
    const board = c("As Kh Qd 9c");
    const eq = equityVsRange(hero, board, TURN_BETTOR_RANGE_SPEC, 4000, lcg(7));
    expect(eq).toBeLessThan(TURN_DEFENSE_CALL_THRESHOLD);
    expect(judgeTurn(eq, "defense")).toBe("fold");
  });

  it("中对 9♥9♦ 在 T♥6♦2♣4♥ 面对第二枪 → 跟注（~54%，30-68% 之间）", () => {
    const hero = c("9h 9d") as [Card, Card];
    const board = c("Th 6d 2c 4h");
    const eq = equityVsRange(hero, board, TURN_BETTOR_RANGE_SPEC, 4000, lcg(7));
    expect(eq).toBeGreaterThanOrEqual(TURN_DEFENSE_CALL_THRESHOLD);
    expect(eq).toBeLessThan(TURN_DEFENSE_RAISE_THRESHOLD);
    expect(judgeTurn(eq, "defense")).toBe("passive");
  });
});

describe("用户实报回归：多人池防守只对下注者（2026-09-29 框架修正）", () => {
  // 用户实锤：T♥9♥ 顶两对在 6♣8♥8♣9♦，翻前跟注+翻牌跟注后转牌面对第二枪
  // 1/2 池、两家未行动（四人池，opponents=3）。新框架：防守判定只评估对
  // 第二枪者的胜率（身后跟注者 = 死钱，改善直接赔率），跟注线 = 实现率税
  // 0.30 + 0.03/人。旧框架「联合胜率 + 跟注线 +0.04/人」对多人摊薄重复计费，
  // 把对下注者 ~0.60 的胜率压到 ~0.24 → 误弃。
  const hero = c("Th 9h") as [Card, Card];
  const board = c("6c 8h 8c 9d") as [Card, Card, Card, Card];
  const draws = analyzeDraws(hero, board);
  resetRangeCaches();
  const vsBettor = equityVsRange(hero, board, TURN_BETTOR_RANGE_SPEC, 8000, lcg(99), 1);
  resetRangeCaches();
  const oldJoint = equityVsRange(hero, board, TURN_BETTOR_RANGE_SPEC, 8000, lcg(99), 3);

  it(`哨兵转正：四人池对第二枪者胜率 ${vsBettor.toFixed(3)} ≥ 跟注线 0.36 → passive（旧联合口径 ${oldJoint.toFixed(3)} 误弃）`, () => {
    // 上一版哨兵断言「四人池仍判弃牌」——框架修正后按新口径更新为判跟注（变绿）
    expect(vsBettor).toBeGreaterThanOrEqual(turnDefenseCallLine(3)); // 0.36
    expect(vsBettor).toBeLessThan(turnDefenseRaiseLine(3)); // 0.80
    expect(judgeTurn(vsBettor, "defense", draws, 3)).toBe("passive");
    // 旧联合口径同一手牌判弃牌（重复计费的实锤）
    expect(oldJoint).toBeLessThan(turnDefenseCallLine(3));
    expect(judgeTurn(oldJoint, "defense", draws, 3)).toBe("fold");
    expect(vsBettor).toBeGreaterThan(oldJoint + 0.2);
  });

  it("弱牌仍弃（防矫枉过正）：四人池纯空气 7♣2♦ 在 A♠K♥Q♦9♣ 面对第二枪，对下注者 ~0.04 < 0.36 → fold", () => {
    const h2 = c("7c 2d") as [Card, Card];
    const b2 = c("As Kh Qd 9c") as [Card, Card, Card, Card];
    resetRangeCaches();
    const eq = equityVsRange(h2, b2, TURN_BETTOR_RANGE_SPEC, 4000, lcg(7), 1);
    expect(eq).toBeLessThan(turnDefenseCallLine(3));
    expect(judgeTurn(eq, "defense", analyzeDraws(h2, b2), 3)).toBe("fold");
  });

  it("多人池强牌案例：四人池中对 9♥9♦ 在 T♥6♦2♣4♥ 面对第二枪，对下注者 ~0.53 → 跟注", () => {
    const h2 = c("9h 9d") as [Card, Card];
    const b2 = c("Th 6d 2c 4h") as [Card, Card, Card, Card];
    resetRangeCaches();
    const eq = equityVsRange(h2, b2, TURN_BETTOR_RANGE_SPEC, 8000, lcg(96), 1);
    expect(eq).toBeGreaterThanOrEqual(turnDefenseCallLine(3));
    expect(eq).toBeLessThan(turnDefenseRaiseLine(3));
    expect(judgeTurn(eq, "defense", analyzeDraws(h2, b2), 3)).toBe("passive");
  });

  it("多人池碾压级强牌案例：四人池 TPTK A♥K♦ 在 K♥7♦2♣4♠ 面对第二枪，对下注者 ~0.82 ≥ 0.80 加注线 → 价值加注", () => {
    const h2 = c("Ah Kd") as [Card, Card];
    const b2 = c("Kh 7d 2c 4s") as [Card, Card, Card, Card];
    resetRangeCaches();
    const eq = equityVsRange(h2, b2, TURN_BETTOR_RANGE_SPEC, 12000, lcg(95), 1);
    expect(eq).toBeGreaterThanOrEqual(turnDefenseRaiseLine(3));
    expect(judgeTurn(eq, "defense", analyzeDraws(h2, b2), 3)).toBe("aggressive");
  });

  it("单挑防守逐比特回归：opp=1 分支同 seed 与旧口径一致，且该手牌单挑判跟注", () => {
    resetRangeCaches();
    const a = equityVsRange(hero, board, TURN_BETTOR_RANGE_SPEC, 1500, lcg(94), 1);
    resetRangeCaches();
    const b = equityVsRange(hero, board, TURN_BETTOR_RANGE_SPEC, 1500, lcg(94));
    expect(b).toBe(a);
    // 单挑线不变（0.30/0.68）：0.60 在跟注带
    expect(a).toBeGreaterThanOrEqual(turnDefenseCallLine(1));
    expect(a).toBeLessThan(turnDefenseRaiseLine(1));
    expect(judgeTurn(a, "defense", draws, 1)).toBe("passive");
  });
});

describe("generateTurnQuiz 混合场景与整题", () => {
  // 题量由 50 减到 26：A3 边界带复核（每次 20000 迭代 ≈2-3s）在小迭代基数下
  // 命中率高，分布性断言无需原题量；超时相应放宽
  it(
    "26 题内两种子题型都出现，答案分布不止一种",
    () => {
      const rng = lcg(2026);
      const types = new Set<string>();
      const answers = new Set<string>();
      for (let i = 0; i < 26; i++) {
        const q = generateTurnQuiz(rng, 400);
        types.add(q.type);
        answers.add(q.answer);
        // 答案与判定函数一致
        expect(q.answer).toBe(
          judgeTurn(q.rangeEquity, q.type, q.draws, q.opponents),
        );
        expect(q.rangeEquity).toBeGreaterThanOrEqual(0);
        expect(q.rangeEquity).toBeLessThanOrEqual(1);
      }
      expect(types.size).toBe(2);
      expect(answers.size).toBeGreaterThan(1);
    },
    120000,
  );

  it(
    "turnQuizComment 返回含胜率百分比的非空简评",
    () => {
      for (let seed = 1; seed <= 6; seed++) {
        const q = generateTurnQuiz(lcg(seed), 400);
        const text = turnQuizComment(q);
        expect(text.length).toBeGreaterThan(10);
        expect(text).toContain((q.rangeEquity * 100).toFixed(1));
      }
    },
    15000,
  );

  it("半诈唬第二枪的点评包含听牌描述", () => {
    const hero = c("Jc Tc") as [Card, Card];
    const board = c("9c 8c 2d 4h") as [Card, Card, Card, Card];
    const draws = analyzeDraws(hero, board);
    const q = {
      hero,
      board,
      type: "barrel" as const,
      actionLine: [{ zh: "翻前：测试线", en: "Preflop: test line" }],
      lineKind: "open" as const,
      openPos: "CO" as const,
      opponents: 1 as const,
      betSize: null,
      equity: { win: 0.4399, tie: 0, lose: 0.5601 },
      rangeEquity: 0.4399,
      draws,
      answer: judgeTurn(0.4399, "barrel", draws),
    };
    expect(q.answer).toBe("aggressive");
    const text = turnQuizComment(q);
    expect(text).toContain("44.0");
    expect(text).toContain("半诈唬");
  });
});

describe("行动线生成", () => {
  it("两个子题型的行动线各 3 行、双语、行内无重复，两种 kind 都出现", () => {
    const rng = lcg(77);
    const barrelKinds = new Set<string>();
    const defenseKinds = new Set<string>();
    for (let i = 0; i < 80; i++) {
      const s = dealTurnScenario(rng);
      expect(s.actionLine.length).toBe(3);
      expect(new Set(s.actionLine.map((l) => l.zh)).size).toBe(3);
      for (const line of s.actionLine) {
        expect(line.zh.length).toBeGreaterThan(4);
        expect(line.en.length).toBeGreaterThan(4);
      }
      expect(s.actionLine[0].zh).toContain("翻前");
      if (s.type === "barrel") barrelKinds.add(s.lineKind);
      else defenseKinds.add(s.lineKind);
    }
    expect(barrelKinds.size).toBe(2);
    expect(defenseKinds.size).toBe(2);
  });

  it("范围收窄联动：defense 的 threeBet 线 topPct 0.3 < open 线 0.45；barrel 恒 0.45", () => {
    expect(turnRangeSpecFor("barrel", "open")).toEqual(TURN_CALLER_RANGE_SPEC);
    expect(turnRangeSpecFor("barrel", "threeBet")).toEqual(TURN_CALLER_RANGE_SPEC);
    expect(turnRangeSpecFor("defense", "open")).toEqual(TURN_BETTOR_RANGE_SPEC);
    expect(turnRangeSpecFor("defense", "threeBet")).toEqual(
      TURN_BETTOR_3BET_RANGE_SPEC,
    );
    expect(turnRangeSpecFor("defense", "threeBet").topPct).toBeLessThan(
      turnRangeSpecFor("defense", "open").topPct,
    );
  });

  it("drawTurnLine 同一种子可复现", () => {
    expect(drawTurnLine("defense", lcg(5))).toEqual(drawTurnLine("defense", lcg(5)));
  });
});

describe("fold 点评按行动线实际尺度算直接赔率（A2）", () => {
  const foldQuiz = (over: Partial<TurnQuiz>): TurnQuiz => ({
    hero: c("7c 2d") as [Card, Card],
    board: c("As Kh Qd 9c") as [Card, Card, Card, Card],
    type: "defense",
    actionLine: [{ zh: "翻前：测试线", en: "Preflop: test line" }],
    lineKind: "open",
    openPos: "CO",
    opponents: 1,
    betSize: null,
    equity: { win: 0.04, tie: 0, lose: 0.96 },
    rangeEquity: 0.04,
    draws: { flushDraw: false, straightOuts: 0 },
    answer: "fold",
    ...over,
  });

  it("半池注 + 胜率 < 25%：「1/2 底池注需 25% 赔率也够不上」", () => {
    const text = turnQuizComment(
      foldQuiz({
        betSize: { zh: "1/2 底池", en: "half pot", frac: 0.5 },
        rangeEquity: 0.04,
      }),
    );
    expect(text).toContain("1/2 底池");
    expect(text).toContain("25%");
    expect(text).toContain("够不上");
  });

  it("2/3 池注：动态算 28.6%，不再写死「半池注赔率也够不上」", () => {
    const text = turnQuizComment(
      foldQuiz({
        betSize: { zh: "2/3 底池", en: "2/3 pot", frac: 2 / 3 },
        rangeEquity: 0.04,
      }),
    );
    expect(text).toContain("2/3 底池");
    expect(text).toContain("28.6%");
    expect(text).not.toContain("半池");
  });

  it("胜率 ∈ [直接赔率, 跟注线)：「接近赔率但不足」而非「赔率也够不上」", () => {
    // 半池注：0.26 ∈ [0.25, 0.30)——审计实报 K♦Q♦ 32.8% 类情形的字面修正
    const text = turnQuizComment(
      foldQuiz({
        betSize: { zh: "1/2 底池", en: "half pot", frac: 0.5 },
        rangeEquity: 0.26,
      }),
    );
    expect(text).toContain("接近赔率但不足");
    expect(text).not.toContain("够不上");
  });

  it("dealt 场景：defense 题必带 betSize（第二枪尺度），barrel 题恒 null", () => {
    const rng = lcg(44);
    let defenseChecked = 0;
    let barrelChecked = 0;
    for (let i = 0; i < 200 && (defenseChecked < 30 || barrelChecked < 30); i++) {
      const s = dealTurnScenario(rng);
      if (s.type === "defense") {
        defenseChecked++;
        expect(s.betSize).not.toBeNull();
        expect([0.5, 2 / 3]).toContain(s.betSize!.frac);
        expect(
          s.actionLine.some((l) => l.zh.includes(s.betSize!.zh)),
        ).toBe(true);
      } else {
        barrelChecked++;
        expect(s.betSize).toBeNull();
      }
    }
    expect(defenseChecked).toBeGreaterThan(0);
    expect(barrelChecked).toBeGreaterThan(0);
  });
});

describe("多人池 barrel 被动点评中性话术（A4）", () => {
  it("多人池 AA 未过线：不再叫「弱牌」，改为控池话术", () => {
    // 审计题例：A♣A♠ on 2♥8♠J♠8♣（三人池）对两跟注者范围 60.5% < 61% → passive
    const q: TurnQuiz = {
      hero: c("Ac As") as [Card, Card],
      board: c("2h 8s Js 8c") as [Card, Card, Card, Card],
      type: "barrel",
      actionLine: [{ zh: "翻前：测试线", en: "Preflop: test line" }],
      lineKind: "open",
      openPos: "LJ",
      opponents: 2,
      betSize: null,
      equity: { win: 0.605, tie: 0, lose: 0.395 },
      rangeEquity: 0.605,
      draws: { flushDraw: false, straightOuts: 0 },
      answer: "passive",
    };
    expect(judgeTurn(q.rangeEquity, "barrel", q.draws, q.opponents)).toBe(
      "passive",
    );
    const text = turnQuizComment(q);
    expect(text).not.toContain("弱牌");
    expect(text).toContain("控池");
  });
});

describe("难度过滤（反脑残）", () => {
  it("防守题：判定胜率 0.1（纯垃圾面对第二枪弃牌）必被重发，0.5 保留", () => {
    expect(isTooObvious(0.1, "defense")).toBe(true);
    expect(isTooObvious(0.5, "defense")).toBe(false);
    expect(isTooObvious(0.9, "defense")).toBe(true);
    expect(isTooObvious(0.2, "defense")).toBe(false);
    expect(isTooObvious(0.85, "defense")).toBe(false);
  });

  it("第二枪题：>85% 无脑价值重发；<25% 无听牌重发、有强听牌保留", () => {
    const noDraw = { flushDraw: false, straightOuts: 0 };
    const strongDraw = { flushDraw: true, straightOuts: 0 };
    expect(isTooObvious(0.9, "barrel", noDraw)).toBe(true);
    expect(isTooObvious(0.1, "barrel", noDraw)).toBe(true);
    expect(isTooObvious(0.1, "barrel", strongDraw)).toBe(false);
    expect(isTooObvious(0.5, "barrel", noDraw)).toBe(false);
  });

  it(
    "生成的题全部不在显而易见区",
    () => {
      // 题量由 40 减到 24：A3 边界带复核（每次 20000 迭代 ≈2-3s）拉高单题耗时
      const rng = lcg(2027);
      for (let i = 0; i < 24; i++) {
        const q = generateTurnQuiz(rng, 400);
        expect(isTooObvious(q.rangeEquity, q.type, q.draws)).toBe(false);
        if (q.type === "defense") {
          expect(q.rangeEquity).toBeGreaterThanOrEqual(0.2);
          expect(q.rangeEquity).toBeLessThanOrEqual(0.85);
        }
      }
    },
    120000,
  );

  it("恒定 rng 极端情形：10 次上限兜底返回合法题，不死循环", () => {
    const q = generateTurnQuiz(() => 0, 200);
    expect(["aggressive", "passive", "fold"]).toContain(q.answer);
    expect(new Set([...q.hero, ...q.board]).size).toBe(6);
  });
});

describe("底牌与行动线一致性（hero 范围抽样接线）", () => {
  it("抽样 200 次：底牌全部落在 type+lineKind 映射的角色范围内", () => {
    const rng = lcg(555);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const s = dealTurnScenario(rng);
      seen.add(`${s.type}/${s.lineKind}`);
      const role = heroRoleForTurn(s.type, s.lineKind);
      const label = cardsToHandType(s.hero[0], s.hero[1]).label;
      const range = heroRangeLabels(role, role === "open" ? s.openPos : undefined);
      expect(
        range.has(label),
        `${s.type}/${s.lineKind}（角色 ${role}）发出了范围外的 ${label}`,
      ).toBe(true);
    }
    expect(seen.size).toBe(4); // 两子题型 × 两种线都覆盖
  });

  it("defense-open 线（hero 大盲跟注方）永无 2♥4♥ 类绝对垃圾（用户实报案例回归）", () => {
    const rng = lcg(777);
    const trash = new Set(["72o", "82o", "92o", "94o", "32o", "42o", "83o", "74o",
      "42s", "72s", "82s", "92s", "32s", "85o", "73o"]);
    let checked = 0;
    for (let i = 0; i < 300 && checked < 60; i++) {
      const s = dealTurnScenario(rng);
      if (s.type !== "defense" || s.lineKind !== "open") continue;
      checked++;
      expect(heroRoleForTurn(s.type, s.lineKind)).toBe("bbDefend");
      expect(trash.has(cardsToHandType(s.hero[0], s.hero[1]).label)).toBe(false);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("barrel-threeBet 线（hero 大盲 3bet 方）底牌全在 threeBet 范围（顶端带/诈唬集）", () => {
    const rng = lcg(888);
    let checked = 0;
    for (let i = 0; i < 300 && checked < 60; i++) {
      const s = dealTurnScenario(rng);
      if (s.type !== "barrel" || s.lineKind !== "threeBet") continue;
      checked++;
      expect(heroRoleForTurn(s.type, s.lineKind)).toBe("threeBet");
      const label = cardsToHandType(s.hero[0], s.hero[1]).label;
      expect(heroRangeLabels("threeBet").has(label)).toBe(true);
    }
    expect(checked).toBeGreaterThan(0);
  });
});
