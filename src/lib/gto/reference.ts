/**
 * src/lib/gto/reference.ts — 决策点级 GTO 参考线（纯函数模块）
 *
 * 用途：手牌回放时，在 hero 的每个决策点旁给出引擎参考——实算胜率
 * （equityMulti 蒙特卡洛，对 N 名未弃牌对手的随机底牌）+ 建议动作倾向。
 *
 * ⚠️ 这是「简化启发式」，不是 solver 精确解：只用胜率与底池赔率做阈值判定，
 * 不建模范围、位置、筹码深度与 ICM。UI 提示语统一为「启发式参考线，非 solver 精确解」。
 *
 * 判定规则（equity = win + tie/2 的有效胜率，0-1）：
 * - 面对下注（callAmount > 0）：
 *   1. equity ≥ 0.65                    → raise / strong（强牌加注）
 *   2. 跟注所需胜率 > equity + 0.03      → fold  / strong（赔率不够，弃牌）
 *      （所需胜率 = callAmount / (potBefore + callAmount)，即保本胜率）
 *   3. 0.45 ≤ equity < 0.65             → call  / marginal（call/raise 边际带）
 *   4. |所需胜率 − equity| ≤ 0.03        → call  / marginal（赔率刚好的边缘跟注）
 *   5. 其余（equity 明显覆盖所需胜率）    → call  / strong
 *   规则 2 优先于规则 3：即使 equity 落在 0.45+ 边际带，赔率不够仍然弃牌。
 * - 无人下注（callAmount = 0）：
 *   1. equity ≥ 0.65  → raise / strong（价值主动下注）
 *   2. equity ≥ 0.55  → raise / marginal（可主动下注）
 *   3. equity ≥ 0.45  → check / marginal（中等牌力过牌控池）
 *   4. 其余            → check / strong（牌力不足，过牌）
 *
 * 翻前口径与翻后一致：board 为空时同样用 equityMulti 对 N 名随机对手跑
 * 蒙特卡洛（不发 169 牌型百分位静态表，避免两套胜率口径）。
 */
import type { Card, HandRecord, Seat } from "@/lib/types";
import { equityMulti } from "@/lib/poker/equity";
import { seatPositionName } from "@/lib/ai/positions";

// ---------------------------------------------------------------------------
// 类型与常量
// ---------------------------------------------------------------------------

/** 建议动作倾向（无人下注时的主动下注归入 raise，UI 按 callAmount 区分文案） */
export type GtoTendency = "raise" | "call" | "fold" | "check";
/** 置信度：strong = 明确建议；marginal = 边际决策 */
export type GtoConfidence = "strong" | "marginal";

/** 一个 hero 决策点的输入快照 */
export interface ReferenceInput {
  /** hero 底牌（2 张） */
  heroCards: Card[];
  /** 决策点公共牌快照（翻前为 []） */
  board: Card[];
  /** hero 行动前的底池（含盲注/ante 与本手此前所有投入） */
  potBefore: number;
  /** hero 需要跟注的额度（0 = 无人下注/无需跟注） */
  callAmount: number;
  /** 未弃牌对手数（≥1；全下未弃牌的对手仍计入——底牌仍然活着） */
  activeOpponents: number;
  /** 位置短名（如 "BTN"/"BB"）；展示用，不参与启发式判定 */
  position?: string;
}

/** 参考线结果 */
export interface ReferenceLine {
  /** 有效胜率 win + tie/2（0-1） */
  equity: number;
  tendency: GtoTendency;
  confidence: GtoConfidence;
  /** 人类可读理由（含胜率/所需胜率数值） */
  note: string;
}

/** 强牌加注线 */
export const RAISE_EQUITY = 0.65;
/** 边际带下沿 / 跟注最低胜率 */
export const CALL_EQUITY_MIN = 0.45;
/** 无人下注时的主动下注线 */
export const BET_EQUITY = 0.55;
/** 赔率比较的边际容差（±0.03 内视为边缘） */
export const MARGIN = 0.03;
/** 默认蒙特卡洛迭代次数（实测几十 ms，UI 点击时惰性计算） */
export const REFERENCE_ITERATIONS = 2000;

// ---------------------------------------------------------------------------
// 纯规则
// ---------------------------------------------------------------------------

/** 跟注所需胜率（保本胜率）：callAmount / (potBefore + callAmount) */
export function requiredEquity(potBefore: number, callAmount: number): number {
  if (callAmount <= 0) return 0;
  return callAmount / (potBefore + callAmount);
}

/**
 * 由有效胜率与底池赔率推导建议倾向（不含胜率计算的纯判定，便于确定性测试）。
 * 规则见文件头注释。
 */
