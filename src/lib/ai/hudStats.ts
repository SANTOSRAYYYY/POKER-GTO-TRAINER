/**
 * src/lib/ai/hudStats.ts — 个人数据中心（/stats）的统计聚合（纯函数，node/浏览器通用）
 *
 * 输入全部历史 HandRecord[]，输出 hero 视角的 HUD 数据：
 * - 核心指标：总手数 / 总盈亏 / bb 每百手 / 胜率（平局按 0.5 计）/ 摊牌率
 * - hero 打法四指标 VPIP / PFR / AF / WTSD：复用 adapt.ts 的 updateStats
 *   逐手累积（计数口径与对手建模完全一致），另带翻前位置分桶（early/middle/late）。
 *   累积前临时把 adapt 的近因衰减 λ 置 1.0（全量整数口径，HUD 看的是长期全貌
 *   而非近期动态），同步循环结束后恢复原值——单线程同步执行，无并发风险。
 * - 盈亏曲线：按时间升序的逐手累计盈亏（bb/100 按每手 profit/bigBlind 归一化，
 *   兼容锦标赛升盲）。
 * - 位置拆分：seatPositionName 短名聚合手数/盈亏/胜率。
 * - 风格拆分：一手遇到的每个不同 AI 风格各计入一次（多人桌混合风格时该手
 *   盈亏同时归属各在场风格，口径 = 「桌上有该类对手时我的整体表现」）。
 */
import type { ConcreteAIStyle, HandRecord } from "@/lib/types";
import {
  buildModel,
  createOpponentStats,
  getAdaptRecencyLambda,
  normalizeStats,
  setAdaptRecencyLambda,
  updateStats,
} from "./adapt";
import { seatPositionName } from "./positions";

/** 单个翻前位置桶的统计（vpip/pfr 为比率；null = 该桶无样本） */
export interface HudBucket {
  hands: number;
  vpip: number | null;
  pfr: number | null;
}

/** 按位置（BTN/CO/.../BB）聚合的一行 */
export interface PositionRow {
  position: string;
  hands: number;
  profit: number;
  winRate: number;
}

/** 按对手 AI 风格聚合的一行 */
export interface StyleRow {
  style: ConcreteAIStyle;
  hands: number;
  profit: number;
  winRate: number;
}

/** 盈亏曲线的一个点（按时间升序） */
export interface CurvePoint {
  /** 时间升序后的序号（从 1 开始） */
  handNumber: number;
  timestamp: number;
  /** 该手盈亏 */
  profit: number;
  /** 截至该手的累计盈亏 */
  cumulative: number;
}

export interface HeroHud {
  totalHands: number;
  totalProfit: number;
  /** bb/100 = Σ(profit_i / bigBlind_i) / 手数 × 100；无手牌时为 null */
  bbPer100: number | null;
  /** 胜率 0-1（平局按 0.5 计，与 historyStore.computeStats 同口径） */
  winRate: number;
  /** 摊牌率 0-1（showdown 手数 / 总手数） */
  showdownRate: number;
  /** hero 自愿入池率 0-1 */
  vpip: number;
  /** hero 翻前加注率 0-1 */
  pfr: number;
  /** hero 翻后 aggression factor（分母至少按 1 计） */
  af: number;
  /** hero 摊牌率 WTSD 0-1（看到翻牌后打到摊牌的比例） */
  wtsd: number;
  /** 翻前位置分桶（early/middle/late）的手数与 VPIP/PFR */
  buckets: { early: HudBucket; middle: HudBucket; late: HudBucket };
  /** 时间升序的累计盈亏曲线 */
  curve: CurvePoint[];
  /** 按位置聚合（按 POSITION_ORDER 排序，只含打过的位置） */
  byPosition: PositionRow[];
  /** 按对手风格聚合（按 STYLE_ORDER 排序，只含遇到过的风格） */
  byStyle: StyleRow[];
}

/** 位置展示顺序：BTN → CO → … → BB（与任务要求的 BTN/CO/.../BB 一致） */
export const POSITION_ORDER: readonly string[] = [
  "BTN",
  "CO",
  "HJ",
  "LJ",
  "UTG+2",
  "UTG+1",
  "UTG",
  "BB",
  "SB",
  "CO/UTG",
  "BTN/SB",
];

