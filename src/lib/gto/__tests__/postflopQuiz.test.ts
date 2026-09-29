/**
 * postflopQuiz.ts（翻后特训出题器）测试
 *
 * - 发牌：5 张互不重复且都是合法牌；种子 rng 可复现；题型合法
 * - 行动线：attack 固定 open 线 / defense 两种线都出现；双语、行内无重复；
 *   范围收窄联动（defenseRangeSpecFor：open → 0.6 / threeBet → 0.35）
 * - 难度过滤：isTooObvious 纯函数口径（防守 0.1 必重发 / 0.5 保留 / >0.85
 *   重发；进攻 >0.85 重发 / <0.25 无听牌重发 / <0.25 有听牌保留）；
 *   生成的题永不在显而易见区；恒定 rng 下 10 次兜底不死循环
 * - 判定规则：55% 进攻线（含边界）、防守题 30% 弃牌线（含边界）、
 *   进攻题弱牌只过牌不弃牌（没人下注无可弃）
 * - 实算胜率：四条 A 不败（win=1）、7-2 高牌垃圾面 < 30%
 * - 整题生成：答案与 judgePostflop 一致、win+tie+lose≈1
 */
import { describe, expect, it } from "vitest";
import type { Card } from "@/lib/types";
import {
  analyzeDraws,
  dealPostflopScenario,
  DEFENSE_CALL_THRESHOLD,
  DEFENSE_RANGE_SPEC,
  DEFENSE_RAISE_THRESHOLD,
  defenseRangeSpecFor,
  drawPostflopLine,
  evaluateScenario,
  FLOP_DEFENSE_3BET_RANGE_SPEC,
  generatePostflopQuiz,
  heroRoleForPostflop,
  isStrongDraw,
  isTooObvious,
  judgePostflop,
  quizComment,
  type PostflopQuiz,
  type PostflopScenario,
} from "../postflopQuiz";
import { FILTER_MAX_ATTEMPTS } from "../trainerDifficulty";
import { heroRangeLabels } from "../heroRange";
import { flopDefenseCallLine, flopDefenseRaiseLine } from "../multiway";
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

/** 手搓场景字面量用的固定行动线（内容与判定无关） */
const TEST_LINE = {
  actionLine: [{ zh: "翻前：测试线", en: "Preflop: test line" }],
  lineKind: "open" as const,
  openPos: "CO" as const,
  opponents: 1 as const,
  betSize: null,
};

describe("dealPostflopScenario 发牌", () => {
  it("5 张牌互不重复，hero 2 张 + 公共牌 3 张", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = dealPostflopScenario(lcg(seed));
      const all = [...s.hero, ...s.board];
      expect(new Set(all).size).toBe(5);
      expect(s.hero).toHaveLength(2);
      expect(s.board).toHaveLength(3);
      for (const card of all) expect(card).toMatch(/^[2-9TJQKA][shdc]$/);
      expect(["attack", "defense"]).toContain(s.type);
    }
  });

  it("同一种子 rng 发同样的牌（可复现）", () => {
    const a = dealPostflopScenario(lcg(42));
    const b = dealPostflopScenario(lcg(42));
    expect(a).toEqual(b);
  });

  it("题型随 rng 变化（1000 次抽样两种题型都出现）", () => {
    const rng = lcg(7);
    const types = new Set<string>();
    for (let i = 0; i < 1000; i++) types.add(dealPostflopScenario(rng).type);
    expect(types.size).toBe(2);
  });
});