export function decideTendency(input: {
  equity: number;
  potBefore: number;
  callAmount: number;
}): Omit<ReferenceLine, "equity"> {
  const { equity, potBefore, callAmount } = input;
  const pct = `${Math.round(equity * 100)}%`;

  if (callAmount > 0) {
    const req = requiredEquity(potBefore, callAmount);
    const reqPct = `${Math.round(req * 100)}%`;
    if (equity >= RAISE_EQUITY) {
      return {
        tendency: "raise",
        confidence: "strong",
        note: `胜率 ${pct} ≥ ${RAISE_EQUITY * 100}%，强牌建议加注`,
      };
    }
    if (req > equity + MARGIN) {
      return {
        tendency: "fold",
        confidence: "strong",
        note: `跟注需胜率 ${reqPct}，实算仅 ${pct}，赔率不够建议弃牌`,
      };
    }
    if (equity >= CALL_EQUITY_MIN) {
      return {
        tendency: "call",
        confidence: "marginal",
        note: `胜率 ${pct} 处于 ${CALL_EQUITY_MIN * 100}–${RAISE_EQUITY * 100}% 边际带，可跟注`,
      };
    }
    if (Math.abs(req - equity) <= MARGIN) {
      return {
        tendency: "call",
        confidence: "marginal",
        note: `所需胜率 ${reqPct} ≈ 实算 ${pct}，边缘跟注`,
      };
    }
    return {
      tendency: "call",
      confidence: "strong",
      note: `实算胜率 ${pct} 覆盖所需 ${reqPct}，跟注`,
    };
  }

  // 无人下注：主动进攻 or 过牌
  if (equity >= RAISE_EQUITY) {
    return {
      tendency: "raise",
      confidence: "strong",
      note: `胜率 ${pct} ≥ ${RAISE_EQUITY * 100}%，建议主动下注`,
    };
  }
  if (equity >= BET_EQUITY) {
    return {
      tendency: "raise",
      confidence: "marginal",
      note: `胜率 ${pct} ≥ ${BET_EQUITY * 100}%，可主动下注`,
    };
  }
  if (equity >= CALL_EQUITY_MIN) {
    return {
      tendency: "check",
      confidence: "marginal",
      note: `胜率 ${pct} 中等，过牌控池`,
    };
  }
  return {
    tendency: "check",
    confidence: "strong",
    note: `胜率 ${pct} 偏低，过牌`,
  };
}

/**
 * 计算某决策点的参考线：equityMulti 实算胜率 + decideTendency 规则判定。
 * 同步执行（默认 2000 次迭代约几十 ms），调用方（UI）自行做 loading 微态与缓存。
 */
export function referenceLine(
  input: ReferenceInput,
  iterations: number = REFERENCE_ITERATIONS,
): ReferenceLine {
  const res = equityMulti(input.heroCards, input.board, input.activeOpponents, iterations);
  // 有效胜率：平分计一半
  const equity = res.win + res.tie / 2;
  const verdict = decideTendency({
    equity,
    potBefore: input.potBefore,
    callAmount: input.callAmount,
  });
  return { equity, ...verdict };
}

// ---------------------------------------------------------------------------
// 从 HandRecord 推导决策点输入
// ---------------------------------------------------------------------------

/**
 * 重放动作序列，推导 (streetIdx, actionIdx) 处 hero 决策点的 ReferenceInput。
 * 返回 null 的情形：该动作不是 hero 的、hero 底牌未知、showdown 街、
 * 无存活对手（底池已收，无参考意义）。
 *
 * 口径与回放页 buildSteps 一致：
 * - 初始底池 = 小盲 + 大盲 + ante × 人数（引擎 createGame 直接计入 pot，
 *   streetActions 不含盲注/ante 投放动作）；
 * - call 的 amount 是补差增量；bet/raise/allin 是 bet-to 总额，增量 =
 *   amount − 该座位本街已投入；
 * - 翻前把盲注座位按「位置短名 SB/BTN/SB→smallBlind、BB→bigBlind」预置投入，
 *   否则 BB 位 hero 的 callAmount 会高估一个大盲。
 *   （HandRecord 不存逐座位筹码，盲注不足全下的极端情形按满额盲注近似。）
 */
