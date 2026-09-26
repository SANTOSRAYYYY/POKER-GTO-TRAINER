import { describe, expect, it } from "vitest";
import type { GameState, Seat } from "@/lib/types";
import { actOrderInfo, activeSeatsFromButton, positionName } from "../positions";
import { applyAction, createGame, legalActions } from "@/lib/poker/game";
import { makePlayer } from "./helpers";

function mkState(playerCount: number, buttonSeat: Seat, eliminated: Seat[] = []): GameState {
  return {
    deck: [],
    players: Array.from({ length: playerCount }, (_, seat) =>
      makePlayer({ seat, eliminated: eliminated.includes(seat) }),
    ),
    board: [],
    pot: 0,
    street: "preflop",
    currentSeat: null,
    buttonSeat,
    smallBlind: 5,
    bigBlind: 10,
    ante: 0,
    minRaise: 10,
    currentBet: 0,
    streetActions: [],
    handNumber: 1,
    handOver: false,
    winners: null,
    showdown: false,
  };
}

describe("activeSeatsFromButton", () => {
  it("从按钮起按行动顺序列出全部在局座位", () => {
    expect(activeSeatsFromButton(mkState(6, 0))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(activeSeatsFromButton(mkState(6, 2))).toEqual([2, 3, 4, 5, 0, 1]);
  });

  it("跳过已淘汰座位；按钮已淘汰时从其后第一个在局座位开始", () => {
    expect(activeSeatsFromButton(mkState(9, 0, [1, 4]))).toEqual([0, 2, 3, 5, 6, 7, 8]);
    expect(activeSeatsFromButton(mkState(5, 1, [1]))).toEqual([2, 3, 4, 0]);
  });
});

describe("positionName 全表", () => {
  it("2 人：BTN/SB 与 BB", () => {
    const s = mkState(2, 0);
    expect(positionName(0, s)).toBe("BTN/SB（按钮位=小盲）");
    expect(positionName(1, s)).toBe("BB（大盲）");
  });

  it("3 人：BTN / SB / BB", () => {
    const s = mkState(3, 0);
    expect(positionName(0, s)).toBe("BTN（按钮位）");
    expect(positionName(1, s)).toBe("SB（小盲）");
    expect(positionName(2, s)).toBe("BB（大盲）");
  });

  it("4 人：CO 即 UTG", () => {
    const s = mkState(4, 0);
    expect(positionName(3, s)).toContain("CO");
    expect(positionName(3, s)).toContain("UTG");
  });

  it("5 人：UTG / CO", () => {
    const s = mkState(5, 0);
    expect(positionName(3, s)).toContain("UTG");
    expect(positionName(4, s)).toContain("CO");
  });

  it("6 人：UTG / HJ / CO", () => {
    const s = mkState(6, 0);
    expect(positionName(3, s)).toContain("UTG");
    expect(positionName(4, s)).toContain("HJ");
    expect(positionName(5, s)).toContain("CO");
  });

  it("7 人：UTG / UTG+1 / HJ / CO", () => {
    const s = mkState(7, 0);
    expect(positionName(3, s)).toContain("UTG（");
    expect(positionName(4, s)).toBe("UTG+1");
    expect(positionName(5, s)).toContain("HJ");
    expect(positionName(6, s)).toContain("CO");
  });

  it("8 人：UTG / UTG+1 / LJ / HJ / CO", () => {
    const s = mkState(8, 0);
    expect(positionName(3, s)).toContain("UTG（");
    expect(positionName(4, s)).toBe("UTG+1");
    expect(positionName(5, s)).toContain("LJ");
    expect(positionName(6, s)).toContain("HJ");
    expect(positionName(7, s)).toContain("CO");
  });

  it("9 人：UTG / UTG+1 / UTG+2 / LJ / HJ / CO / BTN / SB / BB", () => {
    const s = mkState(9, 0);
    expect(positionName(0, s)).toContain("BTN");
    expect(positionName(1, s)).toContain("SB");
    expect(positionName(2, s)).toContain("BB");
    expect(positionName(3, s)).toContain("UTG（");
    expect(positionName(4, s)).toBe("UTG+1");
    expect(positionName(5, s)).toBe("UTG+2");
    expect(positionName(6, s)).toContain("LJ");
    expect(positionName(7, s)).toContain("HJ");
    expect(positionName(8, s)).toContain("CO");
  });

  it("按钮不在座位 0 时按按钮轮转", () => {
    const s = mkState(6, 2);
    expect(positionName(2, s)).toContain("BTN");
    expect(positionName(3, s)).toContain("SB");
    expect(positionName(4, s)).toContain("BB");
    expect(positionName(5, s)).toContain("UTG");
    expect(positionName(0, s)).toContain("HJ");
    expect(positionName(1, s)).toContain("CO");
  });

  it("已淘汰座位返回「已淘汰」，其余座位按在局人数重新命名", () => {
    const s = mkState(9, 0, [1]); // 8 人在局 → 用 8 人表
    expect(positionName(1, s)).toBe("已淘汰");
    expect(positionName(2, s)).toContain("SB");
    expect(positionName(3, s)).toContain("BB");
    expect(positionName(4, s)).toContain("UTG（");
    expect(positionName(5, s)).toBe("UTG+1");
    expect(positionName(6, s)).toContain("LJ");
    expect(positionName(7, s)).toContain("HJ");
    expect(positionName(8, s)).toContain("CO");
  });
});

describe("actOrderInfo", () => {
  it("6 人桌：翻前 UTG 先动，翻后按钮左邻先动", () => {
    const s = mkState(6, 0);
    const info = actOrderInfo(5, s)!; // CO
    expect(info.preflopFirst).toBe(3);
    expect(info.postflopFirst).toBe(1);
    expect(info.activeCount).toBe(6);
    expect(info.preflopRank).toBe(3); // UTG=1, UTG 左=2, CO=3
    expect(info.postflopRank).toBe(5); // SB=1 … CO=5
  });

  it("单挑：按钮翻前先动、翻后后动", () => {
    const s = mkState(2, 0);
    const btn = actOrderInfo(0, s)!;
    expect(btn.preflopFirst).toBe(0);
    expect(btn.postflopFirst).toBe(1);
    expect(btn.preflopRank).toBe(1);
    expect(btn.postflopRank).toBe(2);
    const bb = actOrderInfo(1, s)!;
    expect(bb.preflopRank).toBe(2);
    expect(bb.postflopRank).toBe(1);
  });

  it("3 人桌：UTG 即按钮（翻前 BTN 先动，此前误算为 BB 先动）", () => {
    const s = mkState(3, 0);
    const btn = actOrderInfo(0, s)!;
    expect(btn.preflopFirst).toBe(0); // 大盲左邻环绕回按钮
    expect(btn.postflopFirst).toBe(1);
    expect(btn.preflopRank).toBe(1);
    expect(actOrderInfo(1, s)!.preflopRank).toBe(2); // SB
    expect(actOrderInfo(2, s)!.preflopRank).toBe(3); // BB
  });

  it("已淘汰座位返回 null", () => {
    expect(actOrderInfo(1, mkState(4, 0, [1]))).toBeNull();
  });
});

describe("actOrderInfo 与引擎行动顺序一致（2/3/4/6/9 人桌 × 全按钮位）", () => {
  const TABLE_SIZES = [2, 3, 4, 6, 9] as const;

  it("preflopFirst 显式期望（按钮在座位 0）", () => {
    // 引擎规则：单挑 UTG=按钮；3 人桌 UTG=按钮；4 人及以上 UTG=大盲左邻 seats[3]
    expect(actOrderInfo(0, mkState(2, 0))!.preflopFirst).toBe(0);
    expect(actOrderInfo(0, mkState(3, 0))!.preflopFirst).toBe(0);
    expect(actOrderInfo(0, mkState(4, 0))!.preflopFirst).toBe(3);
    expect(actOrderInfo(0, mkState(6, 0))!.preflopFirst).toBe(3);
    expect(actOrderInfo(0, mkState(9, 0))!.preflopFirst).toBe(3);
    // postflopFirst 恒为按钮左邻 seats[1]
    for (const n of TABLE_SIZES) {
      expect(actOrderInfo(0, mkState(n, 0))!.postflopFirst).toBe(1);
    }
    // 按钮轮转：6 人桌按钮 2 → UTG=5、翻后先动=3
    expect(actOrderInfo(0, mkState(6, 2))!.preflopFirst).toBe(5);
    expect(actOrderInfo(0, mkState(6, 2))!.postflopFirst).toBe(3);
    // 3 人桌按钮 1 → UTG=按钮=1
    expect(actOrderInfo(0, mkState(3, 1))!.preflopFirst).toBe(1);
  });

  it("preflopFirst === createGame 后引擎选定的首个行动座位", () => {
    for (const n of TABLE_SIZES) {
      for (let button = 0; button < n; button++) {
        const g = createGame({
          players: n,
          smallBlind: 5,
          bigBlind: 10,
          stack: 1000,
          buttonSeat: button,
        });
        const actor = g.currentSeat!;
        expect(actOrderInfo(actor, g)!.preflopFirst).toBe(actor);
        // 首个行动者的 preflopRank 必为 1
        expect(actOrderInfo(actor, g)!.preflopRank).toBe(1);
      }
    }
  });

  it("postflopFirst === 全员过牌到翻牌圈后引擎选定的首个行动座位", () => {
    for (const n of TABLE_SIZES) {
      for (let button = 0; button < n; button++) {
        let g = createGame({
          players: n,
          smallBlind: 5,
          bigBlind: 10,
          stack: 1000,
          buttonSeat: button,
        });
        // 翻前全员跟注/过牌，推进到翻牌圈
        let guard = 0;
        while (g.street === "preflop" && !g.handOver && guard++ < 50) {
          const legal = legalActions(g);
          const a = legal.find((x) => x.type === "call") ??
            legal.find((x) => x.type === "check")!;
          g = applyAction(g, a);
        }
        expect(g.street).toBe("flop");
        const actor = g.currentSeat!;
        expect(actOrderInfo(actor, g)!.postflopFirst).toBe(actor);
        expect(actOrderInfo(actor, g)!.postflopRank).toBe(1);
      }
    }
  });
});
