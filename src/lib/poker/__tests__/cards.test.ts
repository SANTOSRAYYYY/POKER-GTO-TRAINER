import { describe, expect, it } from "vitest";
import type { Card } from "@/lib/types";
import {
  cardParts,
  cardToString,
  newDeck,
  parseCard,
  shuffle,
} from "@/lib/poker/cards";

describe("cards", () => {
  it("newDeck: 52 张、无重复、覆盖全部 Rank×Suit", () => {
    const deck = newDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck).size).toBe(52);
    for (const suit of ["s", "h", "d", "c"] as const) {
      for (const rank of [
        "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A",
      ] as const) {
        expect(deck).toContain(`${rank}${suit}`);
      }
    }
  });

  it("newDeck: 顺序为花色 s,h,d,c × 点数 2..A 升序", () => {
    const deck = newDeck();
    expect(deck[0]).toBe("2s");
    expect(deck[12]).toBe("As");
    expect(deck[13]).toBe("2h");
    expect(deck[51]).toBe("Ac");
  });

  it("shuffle: 不修改入参、不改变元素集合", () => {
    const deck = newDeck();
    const copy = deck.slice();
    const shuffled = shuffle(deck);
    expect(deck).toEqual(copy); // 入参未被修改
    expect(shuffled).not.toBe(deck); // 返回新数组
    expect([...shuffled].sort()).toEqual([...deck].sort());
  });

  it("shuffle: 注入 rng 可复现", () => {
    // 固定 rng 序列：mulberry32
    const makeRng = (seed: number) => () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const a = shuffle(newDeck(), makeRng(42));
    const b = shuffle(newDeck(), makeRng(42));
    expect(a).toEqual(b);
    // 几乎不可能与原顺序完全相同
    expect(a).not.toEqual(newDeck());
  });

  it("cardToString: 返回短码自身", () => {
    expect(cardToString("As")).toBe("As");
    expect(cardToString("Td")).toBe("Td");
  });

  it("parseCard: 合法输入归一化", () => {
    expect(parseCard("As")).toBe("As");
    expect(parseCard("AS")).toBe("As");
    expect(parseCard("aS")).toBe("As");
    expect(parseCard("td")).toBe("Td");
    expect(parseCard("TD")).toBe("Td");
    expect(parseCard("2c")).toBe("2c");
  });

  it("parseCard: 非法输入抛错", () => {
    for (const bad of ["", "A", "Ax", "1s", "Ass", "10s", "xs", "a1"]) {
      expect(() => parseCard(bad)).toThrow();
    }
  });

  it("cardParts: 正确拆出点数与花色", () => {
    expect(cardParts("As")).toEqual({ rank: "A", suit: "s" });
    expect(cardParts("Td")).toEqual({ rank: "T", suit: "d" });
    expect(cardParts("2c")).toEqual({ rank: "2", suit: "c" });
  });

  it("parseCard 与 cardToString 互逆", () => {
    const c: Card = "Qh";
    expect(parseCard(cardToString(c))).toBe(c);
  });
});
