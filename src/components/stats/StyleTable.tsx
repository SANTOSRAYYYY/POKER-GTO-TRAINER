"use client";

import { useI18n } from "@/lib/i18n";
import type { StyleRow } from "@/lib/ai/hudStats";
import { styleName } from "@/components/history/labels";

/** 按对手 AI 风格的表现表：对战手数 / 盈亏 / 胜率 */
export function StyleTable({ rows }: { rows: StyleRow[] }) {
  const { t, lang } = useI18n();
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="mb-3 font-semibold">{t("stats.style.title")}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-600">{t("stats.style.empty")}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
              <th className="py-2 pr-3 font-medium">{t("stats.style.th.style")}</th>
              <th className="py-2 pr-3 font-medium">{t("stats.th.hands")}</th>
              <th className="py-2 pr-3 font-medium">{t("stats.th.profit")}</th>
              <th className="py-2 font-medium">{t("stats.th.winRate")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.style} className="border-b border-zinc-800/60 last:border-0">
                <td className="py-2 pr-3">
                  <span className="rounded bg-emerald-900/40 px-1.5 py-0.5 text-xs text-emerald-300">
                    {styleName(r.style, lang)}
                  </span>
                </td>
                <td className="py-2 pr-3 text-zinc-300">{r.hands}</td>
                <td className="py-2 pr-3">
                  <span
                    className={`font-mono font-semibold ${
                      r.profit > 0
                        ? "text-emerald-400"
                        : r.profit < 0
                          ? "text-red-400"
                          : "text-zinc-500"
                    }`}
                  >
                    {r.profit >= 0 ? "+" : ""}
                    {r.profit}
                  </span>
                </td>
                <td className="py-2 text-zinc-300">{(r.winRate * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-3 text-xs text-zinc-600">
        {t("stats.style.note")}
      </p>
    </section>
  );
}
