/**
 * 位置命名一致性锁定测试（Phase C 集成验收）。
 *
 * 唯一权威映射是 ai/positions 的 POSITION_SHORT_NAMES / seatPositionName；
 * components/history/labels 是薄封装（回放/复盘只有 HandRecord，按人数+按钮位查表）。
 * 本测试锁定两套 API 对每个座位给出完全一致的短名，并锁定 9 人桌全序列。
 */
import { describe, expect, it } from "vitest";
import type { GameState, Seat } from "@/lib/types";
import {
  POSITION_SHORT_NAMES,
  positionName,
  seatPositionName,
} from "@/lib/ai/positions";
import { seatPosition, seatPositionCn } from "@/components/history/labels";
import { makePlayer } from "@/lib/ai/__tests__/helpers";

function mkState(playerCount: number, buttonSeat: Seat): GameState {
  return {
    deck: [],
    players: Array.from({ length: playerCount }, (_, seat) =>
      makePlayer({ seat }),
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

describe("位置命名映射（唯一权威表）", () => {
  it("9 人桌全序列：UTG/UTG+1/UTG+2/LJ/HJ/CO/BTN/SB/BB", () => {
    expect(POSITION_SHORT_NAMES[9]).toEqual([
      "BTN",
      "SB",
      "BB",
      "UTG",
      "UTG+1",
      "UTG+2",
      "LJ",
      "HJ",
      "CO",
    ]);
  });

  it("2-9 人每个座位：labels.seatPosition 与 ai seatPositionName 完全一致", () => {
    for (let n = 2; n <= 9; n++) {
      for (let button = 0; button < n; button++) {
        for (let seat = 0; seat < n; seat++) {
          expect(seatPosition(seat, button, n)).toBe(
            seatPositionName(seat, button, n),
          );
        }
      }
    }
  });

  it("短名与 positionName（GameState 版）前缀一致：全员在局时同一座位同名", () => {
    for (let n = 2; n <= 9; n++) {
      for (let button = 0; button < n; button++) {
        const state = mkState(n, button);
        for (let seat = 0; seat < n; seat++) {
          const short = seatPositionName(seat, button, n);
          // positionName = 短名 + 中文标注后缀（如 "UTG+1"、"BTN（按钮位）"）
          expect(positionName(seat, state).startsWith(short)).toBe(true);
        }
      }
    }
  });

  it("4 人桌第 4 位为 CO/UTG、7 人桌无 LJ（第 5 位 UTG+1）", () => {
    expect(seatPosition(3, 0, 4)).toBe("CO/UTG");
    expect(seatPosition(3, 0, 7)).toBe("UTG");
    expect(seatPosition(4, 0, 7)).toBe("UTG+1");
    expect(seatPosition(5, 0, 7)).toBe("HJ");
  });

  it("中文标注覆盖所有短名；非法人数返回空串", () => {
    expect(seatPosition(0, 0, 0)).toBe("");
    expect(seatPositionCn(0, 0, 10)).toBe("");
    expect(seatPositionCn(0, 0, 9)).toBe("按钮位");
    expect(seatPositionCn(3, 0, 9)).toBe("枪口位");
    expect(seatPositionCn(4, 0, 9)).toBe("枪口+1");
    expect(seatPositionCn(5, 0, 9)).toBe("枪口+2");
    expect(seatPositionCn(6, 0, 9)).toBe("LJ（洛杰克）");
    expect(seatPositionCn(7, 0, 9)).toBe("HJ（劫持位）");
    expect(seatPositionCn(8, 0, 9)).toBe("CO（关煞位）");
    expect(seatPositionCn(1, 0, 9)).toBe("小盲");
    expect(seatPositionCn(2, 0, 9)).toBe("大盲");
    expect(seatPositionCn(3, 0, 4)).toBe("关煞位/枪口位");
  });
});
