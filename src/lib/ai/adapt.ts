/**
 * src/lib/ai/adapt.ts — 对手建模与剥削性调整（opponent modeling）
 *
 * 数据流：
 *   gameStore.finalizeHand / 台架 match.ts 用每手 HandRecord 调 updateStats
 *   累积各桌面座位统计 → buildModel/classify 把统计渲染为 OpponentModel
 *   （VPIP/PFR/AF/WTSD + 分桶 + 分类 + 置信度）
 *   → brain.ts 用 adjustments() 聚合在局对手的模型，调制自身阈值/诈唬率/
 *   翻前范围档位/面对加注的百分位门槛。
 *
 * 指标口径：
 * - VPIP（自愿入池率）：翻前 call/bet/raise/allin 的手数占比。盲注/ante 是强制投入，
 *   不计入；HandRecord 契约保证盲注不产生动作记录（streets 里第一条动作就是 UTG）。
 *   按「手」计而非按动作计：limp 后再跟加注仍只算 1 次 VPIP。
 * - PFR（翻前加注率）：翻前主动抬高下注线（bet/raise/加注性 allin）的手数占比。
 * - AF（翻后 aggression factor）：翻后 bet/raise/加注性 allin 次数 ÷ call/跟注性 allin
 *   次数（分母至少按 1 计，小样本避免除零爆炸）。按动作次数计。
 * - WTSD（摊牌率）：看到翻牌（翻前未弃牌且本手进入翻牌圈）的手当中打到摊牌的比例。
 * - 位置分桶（Phase 6）：VPIP/PFR 同时按翻前行动时「身后人数」分桶
 *   （early ≥5 / middle 2-4 / late ≤1；单挑全归 late），总量口径保留兼容。
 *   BTN 开局 40% 很正常、UTG 开局 40% 是松浪——分类用桶校正后的 VPIP
 *   （classifyPositional），避免「后位松前位紧」被误判为全面松浪。
 *
 * 近因加权（Phase 6）：updateStats 每手更新前先把旧计数乘 λ（模块级旋钮
 * adaptRecencyLambda，默认 0.92，稳态有效样本 ≈ 1/(1-λ) ≈ 12.5 手；
 * λ=1.0 = 关闭近因加权，退化为整数累加旧口径）。hands 变为衰减后有效样本量，
 * confidence 公式随之使用有效样本量。计数由此成为浮点（λ=1 时保持整数）。
 *
 * allin 归类：amount 语义是 bet-to（本街累计总额），超过本街当前最高下注线记
 * 加注性（进攻/算 PFR），否则记跟注性（被动/不算 PFR）。
 *
 * 摊牌学习（Phase 8，showdown-calibrated ranges）：对手摊牌亮出的牌是其真实
 * 范围的直接证据（"他在 BTN 用 J4o 开局过" ⇒ 其 BTN 开局范围比基线宽）。
 * updateStats 把每次亮牌记入 stats 的 showdownsSeen 环形缓冲（上限 30 条，
 * 记录位置桶/169 牌型/翻前首个主动作）；rangeWidthAdjustment 把「该桶亮牌中
 * 弱牌（翻前强度百分位 < 0.5）占比」渲染为范围宽度乘数（>1 放宽 / 0.9 微收），
 * brain 经 showdownWidthMult（按模型置信度缩放）接入翻前面对加注与翻后
 * facing spec 的 topPct。环形窗口自带近因性，不随 λ 衰减。
 * 注：showdownsSeen 字段挂在 OpponentStats 对象上但类型声明在本文件
 * （OpponentStatsWithShowdowns 结构化扩展），types.ts 保持不动。
 */
import type {
  Card,
  HandRecord,
  OpponentClass,
  OpponentModel,
  OpponentStats,
  PreflopBucketCounts,
  Seat,
  Street,
} from "@/lib/types";
import { MATRIX_RANKS } from "@/lib/gto/ranges";

// ---------------------------------------------------------------------------
// 阈值常量（导出供测试；分类阈值按 6 人桌常识标定）
// ---------------------------------------------------------------------------

/** 分类所需最小样本：不足则 cls=unknown、confidence=0（零修正） */
export const MIN_SAMPLE_HANDS = 10;
/** 置信度满值样本量 */
export const FULL_CONFIDENCE_HANDS = 40;
/** 最小样本处的置信度（10 手 0.3 → 40 手 1.0 线性） */
export const CONFIDENCE_AT_MIN_SAMPLE = 0.3;

// 分类阈值（6 人桌常识）：
// - nit：VPIP < 0.20 且 AF < 1.5（极少入池且翻后偏被动）
// - calling_station：VPIP > 0.45 且 AF < 1.0（什么牌都跟，几乎不主动加注）
// - maniac：VPIP > 0.40 且 AF > 2.5（入池多且翻后疯狂进攻）
// - lag：0.25 ≤ VPIP ≤ 0.45 且 AF > 2.0（入池偏宽且翻后进攻性强）
// - 其余中庸归为 tag（均衡，无剥削修正）
export const NIT_MAX_VPIP = 0.2;
export const NIT_MAX_AF = 1.5;
export const STATION_MIN_VPIP = 0.45;
export const STATION_MAX_AF = 1.0;
export const MANIAC_MIN_VPIP = 0.4;
export const MANIAC_MIN_AF = 2.5;
export const LAG_MIN_VPIP = 0.25;
export const LAG_MAX_VPIP = 0.45;
export const LAG_MIN_AF = 2.0;

