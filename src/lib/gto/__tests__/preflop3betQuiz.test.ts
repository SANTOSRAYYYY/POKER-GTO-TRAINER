/**
 * preflop3betQuiz.ts（翻前 3bet 应对出题器）测试
 *
 * - 发牌：hero 2 张互不重复且落在 hero 开局位（BTN/CO）的开局范围内；
 *   位置 BTN/CO 与 3bet 范围紧/松合法；种子可复现
 * - 行动线：sb/bb/aggro 三种路线都出现、两行双语、首行含 hero 位置
 * - 判定边界：60% 4bet 线 / 45% 跟注线（±0.01 卡点）
 * - 静态表锚点（preflopEquityVsOpenRange 实算值）：
 *   KK/AKs → 4bet；AKo/TT/AJo → 跟注；66/KQs/98o → 弃牌
 *   （AA 84.3% > 75% 被难度过滤，改用 KK 72.6% 作坚果锚点；
 *   72o 已不在开局范围，改用 98o 33.1% 作弱牌弃牌锚点）
 * - 难度过滤：isTooObvious 口径（<0.25 / >0.75 重发，0.5 保留）；
 *   生成的题胜率恒在 [0.25, 0.75]；恒定 rng 下 10 次兜底不死循环
 * - 混合场景：200 题内两种位置、两档范围都出现，答案分布含 call 与 fold
 * - 点评文案含胜率数字与「对紧/松 3bet 范围」字样
 */
import { describe, expect, it } from "vitest";
import {
  dealPreflop3BetScenario,
  drawThreeBetLine,
  FOURBET_THRESHOLD,
  generatePreflop3BetQuiz,
  isTooObvious,
  judge3bet,
  THREEBET_CALL_THRESHOLD,
  THREEBET_RANGE_LOOSE,
  THREEBET_RANGE_TIGHT,
  threeBetQuizComment,
} from "../preflop3betQuiz";
import { heroRangeLabels } from "../heroRange";
import { cardsToHandType } from "../pushfold";

/** 线性同余种子 rng（测试可复现） */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("dealPreflop3BetScenario 发牌", () => {
  it("hero 2 张互不重复，位置与范围档合法", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = dealPreflop3BetScenario(lcg(seed));
      expect(new Set(s.hero).size).toBe(2);
      for (const card of s.hero) expect(card).toMatch(/^[2-9TJQKA][shdc]$/);
      expect(["BTN", "CO"]).toContain(s.position);
      expect([THREEBET_RANGE_TIGHT, THREEBET_RANGE_LOOSE]).toContain(
        s.threeBetRangePct,
      );
    }
  });

  it("同一种子 rng 发同样的牌（可复现）", () => {
    expect(dealPreflop3BetScenario(lcg(42))).toEqual(dealPreflop3BetScenario(lcg(42)));
  });
});

describe("judge3bet 判定边界（±0.01 卡点）", () => {
  it("≥60% → 4bet（含 0.60 边界）", () => {
    expect(judge3bet(0.61)).toBe("fourbet");
    expect(judge3bet(FOURBET_THRESHOLD)).toBe("fourbet");
    expect(judge3bet(0.59)).toBe("call");
  });

  it("45-60% → 跟注（含 0.45 边界）；<45% → 弃牌", () => {
    expect(judge3bet(0.46)).toBe("call");
    expect(judge3bet(THREEBET_CALL_THRESHOLD)).toBe("call");
    expect(judge3bet(0.44)).toBe("fold");
    expect(judge3bet(0.25)).toBe("fold");
  });
});

