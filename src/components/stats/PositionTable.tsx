"use client";

import { useI18n } from "@/lib/i18n";
import type { PositionRow } from "@/lib/ai/hudStats";

/** 位置短名的双语标注（键与 ai/positions 的 POSITION_SHORT_NAMES 一致） */
export const POS_LABEL: Record<string, { zh: string; en: string }> = {
  BTN: { zh: "按钮位", en: "Button" },
  CO: { zh: "关煞位", en: "Cutoff" },
  HJ: { zh: "劫持位", en: "Hijack" },
  LJ: { zh: "洛杰克", en: "Lojack" },
  UTG: { zh: "枪口位", en: "Under the gun" },
  "UTG+1": { zh: "枪口+1", en: "UTG+1" },
  "UTG+2": { zh: "枪口+2", en: "UTG+2" },
  SB: { zh: "小盲", en: "Small blind" },
  BB: { zh: "大盲", en: "Big blind" },
  "CO/UTG": { zh: "关煞/枪口", en: "Cutoff / UTG" },
  "BTN/SB": { zh: "按钮/小盲", en: "Button / Small blind" },
};

function Profit({ value }: { value: number }) {
  return (
    <span
      className={`font-mono font-semibold ${
        value > 0 ? "text-emerald-400" : value < 0 ? "text-red-400" : "text-zinc-500"
      }`}
    >
      {value >= 0 ? "+" : ""}
      {value}
    </span>
  );
}

/** 按位置（BTN/CO/.../BB）的表现表：手数 / 盈亏 / 胜率 */
export function PositionTable({ rows }: { rows: PositionRow[] }) {
  const { t, lang } = useI18n();
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="mb-3 font-semibold">{t("stats.pos.title")}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-600">{t("stats.pos.empty")}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
              <th className="py-2 pr-3 font-medium">{t("stats.pos.th.position")}</th>
              <th className="py-2 pr-3 font-medium">{t("stats.th.hands")}</th>
              <th className="py-2 pr-3 font-medium">{t("stats.th.profit")}</th>
              <th className="py-2 font-medium">{t("stats.th.winRate")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.position} className="border-b border-zinc-800/60 last:border-0">
                <td className="py-2 pr-3">
                  <span className="font-medium text-zinc-200">{r.position}</span>
                  {POS_LABEL[r.position] && (
                    <span className="ml-2 text-xs text-zinc-500">{POS_LABEL[r.position][lang]}</span>
                  )}
                </td>
                <td className="py-2 pr-3 text-zinc-300">{r.hands}</td>
                <td className="py-2 pr-3">
                  <Profit value={r.profit} />
                </td>
                <td className="py-2 text-zinc-300">{(r.winRate * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
