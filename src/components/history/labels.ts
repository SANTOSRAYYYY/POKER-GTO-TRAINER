import type { ConcreteAIStyle, HandRecord, Seat } from "@/lib/types";
import { seatPositionName } from "@/lib/ai/positions";

/** AI 风格显示名（历史/回放等页面共用） */
export const STYLE_NAME: Record<ConcreteAIStyle, string> = {
  nit: "紧弱 Nit",
  tag: "紧凶 TAG",
  lag: "松凶 LAG",
  maniac: "疯子",
  calling_station: "跟注站",
  gto: "GTO",
};

/**
 * 位置短名的中文标注（键与 ai/positions 的 POSITION_SHORT_NAMES 一致）。
 */
const POSITION_CN: Record<string, string> = {
  "BTN": "按钮位",
  "BTN/SB": "按钮位/小盲",
  "SB": "小盲",
  "BB": "大盲",
  "CO/UTG": "关煞位/枪口位",
  "UTG": "枪口位",
  "UTG+1": "枪口+1",
  "UTG+2": "枪口+2",
  "LJ": "LJ（洛杰克）",
  "HJ": "HJ（劫持位）",
  "CO": "CO（关煞位）",
};

/**
 * 座位位置短名（如 "BTN" / "SB" / "UTG+1"）。
 * 薄封装：唯一权威映射在 @/lib/ai/positions（POSITION_SHORT_NAMES），
 * HandRecord 只含本手在局玩家，按「人数 + 按钮位」查表即可。
 */
export function seatPosition(seat: Seat, buttonSeat: Seat, playerCount: number): string {
  return seatPositionName(seat, buttonSeat, playerCount);
}

/** 位置中文标注（无对应则原样返回短名） */
export function seatPositionCn(seat: Seat, buttonSeat: Seat, playerCount: number): string {
  const short = seatPosition(seat, buttonSeat, playerCount);
  if (!short) return "";
  return POSITION_CN[short] ?? short;
}

/** 是否锦标赛手牌（任一玩家带最终名次即视为锦标赛） */
export function isTournamentHand(hand: HandRecord): boolean {
  return hand.players.some((p) => p.finishPlace != null);
}

/** 本手出现过的 AI 风格（去重，按座位升序） */
export function handStyles(hand: HandRecord): ConcreteAIStyle[] {
  const seen = new Set<ConcreteAIStyle>();
  for (const p of hand.players) {
    if (p.aiStyle) seen.add(p.aiStyle);
  }
  return [...seen];
}
