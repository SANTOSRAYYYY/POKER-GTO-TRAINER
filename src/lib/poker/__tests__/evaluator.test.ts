import { describe, expect, it } from "vitest";
import type { Card } from "@/lib/types";
import { compareHands, evaluate7, handName } from "@/lib/poker/evaluator";

const c = (s: string) => s.split(" ") as Card[];

describe("evaluator: 牌型类别排序", () => {
  it("同花顺 > 四条 > 葫芦 > 同花 > 顺子 > 三条 > 两对 > 一对 > 高牌", () => {
    const sf = evaluate7(c("As Ks Qs Js Ts"));
    const quads = evaluate7(c("9h 9d 9c 9s Ah"));
    const boat = evaluate7(c("Kh Kd Kc Qh Qd"));
    const flush = evaluate7(c("As Qs 9s 5s 2s"));
    const straight = evaluate7(c("9h 8d 7c 6s 5h"));
    const trips = evaluate7(c("Ah Ad Ac Ks Qd"));
    const twoPair = evaluate7(c("Kh Kd Qc Qs Jh"));
    const pair = evaluate7(c("Ah Ad Ks Qd Jc"));
    const high = evaluate7(c("Ah Kd Qs Jc 9h"));

    expect(sf).toBeGreaterThan(quads);
    expect(quads).toBeGreaterThan(boat);
    expect(boat).toBeGreaterThan(flush);
    expect(flush).toBeGreaterThan(straight);
    expect(straight).toBeGreaterThan(trips);
    expect(trips).toBeGreaterThan(twoPair);
    expect(twoPair).toBeGreaterThan(pair);
    expect(pair).toBeGreaterThan(high);
  });
});

describe("evaluator: 同牌型踢脚比较", () => {
  it("高牌比踢脚", () => {
    expect(evaluate7(c("Ah Kd Qs Jc 9h"))).toBeGreaterThan(
      evaluate7(c("Ah Kd Qs Jc 8h")),
    );
  });

  it("对子先比对子点数再比踢脚", () => {
    expect(evaluate7(c("Ah Ad 2s 3c 4h"))).toBeGreaterThan(
      evaluate7(c("Kh Kd As Qc Jh")),
    );
    expect(evaluate7(c("Ah Ad Ks Qc Jh"))).toBeGreaterThan(
      evaluate7(c("Ah Ad Ks Qc Th")),
    );
  });

  it("两对先比大对子、再比小对子、最后比踢脚", () => {
    expect(evaluate7(c("Ah Ad Kh Kd Qc"))).toBeGreaterThan(
      evaluate7(c("Ah Ad Qh Qd Kc")),
    );
    expect(evaluate7(c("Ah Ad Kh Kd Qc"))).toBeGreaterThan(
      evaluate7(c("Ah Ad Kh Kd Jc")),
    );
    expect(evaluate7(c("Ah Ad Kh Kd 2c"))).toBeGreaterThan(
      evaluate7(c("Kh Kd Qh Qd Ac")),
    );
  });

  it("三条比点数再比踢脚", () => {
    expect(evaluate7(c("Ah Ad Ac 2s 3d"))).toBeGreaterThan(
      evaluate7(c("Kh Kd Kc As Qd")),
    );
    expect(evaluate7(c("Ah Ad Ac Ks Qd"))).toBeGreaterThan(
      evaluate7(c("Ah Ad Ac Ks Jd")),
    );
  });

  it("顺子比顶张", () => {
    expect(evaluate7(c("Ah Kd Qs Jc Th"))).toBeGreaterThan(
      evaluate7(c("Kh Qd Js Tc 9h")),
    );
  });

  it("同花比五张点数", () => {
    expect(evaluate7(c("Ah Kh Qh 9h 5h"))).toBeGreaterThan(
      evaluate7(c("Ah Kh Qh 9h 4h")),
    );
  });

  it("葫芦比三条点数", () => {
    expect(evaluate7(c("Kh Kd Kc 2h 2d"))).toBeGreaterThan(
      evaluate7(c("Qh Qd Qc Ah Ad")),
    );
  });

  it("四条比点数再比踢脚", () => {
    expect(evaluate7(c("Ah Ad Ac As Kh"))).toBeGreaterThan(
      evaluate7(c("Kh Kd Kc Ks Ah")),
    );
    expect(evaluate7(c("Ah Ad Ac As Kh"))).toBeGreaterThan(
      evaluate7(c("Ah Ad Ac As Qh")),
    );
  });

  it("同花顺比顶张", () => {
    expect(evaluate7(c("As Ks Qs Js Ts"))).toBeGreaterThan(
      evaluate7(c("9s 8s 7s 6s 5s")),
    );
  });
});

