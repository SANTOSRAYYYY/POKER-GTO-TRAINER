/**
 * 补齐全下跑马被跳过的空动作街记录（纯函数，供 gameStore/historyStore 共用——
 * 放独立模块避免 gameStore ↔ historyStore 循环引用）。
 *
 * 背景：全员全下时引擎一次性发完剩余公共牌并直达摊牌
 * （applyAction → settleShowdown，street 从当前街直接跳到 "showdown"），
 * 归档每次动作只记一条街，被跳过的街（不可能有动作）不会进入日志——
 * 导致 HandRecord.streets 缺后续街，回放与教练复盘都看不到跑马发了什么牌。
 *
 * 本函数按 finalBoard 补录这些街：board 为该街发完后的快照
 * （flop 3 张 / turn 4 张 / river 5 张），actions 为空（空动作街）。
 * 折返/弃牌收场（finalBoard 不足下一条街张数）时不补录。幂等：已齐全的记录不变。
 */
import type { Card, Street, StreetRecord } from "@/lib/types";

const STREET_SEQUENCE: Street[] = ["preflop", "flop", "turn", "river"];

const STREET_DEALT_COUNT: Record<Street, number> = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
  showdown: 5,
};

export function withRunoutStreets(
  streets: StreetRecord[],
  finalBoard: Card[],
): StreetRecord[] {
  const out = [...streets];
  let nextIdx = 0;
  if (out.length > 0) {
    const lastIdx = STREET_SEQUENCE.indexOf(out[out.length - 1].street);
    if (lastIdx < 0) return out; // 防御：末尾是未知街（如 showdown）时不补
    nextIdx = lastIdx + 1;
  }
  for (let i = nextIdx; i < STREET_SEQUENCE.length; i++) {
    const street = STREET_SEQUENCE[i];
    const count = STREET_DEALT_COUNT[street];
    if (finalBoard.length < count) break; // 该街的牌没发出 → 之后的街也没发
    out.push({ street, board: finalBoard.slice(0, count), actions: [] });
  }
  return out;
}
