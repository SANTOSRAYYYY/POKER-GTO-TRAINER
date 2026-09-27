/**
 * src/components/history/replay.ts — 手牌回放的纯逻辑（从 [id]/page.tsx 抽出，
 * 供 vitest 直接单测；page.tsx 只保留渲染）。
 *
 * 内容：
 * - buildSteps：把 HandRecord 的逐街动作展开成线性步骤序列；摊牌手在末尾
 *   追加一个终局步骤（streetIdx = hand.streets.length 哨兵），回放页据此
 *   渲染「摊牌」tab——亮出未弃牌者底牌、展示完整公共牌。
 * - foldedSeatsAt：截至某步骤已弃牌的座位集合。
 * - actionText / actorLabel：动作与行动者的文案。
 * - replayText：回放页少量文案直查全站字典（replay.* 前缀，登记于
 *   src/lib/i18n/dict-pages.ts）。
 */
import type { Lang } from "@/lib/i18n";
import { DICT, type DictKey } from "@/lib/i18n/dict";
import type { HandRecord, Seat, SeatAction } from "@/lib/types";
import { seatPositionName } from "@/lib/ai/positions";
import { STYLE_NAME } from "@/components/history/labels";

export type TFunc = (key: DictKey, vars?: Record<string, string | number>) => string;

/** 行动者称呼：hero 显示“你”，AI 显示座位号与风格 */
export function actorLabel(hand: HandRecord, seat: Seat, t: TFunc): string {
  const p = hand.players.find((pl) => pl.seat === seat);
  if (!p) return t("history.seat", { n: seat });
  if (p.isHero) return t("common.you");
  return p.aiStyle
    ? t("history.aiActor", { style: STYLE_NAME[p.aiStyle] })
    : t("history.seat", { n: seat });
}

export function actionText(sa: SeatAction, hand: HandRecord, t: TFunc): string {
  const who = t("history.actorWithSeat", {
    who: actorLabel(hand, sa.seat, t),
    seat: sa.seat,
  });
  const { type, amount } = sa.action;
  switch (type) {
    case "fold":
      return t("history.act.fold", { who });
    case "check":
      return t("history.act.check", { who });
    case "call":
      return t("history.act.call", { who, amount: amount ?? 0 });
    case "bet":
      return t("history.act.bet", { who, amount: amount ?? 0 });
    case "raise":
      return t("history.act.raise", { who, amount: amount ?? 0 });
    case "allin":
      return t("history.act.allin", { who, amount: amount ?? 0 });
  }
}

export interface Step {
  /** hand.streets 下标；hand.streets.length 为「摊牌」终局步骤的哨兵值 */
  streetIdx: number;
  /** -1 表示刚到该街、尚未应用任何动作 */
  actionIdx: number;
  pot: number;
  /** 该步行动者座位（无动作的步骤为 null） */
  actor: Seat | null;
  text: string | null;
}

/** 摊牌终局步骤的 streetIdx 哨兵（= hand.streets.length） */
export function isShowdownStep(hand: HandRecord, step: Step): boolean {
  return step.streetIdx >= hand.streets.length;
}

/**
 * 把 HandRecord 的逐街动作展开成线性步骤序列。
 * 底池初始 = 小盲 + 大盲 + 全员 ante（引擎 streetActions 不含盲注/ante
 * 投放动作——createGame 时直接计入 pot，见 game.ts——故恒按此公式计算）。
 * bet-to 语义：每人维护本街已投入额，bet/raise/allin 按增量计入底池；
 * 翻前按位置预置盲注投入（与 heroDecisionInput 口径一致），否则盲位的
 * raise/all-in 会把盲注额在底池里重复计一次。
 * 每条街（含空动作的跑马街）至少产生一个「进入该街」步骤，保证街道 tab 可点。
 * 摊牌手在末尾追加终局步骤（streetIdx 哨兵），作为「摊牌」tab 的落点。
 */
export function buildSteps(hand: HandRecord, t: TFunc): Step[] {
  const initialPot =
    hand.smallBlind + hand.bigBlind + hand.ante * hand.players.length;

  const steps: Step[] = [];
  let pot = initialPot;
  hand.streets.forEach((st, si) => {
    const invested: number[] = [];
    if (st.street === "preflop") {
      for (const p of hand.players) {
        const pos = seatPositionName(p.seat, hand.buttonSeat, hand.players.length);
        if (pos === "SB" || pos === "BTN/SB") invested[p.seat] = hand.smallBlind;
        else if (pos === "BB") invested[p.seat] = hand.bigBlind;
      }
    }
    steps.push({ streetIdx: si, actionIdx: -1, pot, actor: null, text: null });
    st.actions.forEach((sa, ai) => {
      let inc = 0;
      const { type, amount } = sa.action;
      if (type === "call") inc = amount;
      else if (type === "bet" || type === "raise" || type === "allin") {
        inc = Math.max(0, amount - (invested[sa.seat] ?? 0));
      }
      invested[sa.seat] = (invested[sa.seat] ?? 0) + inc;
      pot += inc;
      steps.push({
        streetIdx: si,
        actionIdx: ai,
        pot,
        actor: sa.seat,
        text: actionText(sa, hand, t),
      });
    });
  });
  if (hand.showdown) {
    steps.push({
      streetIdx: hand.streets.length,
      actionIdx: -1,
      pot,
      actor: null,
      text: null,
    });
  }
  return steps;
}

/** 截至当前步骤已弃牌的座位集合（用于座位卡片状态与摊牌亮牌名单） */
export function foldedSeatsAt(hand: HandRecord, steps: Step[], cur: number): Set<Seat> {
  const folded = new Set<Seat>();
  for (let i = 0; i <= cur && i < steps.length; i++) {
    const s = steps[i];
    if (s.actionIdx < 0) continue;
    const sa = hand.streets[s.streetIdx]?.actions[s.actionIdx];
    if (sa && sa.action.type === "fold") folded.add(sa.seat);
  }
  return folded;
}

// ---------------------------------------------------------------------------
// 回放页文案（登记于 src/lib/i18n/dict-pages.ts 的 replay.* 前缀，此处按 lang 直查）
// ---------------------------------------------------------------------------

export type ReplayExtraKey = Extract<DictKey, `replay.${string}`>;

export function replayText(key: ReplayExtraKey, lang: Lang): string {
  return DICT[key][lang];
}