// 剥削规则修正量（单一对手、满置信度时）
/** 对跟注站：诈唬频率 ×0.25（诈唬不走），价值下注门槛 -5%（打薄） */
export const STATION_BLUFF_MULT = 0.25;
export const STATION_VALUE_BET_DELTA = -0.05;
/** 对 nit：翻前后位偷盲/开局范围放宽一档，诈唬 ×1.5 */
export const NIT_BLUFF_MULT = 1.5;
export const NIT_OPEN_RANGE_SHIFT = -1;
/** 对 maniac：跟注边际 -4%（放宽抓诈），自身诈唬 ×0.5，价值下注门槛 -3% */
export const MANIAC_CALL_MARGIN_DELTA = -0.04;
export const MANIAC_BLUFF_MULT = 0.5;
export const MANIAC_VALUE_BET_DELTA = -0.03;
/** 对 lag：跟注边际 -2% */
export const LAG_CALL_MARGIN_DELTA = -0.02;

/** 聚合输出的安全钳制区间 */
export const BLUFF_MULT_RANGE = { min: 0.1, max: 2 } as const;
export const CALL_MARGIN_DELTA_RANGE = { min: -0.06, max: 0.06 } as const;
export const VALUE_BET_DELTA_RANGE = { min: -0.08, max: 0.08 } as const;
export const OPEN_RANGE_SHIFT_RANGE = { min: -1, max: 0 } as const;
export const FACING_RAISE_DELTA_RANGE = { min: -0.06, max: 0.06 } as const;

// ---- 近因加权（recency weighting）----
/**
 * 近因衰减默认值：每手更新前旧计数 ×0.92。
 * 稳态有效样本 ≈ 1/(1-λ) ≈ 12.5 手——模型对打法突变约十几手内完成跟踪，
 * 代价是长期置信度上限被压到 ~0.36（10 手 0.3 起步的曲线几乎触顶即平）。
 * 1.0 = 关闭近因加权（整数累加旧口径）。模块级旋钮：生产固定默认值；
 * 台架按座位经 updateStats 第 4 参显式传入（每座位独立 λ，见 match.ts）。
 */
export const DEFAULT_RECENCY_LAMBDA = 0.92;
let recencyLambda = DEFAULT_RECENCY_LAMBDA;

/** 设置近因衰减系数（钳制 [0.5, 1]；非法值回退默认） */
export function setAdaptRecencyLambda(lambda: number): void {
  recencyLambda = Number.isFinite(lambda)
    ? clamp(lambda, 0.5, 1)
    : DEFAULT_RECENCY_LAMBDA;
}
export function getAdaptRecencyLambda(): number {
  return recencyLambda;
}

// ---- 位置分桶（Phase 6）----
export type PreflopBucket = keyof PreflopBucketCounts; // "early" | "middle" | "late"

/**
 * 各桶 VPIP 基线（6-max 常识）：前位 ~17%（UTG 侧最紧）、中位 ~30%
 * （HJ/CO/BTN 混合）、盲位侧后桶 ~50%（SB 第一入池常态宽开 + BB 防守性跟注）。
 * 分类用「超额 VPIP」：桶 VPIP 减桶基线后再汇总，与总体阈值可比。
 */
export const BUCKET_BASELINE_VPIP: Readonly<PreflopBucketCounts> = {
  early: 0.17,
  middle: 0.3,
  late: 0.5,
};
/** 超额校正后挂回的总体锚点（与旧分类阈值同口径） */
export const OVERALL_BASELINE_VPIP = 0.28;
/**
 * 桶参与校正的最小（有效）样本量。取 3 而非更高：λ=0.92 稳态总有效样本
 * 仅 ~12.5 手，分到中位桶 ~6 / 后桶 ~4 / 前位桶 ~2——前位桶经常达不到
 * 门槛而回退总体口径，属预期的保守行为（前位证据不足不乱校正）。
 */
export const MIN_BUCKET_HANDS = 3;

// ---- 位置敏感剥削（brain 旋钮 adaptPositionalEnabled 开启时生效）----
/** 盲位侧偷盲判定：加注者 late 桶 VPIP 超出基线该值（15pp）视为偷盲狂 */
export const LATE_STEAL_VPIP_EXCESS = 0.15;
/** 对偷盲狂：盲位防守放宽（面对其加注的百分位门槛负向修正） */
export const LATE_STEAL_DEFEND_DELTA = -0.04;
/** maniac 在前位（early 桶）加注给足尊重：面对其加注的门槛正向修正（收紧） */
export const MANIAC_EARLY_RESPECT_DELTA = 0.04;

// ---- 摊牌学习（Phase 8：showdown-calibrated ranges）----
/** 亮牌记录的翻前首个主动作（open_raise = 首次抬线加注；three_bet = 对已有一次加注再加注） */
export type ShowdownAction =
  | "open_raise"
  | "call"
  | "three_bet"
  | "four_bet_plus"
  | "check";

