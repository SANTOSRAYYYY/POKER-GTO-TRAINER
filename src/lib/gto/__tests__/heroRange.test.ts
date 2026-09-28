/**
 * heroRange.ts（底牌与行动线一致性：角色范围抽样器）测试
 *
 * - 范围集合构成：caller 无 72o/82o/92o/94o 档绝对垃圾（也不含 3bet 格 66+/AKo）；
 *   threeBet = 顶端价值带 + 指定诈唬集；bbDefend 宽但排除底部纯垃圾；
 *   open 按开局位（UTG+1 紧 / BTN 宽）各成集合
 * - 抽样器：各角色抽 500 次全部落入对应范围集合；caller 样本无绝对垃圾；
 *   threeBet 样本全在顶端带或指定诈唬集；open 指定开局位时样本全在该位开局表
 * - 展开器 labelToCards：对子不同花色、同花同花色、杂色不同花色、两张不重复
 * - dealRemainingCards：数量正确、无重复、不碰已发牌
 * - 种子可复现；rng 端点（0 / →1）鲁棒
 */
import { describe, expect, it } from "vitest";
import type { Card } from "@/lib/types";
import {
  dealRemainingCards,
  heroRangeLabels,
  labelToCards,
  sampleHeroCards,
  THREEBET_BLUFF_NOTATION,
  THREEBET_VALUE_NOTATION,
  type HeroRole,
} from "../heroRange";
import { expandRange } from "../ranges";
import { cardsToHandType } from "../pushfold";
import { OPEN_POS_OPTS } from "../actionLine";

/** 线性同余种子 rng（测试可复现） */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** 两张底牌 → 169 牌型标签（如 "72o"/"AKs"/"AA"） */
function labelOf(hero: [Card, Card]): string {
  return cardsToHandType(hero[0], hero[1]).label;
}

describe("heroRangeLabels 范围集合构成", () => {
  it("caller：含可玩跟注牌，排除 72o/82o/92o/94o 档绝对垃圾与低点同花垃圾", () => {
    const s = heroRangeLabels("caller");
    for (const label of ["22", "55", "A5s", "KTs", "J9s", "98s", "A2o", "K9o", "T9o", "98o"]) {
      expect(s.has(label), `${label} 应在 caller 范围`).toBe(true);
    }
    // 绝对垃圾全灭（杂色垃圾档 + 低点无连接同花）
    for (const label of ["72o", "82o", "92o", "94o", "32o", "42o", "83o", "74o",
      "42s", "72s", "73s", "82s", "92s", "32s"]) {
      expect(s.has(label), `${label} 不应在 caller 范围`).toBe(false);
    }
    // 3bet 格（66+ / AJs+ / KQs / AKo）不在「跟注」范围
    for (const label of ["66", "AA", "AJs", "KQs", "AKo"]) {
      expect(s.has(label), `${label} 是 3bet 格，不应在 caller 跟注范围`).toBe(false);
    }
  });

  it("threeBet：顶端价值带 + 少量同花连张/Ax 诈唬，带外牌不入", () => {
    const s = heroRangeLabels("threeBet");
    for (const label of ["AA", "77", "AKs", "A9s", "KTs", "JTs", "AJo", "KQo"]) {
      expect(s.has(label), `${label} 应在 threeBet 价值带`).toBe(true);
    }
    // 指定诈唬集：轮子 Ax 同花 + 小同花连张
    for (const label of ["A2s", "A3s", "A4s", "A5s", "87s", "76s", "65s", "54s"]) {
      expect(s.has(label), `${label} 应在 threeBet 诈唬集`).toBe(true);
    }
    for (const label of ["66", "55", "A8s", "A6s", "K9s", "Q9s", "J9s", "98s", "ATo", "KJo", "72o"]) {
      expect(s.has(label), `${label} 不应在 threeBet 范围`).toBe(false);
    }
    // 集合恰好 = 价值带 ∪ 诈唬集
    const expectSet = expandRange(THREEBET_VALUE_NOTATION);
    for (const l of expandRange(THREEBET_BLUFF_NOTATION)) expectSet.add(l);
    expect(new Set(s)).toEqual(expectSet);
  });

  it("bbDefend：宽范围（全对子/可玩同花与杂色），排除底部纯垃圾", () => {
    const s = heroRangeLabels("bbDefend");
    for (const label of ["22", "AA", "A2s", "43s", "65s", "93s",
      "A2o", "K5o", "Q8o", "J8o", "T8o", "98o", "87o", "76o", "65o"]) {
      expect(s.has(label), `${label} 应在 bbDefend 范围`).toBe(true);
    }
    for (const label of ["72o", "82o", "92o", "94o", "32o", "85o", "96o", "J7o",
      "42s", "72s", "73s", "82s", "92s", "32s"]) {
      expect(s.has(label), `${label} 不应在 bbDefend 范围`).toBe(false);
    }
  });

  it("open：按开局位取对应开局表（UTG+1 紧、BTN 宽），缺省为并集", () => {
    const utg1 = heroRangeLabels("open", "UTG+1");
    expect(utg1.has("AQo")).toBe(true);
    expect(utg1.has("66")).toBe(true);
    expect(utg1.has("98s")).toBe(true);
    for (const label of ["55", "22", "98o", "K8s", "72o", "A2o"]) {
      expect(utg1.has(label), `${label} 不应在 UTG+1 开局范围`).toBe(false);
    }
    const btn = heroRangeLabels("open", "BTN");
    for (const label of ["22", "54s", "K2s", "98o", "K8o", "A2o", "J9o"]) {
      expect(btn.has(label), `${label} 应在 BTN 开局范围`).toBe(true);
    }
    for (const label of ["72o", "85o", "94o", "J7o"]) {
      expect(btn.has(label), `${label} 不应在 BTN 开局范围`).toBe(false);
    }
    const union = heroRangeLabels("open");
    for (const pos of OPEN_POS_OPTS) {
      for (const label of heroRangeLabels("open", pos)) {
        expect(union.has(label)).toBe(true);
      }
    }
    expect(union.size).toBe(btn.size); // 并集 = 最宽的 BTN 表
  });
});