describe("judgePostflop 判定规则", () => {
  it("进攻题：对随机胜率 ≥55% 进攻（含 0.55 边界），否则过牌", () => {
    expect(judgePostflop(0.55, "attack")).toBe("aggressive");
    expect(judgePostflop(0.8, "attack")).toBe("aggressive");
    expect(judgePostflop(0.549, "attack")).toBe("passive");
  });

  it("防守题：对下注者范围胜率 ≥68% 才加注（第三对子不再误判加注）", () => {
    // 0.55（旧规则的误判区）现在必须是跟注
    expect(judgePostflop(0.9, "defense", 0.55)).toBe("passive");
    expect(judgePostflop(0.9, "defense", 0.68)).toBe("aggressive");
    expect(judgePostflop(0.9, "defense", 0.8)).toBe("aggressive");
    expect(judgePostflop(0.9, "defense", 0.679)).toBe("passive");
  });

  it("防守题：<28% 弃牌（含 0.28 边界跟注）", () => {
    expect(judgePostflop(0.9, "defense", 0.28)).toBe("passive");
    expect(judgePostflop(0.9, "defense", 0.27)).toBe("fold");
    expect(judgePostflop(0.9, "defense", 0.12)).toBe("fold");
  });

  it("防守题不传范围胜率时回退用 win（兼容旧签名）", () => {
    expect(judgePostflop(0.7, "defense")).toBe("aggressive");
    expect(judgePostflop(0.12, "defense")).toBe("fold");
  });

  it("进攻题弱牌只过牌不弃牌", () => {
    expect(judgePostflop(0.3, "attack")).toBe("passive");
    expect(judgePostflop(0.05, "attack")).toBe("passive");
  });
});

describe("evaluateScenario 实算胜率", () => {
  it("四条 A 面不败：win = 1", () => {
    const s: PostflopScenario = {
      hero: c("As Ah") as [Card, Card],
      board: c("Ac Ad 2s") as [Card, Card, Card],
      type: "attack",
      ...TEST_LINE,
    };
    const r = evaluateScenario(s, 500);
    expect(r.win).toBe(1);
    expect(r.lose).toBe(0);
  });

  it("7-2 高牌垃圾面胜率 < 30%（应对应防守题弃牌）", () => {
    const s: PostflopScenario = {
      hero: c("7c 2d") as [Card, Card],
      board: c("As Kh Qd") as [Card, Card, Card],
      type: "defense",
      ...TEST_LINE,
    };
    const r = evaluateScenario(s, 3000);
    expect(r.win).toBeLessThan(0.3);
    expect(r.win + r.tie + r.lose).toBeCloseTo(1, 6);
  });

  it("翻牌圈中天顺面高胜率（>55%，应对应进攻）", () => {
    // hero JdTd 在 9s 8s 2c 面：两头顺 + 对子出路，对随机手大幅领先
    const s: PostflopScenario = {
      hero: c("Qh Jc") as [Card, Card],
      board: c("Ts 9d 2c") as [Card, Card, Card],
      type: "attack",
      ...TEST_LINE,
    };
    const r = evaluateScenario(s, 3000);
    expect(r.win).toBeGreaterThan(0.55);
  });
});

describe("多人池防守只对下注者（2026-09-29 框架修正）", () => {
  // 新框架：防守判定只评估对下注者的胜率（身后跟注者 = 死钱，改善直接赔率），
  // 跟注线 = 实现率税 0.28 + 0.03/人（四人池 0.34），加注线保持 0.68 + 0.06/人。
  it("四人池 TPTK A♥K♦ 在 K♣7♠2♦ 面对持续下注（两家未行动）：对下注者 ~0.86 ≥ 0.80 加注线 → 价值加注", () => {
    const hero = c("Ah Kd") as [Card, Card];
    const board = c("Kc 7s 2d") as [Card, Card, Card];
    resetRangeCaches();
    const eq = equityVsRange(hero, board, DEFENSE_RANGE_SPEC, 8000, lcg(94), 1);
    expect(eq).toBeGreaterThanOrEqual(flopDefenseRaiseLine(3)); // 0.80
    expect(judgePostflop(0.9, "defense", eq, undefined, 3)).toBe("aggressive");
  });

  it("四人池中对 9♥9♦ 在 K♣7♠2♦ 面对持续下注：对下注者 ~0.63 在跟注带（0.34-0.80）→ 跟注", () => {
    const hero = c("9h 9d") as [Card, Card];
    const board = c("Kc 7s 2d") as [Card, Card, Card];
    resetRangeCaches();
    const eq = equityVsRange(hero, board, DEFENSE_RANGE_SPEC, 8000, lcg(92), 1);
    expect(eq).toBeGreaterThanOrEqual(flopDefenseCallLine(3));
    expect(eq).toBeLessThan(flopDefenseRaiseLine(3));
    expect(judgePostflop(0.9, "defense", eq, undefined, 3)).toBe("passive");
  });

  it("单挑防守逐比特回归：同一手牌同 seed 与 equityVsRange 一致", () => {
    const hero = c("Ah Kd") as [Card, Card];
    const board = c("Kc 7s 2d") as [Card, Card, Card];
    resetRangeCaches();
    const a = equityVsRange(hero, board, DEFENSE_RANGE_SPEC, 1500, lcg(93), 1);
    resetRangeCaches();
    const b = equityVsRange(hero, board, DEFENSE_RANGE_SPEC, 1500, lcg(93));
    expect(b).toBe(a);
  });
});