/** 一次摊牌亮牌记录（存 OpponentStats.showdownsSeen 环形缓冲） */
export interface ShowdownShown {
  /** 亮牌者座位 */
  seat: Seat;
  /** 其翻前行动位置桶（与 bucketOfPreflop 同口径） */
  bucket: PreflopBucket;
  /** 169 型牌型记号（"J4o"/"AKs"/"TT"；与 brain canonicalLabel 同口径） */
  handType: string;
  /** 翻前首个主动作（异常快照无动作记录时兜底 "check"） */
  action: ShowdownAction;
}

/**
 * OpponentStats 的摊牌学习扩展视图：showdownsSeen 字段随对象走（updateStats
 * 纯函数逐代传递，JSON 序列化兼容），但类型声明留在本文件——types.ts 不在
 * 本次改动边界内。旧对象/旧存档缺字段时一律按空缓冲处理。
 */
export interface OpponentStatsWithShowdowns extends OpponentStats {
  showdownsSeen?: ShowdownShown[];
}

/** 亮牌环形缓冲上限（每座位/每观察者表） */
export const SHOWDOWN_RING_LIMIT = 30;
/** 宽度调整的最小亮牌样本量（按桶计；不足 → 乘数 1 不调整） */
export const SHOWDOWN_MIN_SAMPLE = 5;
/** 弱牌占比基线阈值：亮出牌中「翻前强度百分位 < 0.5」的占比超过该值才放宽 */
export const SHOWDOWN_WEAK_THRESHOLD = 0.3;
/** 放宽乘数上限 */
export const SHOWDOWN_WIDEN_MAX = 1.5;
/** 亮牌全部强牌（弱牌占比 = 0）时的收紧乘数 */
export const SHOWDOWN_ALL_STRONG_MULT = 0.9;
/** 放宽斜率：弱牌占比从阈值升到 1.0 线性映射到 1 → SHOWDOWN_WIDEN_MAX */
const SHOWDOWN_WIDEN_SLOPE =
  (SHOWDOWN_WIDEN_MAX - 1) / (1 - SHOWDOWN_WEAK_THRESHOLD);

/**
 * 169 牌型翻前强度序（从强到弱）：与 brain.ts PREFLOP_ORDER 同源（离线蒙特卡洛
 * 对随机单对手排序生成）的有意拷贝——brain.ts 的表是模块私有且 brain 依赖 adapt
 * （反向 import 成环），拷贝保持单向依赖。两处必须一致：改动任一处需同步另一处
 * （__tests__/showdownBlocker.test.ts 有一致性锚点断言）。
 */
const PREFLOP_STRENGTH_ORDER: readonly string[] = [
  "AA","KK","QQ","JJ","TT","99","88","AKs","AQs","77","AJs","ATs",
  "AQo","AKo","KQs","66","AJo","A9s","ATo","KJs","A8s","KQo","KTs","A9o",
  "55","A7s","K9s","A6s","QJs","KJo","QTs","A8o","A4s","A5s","KTo","K8s",
  "A6o","A5o","A7o","QJo","A3s","Q9s","JTs","44","K7s","A4o","K9o","QTo",
  "A2s","K8o","K5s","K6s","Q8s","K7o","A3o","JTo","J9s","K4s","A2o","K6o",
  "Q9o","T9s","Q7s","K3s","J8s","K5o","K2s","Q8o","Q5s","33","Q6s","K4o",
  "J7s","Q4s","J9o","T8s","K3o","Q7o","Q6o","T9o","J8o","98s","Q3s","K2o",
  "J5s","Q5o","Q4o","J6s","J7o","22","T8o","T7s","Q2s","98o","T6s","T7o",
  "87s","J4s","J3s","97s","J5o","96s","T5s","Q2o","J6o","J2s","Q3o","97o",
  "J4o","86s","T4s","T6o","T3s","95s","76s","87o","J3o","85s","T5o","T2s",
  "J2o","75s","T4o","96o","86o","94s","84s","93s","95o","65s","T3o","92s",
  "T2o","74s","54s","76o","83s","64s","85o","94o","75o","73s","82s","65o",
  "93o","84o","53s","63s","92o","72s","74o","43s","62s","54o","64o","83o",
  "52s","82o","73o","42s","32s","63o","72o","53o","43o","52o","62o","42o",
  "32o",
];

const PREFLOP_STRENGTH_PCT: ReadonlyMap<string, number> = new Map(
  PREFLOP_STRENGTH_ORDER.map((label, idx) => [
    label,
    (PREFLOP_STRENGTH_ORDER.length - 1 - idx) / (PREFLOP_STRENGTH_ORDER.length - 1),
  ]),
);

/** 169 牌型的翻前强度百分位 0-1（1 = 最强 AA；未知牌型保守取 0.3，与 brain 兜底一致） */
function preflopStrengthPctile(label: string): number {
  return PREFLOP_STRENGTH_PCT.get(label) ?? 0.3;
}

const SHOWDOWN_RANK_VALUES: Record<string, number> = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};

