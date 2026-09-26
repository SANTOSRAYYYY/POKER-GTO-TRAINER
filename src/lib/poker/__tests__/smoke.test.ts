/**
 * 脚手架冒烟测试：验证 vitest、@/ 别名、类型契约与空壳语义。
 */
import { describe, expect, it } from "vitest";
import type { Card, GameState, PlayerAction } from "@/lib/types";
import { newDeck } from "@/lib/poker/cards";

describe("scaffold smoke", () => {
  it("vitest 工作正常", () => {
    expect(1 + 1).toBe(2);
  });

  it("类型契约可用：Card 短码可赋值", () => {
    const c: Card = "As";
    const a: PlayerAction = { type: "call", amount: 100 };
    expect(c).toBe("As");
    expect(a.type).toBe("call");
  });

  it("GameState 结构可构造（仅类型层面）", () => {
    const partial: Pick<GameState, "street" | "pot" | "handOver"> = {
      street: "preflop",
      pot: 0,
      handOver: false,
    };
    expect(partial.handOver).toBe(false);
  });

  it("newDeck 返回 52 张牌", () => {
    expect(newDeck()).toHaveLength(52);
  });
});