describe("sampleHeroCards 抽样器（每角色 500 次）", () => {
  const roles: HeroRole[] = ["open", "caller", "threeBet", "bbDefend"];

  it("各角色 500 次抽样全部落入对应范围集合，且样本牌合法", () => {
    for (const role of roles) {
      const rng = lcg(1000 + roles.indexOf(role));
      const range = heroRangeLabels(role);
      for (let i = 0; i < 500; i++) {
        const hero = sampleHeroCards(rng, role);
        expect(hero[0]).toMatch(/^[2-9TJQKA][shdc]$/);
        expect(hero[1]).toMatch(/^[2-9TJQKA][shdc]$/);
        expect(hero[0]).not.toBe(hero[1]);
        expect(range.has(labelOf(hero)), `${role} 抽出了范围外的 ${labelOf(hero)}`).toBe(true);
      }
    }
  });

  it("caller 样本永无 72o/82o/92o/94o/42s 等绝对垃圾（用户实报案例回归）", () => {
    const rng = lcg(7);
    const trash = new Set(["72o", "82o", "92o", "94o", "32o", "42o", "83o", "74o",
      "42s", "72s", "82s", "92s", "32s"]);
    for (let i = 0; i < 500; i++) {
      expect(trash.has(labelOf(sampleHeroCards(rng, "caller")))).toBe(false);
    }
  });

  it("threeBet 样本全在顶端价值带或指定诈唬集", () => {
    const rng = lcg(11);
    const value = expandRange(THREEBET_VALUE_NOTATION);
    const bluff = expandRange(THREEBET_BLUFF_NOTATION);
    let sawBluff = false;
    for (let i = 0; i < 500; i++) {
      const label = labelOf(sampleHeroCards(rng, "threeBet"));
      expect(value.has(label) || bluff.has(label)).toBe(true);
      if (bluff.has(label) && !value.has(label)) sawBluff = true;
    }
    expect(sawBluff).toBe(true); // 500 次应至少抽到一次诈唬集牌型
  });

  it("open 指定开局位时样本全在该位开局表（牌与行动线文本对齐）", () => {
    for (const pos of OPEN_POS_OPTS) {
      const rng = lcg(2000);
      const range = heroRangeLabels("open", pos);
      for (let i = 0; i < 200; i++) {
        const hero = sampleHeroCards(rng, "open", { openPos: pos });
        expect(range.has(labelOf(hero)), `${pos} 开局抽出了表外 ${labelOf(hero)}`).toBe(true);
      }
    }
  });

  it("同一种子 rng 抽同样的牌（可复现）", () => {
    expect(sampleHeroCards(lcg(42), "caller")).toEqual(sampleHeroCards(lcg(42), "caller"));
    expect(sampleHeroCards(lcg(42), "open", { openPos: "CO" })).toEqual(
      sampleHeroCards(lcg(42), "open", { openPos: "CO" }),
    );
  });

  it("抽样有覆盖面：500 次 caller 出现 >30 种不同牌型", () => {
    const rng = lcg(99);
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(labelOf(sampleHeroCards(rng, "caller")));
    expect(seen.size).toBeGreaterThan(30);
  });

  it("rng 端点鲁棒：rng()=0 与 rng()→1 都返回合法牌", () => {
    for (const role of roles) {
      for (const edge of [() => 0, () => 0.999999]) {
        const hero = sampleHeroCards(edge, role);
        expect(hero[0]).toMatch(/^[2-9TJQKA][shdc]$/);
        expect(hero[1]).toMatch(/^[2-9TJQKA][shdc]$/);
        expect(hero[0]).not.toBe(hero[1]);
        expect(heroRangeLabels(role).has(labelOf(hero))).toBe(true);
      }
    }
  });
});