const STYLE_ORDER: readonly ConcreteAIStyle[] = [
  "nit",
  "tag",
  "lag",
  "maniac",
  "calling_station",
  "gto",
];

interface Acc {
  hands: number;
  profit: number;
  winScore: number;
}

function accPut<K>(map: Map<K, Acc>, key: K, profit: number, winScore: number): void {
  const a = map.get(key) ?? { hands: 0, profit: 0, winScore: 0 };
  a.hands += 1;
  a.profit += profit;
  a.winScore += winScore;
  map.set(key, a);
}

/**
 * 汇总全部历史手牌为 hero HUD 数据（纯函数）。
 * 输入数组顺序不限（内部按 timestamp 升序重排后再累积）。
 */
export function computeHeroHud(hands: HandRecord[]): HeroHud {
  const sorted = [...hands].sort((a, b) => a.timestamp - b.timestamp);
  const prevLambda = getAdaptRecencyLambda();
  // HUD 是全量长期口径：临时关闭近因衰减（λ=1 退化为整数累加），结束后恢复
  setAdaptRecencyLambda(1);
  try {
    let stats = createOpponentStats(sorted[0]?.heroSeat ?? 0);
    let totalProfit = 0;
    let winScore = 0;
    let showdowns = 0;
    let bbWon = 0; // Σ profit_i / bigBlind_i（逐手归一化，兼容升盲）
    const curve: CurvePoint[] = [];
    const posMap = new Map<string, Acc>();
    const styleMap = new Map<ConcreteAIStyle, Acc>();

    for (const h of sorted) {
      stats = updateStats(stats, h, h.heroSeat);
      totalProfit += h.profit;
      const w = h.result === "win" ? 1 : h.result === "tie" ? 0.5 : 0;
      winScore += w;
      if (h.showdown) showdowns += 1;
      if (h.bigBlind > 0) bbWon += h.profit / h.bigBlind;
      curve.push({
        handNumber: curve.length + 1,
        timestamp: h.timestamp,
        profit: h.profit,
        cumulative: totalProfit,
      });

      const pos =
        seatPositionName(h.heroSeat, h.buttonSeat, h.players.length) || "未知";
      accPut(posMap, pos, h.profit, w);

      const styles = new Set<ConcreteAIStyle>();
      for (const p of h.players) {
        if (!p.isHero && p.aiStyle) styles.add(p.aiStyle);
      }
      for (const st of styles) accPut(styleMap, st, h.profit, w);
    }

    const totalHands = sorted.length;
    const model = buildModel(stats);
    const s = normalizeStats(stats);
    const bucket = (b: "early" | "middle" | "late"): HudBucket => {
      const h = s.pfBucketHands[b];
      return {
        hands: Math.round(h),
        vpip: h > 0 ? s.pfBucketVpip[b] / h : null,
        pfr: h > 0 ? s.pfBucketPfr[b] / h : null,
      };
    };

    const toRow = (a: Acc) => ({
      hands: a.hands,
      profit: a.profit,
      winRate: a.hands > 0 ? a.winScore / a.hands : 0,
    });
    const posOrder = (p: string) => {
      const i = POSITION_ORDER.indexOf(p);
      return i === -1 ? POSITION_ORDER.length : i;
    };
    const byPosition: PositionRow[] = [...posMap.entries()]
      .map(([position, a]) => ({ position, ...toRow(a) }))
      .sort((a, b) => posOrder(a.position) - posOrder(b.position));
    const byStyle: StyleRow[] = [...styleMap.entries()]
      .map(([style, a]) => ({ style, ...toRow(a) }))
      .sort((a, b) => STYLE_ORDER.indexOf(a.style) - STYLE_ORDER.indexOf(b.style));

    return {
      totalHands,
      totalProfit,
      bbPer100: totalHands > 0 ? (bbWon / totalHands) * 100 : null,
      winRate: totalHands > 0 ? winScore / totalHands : 0,
      showdownRate: totalHands > 0 ? showdowns / totalHands : 0,
      vpip: model.vpip,
      pfr: model.pfr,
      af: model.af,
      wtsd: model.wtsd,
      buckets: { early: bucket("early"), middle: bucket("middle"), late: bucket("late") },
      curve,
      byPosition,
      byStyle,
    };
  } finally {
    setAdaptRecencyLambda(prevLambda);
  }
}
