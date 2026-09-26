"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Nav } from "@/components/history/Nav";
import { handStyles, isTournamentHand, STYLE_NAME } from "@/components/history/labels";
import { useI18n } from "@/lib/i18n";
import type { DictKey } from "@/lib/i18n/dict";
import { useHistoryStore } from "@/lib/store/historyStore";
import type { HandRecord } from "@/lib/types";

type TFunc = (key: DictKey, vars?: Record<string, string | number>) => string;

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 手牌摘要：hero 底牌 vs 已公开的对手底牌（多人时列出全部摊牌者） */
function handSummary(h: HandRecord, t: TFunc): string {
  const hero = h.players.find((p) => p.isHero);
  const heroCards = hero?.cards?.join(" ") ?? "??";
  const shown = h.players
    .filter((p) => !p.isHero && p.cards && p.cards.length > 0)
    .map((p) => p.cards!.join(" "));
  return shown.length > 0
    ? `${heroCards} vs ${shown.join(" / ")}`
    : `${heroCards} vs ${t("history.unrevealed")}`;
}

export default function HistoryPage() {
  const { t } = useI18n();
  const { hands, loaded, loadAll, deleteHand, clearAll, stats } = useHistoryStore();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadAll().catch(() => {});
  }, [loadAll]);

  const s = stats();

  const onDelete = async (id: string) => {
    if (!window.confirm(t("history.confirmDelete"))) return;
    setBusy(true);
    try {
      await deleteHand(id);
    } finally {
      setBusy(false);
    }
  };

  const onClear = async () => {
    if (!window.confirm(t("history.confirmClear"))) return;
    setBusy(true);
    try {
      await clearAll();
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <Nav />
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-5 flex items-center justify-between">
          <h1 className="text-2xl font-bold">{t("history.title")}</h1>
          <div className="flex items-center gap-2">
            <Link
              href="/stats"
              className="rounded-lg border border-emerald-900 px-3 py-1.5 text-sm text-emerald-400 transition-colors hover:bg-emerald-950/50"
            >
              {t("history.statsCenter")}
            </Link>
            {hands.length > 0 && (
              <button
                onClick={onClear}
                disabled={busy}
                className="rounded-lg border border-red-900 px-3 py-1.5 text-sm text-red-400 transition-colors hover:bg-red-950/50 disabled:opacity-50"
              >
                {t("history.clearAll")}
              </button>
            )}
          </div>
        </div>

        {/* 统计卡片 */}
        <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label={t("history.totalHands")} value={String(s.totalHands)} />
          <StatCard
            label={t("history.totalProfit")}
            value={`${s.totalProfit >= 0 ? "+" : ""}${s.totalProfit}`}
            valueClass={s.totalProfit >= 0 ? "text-emerald-400" : "text-red-400"}
          />
          <StatCard label={t("history.winRate")} value={`${(s.winRate * 100).toFixed(1)}%`} />
          <StatCard label={t("history.showdownRate")} value={`${(s.showdownRate * 100).toFixed(1)}%`} />
        </section>

        {!loaded ? (
          <p className="py-16 text-center text-zinc-500">{t("common.loading")}</p>
        ) : hands.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 py-16 text-center">
            <p className="text-zinc-500">{t("history.empty")}</p>
            <Link href="/" className="mt-2 inline-block text-sm text-emerald-400 hover:underline">
              {t("history.emptyCta")}
            </Link>
          </div>
        ) : (
          <ul className="space-y-2">
            {hands.map((h) => (
              <li key={h.id}>
                <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3">
                  <Link href={`/history/${h.id}`} className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-sm text-zinc-400">{formatTime(h.timestamp)}</span>
                    <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">
                      {t("history.seatsBadge", { n: h.players.length })}
                      {isTournamentHand(h)
                        ? ` · ${t("history.modeTournament")}`
                        : ` · ${t("history.modeCash")}`}
                    </span>
                    {handStyles(h).map((st) => (
                      <span
                        key={st}
                        className="rounded bg-emerald-900/40 px-1.5 py-0.5 text-[11px] text-emerald-300"
                      >
                        {STYLE_NAME[st]}
                      </span>
                    ))}
                    <span className="font-mono text-sm text-zinc-200">{handSummary(h, t)}</span>
                    {h.showdown && (
                      <span className="rounded bg-sky-900/40 px-2 py-0.5 text-xs text-sky-300">
                        {t("street.showdown")}
                      </span>
                    )}
                    <span
                      className={`text-sm font-semibold ${
                        h.result === "win" ? "text-emerald-400" : h.result === "lose" ? "text-red-400" : "text-zinc-400"
                      }`}
                    >
                      {h.result === "win"
                        ? t("history.win")
                        : h.result === "lose"
                          ? t("history.lose")
                          : t("history.tie")}{" "}
                      {h.profit >= 0 ? "+" : ""}
                      {h.profit}
                    </span>
                  </Link>
                  <button
                    onClick={() => void onDelete(h.id)}
                    disabled={busy}
                    className="rounded px-2 py-1 text-xs text-zinc-500 transition-colors hover:bg-red-950/50 hover:text-red-400 disabled:opacity-50"
                  >
                    {t("common.delete")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function StatCard({ label, value, valueClass = "text-zinc-100" }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${valueClass}`}>{value}</div>
    </div>
  );
}