describe("labelToCards 牌型展开器", () => {
  it("对子：同点数、两个不同花色", () => {
    const rng = lcg(5);
    for (let i = 0; i < 50; i++) {
      const [a, b] = labelToCards("AA", rng);
      expect(a[0]).toBe("A");
      expect(b[0]).toBe("A");
      expect(a[1]).not.toBe(b[1]);
      expect(a).not.toBe(b);
    }
  });

  it("同花：同一花色、点数按标签", () => {
    const rng = lcg(5);
    for (let i = 0; i < 50; i++) {
      const [a, b] = labelToCards("AKs", rng);
      expect(a[1]).toBe(b[1]);
      expect([a[0], b[0]].sort().join("")).toBe("AK");
    }
  });

  it("杂色：两个不同花色、点数按标签", () => {
    const rng = lcg(5);
    for (let i = 0; i < 50; i++) {
      const [a, b] = labelToCards("AKo", rng);
      expect(a[1]).not.toBe(b[1]);
      expect([a[0], b[0]].sort().join("")).toBe("AK");
    }
  });

  it("rng 端点不越界（rng()=0 / →1 对子花色也不重复）", () => {
    for (const edge of [() => 0, () => 0.999999]) {
      for (const label of ["AA", "22", "AKs", "72o"]) {
        const [a, b] = labelToCards(label, edge);
        expect(a).not.toBe(b);
        if (label.endsWith("s")) expect(a[1]).toBe(b[1]);
        else expect(a[1]).not.toBe(b[1]);
      }
    }
  });
});

describe("dealRemainingCards 公共牌补发", () => {
  it("数量正确、无重复、不碰已发牌", () => {
    const rng = lcg(7);
    for (let i = 0; i < 50; i++) {
      const hero = sampleHeroCards(rng, "open");
      const board = dealRemainingCards(rng, hero, 5);
      expect(board).toHaveLength(5);
      const all = [...hero, ...board];
      expect(new Set(all).size).toBe(7);
    }
  });

  it("同一种子可复现", () => {
    const hero: [Card, Card] = ["As", "Kh"];
    expect(dealRemainingCards(lcg(3), hero, 4)).toEqual(dealRemainingCards(lcg(3), hero, 4));
  });
});
