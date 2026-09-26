"use client";

import { useI18n } from "@/lib/i18n";
import type { DictKey } from "@/lib/i18n/dict";
import {
  buildMetricDeltas,
  type MetricDelta,
  type MetricKey,
  type SegmentCompare,
} from "./filterCompare";

const METRIC_LABEL_KEY: Record<MetricKey, DictKey> = {
  vpip: "stats.metric.vpip",
  pfr: "stats.metric.pfr",
  af: "stats.metric.af",
  wtsd: "stats.metric.wtsd",
  bb100: "stats.metric.bb100",
};

function fmtValue(d: MetricDelta, v: number | null): string {
  if (v === null) return "—";
  if (d.format === "pct") return `${(v * 100).toFixed(1)}%`;
  if (d.key === "bb100") return `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
  return v.toFixed(2);
}

function fmtDelta(d: MetricDelta): string {
  if (d.delta === null) return "—";
  const sign = d.delta >= 0 ? "+" : "";
  if (d.format === "pct") return `${sign}${(d.delta * 100).toFixed(1)}pt`;
  return `${sign}${d.delta.toFixed(2)}`;
}

/** 变化箭头与配色：good-up 绿升红降；中性指标只显示数值变化（灰） */
function DeltaCell({ d }: { d: MetricDelta }) {
  if (d.delta === null || Math.abs(d.delta) < 1e-9) {
    return <span className="text-zinc-500">—</span>;
  }
  const up = d.delta > 0;
  const arrow = up ? "↑" : "↓";
  const color =
    d.polarity === "neutral"
      ? "text-zinc-400"
      : up
        ? "text-emerald-400"
        : "text-red-400";
  return (
    <span className={`font-mono font-semibold ${color}`}>
      {arrow} {fmtDelta(d)}
    </span>
  );
}

/** 两段对比面板：之前 N 手 → 最近 N 手，五项打法指标变化 */
export function ComparePanel({ compare }: { compare: SegmentCompare }) {
  const { t } = useI18n();
  const deltas = buildMetricDeltas(compare.recent, compare.previous);
  const n = compare.segmentSize;
  return (
    <section className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3">
        <h2 className="font-semibold">{t("stats.compare.title")}</h2>
        <span className="text-xs text-zinc-500">
          {t("stats.compare.summary", {
            recent: compare.recentCount,
            previous: compare.previousCount,
          })}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-105 text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
              <th className="py-2 pr-3 font-medium">{t("stats.compare.metric")}</th>
              <th className="py-2 pr-3 font-medium">{t("stats.compare.previous", { n })}</th>
              <th className="py-2 pr-3 font-medium">{t("stats.compare.recent", { n })}</th>
              <th className="py-2 font-medium">{t("stats.compare.delta")}</th>
            </tr>
          </thead>
          <tbody>
            {deltas.map((d) => (
              <tr key={d.key} className="border-b border-zinc-800/60 last:border-0">
                <td className="py-2 pr-3 text-zinc-300">{t(METRIC_LABEL_KEY[d.key])}</td>
                <td className="py-2 pr-3 font-mono text-zinc-400">
                  {fmtValue(d, d.previous)}
                </td>
                <td className="py-2 pr-3 font-mono text-zinc-200">
                  {fmtValue(d, d.recent)}
                </td>
                <td className="py-2">
                  <DeltaCell d={d} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