export function heroDecisionInput(
  hand: HandRecord,
  streetIdx: number,
  actionIdx: number,
): ReferenceInput | null {
  const st = hand.streets[streetIdx];
  if (!st || st.street === "showdown") return null;
  const sa = st.actions[actionIdx];
  if (!sa || sa.seat !== hand.heroSeat) return null;

  const hero = hand.players.find((p) => p.seat === hand.heroSeat);
  if (!hero || !hero.cards || hero.cards.length !== 2) return null;

  const n = hand.players.length;
  // BBA 模式只有大盲位投一份 ante；缺省/全体模式按人头计
  const anteTotal = hand.anteMode === "bb" ? hand.ante : hand.ante * n;
  let pot = hand.smallBlind + hand.bigBlind + anteTotal;
  const folded = new Set<Seat>();

  for (let si = 0; si <= streetIdx; si++) {
    const street = hand.streets[si];
    const invested: number[] = [];
    // 翻前预置盲注投入（ante 是死钱，不计入 streetBet 口径）
    if (si === 0) {
      for (const p of hand.players) {
        const pos = seatPositionName(p.seat, hand.buttonSeat, n);
        if (pos === "SB" || pos === "BTN/SB") invested[p.seat] = hand.smallBlind;
        else if (pos === "BB") invested[p.seat] = hand.bigBlind;
      }
    }
    const lastAi = si === streetIdx ? actionIdx - 1 : street.actions.length - 1;
    for (let ai = 0; ai <= lastAi; ai++) {
      const prev = street.actions[ai];
      if (!prev) break;
      const { type, amount } = prev.action;
      if (type === "fold") folded.add(prev.seat);
      let inc = 0;
      if (type === "call") inc = amount;
      else if (type === "bet" || type === "raise" || type === "allin") {
        inc = Math.max(0, amount - (invested[prev.seat] ?? 0));
      }
      invested[prev.seat] = (invested[prev.seat] ?? 0) + inc;
      pot += inc;
    }
    if (si === streetIdx) {
      const heroInvested = invested[hand.heroSeat] ?? 0;
      let maxInvested = 0;
      for (const p of hand.players) {
        if (folded.has(p.seat)) continue;
        maxInvested = Math.max(maxInvested, invested[p.seat] ?? 0);
      }
      const activeOpponents = hand.players.filter(
        (p) => p.seat !== hand.heroSeat && !folded.has(p.seat),
      ).length;
      if (activeOpponents < 1) return null;
      return {
        heroCards: hero.cards,
        board: street.board,
        potBefore: pot,
        callAmount: Math.max(0, maxInvested - heroInvested),
        activeOpponents,
        position: seatPositionName(hand.heroSeat, hand.buttonSeat, n) || undefined,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 教练复盘 prompt 注入：每个 hero 决策点一行参考数据
// ---------------------------------------------------------------------------

const TENDENCY_LABEL: Record<GtoTendency, string> = {
  raise: "加注/下注",
  call: "跟注",
  fold: "弃牌",
  check: "过牌",
};
const CONFIDENCE_LABEL: Record<GtoConfidence, string> = {
  strong: "明确",
  marginal: "边际",
};
const PROMPT_STREET_LABEL: Record<string, string> = {
  preflop: "翻前",
  flop: "翻牌圈",
  turn: "转牌圈",
  river: "河牌圈",
};

/**
 * 为教练复盘 prompt 生成「每个 hero 决策点一行」的参考数据。
 *
 * 每行含：街道、面对跟注额与底池、实算胜率、（有跟注额时）保本所需胜率、
 * 参考倾向（含明确/边际置信度）。让教练有点对点的客观弹药，不再泛泛点评。
 *
 * 从略情形（该行直接省略，不阻塞复盘）：
 * - 非 hero 的动作 / showdown 街（heroDecisionInput 返回 null）；
 * - hero 底牌未知、无存活对手；
 * - 胜率模拟等计算抛错（数据不全等异常）。
 * 翻前 board 为空同样可算（equityMulti 对 N 名随机对手跑蒙特卡洛）。
 */
export function handReferenceLines(
  hand: HandRecord,
  iterations: number = REFERENCE_ITERATIONS,
): string[] {
  const lines: string[] = [];
  hand.streets.forEach((st, si) => {
    if (st.street === "showdown") return;
    st.actions.forEach((sa, ai) => {
      if (sa.seat !== hand.heroSeat) return;
      try {
        const input = heroDecisionInput(hand, si, ai);
        if (!input) return;
        const line = referenceLine(input, iterations);
        const street = PROMPT_STREET_LABEL[st.street] ?? st.street;
        const eqPct = (line.equity * 100).toFixed(1);
        const tendency = TENDENCY_LABEL[line.tendency];
        const confidence = CONFIDENCE_LABEL[line.confidence];
        if (input.callAmount > 0) {
          const reqPct = (
            requiredEquity(input.potBefore, input.callAmount) * 100
          ).toFixed(1);
          lines.push(
            `- ${street} 你面对跟注额 ${input.callAmount}（底池 ${input.potBefore}）：` +
              `实算胜率 ${eqPct}%，所需胜率 ${reqPct}%，参考倾向：${tendency}（${confidence}）`,
          );
        } else {
          lines.push(
            `- ${street} 无人下注到你（底池 ${input.potBefore}）：` +
              `实算胜率 ${eqPct}%，参考倾向：${tendency}（${confidence}）`,
          );
        }
      } catch {
        // 该决策点数据从略
      }
    });
  });
  return lines;
}
