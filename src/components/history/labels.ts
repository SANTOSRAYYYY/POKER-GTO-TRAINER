import type { ConcreteAIStyle, HandRecord, Seat } from "@/lib/types";
import type { Lang } from "@/lib/i18n/lang";
import { seatPositionName } from "@/lib/ai/positions";

/** AI 风格显示名（中文；历史/回放等页面与 LLM prompt 共用） */
export const STYLE_NAME: Record<ConcreteAIStyle, string> = {
  nit: "紧弱 Nit",
  tag: "紧凶 TAG",
  lag: "松凶 LAG",
  maniac: "疯子",
  calling_station: "跟注站",
  gto: "GTO",
};

/** AI 风格显示名（英文；键集合与 STYLE_NAME 一致） */
export const STYLE_NAME_EN: Record<ConcreteAIStyle, string> = {
  nit: "Nit",
  tag: "TAG",
  lag: "LAG",
  maniac: "Maniac",
  calling_station: "Calling station",
  gto: "GTO",
};

/** 风格显示名按语言选择；默认中文（LLM prompt 等无 UI 语言上下文处沿用） */
export function styleName(style: ConcreteAIStyle, lang: Lang = "zh"): string {
  return (lang === "en" ? STYLE_NAME_EN : STYLE_NAME)[style] ?? style;
}

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

/** 位置短名的英文标注（键集合与 POSITION_CN 一致） */
const POSITION_EN: Record<string, string> = {
  "BTN": "Button",
  "BTN/SB": "Button / Small blind",
  "SB": "Small blind",
  "BB": "Big blind",
  "CO/UTG": "Cutoff / UTG",
  "UTG": "Under the gun",
  "UTG+1": "UTG+1",
  "UTG+2": "UTG+2",
  "LJ": "Lojack",
  "HJ": "Hijack",
  "CO": "Cutoff",
};

/** 位置短名的双语标注（导出供齐全性测试；渲染请用 seatPositionCn） */
export const POSITION_LABEL: Record<string, { zh: string; en: string }> =
  Object.fromEntries(
    Object.keys(POSITION_CN).map(
      (k): [string, { zh: string; en: string }] => [
        k,
        { zh: POSITION_CN[k], en: POSITION_EN[k] },
      ],
    ),
  );

/**
 * 座位位置短名（如 "BTN" / "SB" / "UTG+1"）。
 * 薄封装：唯一权威映射在 @/lib/ai/positions（POSITION_SHORT_NAMES），
 * HandRecord 只含本手在局玩家，按「人数 + 按钮位」查表即可。
 */
export function seatPosition(seat: Seat, buttonSeat: Seat, playerCount: number): string {
  return seatPositionName(seat, buttonSeat, playerCount);
}

/** 位置标注（按语言选择；无对应则原样返回短名；默认中文，兼容 LLM prompt 调用） */
export function seatPositionCn(
  seat: Seat,
  buttonSeat: Seat,
  playerCount: number,
  lang: Lang = "zh",
): string {
  const short = seatPosition(seat, buttonSeat, playerCount);
  if (!short) return "";
  const map = lang === "en" ? POSITION_EN : POSITION_CN;
  return map[short] ?? short;
}

/**
 * 是否锦标赛手牌。
 * 新记录优先看 mode 字段（归档时写入，锦标赛前期手也能正确归类）；
 * 缺 mode 的旧记录回退到启发式：任一玩家带最终名次即视为锦标赛
 * （finishPlace 只在出局/夺冠那一手才填写，旧数据里的锦标赛前期手无法识别）。
 */
export function isTournamentHand(hand: HandRecord): boolean {
  if (hand.mode !== undefined) return hand.mode === "tournament";
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
