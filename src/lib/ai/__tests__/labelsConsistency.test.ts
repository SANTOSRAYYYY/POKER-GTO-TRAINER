/**
 * 位置命名一致性锁定测试（Phase C 集成验收）。
 *
 * 唯一权威映射是 ai/positions 的 POSITION_SHORT_NAMES / seatPositionName；
 * components/history/labels 是薄封装（回放/复盘只有 HandRecord，按人数+按钮位查表）。
 * 本测试锁定两套 API 对每个座位给出完全一致的短名，并锁定 9 人桌全序列。
 */
import { describe, expect, it } from "vitest";
import type { ConcreteAIStyle, GameState, Seat } from "@/lib/types";
import {
  POSITION_SHORT_NAMES,
  positionName,
  seatPositionName,
} from "@/lib/ai/positions";
import {
  POSITION_LABEL,
  seatPosition,
  seatPositionCn,
  STYLE_NAME,
  STYLE_NAME_EN,
  styleName,
} from "@/components/history/labels";
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

describe("双语标注（Bug 3 修复：EN 模式不再残留中文）", () => {
  /** POSITION_SHORT_NAMES（2-9 人桌）出现过的全部短名 */
  const ALL_SHORTS = [
    ...new Set(Object.values(POSITION_SHORT_NAMES).flat()),
  ];

  it("位置标注：每个短名双语非空，且与 POSITION_SHORT_NAMES 键集合一致", () => {
    expect(Object.keys(POSITION_LABEL).sort()).toEqual(ALL_SHORTS.sort());
    for (const short of ALL_SHORTS) {
      const label = POSITION_LABEL[short];
      expect(label, short).toBeDefined();
      expect(label.zh.length, `${short}.zh`).toBeGreaterThan(0);
      expect(label.en.length, `${short}.en`).toBeGreaterThan(0);
    }
  });

  it("seatPositionCn 按 lang 选择：默认 zh 不变，en 返回英文标注", () => {
    expect(seatPositionCn(0, 0, 9)).toBe("按钮位");
    expect(seatPositionCn(0, 0, 9, "zh")).toBe("按钮位");
    expect(seatPositionCn(0, 0, 9, "en")).toBe("Button");
    expect(seatPositionCn(1, 0, 9, "en")).toBe("Small blind");
    expect(seatPositionCn(0, 0, 2, "en")).toBe("Button / Small blind");
    // 无标注的短名原样返回；非法人数仍为空串
    expect(seatPositionCn(0, 0, 10, "en")).toBe("");
  });

  it("风格名：每个 ConcreteAIStyle 双语非空，styleName 按 lang 选择", () => {
    const styles: ConcreteAIStyle[] = [
      "nit",
      "tag",
      "lag",
      "maniac",
      "calling_station",
      "gto",
    ];
    for (const s of styles) {
      expect(STYLE_NAME[s].length, `${s}.zh`).toBeGreaterThan(0);
      expect(STYLE_NAME_EN[s].length, `${s}.en`).toBeGreaterThan(0);
      expect(styleName(s)).toBe(STYLE_NAME[s]); // 默认 zh（LLM prompt 口径不变）
      expect(styleName(s, "zh")).toBe(STYLE_NAME[s]);
      expect(styleName(s, "en")).toBe(STYLE_NAME_EN[s]);
    }
    expect(styleName("tag", "en")).toBe("TAG");
    expect(styleName("maniac", "en")).toBe("Maniac");
  });
});
