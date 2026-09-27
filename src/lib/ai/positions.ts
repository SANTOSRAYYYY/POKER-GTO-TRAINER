/**
 * 位置名称模块：根据按钮位与在局人数推导每个座位的标准位置名。
 *
 * 规则：从按钮位开始沿行动方向（引擎的 nextActiveSeat，即按钮左邻依次是
 * 小盲、大盲、UTG……）为每个未淘汰座位命名；已淘汰座位不参与计数。
 * 名称表（offset 0 起为按钮）：
 * - 2 人：BTN/SB、BB（单挑按钮=小盲，翻前按钮先行动）
 * - 3 人：BTN、SB、BB
 * - 4 人：BTN、SB、BB、CO（4 人桌 CO 即 UTG，翻前最先行动）
 * - 5 人：BTN、SB、BB、UTG、CO
 * - 6 人：+ UTG、HJ、CO
 * - 7 人：UTG、UTG+1、HJ、CO
 * - 8 人：UTG、UTG+1、LJ、HJ、CO
 * - 9 人：UTG、UTG+1、UTG+2、LJ、HJ、CO
 */
import type { GameState, Seat } from "@/lib/types";
import { nextActiveSeat } from "@/lib/poker/game";

/**
 * 从按钮位（含）开始，按行动顺序列出所有未淘汰座位。
 * 按钮位已淘汰时从其后第一个在局座位开始。全灭返回空数组。
 */
export function activeSeatsFromButton(state: GameState): Seat[] {
  const total = state.players.length;
  if (total === 0) return [];
  const button = state.players[state.buttonSeat];
  const first =
    button && !button.eliminated
      ? state.buttonSeat
      : nextActiveSeat(state.players, state.buttonSeat);
  if (first === null) return [];
  const seats: Seat[] = [first];
  let cur = first;
  while (seats.length < total) {
    const nxt = nextActiveSeat(state.players, cur);
    if (nxt === null || nxt === cur || seats.includes(nxt)) break;
    seats.push(nxt);
    cur = nxt;
  }
  return seats;
}

/**
 * 各人数下的位置短名表（索引 = 距按钮的行动顺序 offset）。
 * 全项目唯一权威映射；回放/复盘等只有「人数 + 按钮位」的场景用
 * seatPositionName 按距离查本表，无需构造 GameState。
 */
export const POSITION_SHORT_NAMES: Record<number, readonly string[]> = {
  2: ["BTN/SB", "BB"],
  3: ["BTN", "SB", "BB"],
  4: ["BTN", "SB", "BB", "CO/UTG"],
  5: ["BTN", "SB", "BB", "UTG", "CO"],
  6: ["BTN", "SB", "BB", "UTG", "HJ", "CO"],
  7: ["BTN", "SB", "BB", "UTG", "UTG+1", "HJ", "CO"],
  8: ["BTN", "SB", "BB", "UTG", "UTG+1", "LJ", "HJ", "CO"],
  9: ["BTN", "SB", "BB", "UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO"],
};

/**
 * 座位位置短名（如 "BTN" / "SB" / "UTG+1"）。
 * 距离 0 = 按钮位，之后沿行动顺序依次为 SB、BB、UTG……（单挑：按钮=小盲）。
 * 人数超出 2-9 或参数非法时返回 ""。
 */
export function seatPositionName(
  seat: Seat,
  buttonSeat: Seat,
  playerCount: number,
): string {
  const names = POSITION_SHORT_NAMES[playerCount];
  if (!names || names.length !== playerCount) return "";
  const dist = (((seat - buttonSeat) % playerCount) + playerCount) % playerCount;
  return names[dist] ?? "";
}

/** 位置短名 → 中文标注后缀（拼接成 positionName 的完整显示名） */
const POSITION_CN_SUFFIX: Record<string, string> = {
  "BTN/SB": "（按钮位=小盲）",
  "BTN": "（按钮位）",
  "SB": "（小盲）",
  "BB": "（大盲）",
  "CO/UTG": "（关煞位，4 人桌即枪口位，翻前最先行动）",
  "UTG": "（枪口位，翻前最先行动）",
  "UTG+1": "",
  "UTG+2": "",
  "LJ": "（洛杰克）",
  "HJ": "（劫持位）",
  "CO": "（关煞位）",
};

/** 各人数下的位置名表（索引 = 距按钮的行动顺序 offset），由短名表派生 */
const POSITION_NAMES: Record<number, readonly string[]> = Object.fromEntries(
  Object.entries(POSITION_SHORT_NAMES).map(([n, shorts]) => [
    n,
    shorts.map((s) => s + (POSITION_CN_SUFFIX[s] ?? "")),
  ]),
);

/**
 * 座位的位置名。已淘汰座位返回 "已淘汰"；人数超出 2-9 范围时退化为座位号。
 */
export function positionName(seat: Seat, state: GameState): string {
  const seats = activeSeatsFromButton(state);
  const idx = seats.indexOf(seat);
  if (idx === -1) return "已淘汰";
  const names = POSITION_NAMES[seats.length];
  return names ? names[idx] : `座位 ${seat}`;
}

/** 座位的位置短名（无中文标注，供英文 LLM prompt 等场景）；规则与 positionName 一致 */
export function positionShortName(seat: Seat, state: GameState): string {
  const seats = activeSeatsFromButton(state);
  const idx = seats.indexOf(seat);
  if (idx === -1) return "eliminated";
  const names = POSITION_SHORT_NAMES[seats.length];
  return names ? names[idx] : `Seat ${seat}`;
}

/** 行动顺序信息（供 prompt 向 AI 说明先后手） */
export interface ActOrderInfo {
  /** 翻前第一个行动的座位（UTG；单挑为按钮位） */
  preflopFirst: Seat;
  /** 翻后第一个行动的座位（按钮左邻第一个在局玩家） */
  postflopFirst: Seat;
  /** 本座位翻前行动顺位（1-based，从翻前首个行动者数起） */
  preflopRank: number;
  /** 本座位翻后行动顺位（1-based） */
  postflopRank: number;
  /** 在局人数（未淘汰） */
  activeCount: number;
}

/**
 * 计算某座位的行动顺序信息；座位已淘汰或桌上无人时返回 null。
 * 与引擎规则一致（game.ts createGame 的 UTG 定位）：翻前从 UTG（大盲左邻
 * 第一个在局座位）开始；单挑特例按钮先动；3 人桌大盲左邻环绕回按钮，
 * UTG 即按钮（此前 min(3, n-1) 的写法在 3 人桌错算成 BB 先动）。
 * 翻后从按钮左邻开始。
 */
export function actOrderInfo(seat: Seat, state: GameState): ActOrderInfo | null {
  const seats = activeSeatsFromButton(state);
  const n = seats.length;
  const idx = seats.indexOf(seat);
  if (n === 0 || idx === -1) return null;
  // seats 顺序 = [BTN, SB, BB, UTG, ...]；3 人桌 UTG 环绕回 seats[0]（BTN），
  // 单挑 seats[0] 即按钮（=小盲，翻前先动）
  const preflopStart = n <= 3 ? 0 : 3;
  const postflopStart = n >= 2 ? 1 : 0;
  return {
    preflopFirst: seats[preflopStart],
    postflopFirst: seats[postflopStart],
    preflopRank: ((idx - preflopStart + n) % n) + 1,
    postflopRank: ((idx - postflopStart + n) % n) + 1,
    activeCount: n,
  };
}
