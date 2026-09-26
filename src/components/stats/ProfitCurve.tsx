"use client";

import { useI18n } from "@/lib/i18n";
import type { CurvePoint } from "@/lib/ai/hudStats";

const W = 640;
const H = 260;
const PAD_L = 64;
const PAD_R = 16;
const PAD_T = 16;
const PAD_B = 32;

function fmtSigned(n: number): string {
  return `${n >= 0 ? "+" : ""}${n}`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 累计盈亏折线（手写 SVG，无图表库依赖）：
 * 横轴按手序等距（标签显示首尾时间），纵轴为累计盈亏，
 * 含横向网格线、数值标签与高亮的盈亏零点线。
 */
export function ProfitCurve({ points }: { points: CurvePoint[] }) {
  const { t } = useI18n();
  if (points.length === 0) return null;

  const values = points.map((p) => p.cumulative);
  const minV = Math.min(0, ...values);
  const maxV = Math.max(0, ...values);
  const span = maxV - minV || 1;
  const x = (i: number) =>
    PAD_L + (i / Math.max(1, points.length - 1)) * (W - PAD_L - PAD_R);
  const y = (v: number) => PAD_T + (1 - (v - minV) / span) * (H - PAD_T - PAD_B);

  const ticks = Array.from({ length: 5 }, (_, i) => minV + (span * i) / 4);
  const showZero = minV < 0 && maxV > 0;
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.cumulative).toFixed(1)}`)
    .join(" ");
  const final = points[points.length - 1].cumulative;
  const lineColor = final >= 0 ? "#34d399" : "#f87171";
  const last = points[points.length - 1];

  return (
    <section className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">{t("stats.curve.title")}</h2>
        <span className="text-xs text-zinc-500">
          {t("stats.curve.range", { n: points.length })} ·{" "}
          <span className={final >= 0 ? "text-emerald-400" : "text-red-400"}>
            {fmtSigned(final)}
          </span>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-64 w-full" role="img" aria-label={t("stats.curve.aria")}>
        {/* 横向网格线与数值标签 */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={y(t)}
              y2={y(t)}
              stroke="#27272a"
              strokeWidth={1}
            />
            <text x={PAD_L - 8} y={y(t) + 3} textAnchor="end" fontSize={10} fill="#71717a">
              {fmtSigned(Math.round(t))}
            </text>
          </g>
        ))}
        {/* 盈亏零点线 */}
        {showZero && (
          <line
            x1={PAD_L}
            x2={W - PAD_R}
            y1={y(0)}
            y2={y(0)}
            stroke="#a1a1aa"
            strokeWidth={1}
            strokeDasharray="5 4"
          />
        )}
        {/* 折线 */}
        {points.length === 1 ? (
          <circle cx={x(0)} cy={y(points[0].cumulative)} r={4} fill={lineColor} />
        ) : (
          <path d={path} fill="none" stroke={lineColor} strokeWidth={2} strokeLinejoin="round" />
        )}
        {points.length > 1 && (
          <circle cx={x(points.length - 1)} cy={y(last.cumulative)} r={3.5} fill={lineColor} />
        )}
        {/* 横轴首尾时间标签 */}
        <text x={PAD_L} y={H - 8} textAnchor="start" fontSize={10} fill="#71717a">
          {fmtTime(points[0].timestamp)}
        </text>
        <text x={W - PAD_R} y={H - 8} textAnchor="end" fontSize={10} fill="#71717a">
          {fmtTime(last.timestamp)}
        </text>
      </svg>
    </section>
  );
}
