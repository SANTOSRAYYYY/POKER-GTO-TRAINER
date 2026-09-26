/**
 * 本地启发式决策模块
 *
 * heuristicDecide 现已升级为委托 brain.ts 的胜率驱动决策引擎（brainDecide）；
 * 旧版规则 bot 完整保留为 heuristicDecideLegacy / heuristicDecideLegacyRng，
 * 作为 benchmark 对战的对照组与教学参照。
 *
 * 旧实现说明（legacy）：
 * - 翻前：Chen 公式归一化到 0-1
 * - 翻后：对 5-7 张牌做「对子/两对/三条/顺子/同花」模式匹配 + 听牌加分
 * 决策时结合风格参数（HEURISTIC_PARAMS）与底池赔率，并注入少量随机噪声。
 * 多人底池适配：在局对手每多 1 人，跟注/加注强度门槛 +8%，诈唬概率按 0.5^n 衰减；
 * 单挑（1 名对手在局）行为与 v1 完全一致。
 */
import type {
  Card,
  ConcreteAIStyle,
  DecideInput,
  DecideResult,
  PlayerAction,
  Rank,
} from "@/lib/types";
import { AI_PROFILES, HEURISTIC_PARAMS } from "./profiles";
import { brainDecide, type Rng } from "./brain";

// ---------------------------------------------------------------------------
// 牌面工具
// ---------------------------------------------------------------------------

const RANK_VALUES: Record<Rank, number> = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};

function rankValue(card: Card): number {
  return RANK_VALUES[card[0] as Rank];
}

