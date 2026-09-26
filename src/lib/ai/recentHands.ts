/**
 * src/lib/ai/recentHands.ts — 一手牌的一句话回顾（纯模块，node/浏览器通用）
 *
 * 从 gameStore.ts 抽出：自对战台架（scripts/selfplay）在 node 里跑，
 * 不能 import store 链路（historyStore → idb）。gameStore 改为 re-export
 * 本模块，浏览器行为不变。
 */
import type { HandRecord } from "@/lib/types";
import { seatPositionName } from "./positions";

/**
 * 一手牌的一句话回顾（供 LLM 决策的近期上下文）。
 * 例：「你 A♥K♦（BTN）：翻前加注到30、翻牌圈跟注、河牌弃牌｜结果 -130，
 *     赢家 座位3（TAG）亮出 Q♠Q♥」
 */
export function summarizeHand(record: HandRecord, styleName: (s: string) => string): string {
  const hero = record.players.find((p) => p.isHero);
  const heroCards = hero?.cards?.join("") ?? "??";
  const pos = seatPositionName(record.heroSeat, record.buttonSeat, record.players.length);
  const streetVerbs: Record<string, string> = {
    preflop: "翻前",
    flop: "翻牌圈",
    turn: "转牌圈",
    river: "河牌圈",
  };
  const acts = record.streets
    .map((sr) => {
      const mine = sr.actions.filter((a) => a.seat === record.heroSeat);
      if (mine.length === 0) return null;
      const last = mine[mine.length - 1].action;
      const verb: Record<string, string> = {
        fold: "弃牌",
        check: "过牌",
        call: "跟注",
        bet: "下注",
        raise: "加注",
        allin: "全下",
      };
      return `${streetVerbs[sr.street] ?? sr.street}${verb[last.type] ?? last.type}`;
    })
    .filter(Boolean)
    .join("、");
  const profitStr = `${record.profit > 0 ? "+" : ""}${record.profit}`;
  // 赢家 = 盈利最高的座位（平局时可能多个，取第一个）
  const winner = record.players.reduce((a, b) => (b.profit > a.profit ? b : a));
  const winnerLabel = winner.isHero
    ? "你"
    : `座位${winner.seat}${winner.aiStyle ? `（${styleName(winner.aiStyle)}）` : ""}`;
  const showdownBit =
    record.showdown && winner.cards ? ` 亮出 ${winner.cards.join(" ")}` : "";
  return `你 ${heroCards}（${pos}）：${acts || "未行动"}｜结果 ${profitStr}，赢家 ${winnerLabel}${showdownBit}`;
}