describe("generatePreflop3BetQuiz 静态表锚点（实算胜率表）", () => {
  /** 固定种子出题直到拿到指定 label 的题 */
  function quizOf(label: string, tight?: boolean) {
    for (let seed = 1; seed < 200000; seed++) {
      const q = generatePreflop3BetQuiz(lcg(seed));
      if (q.handLabel !== label) continue;
      if (tight !== undefined) {
        const want = tight ? THREEBET_RANGE_TIGHT : THREEBET_RANGE_LOOSE;
        if (q.threeBetRangePct !== want) continue;
      }
      return q;
    }
    throw new Error(`未抽到 ${label}`);
  }

  it("KK（72.6%）与 AKs（60.6%）→ 4bet（AA 84.3% 超过 75% 无脑线，被难度过滤不出题）", () => {
    const kk = quizOf("KK");
    expect(kk.equity).toBeCloseTo(0.726, 3);
    expect(kk.answer).toBe("fourbet");
    const aks = quizOf("AKs");
    expect(aks.equity).toBeCloseTo(0.606, 3);
    expect(aks.answer).toBe("fourbet");
  });

  it("AKo（59.2%）/ TT（56.0%）/ AJo（47.0%）→ 跟注（45-60% 带）", () => {
    for (const [label, eq] of [
      ["AKo", 0.592],
      ["TT", 0.56],
      ["AJo", 0.47],
    ] as const) {
      const q = quizOf(label);
      expect(q.equity).toBeCloseTo(eq, 3);
      expect(q.answer).toBe("call");
    }
  });

  it("66（44.0% 紧贴 45% 线下方）/ KQs（42.0%）/ 98o（33.1%）→ 弃牌", () => {
    // 72o（25.3%）已不在 hero 开局范围（底牌按 open 角色抽），改用 98o 作弱牌锚点
    for (const [label, eq] of [
      ["66", 0.44],
      ["KQs", 0.42],
      ["98o", 0.331],
    ] as const) {
      const q = quizOf(label);
      expect(q.equity).toBeCloseTo(eq, 3);
      expect(q.answer).toBe("fold");
    }
  });

  it("紧/松两档范围当前映射同一静态表档（15% 档），胜率一致（量化注记回归）", () => {
    const tight = quizOf("TT", true);
    const loose = quizOf("TT", false);
    expect(tight.threeBetRangePct).toBe(THREEBET_RANGE_TIGHT);
    expect(loose.threeBetRangePct).toBe(THREEBET_RANGE_LOOSE);
    expect(tight.equity).toBe(loose.equity);
  });
});

describe("generatePreflop3BetQuiz 混合场景与点评", () => {
  it("200 题内两种位置、两档范围都出现，三种答案都有且弃牌占多数", () => {
    // 难度过滤后 fourbet 只剩 [60%,75%] 带（KK/QQ/JJ/AKs，约 1.7% 的手牌），
    // 50 题抽样有 ~43% 概率抽不到 fourbet——放宽到 200 题使固定种子稳定覆盖
    const rng = lcg(42);
    const positions = new Set<string>();
    const tiers = new Set<number>();
    const counts = new Map<string, number>();
    for (let i = 0; i < 200; i++) {
      const q = generatePreflop3BetQuiz(rng);
      positions.add(q.position);
      tiers.add(q.threeBetRangePct);
      counts.set(q.answer, (counts.get(q.answer) ?? 0) + 1);
      expect(q.answer).toBe(judge3bet(q.equity));
      expect(q.handLabel).toMatch(/^[2-9TJQKA]{2}[so]?$/);
    }
    expect(positions.size).toBe(2);
    expect(tiers.size).toBe(2);
    // 对 8-15% 的 3bet 范围：大多数起手牌该弃，少数中对/大 A 跟注，极强牌 4bet
    expect(counts.has("fourbet")).toBe(true);
    expect(counts.has("call")).toBe(true);
    expect(counts.get("fold")!).toBeGreaterThan(counts.get("call")!);
    expect(counts.get("fold")!).toBeGreaterThan(counts.get("fourbet")!);
  });

  it("threeBetQuizComment 含胜率数字与「对紧/松 3bet 范围」字样", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const q = generatePreflop3BetQuiz(lcg(seed));
      const text = threeBetQuizComment(q);
      expect(text).toContain((q.equity * 100).toFixed(1));
      expect(text).toContain(q.handLabel);
      const tightness = q.threeBetRangePct === THREEBET_RANGE_TIGHT ? "紧" : "松";
      expect(text).toContain(`对${tightness} 3bet 范围`);
    }
  });
});