describe("evaluator: wheel（A2345）按 5 高处理", () => {
  it("wheel 是顺子且小于 6 高顺", () => {
    const wheel = evaluate7(c("As 2d 3c 4h 5s"));
    const sixHigh = evaluate7(c("6h 5d 4c 3s 2h"));
    const pairA = evaluate7(c("Ah Ad Ks Qd Jc"));
    expect(wheel).toBeGreaterThan(pairA); // 是顺子
    expect(wheel).toBeLessThan(sixHigh); // 按 5 高
  });

  it("wheel 同花顺小于 6 高同花顺", () => {
    expect(evaluate7(c("As 2s 3s 4s 5s"))).toBeLessThan(
      evaluate7(c("6s 5s 4s 3s 2s")),
    );
  });
});

describe("evaluator: 7 张取最优 5 张", () => {
  it("7 张中的同花顺", () => {
    expect(evaluate7(c("As Ks Qs Js Ts 2d 3c"))).toBe(
      evaluate7(c("As Ks Qs Js Ts")),
    );
  });

  it("两对 vs 三条：7 张里挑出三条", () => {
    expect(evaluate7(c("Ah Ad Ac Ks Qd 2h 3c"))).toBe(
      evaluate7(c("Ah Ad Ac Ks Qd")),
    );
  });

  it("张数/重复校验", () => {
    expect(() => evaluate7(c("As Ks Qs Js"))).toThrow();
    expect(() => evaluate7(c("As Ks Qs Js Ts 9s 8s 7s"))).toThrow();
    expect(() => evaluate7(c("As Ks Qs Js As"))).toThrow();
  });
});

describe("evaluator: compareHands", () => {
  const board = c("As Kd 2h 3c 4s");

  it("两对赢一对", () => {
    expect(compareHands(c("Ah Kh"), c("Qd Qc"), board)).toBe(1);
    expect(compareHands(c("Qd Qc"), c("Ah Kh"), board)).toBe(-1);
  });

  it("平分秋色", () => {
    // 双方都玩公共牌顺子
    const straightBoard = c("5h 6d 7c 8s 9h");
    expect(compareHands(c("2h 3d"), c("Ah Kd"), straightBoard)).toBe(0);
  });

  it("踢脚分出胜负", () => {
    // 双方都是高牌 A，K 踢脚胜 Q 踢脚（注意避开 2-3-4-5 配 A 成 wheel）
    expect(compareHands(c("Ah Kd"), c("As Qc"), c("2h 3d 4c 6s 9h"))).toBe(1);
  });
});

describe("evaluator: handName 中文牌型名", () => {
  const cases: [string, string][] = [
    ["As Ks Qs Js Ts 2d 3c", "同花顺"],
    ["9h 9d 9c 9s Ah 2d 3c", "四条"],
    ["Kh Kd Kc Qh Qd 2s 3c", "葫芦"],
    ["Ah Qh 9h 5h 2h Kd 3c", "同花"],
    ["9h 8d 7c 6s 5h 2d 3c", "顺子"],
    ["As 2d 3c 4h 5s Kd 9c", "顺子"], // wheel
    ["Ah Ad Ac Ks Qd 2h 3c", "三条"],
    ["Kh Kd Qc Qs Jh 2d 3c", "两对"],
    ["Ah Ad Ks Qd Jc 2h 3c", "一对"],
    ["Ah Kd Qs Jc 9h 2d 3c", "高牌"],
  ];
  for (const [cards, name] of cases) {
    it(`${cards} → ${name}`, () => {
      expect(handName(c(cards))).toBe(name);
    });
  }
});