function suitOf(card: Card): string {
  return card[1];
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// ---------------------------------------------------------------------------
// 翻前：Chen 公式
// ---------------------------------------------------------------------------

function chenHighValue(rv: number): number {
  switch (rv) {
    case 14: return 10;
    case 13: return 8;
    case 12: return 7;
    case 11: return 6;
    default: return rv / 2;
  }
}

/**
 * Chen 公式（Bill Chen 起手牌评分），返回原始分（约 -2 ~ 20）。
 */
export function chenScore(c1: Card, c2: Card): number {
  const rv1 = rankValue(c1);
  const rv2 = rankValue(c2);
  const high = Math.max(rv1, rv2);
  const low = Math.min(rv1, rv2);
  let score = chenHighValue(high);
  const pair = rv1 === rv2;
  if (pair) score = Math.max(5, chenHighValue(high) * 2);
  if (suitOf(c1) === suitOf(c2)) score += 2;
  const gap = high - low - 1;
  if (!pair) {
    if (gap === 1) score -= 1;
    else if (gap === 2) score -= 2;
    else if (gap === 3) score -= 4;
    else if (gap >= 4) score -= 5;
    // 小牌连张/半连张的顺子潜力加分
    if (gap <= 1 && high < 12) score += 1;
  }
  return score;
}

/** 翻前手牌强度 0-1（AA≈1，72o≈0.02，AKs≈0.64） */
function preflopStrength(hole: [Card, Card]): number {
  return clamp((chenScore(hole[0], hole[1]) + 2) / 22, 0, 1);
}

// ---------------------------------------------------------------------------
// 翻后：轻量模式匹配
// ---------------------------------------------------------------------------

/**
 * 翻后手牌强度 0-1。
 * 只做成牌类别 + 听牌加分的粗粒度估计，不做蒙特卡洛。
 * 参考刻度：空气 ~0.15-0.25，底对 ~0.42，顶对 ~0.52，超对 ~0.55，
 * 两对 ~0.65，三条 ~0.75，顺子 ~0.84，同花 ~0.88，葫芦 ~0.93，四条 ~0.97。
 */
function postflopStrength(hole: [Card, Card], board: Card[], street: string): number {
  const all = [...hole, ...board];
  const rankCount = new Map<number, number>();
  const suitCount = new Map<string, number>();
  for (const c of all) {
    const rv = rankValue(c);
    rankCount.set(rv, (rankCount.get(rv) ?? 0) + 1);
    suitCount.set(suitOf(c), (suitCount.get(suitOf(c)) ?? 0) + 1);
  }

  // 同花 / 同花听
  let flush = false;
  let flushDraw = false;
  for (const [, n] of suitCount) {
    if (n >= 5) flush = true;
    else if (n === 4) flushDraw = true;
  }

  // 顺子 / 顺子听（唯一点数集合，A 同时按 1 处理以覆盖轮子顺 A-5）
  const uniq = new Set<number>(rankCount.keys());
  if (uniq.has(14)) uniq.add(1);
  const hasStraight = hasNConsecutive(uniq, 5);

  const counts = [...rankCount.values()].sort((a, b) => b - a);
  const quads = counts[0] === 4;
  const trips = counts[0] === 3;
  const pairs = counts.filter((n) => n === 2).length;
  const fullHouse = trips && (pairs >= 1 || counts[1] === 3);

  // 与底牌参与度相关的对子细分
  const [h1, h2] = hole;
  const rv1 = rankValue(h1);
  const rv2 = rankValue(h2);
  const boardRanks = board.map(rankValue);
  const boardMax = boardRanks.length ? Math.max(...boardRanks) : 0;
  const pocketPair = rv1 === rv2;
  const boardPairRank = boardRanks.find(
    (r) => boardRanks.filter((x) => x === r).length >= 2,
  );
  // 底牌中的一张与公共牌配对的对子点数
  const holePairRanks = [rv1, rv2].filter(
    (rv) => !pocketPair && boardRanks.includes(rv),
  );

  let made: number;
  if (quads) made = 0.97;
  else if (fullHouse) made = 0.93;
  else if (flush) made = 0.88;
  else if (hasStraight) made = 0.84;
  else if (trips) {
    // 公共牌自身三条时底牌未提升，强度打折
    made = board.some((c) => (rankCount.get(rankValue(c)) ?? 0) === 3) &&
      !hole.some((c) => (rankCount.get(rankValue(c)) ?? 0) === 3)
      ? 0.5
      : 0.75;
  } else if (pairs >= 2 || (pairs === 1 && pocketPair && boardPairRank !== undefined)) {
    made = 0.65;
  } else if (pairs === 1 || pocketPair) {
    if (pocketPair) {
      made = rv1 > boardMax ? 0.55 : 0.42; // 超对 / 低对
    } else if (boardPairRank !== undefined && holePairRanks.length === 0) {
      made = 0.3; // 公共牌成对，底牌没提升
    } else {
      const pr = Math.max(...holePairRanks);
      made = pr >= boardMax ? 0.52 : 0.44; // 顶对 / 中低对
    }
  } else {
    // 纯高牌
    made = 0.15 + (Math.max(rv1, rv2) === 14 ? 0.07 : 0);
  }

  // 听牌加分（河牌圈听牌已无价值）
  if (street !== "river" && made < 0.75) {
    let bonus = 0;
    if (flushDraw) bonus += 0.12;
    if (!hasStraight && hasOpenEnder(uniq)) bonus += 0.08;
    const overcards = [rv1, rv2].filter((rv) => rv > boardMax).length;
    if (made < 0.4 && overcards === 2) bonus += 0.04;
    made = Math.min(0.8, made + bonus);
  }

  return clamp(made, 0, 1);
}

function hasNConsecutive(uniq: Set<number>, n: number): boolean {
  for (let lo = 1; lo + n - 1 <= 14; lo++) {
    let ok = true;
    for (let r = lo; r < lo + n; r++) if (!uniq.has(r)) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

/** 开放顺子听：某个 5 连窗口内恰好命中 4 个点数 */
function hasOpenEnder(uniq: Set<number>): boolean {
  for (let lo = 1; lo + 4 <= 14; lo++) {
    let hit = 0;
    for (let r = lo; r < lo + 5; r++) if (uniq.has(r)) hit++;
    if (hit === 4) return true;
  }
  return false;
}

/**
 * 综合手牌强度估计（导出供测试与其他模块复用）。
 * 翻前用 Chen 公式，翻后做模式匹配；无公共牌信息时返回保守值。
 */
export function estimateStrength(
  hole: [Card, Card],
  board: Card[],
  street: string,
): number {
  if (!board.length || street === "preflop") return preflopStrength(hole);
  return postflopStrength(hole, board, street);
}

// ---------------------------------------------------------------------------
// 合法动作工具
// ---------------------------------------------------------------------------

interface LegalSet {
  has: (t: PlayerAction["type"]) => boolean;
  amount: (t: PlayerAction["type"]) => number | undefined;
  /** 指定下注类型的合法区间 [min, max]（bet-to 语义） */
  range: (t: "bet" | "raise") => { min: number; max: number } | null;
  first: PlayerAction | null;
}

function analyzeLegal(input: DecideInput, myStreetBet: number, myStack: number): LegalSet {
  const map = new Map(input.legalActions.map((a) => [a.type, a.amount]));
  const maxTo = myStreetBet + myStack;
  const allinTo = map.get("allin") ?? maxTo;
  return {
    has: (t) => map.has(t),
    amount: (t) => map.get(t),
    range: (t) => {
      const min = map.get(t);
      if (min === undefined) return null;
      return { min, max: Math.max(min, allinTo) };
    },
    first: input.legalActions[0] ?? null,
  };
}

// ---------------------------------------------------------------------------
// 决策主体
// ---------------------------------------------------------------------------

export type { Rng } from "./brain";

/**
 * 启发式决策生产入口：已升级为胜率驱动的新脑（brainDecide），
 * 保留函数名以兼容调用方（gameStore 的 heuristic 引擎、opponent 兜底）。
 */
export function heuristicDecide(
  input: DecideInput,
  style: ConcreteAIStyle,
): DecideResult {
  return brainDecide(input, style);
}

/**
 * 可注入随机源的版本，供测试做确定性断言（同样走新脑）。
 */
export function heuristicDecideRng(
  input: DecideInput,
  style: ConcreteAIStyle,
  rng: Rng,
): DecideResult {
  return brainDecide(input, style, rng);
}

/**
 * 旧版规则 bot（对照组）：Chen 公式翻前 + 模式匹配翻后。
 * benchmark 对战用它衡量新脑的强度提升；行为与升级前完全一致。
 */
export function heuristicDecideLegacy(
  input: DecideInput,
  style: ConcreteAIStyle,
): DecideResult {
  return heuristicDecideLegacyRng(input, style, Math.random);
}

/**
 * 旧版规则 bot 的可注入随机源版本。
 */
export function heuristicDecideLegacyRng(
  input: DecideInput,
  style: ConcreteAIStyle,
  rng: Rng,
): DecideResult {
  const profile = AI_PROFILES[style];
  const params = HEURISTIC_PARAMS[style];
  const seat = input.state.currentSeat ?? 1;
  const me = input.state.players[seat];
  const legal = analyzeLegal(input, me.streetBet, me.stack);

  // 多人底池收紧：仍在底池中的对手（未淘汰且未弃牌，含已全下者）超过 1 个时，
  // 每多一人跟注/加注的强度门槛上调 8%，诈唬掷签概率按 0.5^extra 衰减。
  // 单挑（extraOpponents=0）时 tighten=0、bluffScale=1，行为与 v1 完全一致。
  const opponentsInHand = input.state.players.filter(
    (p) => p.seat !== me.seat && !p.eliminated && !p.folded,
  ).length;
  const extraOpponents = Math.max(0, opponentsInHand - 1);
  const tighten = 0.08 * extraOpponents;
  const bluffScale = Math.pow(0.5, extraOpponents);

  const strength = me.holeCards
    ? estimateStrength(me.holeCards, input.state.board, input.state.street)
    : 0.2;
  // 注入少量噪声，避免打法完全可预测
  const s = clamp(strength + (rng() - 0.5) * 0.08, 0, 1);

  const facingBet = input.callAmount > 0 && legal.has("call");
  // 诈唬掷签：命中后进攻决策按强牌处理（跟注决策不受影响）；多人池显著降频
  const bluffing = rng() < params.bluffFreq * 0.5 * bluffScale;
  const sb = bluffing ? Math.max(s, 0.62 + rng() * 0.15) : s;

  const pct = Math.round(strength * 100);
  let chosen: PlayerAction | null = null;
  let reasoning = "";

  const allinTo = legal.amount("allin") ?? me.streetBet + me.stack;

  /** 在 [min, max] 内选下注额；打到上限附近时直接记为该值（引擎按 allin 处理） */
  const sizeTo = (t: "bet" | "raise", target: number): number | null => {
    const r = legal.range(t);
    if (!r) return null;
    return clamp(Math.round(target), r.min, r.max);
  };

  if (facingBet) {
    // 跟注门槛：底池赔率 × 风格松紧系数，再按 VPIP 给松派额外宽限；
    // 另有绝对强度下限（防止面对极小注时紧派也乱跟空气）
    const threshold = input.potOdds * (1.3 - 0.9 * params.vpip) - 0.25 * params.vpip + tighten;
    const floor = 0.34 - 0.35 * params.vpip + tighten;
    const wantsContinue = s >= threshold && s >= floor;
    const valueRaise =
      sb >= 0.72 + tighten && rng() < Math.max(params.aggression, sb >= 0.9 ? 0.85 : 0);
    const bluffRaise =
      !wantsContinue && bluffing && rng() < params.aggression * params.bluffFreq;

    if ((valueRaise || bluffRaise) && legal.has("raise")) {
      const target =
        input.state.currentBet +
        Math.max(input.state.minRaise, Math.round(input.state.pot * 0.75));
      const amount = sizeTo("raise", target);
      if (amount !== null) {
        chosen = { type: "raise", amount };
        reasoning = valueRaise
          ? `${profile.name}：手牌强度约 ${pct}%，加注打价值。`
          : `${profile.name}：牌力不足，加注诈唬抢池。`;
      }
    }

    if (!chosen && wantsContinue) {
      chosen = { type: "call", amount: legal.amount("call") ?? input.callAmount };
      reasoning = `${profile.name}：手牌强度约 ${pct}%，底池赔率 ${(input.potOdds * 100).toFixed(0)}%，跟注继续。`;
    }

    if (!chosen && s >= 0.88 && legal.has("allin") && params.aggression >= 0.9) {
      chosen = { type: "allin", amount: allinTo };
      reasoning = `${profile.name}：超强牌直接全下施压。`;
    }

    if (!chosen && legal.has("fold")) {
      chosen = { type: "fold", amount: 0 };
      reasoning =
        `${profile.name}：手牌强度约 ${pct}%，赔率/牌力不够` +
        (extraOpponents > 0 ? `，且面对 ${opponentsInHand} 名对手需收紧` : "") +
        "，弃牌。";
    }
  } else if (legal.has("check")) {
    // 无人下注：按强度与激进度决定主动下注；多人池纯诈唬降频
    const betProb =
      sb >= 0.6
        ? 0.5 + params.aggression * 0.5
        : sb >= 0.45
          ? params.aggression * 0.5
          : params.bluffFreq * params.aggression * bluffScale;
    if (legal.has("bet") && rng() < betProb) {
      const target = input.state.pot * (0.5 + 0.4 * params.aggression);
      const amount = sizeTo("bet", target);
      if (amount !== null) {
        chosen = { type: "bet", amount };
        reasoning =
          s >= 0.45
            ? `${profile.name}：手牌强度约 ${pct}%，主动下注。`
            : `${profile.name}：弱牌诈唬下注，试探对手。`;
      }
    }
    if (!chosen) {
      chosen = { type: "check", amount: 0 };
      reasoning = `${profile.name}：手牌强度约 ${pct}%，过牌控池。`;
    }
  }

  // 兜底链：保证任何局面都返回合法动作
  if (!chosen || !legal.has(chosen.type)) {
    if (legal.has("check")) chosen = { type: "check", amount: 0 };
    else if (legal.has("call"))
      chosen = { type: "call", amount: legal.amount("call") ?? input.callAmount };
    else if (legal.has("fold")) chosen = { type: "fold", amount: 0 };
    else if (legal.has("allin")) chosen = { type: "allin", amount: allinTo };
    else if (legal.first) chosen = legal.first;
    else chosen = { type: "fold", amount: 0 };
    if (!reasoning) reasoning = `${profile.name}：选择当前局面下的合法动作。`;
  }

  // fold/check 的 amount 固定为 0
  if (chosen.type === "fold" || chosen.type === "check") chosen = { ...chosen, amount: 0 };

  return { action: chosen, reasoning, source: "heuristic" };
}
