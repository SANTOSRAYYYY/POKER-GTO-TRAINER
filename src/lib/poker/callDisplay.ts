/**
 * ActionBar 跟注按钮的派生模型（纯函数，便于单测）。
 *
 * amount 直接取自引擎 legalActions 的 call 动作：短码时引擎已把它截断为
 * 全部剩余筹码（all-in 跟注），UI 不得再用 currentBet - streetBet 自行计算
 * （全额会超出 stack，applyAction 会拒绝该动作）。
 */
import type { GameState, Seat } from "@/lib/types";
import { legalActions } from "@/lib/poker/game";

export interface CallDisplayInfo {
  /** 跟注需投入的筹码增量；短码时等于全部剩余 stack */
  amount: number;
  /** true = 这次跟注会花光全部筹码（全下跟注） */
  isAllIn: boolean;
}

/** 当前座位存在合法 call 时返回展示模型，否则返回 null。 */
export function callDisplayInfo(
  state: GameState,
  seat: Seat,
): CallDisplayInfo | null {
  if (state.handOver || state.currentSeat !== seat) return null;
  const me = state.players[seat];
  if (!me || me.folded || me.allIn) return null;
  const call = legalActions(state).find((a) => a.type === "call");
  if (!call) return null;
  return { amount: call.amount, isAllIn: call.amount >= me.stack };
}
