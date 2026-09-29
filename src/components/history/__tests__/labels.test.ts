/**
 * labels.ts 测试：isTournamentHand 的 mode 优先 / 旧记录回退口径。
 *
 * 背景（审计 A1）：finishPlace 只在出局/夺冠那一手才填写，旧启发式把
 * 锦标赛前期手误判为现金局；修复后 HandRecord.mode 优先，
 * 缺 mode 的旧记录回退到 finishPlace 启发式。
 */
import { describe, expect, it } from "vitest";
import type { HandRecord, HandPlayerRecord } from "@/lib/types";
import { isTournamentHand } from "../labels";

function mkPlayers(finishPlace?: number): HandPlayerRecord[] {
  return [
    {
      seat: 0,
      isHero: true,
      aiStyle: null,
      cards: ["As", "Kh"],
      profit: 0,
      ...(finishPlace !== undefined ? { finishPlace } : {}),
    },
    { seat: 1, isHero: false, aiStyle: "tag", cards: null, profit: 0 },
  ];
}

function mkHand(overrides: Partial<HandRecord> = {}): HandRecord {
  return {
    id: "h1",
    timestamp: 0,
    players: mkPlayers(),
    heroSeat: 0,
    buttonSeat: 0,
    smallBlind: 50,
    bigBlind: 100,
    ante: 0,
    streets: [],
    finalBoard: [],
    result: "win",
    profit: 0,
    showdown: true,
    ...overrides,
  };
}

describe("isTournamentHand", () => {
  it("mode='tournament' 时即使无人带 finishPlace（前期手）也判锦标赛", () => {
    expect(isTournamentHand(mkHand({ mode: "tournament" }))).toBe(true);
  });

  it("mode='cash' 优先于 finishPlace 启发式（即便记录带了名次）", () => {
    // 异常组合（理论上不该存在）：mode 是归档事实，以 mode 为准
    expect(
      isTournamentHand(mkHand({ mode: "cash", players: mkPlayers(3) })),
    ).toBe(false);
  });

  it("mode='tournament' 优先于「无 finishPlace」的表象", () => {
    expect(
      isTournamentHand(mkHand({ mode: "tournament", players: mkPlayers() })),
    ).toBe(true);
  });

  it("缺 mode 的旧记录回退启发式：有 finishPlace 判锦标赛，否则判现金局", () => {
    expect(isTournamentHand(mkHand({ players: mkPlayers(2) }))).toBe(true);
    expect(isTournamentHand(mkHand())).toBe(false);
  });
});