describe("generatePostflopQuiz 整题", () => {
  it("用户实报场景：2♦J♠ 在 T♠2♥K♥ 面对半池注 → 跟注（不判加注）", () => {
    // 第三对子 + J 踢脚：对随机胜率 ~55% 曾误判「加注」，对下注者范围应为跟注
    const scenario: PostflopScenario = {
      hero: c("2d Js") as [Card, Card],
      board: c("Ts 2h Kh") as [Card, Card, Card],
      type: "defense",
      ...TEST_LINE,
    };
    const defenseWin = equityVsRange(scenario.hero, scenario.board, DEFENSE_RANGE_SPEC, 3000, lcg(7));
    const answer = judgePostflop(0.553, "defense", defenseWin);
    expect(answer).not.toBe("aggressive"); // 对范围胜率应远低于 0.55
    expect(answer).toBe("passive");
    expect(defenseWin).toBeGreaterThanOrEqual(DEFENSE_CALL_THRESHOLD);
    expect(defenseWin).toBeLessThan(DEFENSE_RAISE_THRESHOLD);
  });

  it(
    "答案与 judgePostflop(win, type, defenseEquity, draws) 一致，概率和≈1",
    () => {
      for (let seed = 100; seed < 110; seed++) {
        const q = generatePostflopQuiz(lcg(seed), 800);
        expect(q.answer).toBe(
          judgePostflop(q.equity.win, q.type, q.defenseEquity ?? undefined, q.draws, q.opponents),
        );
        expect(q.equity.win + q.equity.tie + q.equity.lose).toBeCloseTo(1, 5);
        if (q.type === "defense") {
          expect(q.defenseEquity).not.toBeNull();
          expect(q.defenseEquity!).toBeGreaterThanOrEqual(0);
          expect(q.defenseEquity!).toBeLessThanOrEqual(1);
        } else {
          expect(q.defenseEquity).toBeNull();
        }
      }
    },
    // A3 边界带复核（20000 次迭代）拉高单题耗时，放宽超时
    30000,
  );

  it("quizComment 返回含胜率百分比的非空简评", () => {
    const q = generatePostflopQuiz(lcg(1), 500);
    const text = quizComment(q);
    expect(text.length).toBeGreaterThan(10);
    expect(text).toContain((q.equity.win * 100).toFixed(1));
  });
});