/** 两张底牌 → 169 型牌型记号（与 brain.ts canonicalLabel 同口径） */
function showdownHandLabel(c1: Card, c2: Card): string {
  const v1 = SHOWDOWN_RANK_VALUES[c1[0]];
  const v2 = SHOWDOWN_RANK_VALUES[c2[0]];
  const hi = Math.max(v1, v2);
  const lo = Math.min(v1, v2);
  const R = (v: number) => MATRIX_RANKS[14 - v];
  if (v1 === v2) return `${R(v1)}${R(v1)}`;
  const suited = c1[1] === c2[1];
  return `${R(hi)}${R(lo)}${suited ? "s" : "o"}`;
}

/** 读取 stats 的亮牌环形缓冲（旧对象/旧存档缺字段时为空数组） */
export function showdownRingOf(stats: OpponentStats): ShowdownShown[] {
  return (stats as OpponentStatsWithShowdowns).showdownsSeen ?? [];
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// ---------------------------------------------------------------------------
// 统计累积
// ---------------------------------------------------------------------------

const zeroBuckets = (): PreflopBucketCounts => ({ early: 0, middle: 0, late: 0 });

export function createOpponentStats(seat: Seat): OpponentStats {
  return {
    seat,
    hands: 0,
    vpipHands: 0,
    pfrHands: 0,
    postflopAggressive: 0,
    postflopPassive: 0,
    showdowns: 0,
    showdownsSeenFlop: 0,
    pfBucketHands: zeroBuckets(),
    pfBucketVpip: zeroBuckets(),
    pfBucketPfr: zeroBuckets(),
  };
}

/**
 * 旧版对象/旧会话存档可能缺少分桶字段：归一化为零桶（从此刻起累积分桶，
 * 总体口径不受影响）。已有分桶的对象原样返回（引用不变）。
 */
export function normalizeStats(stats: OpponentStats): OpponentStats {
  if (stats.pfBucketHands && stats.pfBucketVpip && stats.pfBucketPfr) return stats;
  return {
    ...stats,
    pfBucketHands: stats.pfBucketHands ?? zeroBuckets(),
    pfBucketVpip: stats.pfBucketVpip ?? zeroBuckets(),
    pfBucketPfr: stats.pfBucketPfr ?? zeroBuckets(),
  };
}

/**
 * 翻前行动位置分桶：按该座位翻前行动时的「身后人数」
 * （与 positions.ts actOrderInfo 同一口径：n≤3 时 UTG 环绕回按钮，
 * n≥4 时翻前从 seats[3]（大盲左邻）起数行动顺位）。
 * 单挑（2 人桌）特殊处理：两个座位都归入 late。
 */
export function bucketOfPreflop(
  seat: Seat,
  buttonSeat: Seat,
  playerCount: number,
): PreflopBucket {
  const n = playerCount;
  if (n <= 2) return "late";
  const dist = (((seat - buttonSeat) % n) + n) % n;
  const preflopStart = n <= 3 ? 0 : 3;
  const preflopRank = ((dist - preflopStart + n) % n) + 1;
  const behind = n - preflopRank;
  if (behind >= 5) return "early";
  if (behind >= 2) return "middle";
  return "late";
}

/** 分桶计数衰减（λ=1 时退化为原值累加） */
function decayBucket(
  b: PreflopBucketCounts,
  lambda: number,
  add?: PreflopBucket,
): PreflopBucketCounts {
  return {
    early: b.early * lambda + (add === "early" ? 1 : 0),
    middle: b.middle * lambda + (add === "middle" ? 1 : 0),
    late: b.late * lambda + (add === "late" ? 1 : 0),
  };
}

/**
 * 用一手记录更新某座位的统计（纯函数，返回新对象）。
 * seat 指 HandRecord 内的座位号（record.players[*].seat）。
 * 该座位未参与本手时原样返回。
 *
 * 近因加权：先对全部旧计数乘 λ，再累加本手。λ 缺省取模块级
 * adaptRecencyLambda（生产路径不传参，行为不变）；台架可按座位显式传入
 * 实现每座位独立 λ（钳制 [0.5, 1] 与 setAdaptRecencyLambda 同口径）。
 * λ=1.0 时与旧整数累加口径逐比特一致。
 */
export function updateStats(
  stats: OpponentStats,
  record: HandRecord,
  seat: Seat,
  lambdaOverride?: number,
): OpponentStats {
  if (!record.players.some((p) => p.seat === seat)) return stats;
  const prev = normalizeStats(stats);
  const lambda =
    lambdaOverride === undefined
      ? recencyLambda
      : Number.isFinite(lambdaOverride)
        ? clamp(lambdaOverride, 0.5, 1)
        : DEFAULT_RECENCY_LAMBDA;
  const bucket = bucketOfPreflop(seat, record.buttonSeat, record.players.length);
  const next: OpponentStats = {
    seat,
    hands: prev.hands * lambda + 1,
    vpipHands: prev.vpipHands * lambda,
    pfrHands: prev.pfrHands * lambda,
    postflopAggressive: prev.postflopAggressive * lambda,
    postflopPassive: prev.postflopPassive * lambda,
    showdowns: prev.showdowns * lambda,
    showdownsSeenFlop: prev.showdownsSeenFlop * lambda,
    pfBucketHands: decayBucket(prev.pfBucketHands, lambda, bucket),
    pfBucketVpip: decayBucket(prev.pfBucketVpip, lambda),
    pfBucketPfr: decayBucket(prev.pfBucketPfr, lambda),
  };

  // ---- 翻前：VPIP / PFR（按手计，总量与分桶同步）----
  const preflop = record.streets.find((s) => s.street === "preflop");
  let foldedPreflop = false;
  // 摊牌学习：该座位翻前首个主动作（open_raise/three_bet 按此前抬线次数分档）
  let firstVoluntary: ShowdownAction | null = null;
  let pfRaises = 0;
  if (preflop) {
    let vpip = false;
    let pfr = false;
    // 盲注不产生动作记录（契约），下注线从 bigBlind 起算
    let runningMax = record.bigBlind;
    for (const { seat: s, action } of preflop.actions) {
      if (s === seat) {
        if (action.type === "fold") foldedPreflop = true;
        else if (action.type === "call") {
          vpip = true;
          if (firstVoluntary === null) firstVoluntary = "call";
        } else if (action.type === "check") {
          if (firstVoluntary === null) firstVoluntary = "check";
        } else if (action.type === "bet" || action.type === "raise") {
          vpip = true;
          pfr = true;
          if (firstVoluntary === null) {
            firstVoluntary =
              pfRaises === 0 ? "open_raise"
                : pfRaises === 1 ? "three_bet" : "four_bet_plus";
          }
        } else if (action.type === "allin") {
          vpip = true;
          if (action.amount > runningMax) {
            pfr = true;
            if (firstVoluntary === null) {
              firstVoluntary =
                pfRaises === 0 ? "open_raise"
                  : pfRaises === 1 ? "three_bet" : "four_bet_plus";
            }
          } else if (firstVoluntary === null) {
            firstVoluntary = "call"; // 短码跟注性全下（与 PFR 口径一致）
          }
        }
      }
      if (
        action.type === "bet" ||
        action.type === "raise" ||
        (action.type === "allin" && action.amount > runningMax)
      ) {
        pfRaises += 1; // 抬线次数（与 PFR 同口径：bet/raise 与抬线 allin）
      }
      if (
        action.type === "bet" ||
        action.type === "raise" ||
        action.type === "allin"
      ) {
        runningMax = Math.max(runningMax, action.amount);
      }
    }
    if (vpip) {
      next.vpipHands += 1;
      next.pfBucketVpip[bucket] += 1;
    }
    if (pfr) {
      next.pfrHands += 1;
      next.pfBucketPfr[bucket] += 1;
    }
  }

  // ---- WTSD 分母：本手进入翻牌圈且该座位翻前未弃牌 ----
  const sawFlop =
    !foldedPreflop && record.streets.some((s) => s.street === "flop");
  if (sawFlop) next.showdownsSeenFlop += 1;

  // ---- 翻后 AF（按动作次数计）----
  let folded = foldedPreflop;
  const postflopStreets: Street[] = ["flop", "turn", "river"];
  for (const street of record.streets) {
    if (!postflopStreets.includes(street.street)) continue;
    let runningMax = 0; // 每街下注线归零重计
    for (const { seat: s, action } of street.actions) {
      if (s === seat) {
        if (action.type === "fold") folded = true;
        else if (action.type === "call") next.postflopPassive += 1;
        else if (action.type === "bet" || action.type === "raise") {
          next.postflopAggressive += 1;
        } else if (action.type === "allin") {
          if (action.amount > runningMax) next.postflopAggressive += 1;
          else next.postflopPassive += 1;
        }
      }
      if (
        action.type === "bet" ||
        action.type === "raise" ||
        action.type === "allin"
      ) {
        runningMax = Math.max(runningMax, action.amount);
      }
    }
  }

  // ---- WTSD 分子：打到摊牌（本手摊牌且该座位全程未弃牌）----
  if (record.showdown && !folded) next.showdowns += 1;

  // ---- 摊牌学习（Phase 8）：亮牌记入环形缓冲（新在后，上限 SHOWDOWN_RING_LIMIT）。
  // HandRecord 契约：cards 仅摊牌且未弃牌时非 null（生产 gameStore 对 hero 座位恒
  // 亮牌，故这里要求 record.showdown 且全程未弃牌双条件）。环形窗口自带近因性，
  // 不随 λ 衰减；无新记录时引用前滚（缓冲不可变使用，不做每手拷贝）。
  {
    const ring = showdownRingOf(prev);
    let entry: ShowdownShown | null = null;
    if (record.showdown && !folded) {
      const cards = record.players.find((p) => p.seat === seat)?.cards;
      if (cards && cards.length === 2) {
        entry = {
          seat,
          bucket,
          handType: showdownHandLabel(cards[0], cards[1]),
          // 到摊牌但翻前无动作记录（异常快照）兜底 check
          action: firstVoluntary ?? "check",
        };
      }
    }
    if (entry) {
      (next as OpponentStatsWithShowdowns).showdownsSeen = [
        ...ring,
        entry,
      ].slice(-SHOWDOWN_RING_LIMIT);
    } else if (ring.length > 0) {
      (next as OpponentStatsWithShowdowns).showdownsSeen = ring;
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// 分类与画像
// ---------------------------------------------------------------------------

/** 置信度曲线：<10 手（有效样本）为 0；10 手 0.3 线性升到 40 手 1.0（之后保持 1.0） */
export function confidenceForHands(hands: number): number {
  if (hands < MIN_SAMPLE_HANDS) return 0;
  return Math.min(
    1,
    CONFIDENCE_AT_MIN_SAMPLE +
      ((1 - CONFIDENCE_AT_MIN_SAMPLE) * (hands - MIN_SAMPLE_HANDS)) /
        (FULL_CONFIDENCE_HANDS - MIN_SAMPLE_HANDS),
  );
}

/** 各桶 VPIP 比率（null = 该桶无样本）；供 prompt 位置拆分展示 */
export function bucketVpip(stats: OpponentStats): {
  early: number | null;
  middle: number | null;
  late: number | null;
} {
  const s = normalizeStats(stats);
  const rate = (h: number, v: number) => (h > 0 ? v / h : null);
  return {
    early: rate(s.pfBucketHands.early, s.pfBucketVpip.early),
    middle: rate(s.pfBucketHands.middle, s.pfBucketVpip.middle),
    late: rate(s.pfBucketHands.late, s.pfBucketVpip.late),
  };
}

/**
 * 桶校正 VPIP（超额加权法）：
 *   corrected = OVERALL_BASELINE_VPIP + Σ w_b·(vpip_b − baseline_b) / Σ w_b
 * 只使用（有效）样本 ≥ MIN_BUCKET_HANDS 的桶；全部不足时回退总体口径。
 * 含义：把「后位正常宽开」与「前位异常松浪」区分开——同样总体 40% VPIP，
 * 全部来自后位 ≈ 正常（校正后 ≈ 基线），前位也松才是真松（校正后 >> 基线）。
 */
export function correctedVpip(stats: OpponentStats): number {
  const s = normalizeStats(stats);
  const overall = s.hands > 0 ? s.vpipHands / s.hands : 0;
  let wSum = 0;
  let excess = 0;
  for (const b of ["early", "middle", "late"] as const) {
    const h = s.pfBucketHands[b];
    if (h < MIN_BUCKET_HANDS) continue;
    excess += h * (s.pfBucketVpip[b] / h - BUCKET_BASELINE_VPIP[b]);
    wSum += h;
  }
  if (wSum === 0) return overall;
  return clamp(OVERALL_BASELINE_VPIP + excess / wSum, 0, 1);
}

/** 按比率查分类阈值表（6 人桌常识标定；两个 classify 变体共用） */
function classifyByRates(vpip: number, af: number): OpponentClass {
  let cls: OpponentClass = "tag"; // 中庸默认：均衡打法，无剥削点
  if (vpip < NIT_MAX_VPIP && af < NIT_MAX_AF) cls = "nit";
  else if (vpip > MANIAC_MIN_VPIP && af > MANIAC_MIN_AF) cls = "maniac";
  else if (vpip > STATION_MIN_VPIP && af < STATION_MAX_AF) {
    cls = "calling_station";
  } else if (vpip >= LAG_MIN_VPIP && vpip <= LAG_MAX_VPIP && af > LAG_MIN_AF) {
    cls = "lag";
  }
  return cls;
}

/** 打法分类（总体口径）；有效样本不足返回 unknown/confidence 0（调用方应零修正） */
export function classify(stats: OpponentStats): {
  cls: OpponentClass;
  confidence: number;
} {
  const confidence = confidenceForHands(stats.hands);
  if (confidence === 0) return { cls: "unknown", confidence: 0 };
  const vpip = stats.hands > 0 ? stats.vpipHands / stats.hands : 0;
  const af = stats.postflopAggressive / Math.max(1, stats.postflopPassive);
  return { cls: classifyByRates(vpip, af), confidence };
}

/**
 * 位置校正分类：与 classify 同一阈值表，但 VPIP 输入换成分桶超额校正值
 * （correctedVpip）。「BTN 开局频繁但 UTG 紧」的玩家不再被误判为全面松。
 * brain 在 adaptPositionalEnabled 时对模型重分类用；样本不足的桶自动回退
 * 总体口径（correctedVpip 内部处理）。
 */
export function classifyPositional(stats: OpponentStats): {
  cls: OpponentClass;
  confidence: number;
} {
  const confidence = confidenceForHands(stats.hands);
  if (confidence === 0) return { cls: "unknown", confidence: 0 };
  const af = stats.postflopAggressive / Math.max(1, stats.postflopPassive);
  return { cls: classifyByRates(correctedVpip(stats), af), confidence };
}

/** 由累积统计渲染完整对手画像 */
export function buildModel(stats: OpponentStats): OpponentModel {
  const hands = stats.hands;
  const vpip = hands > 0 ? stats.vpipHands / hands : 0;
  const pfr = hands > 0 ? stats.pfrHands / hands : 0;
  const af = stats.postflopAggressive / Math.max(1, stats.postflopPassive);
  const wtsd =
    stats.showdownsSeenFlop > 0 ? stats.showdowns / stats.showdownsSeenFlop : 0;
  const { cls, confidence } = classify(stats);
  return {
    seat: stats.seat,
    stats,
    vpip,
    pfr,
    af,
    wtsd,
    cls,
    confidence,
    bucketVpip: bucketVpip(stats),
  };
}

// ---------------------------------------------------------------------------
// 摊牌学习：范围宽度调整（Phase 8）
// ---------------------------------------------------------------------------

/**
 * 亮牌证据 → 该位置桶的范围宽度乘数（1 = 不调整）。
 * - 该桶亮牌样本 < SHOWDOWN_MIN_SAMPLE（5）→ 1（证据不足不动）；
 * - 弱牌（翻前强度百分位 < 0.5）占比 = 0 → SHOWDOWN_ALL_STRONG_MULT（0.9 微收：
 *   只亮强牌的玩家该桶范围比基线窄）；
 * - 占比 ≤ SHOWDOWN_WEAK_THRESHOLD（0.3）→ 1（基线噪声带内）；
 * - 占比 > 0.3 → 线性放宽：1 + (占比 − 0.3) × SLOPE，钳到 SHOWDOWN_WIDEN_MAX
 *   （1.5；占比 1.0 即全弱牌时触顶）。
 */
export function rangeWidthAdjustment(
  stats: OpponentStats,
  bucket: PreflopBucket,
): number {
  const shown = showdownRingOf(stats);
  let n = 0;
  let weak = 0;
  for (const r of shown) {
    if (r.bucket !== bucket) continue;
    n += 1;
    if (preflopStrengthPctile(r.handType) < 0.5) weak += 1;
  }
  if (n < SHOWDOWN_MIN_SAMPLE) return 1;
  const weakFrac = weak / n;
  if (weakFrac === 0) return SHOWDOWN_ALL_STRONG_MULT;
  if (weakFrac <= SHOWDOWN_WEAK_THRESHOLD) return 1;
  return clamp(
    1 + (weakFrac - SHOWDOWN_WEAK_THRESHOLD) * SHOWDOWN_WIDEN_SLOPE,
    1,
    SHOWDOWN_WIDEN_MAX,
  );
}

/**
 * brain 接入用的宽度乘数：rangeWidthAdjustment 按模型置信度缩放
 * （factor = 1 + (w − 1) × conf，与 inferFacingSpec 的 cls 修正同口径）。
 * 无模型 / 零置信度 / 无调整 → 精确返回 1（调用方据此跳过乘法，保证旋钮关闭
 * 或无亮牌数据时行为逐比特不变）。
 */
export function showdownWidthMult(
  model: OpponentModel | undefined,
  bucket: PreflopBucket,
): number {
  if (!model) return 1;
  const c = clamp(model.confidence, 0, 1);
  if (c <= 0) return 1;
  const w = rangeWidthAdjustment(model.stats, bucket);
  if (w === 1) return 1;
  return 1 + (w - 1) * c;
}

// ---------------------------------------------------------------------------
// 剥削性调整
// ---------------------------------------------------------------------------

/**
 * 对决策参数的修正量（与 brain.ts 的风格调制相乘/相加）。
 * - bluffMult：诈唬频率乘数（1 = 不变）
 * - callMarginDelta：跟注所需胜率边际修正（负值放宽跟注）
 * - valueBetDelta：无人下注时价值下注门槛修正（负值打薄）
 * - openRangeShift：翻前开局范围档位偏移（-1 = 放宽一档，只在翻前后位生效）
 * - facingRaiseDelta：翻前面对加注时跟注/价值 3bet 百分位门槛修正
 *   （正值收紧给尊重 / 负值放宽防守；位置敏感剥削的输出，默认 0）
 */
export interface Adjustment {
  bluffMult: number;
  callMarginDelta: number;
  valueBetDelta: number;
  openRangeShift: number;
  facingRaiseDelta: number;
}

/** 零修正单例（无模型/对手全部 unknown 时返回，保证 brain 行为逐比特不变） */
export const IDENTITY_ADJUSTMENT: Adjustment = {
  bluffMult: 1,
  callMarginDelta: 0,
  valueBetDelta: 0,
  openRangeShift: 0,
  facingRaiseDelta: 0,
};

export interface AdjustmentContext {
  /** 是否翻前（开局范围放宽只在翻前生效） */
  isPreflop: boolean;
  /** 自身位置短名（"BTN"/"CO"/"SB"/…，见 positions.ts 的 seatPositionName） */
  position: string;
  /** 当前在局对手数（未弃牌） */
  activeOpponents: number;
  /** 位置敏感剥削总开关（brain 传 T.adaptPositionalEnabled；缺省 false 保守） */
  positionalEnabled?: boolean;
  /**
   * 翻前面对加注时的加注者信息（无人加注/找不到加注者时缺省）。
   * behind 为加注者行动时的身后人数（分桶口径见 bucketOfPreflop）。
   */
  raiser?: { seat: Seat; behind: number };
}

/** 后位集合：对 nit 的偷盲/开局放宽只在这些位置生效 */
const LATE_POSITIONS: ReadonlySet<string> = new Set(["CO", "BTN", "SB", "BTN/SB"]);

/** 剥削规则表（unknown/tag 为零修正：tag 打法均衡，按标准策略应对） */
const EXPLOIT_RULES: Record<OpponentClass, Adjustment> = {
  calling_station: {
    bluffMult: STATION_BLUFF_MULT,
    callMarginDelta: 0,
    valueBetDelta: STATION_VALUE_BET_DELTA,
    openRangeShift: 0,
    facingRaiseDelta: 0,
  },
  nit: {
    bluffMult: NIT_BLUFF_MULT,
    callMarginDelta: 0,
    valueBetDelta: 0,
    openRangeShift: NIT_OPEN_RANGE_SHIFT,
    facingRaiseDelta: 0,
  },
  maniac: {
    bluffMult: MANIAC_BLUFF_MULT,
    callMarginDelta: MANIAC_CALL_MARGIN_DELTA,
    valueBetDelta: MANIAC_VALUE_BET_DELTA,
    openRangeShift: 0,
    facingRaiseDelta: 0,
  },
  lag: {
    bluffMult: 1,
    callMarginDelta: LAG_CALL_MARGIN_DELTA,
    valueBetDelta: 0,
    openRangeShift: 0,
    facingRaiseDelta: 0,
  },
  tag: IDENTITY_ADJUSTMENT,
  unknown: IDENTITY_ADJUSTMENT,
};

/**
 * 聚合在局对手的模型，输出对自身的剥削性修正。
 * 按各模型 confidence 加权算术平均；全部 unknown/零置信度时返回 IDENTITY_ADJUSTMENT。
 * 多对手混合时修正量互相稀释（加权平均天然有界，不会超过单规则幅度）。
 *
 * 位置敏感剥削（ctx.positionalEnabled 且给出 ctx.raiser 时）：
 * - 加注者身处 late 桶（身后 ≤1，盲位侧偷盲点）且其 late 桶 VPIP 显著高于
 *   基线（>BUCKET_BASELINE_VPIP.late + LATE_STEAL_VPIP_EXCESS）→ 防守放宽
 *   （facingRaiseDelta 负向），反制偷盲；
 * - 加注者身处 early 桶（身后 ≥5）且分类为 maniac → 范围给足尊重
 *   （facingRaiseDelta 正向），maniac 的前位加注不再按疯狗处理。
 * 该项只由加注者本人的模型贡献，按其 confidence 缩放（不被其他对手稀释）。
 */
export function adjustments(
  models: OpponentModel[],
  ctx: AdjustmentContext,
): Adjustment {
  let wSum = 0;
  let bluff = 0;
  let call = 0;
  let vb = 0;
  let shift = 0;
  let facing = 0;
  for (const m of models) {
    const w = m.confidence;
    if (w <= 0 || m.cls === "unknown") continue;
    const rule = EXPLOIT_RULES[m.cls];
    // nit 的开局范围放宽只在翻前后位生效（前位不偷盲）
    const shiftRule =
      ctx.isPreflop && LATE_POSITIONS.has(ctx.position) ? rule.openRangeShift : 0;
    wSum += w;
    bluff += w * rule.bluffMult;
    call += w * rule.callMarginDelta;
    vb += w * rule.valueBetDelta;
    shift += w * shiftRule;

    // 位置敏感剥削：只采纳加注者本人的模型
    if (ctx.positionalEnabled && ctx.raiser && m.seat === ctx.raiser.seat) {
      if (ctx.raiser.behind <= 1) {
        const s = normalizeStats(m.stats);
        const lateHands = s.pfBucketHands.late;
        if (
          lateHands >= MIN_BUCKET_HANDS &&
          s.pfBucketVpip.late / lateHands >
            BUCKET_BASELINE_VPIP.late + LATE_STEAL_VPIP_EXCESS
        ) {
          facing += w * LATE_STEAL_DEFEND_DELTA;
        }
      }
      if (ctx.raiser.behind >= 5 && m.cls === "maniac") {
        facing += w * MANIAC_EARLY_RESPECT_DELTA;
      }
    }
  }
  if (wSum === 0) return IDENTITY_ADJUSTMENT;
  return {
    bluffMult: clamp(bluff / wSum, BLUFF_MULT_RANGE.min, BLUFF_MULT_RANGE.max),
    callMarginDelta: clamp(
      call / wSum,
      CALL_MARGIN_DELTA_RANGE.min,
      CALL_MARGIN_DELTA_RANGE.max,
    ),
    valueBetDelta: clamp(
      vb / wSum,
      VALUE_BET_DELTA_RANGE.min,
      VALUE_BET_DELTA_RANGE.max,
    ),
    openRangeShift: clamp(
      shift / wSum,
      OPEN_RANGE_SHIFT_RANGE.min,
      OPEN_RANGE_SHIFT_RANGE.max,
    ),
    facingRaiseDelta: clamp(
      facing,
      FACING_RAISE_DELTA_RANGE.min,
      FACING_RAISE_DELTA_RANGE.max,
    ),
  };
}
