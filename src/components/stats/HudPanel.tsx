"use client";

import { useI18n } from "@/lib/i18n";
import type { HeroHud } from "@/lib/ai/hudStats";
import { BUCKET_BASELINE_VPIP } from "@/lib/ai/adapt";

const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

/** hero 打法四指标（VPIP/PFR/AF/WTSD）+ 翻前位置分桶 */
export function HudPanel({ hud }: { hud: HeroHud }) {
  const { t } = useI18n();
  const metrics = [
    { label: t("stats.metric.vpip"), value: pct(hud.vpip) },
    { label: t("stats.metric.pfr"), value: pct(hud.pfr) },
    { label: t("stats.metric.af"), value: hud.af.toFixed(2) },
    { label: t("stats.metric.wtsd"), value: pct(hud.wtsd) },
  ];
  const bucketRows = [
    {
      key: "early" as const,
      label: t("stats.hud.bucket.early"),
      hint: t("stats.hud.bucketHint.early"),
    },
    {
      key: "middle" as const,
      label: t("stats.hud.bucket.middle"),
      hint: t("stats.hud.bucketHint.middle"),
    },
    {
      key: "late" as const,
      label: t("stats.hud.bucket.late"),
      hint: t("stats.hud.bucketHint.late"),
    },
  ];
  return (
    <section className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="mb-3 font-semibold">{t("stats.hud.title")}</h2>
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {metrics.map((m) => (
          <div key={m.label} className="rounded-lg bg-zinc-950/60 p-3">
            <div className="text-xs text-zinc-500">{m.label}</div>
            <div className="mt-1 text-xl font-bold text-emerald-300">{m.value}</div>
          </div>
        ))}
      </div>

      <h3 className="mb-2 text-sm font-medium text-zinc-400">
        {t("stats.hud.bucketTitle")}{" "}
        <span className="text-xs text-zinc-600">{t("stats.hud.bucketNote")}</span>
      </h3>
      {/* 移动端允许表格收起 min-w（5 列挤进窄屏、单元格换行），
          不再强制横向滚动才能看到 PFR/基准列；桌面端维持 min-w-105 */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-105 text-sm max-md:min-w-0">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
              <th className="py-2 pr-3 font-medium">{t("stats.hud.th.bucket")}</th>
              <th className="py-2 pr-3 font-medium">{t("stats.th.hands")}</th>
              <th className="py-2 pr-3 font-medium">VPIP</th>
              <th className="py-2 pr-3 font-medium">PFR</th>
              <th className="py-2 font-medium">{t("stats.hud.th.vpipBaseline")}</th>
            </tr>
          </thead>
          <tbody>
            {bucketRows.map((row) => {
              const b = hud.buckets[row.key];
              return (
                <tr key={row.key} className="border-b border-zinc-800/60 last:border-0">
                  <td className="py-2 pr-3">
                    <span className="text-zinc-200">{row.label}</span>
                    <span className="ml-2 text-xs text-zinc-600">{row.hint}</span>
                  </td>
                  <td className="py-2 pr-3 text-zinc-300">{b.hands}</td>
                  <td className="py-2 pr-3 font-mono text-emerald-300">{pct(b.vpip)}</td>
                  <td className="py-2 pr-3 font-mono text-emerald-300">{pct(b.pfr)}</td>
                  <td className="py-2 text-xs text-zinc-500">
                    {pct(BUCKET_BASELINE_VPIP[row.key])}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