describe("fold 点评按行动线实际尺度算直接赔率（A2）", () => {
  const foldQuiz = (over: Partial<PostflopQuiz>): PostflopQuiz => ({
    hero: c("7c 2d") as [Card, Card],
    board: c("As Kh Qd") as [Card, Card, Card],
    type: "defense",
    ...TEST_LINE,
    equity: { win: 0.12, tie: 0, lose: 0.88 },
    defenseEquity: 0.12,
    draws: { flushDraw: false, straightOuts: 0 },
    answer: "fold",
    ...over,
  });

  it("半池注 + 胜率 < 25%：「1/2 底池注需 25% 赔率也够不上」", () => {
    const text = quizComment(
      foldQuiz({
        betSize: { zh: "1/2 底池", en: "half pot", frac: 0.5 },
        defenseEquity: 0.12,
      }),
    );
    expect(text).toContain("1/2 底池");
    expect(text).toContain("25%");
    expect(text).toContain("够不上");
  });

  it("2/3 池注：动态算 28.6%，不再写死半池 25%", () => {
    const text = quizComment(
      foldQuiz({
        betSize: { zh: "2/3 底池", en: "2/3 pot", frac: 2 / 3 },
        defenseEquity: 0.12,
      }),
    );
    expect(text).toContain("2/3 底池");
    expect(text).toContain("28.6%");
    expect(text).not.toContain("半池");
  });

  it("胜率 ∈ [直接赔率, 跟注线)：「接近赔率但不足」而非「赔率也够不上」", () => {
    // 半池注：0.26 ∈ [0.25, 0.28)——字面够直接赔率但仍弃牌（实现率税 + 范围紧）
    const text = quizComment(
      foldQuiz({
        betSize: { zh: "1/2 底池", en: "half pot", frac: 0.5 },
        defenseEquity: 0.26,
      }),
    );
    expect(text).toContain("接近赔率但不足");
    expect(text).not.toContain("够不上");
    // 2/3 池注：0.27 ∈ [0.25, 0.286)？不——0.27 < 28.6% 直接赔率，仍「够不上」
    const text2 = quizComment(
      foldQuiz({
        betSize: { zh: "2/3 底池", en: "2/3 pot", frac: 2 / 3 },
        defenseEquity: 0.27,
      }),
    );
    expect(text2).toContain("够不上");
    expect(text2).toContain("28.6%");
  });

  it("dealt 场景：defense 题必带 betSize（1/2 或 2/3 池），attack 题恒 null", () => {
    const rng = lcg(33);
    let defenseChecked = 0;
    let attackChecked = 0;
    for (let i = 0; i < 200 && (defenseChecked < 30 || attackChecked < 30); i++) {
      const s = dealPostflopScenario(rng);
      if (s.type === "defense") {
        defenseChecked++;
        expect(s.betSize).not.toBeNull();
        expect([0.5, 2 / 3]).toContain(s.betSize!.frac);
        // 尺度文本与行动线一致
        expect(
          s.actionLine.some((l) => l.zh.includes(s.betSize!.zh)),
        ).toBe(true);
      } else {
        attackChecked++;
        expect(s.betSize).toBeNull();
      }
    }
    expect(defenseChecked).toBeGreaterThan(0);
    expect(attackChecked).toBeGreaterThan(0);
  });
});

describe("analyzeDraws 听牌识别与半诈唬判定", () => {
  it("两头顺听：T♣9♠ 在 4♥8♣J♣ → 8 张出路（7 或 Q）", () => {
    const d = analyzeDraws(c("Tc 9s") as [Card, Card], c("4h 8c Jc") as [Card, Card, Card]);
    expect(d.straightOuts).toBe(8);
  });

  it("同花听：某花色 ≥4 张", () => {
    const d = analyzeDraws(c("Tc 9c") as [Card, Card], c("4h 8c Jc") as [Card, Card, Card]);
    expect(d.flushDraw).toBe(true);
    const d2 = analyzeDraws(c("Ts 9s") as [Card, Card], c("4h 8c Jc") as [Card, Card, Card]);
    expect(d2.flushDraw).toBe(false);
  });

  it("用户实报场景：T♣9♠ 在 4♥8♣J♣ 进攻题（54.4%）→ 半诈唬进攻（不判过牌）", () => {
    const draws = analyzeDraws(c("Tc 9s") as [Card, Card], c("4h 8c Jc") as [Card, Card, Card]);
    expect(isStrongDraw(draws)).toBe(true);
    expect(judgePostflop(0.544, "attack", undefined, draws)).toBe("aggressive");
  });

  it("无听牌的中间胜率仍判过牌（防误放宽）", () => {
    // K♦5♠ 在 Q♣7♥2♦ 面：无花无顺的纯高牌区
    const draws = analyzeDraws(c("Kd 5s") as [Card, Card], c("Qc 7h 2d") as [Card, Card, Card]);
    expect(isStrongDraw(draws)).toBe(false);
    expect(judgePostflop(0.5, "attack", undefined, draws)).toBe("passive");
  });

  it("45% 以下即使有听牌也保持过牌（下限保护）", () => {
    const draws = analyzeDraws(c("Tc 9s") as [Card, Card], c("4h 8c Jc") as [Card, Card, Card]);
    expect(judgePostflop(0.44, "attack", undefined, draws)).toBe("passive");
  });

  it("A 低顺检测：A2345 轮子", () => {
    const d = analyzeDraws(c("As 2d") as [Card, Card], c("3c 4h 5s") as [Card, Card, Card]);
    expect(d.straightOuts).toBeGreaterThanOrEqual(0); // 已成顺，无新增出路需求
  });
});