describe("行动线生成", () => {
  it("sb/bb/aggro 三种路线都出现，两行双语、首行含 hero 开局位", () => {
    const rng = lcg(11);
    const kinds = new Set<string>();
    for (let i = 0; i < 90; i++) {
      const s = dealPreflop3BetScenario(rng);
      kinds.add(s.lineKind);
      expect(s.actionLine.length).toBe(2);
      for (const line of s.actionLine) {
        expect(line.zh.length).toBeGreaterThan(4);
        expect(line.en.length).toBeGreaterThan(4);
      }
      expect(s.actionLine[0].zh).toContain(`你（${s.position}）开局加注`);
      expect(s.actionLine[1].zh).toContain("3bet");
      expect(s.actionLine[1].zh).toContain("轮到你");
    }
    expect(kinds.size).toBe(3);
  });

  it("aggro 线标注激进画像，sb 线说明大盲弃牌", () => {
    expect(drawThreeBetLine("BTN", () => 0.9).kind).toBe("aggro");
    expect(drawThreeBetLine("BTN", () => 0.9).lines[1].zh).toContain("激进");
    expect(drawThreeBetLine("BTN", () => 0.1).kind).toBe("sb");
    expect(drawThreeBetLine("BTN", () => 0.1).lines[1].zh).toContain("大盲弃牌");
    expect(drawThreeBetLine("BTN", () => 0.5).kind).toBe("bb");
  });

  it("drawThreeBetLine 同一种子可复现", () => {
    expect(drawThreeBetLine("CO", lcg(5))).toEqual(drawThreeBetLine("CO", lcg(5)));
  });
});

describe("难度过滤（反脑残）", () => {
  it("对范围胜率 <25%（纯垃圾无脑弃）或 >75%（坚果级无脑 4bet）重发，0.5 保留", () => {
    expect(isTooObvious(0.1)).toBe(true);
    expect(isTooObvious(0.843)).toBe(true); // AA 对紧 3bet 范围
    expect(isTooObvious(0.5)).toBe(false);
    expect(isTooObvious(0.25)).toBe(false); // 边界保留
    expect(isTooObvious(0.75)).toBe(false);
    expect(isTooObvious(0.726)).toBe(false); // KK 保留
  });

  it("生成的 100 道题胜率全部落在 [0.25, 0.75]（AA 不再出现）", () => {
    const rng = lcg(4242);
    for (let i = 0; i < 100; i++) {
      const q = generatePreflop3BetQuiz(rng);
      expect(q.equity).toBeGreaterThanOrEqual(0.25);
      expect(q.equity).toBeLessThanOrEqual(0.75);
      expect(q.handLabel).not.toBe("AA");
      expect(q.answer).toBe(judge3bet(q.equity));
    }
  });

  it("恒定 rng 极端情形：10 次上限兜底返回合法题，不死循环", () => {
    const q = generatePreflop3BetQuiz(() => 0);
    expect(["fourbet", "call", "fold"]).toContain(q.answer);
    expect(new Set(q.hero).size).toBe(2);
  });
});

describe("底牌与行动线一致性（hero 范围抽样接线）", () => {
  it("抽样 200 次：底牌全部落在 hero 开局位（BTN/CO）的 open 范围内", () => {
    const rng = lcg(555);
    const positions = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const s = dealPreflop3BetScenario(rng);
      positions.add(s.position);
      const label = cardsToHandType(s.hero[0], s.hero[1]).label;
      expect(
        heroRangeLabels("open", s.position).has(label),
        `${s.position} 开局发出了范围外的 ${label}`,
      ).toBe(true);
    }
    expect(positions.size).toBe(2);
  });

  it("72o 等开局范围外垃圾永不出题（用户实报案例回归）", () => {
    const rng = lcg(777);
    const trash = new Set(["72o", "82o", "92o", "94o", "32o", "42o", "83o", "74o",
      "42s", "72s", "82s", "92s", "32s", "85o", "73o"]);
    for (let i = 0; i < 200; i++) {
      const q = generatePreflop3BetQuiz(rng);
      expect(trash.has(q.handLabel)).toBe(false);
      // 题面底牌也必在其开局位范围内
      expect(heroRangeLabels("open", q.position).has(q.handLabel)).toBe(true);
    }
  });
});
