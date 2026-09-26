/**
 * src/app/stats/filterCompare.ts — /stats 数据中心的筛选与对比（纯函数）
 *
 * - filterHands：按局型（全部/仅现金局/仅锦标赛，isTournamentHand 口径）与
 *   时间范围（近 50/100/全部手）筛选手牌流；输入顺序不限，内部先按时间
 *   倒序（最新在前）再截取「最近 N 手」。
 * - compareSegments：把筛选后的手牌切成「最近 N 手」与「之前 N 手」两段，
 *   各自聚合 HeroHud；样本不足（之前段为空）返回 null。
 * - buildMetricDeltas：两段 HUD 的 VPIP/PFR/AF/WTSD/bb100 逐项差值，
 *   polarity 标记该指标「升 = 利好」（绿升红降）还是中性（只显示变化值）。
 */
import type { HandRecord } from "@/lib/types";
import { computeHeroHud, type HeroHud } from "@/lib/ai/hudStats";
import { isTournamentHand } from "@/components/history/labels";

export type GameFilter = "all" | "cash" | "tournament";

/** 时间范围：0 = 全部；其余为最近 N 手 */
export type RangeFilter = 0 | 50 | 100;

export const GAME_FILTER_LABEL: Record<GameFilter, string> = {
  all: "全部",
  cash: "仅现金局",
  tournament: "仅锦标赛",
};

export const RANGE_FILTER_LABEL: Record<RangeFilter, string> = {
  0: "全部手",
  50: "近 50 手",
  100: "近 100 手",
};

/**
 * 筛选手牌流：先按局型过滤，再按时间倒序截取最近 range 手（0 = 全部）。
 * 返回顺序为时间倒序（最新在前）。
 */
export function filterHands(
  hands: HandRecord[],
  game: GameFilter,
  range: RangeFilter,
): HandRecord[] {
  const desc = [...hands].sort((a, b) => b.timestamp - a.timestamp);
  const byGame =
    game === "all"
      ? desc
      : desc.filter((h) => isTournamentHand(h) === (game === "tournament"));
  return range > 0 ? byGame.slice(0, range) : byGame;
}

export interface SegmentCompare {
  /** 最近一段（更新） */
  recent: HeroHud;
  /** 之前一段（更早，紧邻 recent 之前） */
  previous: HeroHud;
  recentCount: number;
  previousCount: number;
  /** 每段手数（段大小） */
  segmentSize: number;
}

/**
 * 对比两段：recent = 最近 segmentSize 手，previous = 再之前 segmentSize 手。
 * 输入顺序不限；previous 段为空（样本 < segmentSize+1）时返回 null。
 */
export function compareSegments(
  hands: HandRecord[],
  segmentSize: number,
): SegmentCompare | null {
  const desc = [...hands].sort((a, b) => b.timestamp - a.timestamp);
  const recentHands = desc.slice(0, segmentSize);
  const previousHands = desc.slice(segmentSize, segmentSize * 2);
  if (recentHands.length === 0 || previousHands.length === 0) return null;
  return {
    recent: computeHeroHud(recentHands),
    previous: computeHeroHud(previousHands),
    recentCount: recentHands.length,
    previousCount: previousHands.length,
    segmentSize,
  };
}

/** buildMetricDeltas 只读的五项指标切片（便于测试构造夹具） */
export type HudMetricSlice = Pick<
  HeroHud,
  "vpip" | "pfr" | "af" | "wtsd" | "bbPer100"
>;

export type MetricKey = "vpip" | "pfr" | "af" | "wtsd" | "bb100";

export interface MetricDelta {
  key: MetricKey;
  label: string;
  /** 最近段的值（bbPer100 无样本时为 null） */
  recent: number | null;
  /** 之前段的值 */
  previous: number | null;
  /** recent − previous；任一端为 null 时为 null */
  delta: number | null;
  /** good-up = 上升视为利好（绿升红降）；neutral = 只显示数值变化（灰色） */
  polarity: "good-up" | "neutral";
  /** pct = 百分比指标（差值以百分点展示）；num = 数值指标 */
  format: "pct" | "num";
}

const METRIC_DEFS: {
  key: MetricKey;
  label: string;
  get: (h: HudMetricSlice) => number | null;
  polarity: "good-up" | "neutral";
  format: "pct" | "num";
}[] = [
  { key: "vpip", label: "VPIP 自愿入池率", get: (h) => h.vpip, polarity: "good-up", format: "pct" },
  { key: "pfr", label: "PFR 翻前加注率", get: (h) => h.pfr, polarity: "good-up", format: "pct" },
  { key: "af", label: "AF 翻后进攻系数", get: (h) => h.af, polarity: "good-up", format: "num" },
  { key: "wtsd", label: "WTSD 摊牌率", get: (h) => h.wtsd, polarity: "neutral", format: "pct" },
  { key: "bb100", label: "bb/100 每百手盈亏", get: (h) => h.bbPer100, polarity: "good-up", format: "num" },
];

/** 两段 HUD 的五项指标差值（recent − previous） */
export function buildMetricDeltas(
  recent: HudMetricSlice,
  previous: HudMetricSlice,
): MetricDelta[] {
  return METRIC_DEFS.map((d) => {
    const a = d.get(recent);
    const b = d.get(previous);
    return {
      key: d.key,
      label: d.label,
      recent: a,
      previous: b,
      delta: a === null || b === null ? null : a - b,
      polarity: d.polarity,
      format: d.format,
    };
  });
}