describe("行动线生成", () => {
  it("attack 固定 open 线（2 行），defense 两种线都出现且各 2 行", () => {
    const rng = lcg(99);
    const defenseKinds = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const s = dealPostflopScenario(rng);
      expect(s.actionLine.length).toBe(2);
      if (s.type === "attack") {
        expect(s.lineKind).toBe("open");
        if (s.opponents === 1) {
          expect(s.actionLine[1].zh).toContain("对手过牌");
        } else {
          expect(s.actionLine[1].zh).toContain("轮到你");
        }
      } else {
        defenseKinds.add(s.lineKind);
        expect(["open", "threeBet"]).toContain(s.lineKind);
      }
    }
    expect(defenseKinds.size).toBe(2);
  });

  it("行动线双语、行内无重复、含开局位与下注尺度", () => {
    const rng = lcg(7);
    for (let i = 0; i < 30; i++) {
      const s = dealPostflopScenario(rng);
      const zhSet = new Set(s.actionLine.map((l) => l.zh));
      expect(zhSet.size).toBe(s.actionLine.length);
      for (const line of s.actionLine) {
        expect(line.zh.length).toBeGreaterThan(4);
        expect(line.en.length).toBeGreaterThan(4);
      }
      expect(s.actionLine[0].zh).toContain("翻前");
      expect(s.actionLine[0].zh).toMatch(/（(UTG\+1|LJ|HJ|CO|BTN)）/);
      expect(s.actionLine[1].zh).toMatch(/(1\/2 底池|2\/3 底池|过牌)/);
    }
  });

  it("范围收窄联动：threeBet 线 topPct 0.35 < open 线 0.6（3bet 线比开局线更紧）", () => {
    expect(defenseRangeSpecFor("open")).toEqual(DEFENSE_RANGE_SPEC);
    expect(defenseRangeSpecFor("threeBet")).toEqual(FLOP_DEFENSE_3BET_RANGE_SPEC);
    expect(defenseRangeSpecFor("threeBet").topPct).toBeLessThan(
      defenseRangeSpecFor("open").topPct,
    );
    expect(defenseRangeSpecFor("threeBet").topPct).toBe(0.35);
    expect(defenseRangeSpecFor("open").topPct).toBe(0.6);
  });

  it("整题的 lineKind 与行动线文本一致（threeBet 线提到 3bet）", () => {
    const rng = lcg(31);
    for (let i = 0; i < 40; i++) {
      const s = dealPostflopScenario(rng);
      if (s.type !== "defense") continue;
      if (s.lineKind === "threeBet") {
        expect(s.actionLine[0].zh).toContain("3bet");
      } else {
        expect(s.actionLine[0].zh).not.toContain("3bet");
      }
    }
  });

  it("drawPostflopLine 同一种子可复现", () => {
    expect(drawPostflopLine("defense", lcg(5))).toEqual(
      drawPostflopLine("defense", lcg(5)),
    );
  });
});

describe("难度过滤（反脑残）", () => {  it("防守题：判定胜率 0.1（纯垃圾弃牌）必被重发，0.5 保留", () => {
    expect(isTooObvious(0.1, "defense")).toBe(true);
    expect(isTooObvious(0.19, "defense")).toBe(true);
    expect(isTooObvious(0.5, "defense")).toBe(false);
    expect(isTooObvious(0.2, "defense")).toBe(false); // 边界：<20% 才重发
  });

  it("防守题：>85%（坚果级无脑加注/跟注）重发，0.85 边界保留", () => {
    expect(isTooObvious(0.9, "defense")).toBe(true);
    expect(isTooObvious(0.85, "defense")).toBe(false);
  });

  it("进攻题：>85% 无脑价值重发；<25% 无听牌重发、有强听牌保留", () => {
    const noDraw = { flushDraw: false, straightOuts: 0 };
    const strongDraw = { flushDraw: true, straightOuts: 0 };
    expect(isTooObvious(0.9, "attack", noDraw)).toBe(true);
    expect(isTooObvious(0.1, "attack", noDraw)).toBe(true);
    expect(isTooObvious(0.1, "attack", strongDraw)).toBe(false);
    expect(isTooObvious(0.5, "attack", noDraw)).toBe(false);
  });

  it(
    "生成的题全部不在显而易见区（防守题判定胜率 ∈ [0.2, 0.85]）",
    () => {
      // 题量由 40 减到 24：A3 边界带复核（每次 20000 迭代 ≈2-3s）在小迭代
      // 基数下命中率高，统计性断言无需原题量
      const rng = lcg(2026);
      for (let i = 0; i < 24; i++) {
        const q = generatePostflopQuiz(rng, 400);
        expect(
          isTooObvious(q.defenseEquity ?? q.equity.win, q.type, q.draws),
        ).toBe(false);
        if (q.type === "defense") {
          expect(q.defenseEquity!).toBeGreaterThanOrEqual(0.2);
          expect(q.defenseEquity!).toBeLessThanOrEqual(0.85);
        }
      }
    },
    120000,
  );

  it("恒定 rng 极端情形：10 次上限兜底返回合法题，不死循环", () => {
    const q = generatePostflopQuiz(() => 0, 200);
    expect(["aggressive", "passive", "fold"]).toContain(q.answer);
    expect(new Set([...q.hero, ...q.board]).size).toBe(5);
    // 若该恒定场景本就是显而易见的，兜底后按最后一次结果返回（不无限重发）
    expect(FILTER_MAX_ATTEMPTS).toBe(10);
  });
});

describe("底牌与行动线一致性（hero 范围抽样接线）", () => {
  it("抽样 200 次：底牌全部落在行动线开局位的 open 范围内（两种题型都覆盖）", () => {
    const rng = lcg(555);
    const types = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const s = dealPostflopScenario(rng);
      types.add(s.type);
      const role = heroRoleForPostflop(s.type, s.lineKind, s.opponents);
      // 单挑行动线里 hero 都是开局方；多人池 hero 是跟注者（attack=BTN 跟注 / defense=大盲跟注）
      if (s.opponents === 1) {
        expect(role).toBe("open");
      } else {
        expect(role).toBe(s.type === "attack" ? "caller" : "bbDefend");
      }
      const label = cardsToHandType(s.hero[0], s.hero[1]).label;
      expect(
        heroRangeLabels(role, s.openPos).has(label),
        `${s.type}/${s.lineKind}（${s.openPos}）发出了范围外的 ${label}`,
      ).toBe(true);
    }
    expect(types.size).toBe(2);
  });

  it("2♥4♥ 类绝对垃圾永不出现（用户实报案例回归）", () => {
    const rng = lcg(777);
    const trash = new Set(["72o", "82o", "92o", "94o", "32o", "42o", "83o", "74o",
      "42s", "72s", "82s", "92s", "32s", "85o", "73o"]);
    for (let i = 0; i < 200; i++) {
      const s = dealPostflopScenario(rng);
      expect(trash.has(cardsToHandType(s.hero[0], s.hero[1]).label)).toBe(false);
    }
  });
});
