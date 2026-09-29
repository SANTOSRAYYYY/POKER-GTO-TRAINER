"use client";

import { useEffect } from "react";
import { useI18n } from "@/lib/i18n";
import { ACHIEVEMENTS, useAchievements } from "@/lib/store/achievements";

function fmtDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 成就展示卡：已解锁金色亮色（含解锁日期），未解锁灰色 */
export function AchievementsPanel() {
  const { t } = useI18n();
  const unlocked = useAchievements((s) => s.unlocked);
  const loaded = useAchievements((s) => s.loaded);
  const load = useAchievements((s) => s.load);

  useEffect(() => {
    if (!loaded) load();
  }, [loaded, load]);

  const unlockedCount = ACHIEVEMENTS.filter((a) => unlocked[a.id] !== undefined).length;

  return (
    <section className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="font-semibold">{t("achieve.title")}</h2>
        <span className="text-xs text-zinc-500">
          {t("achieve.unlockedCount", { done: unlockedCount, total: ACHIEVEMENTS.length })}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {ACHIEVEMENTS.map((a) => {
          const at = unlocked[a.id];
          const isUnlocked = at !== undefined;
          return (
            <div
              key={a.id}
              className={`rounded-lg border p-3 ${
                isUnlocked
                  ? "border-amber-400/50 bg-amber-950/20"
                  : "border-zinc-800 bg-zinc-950/40"
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                    isUnlocked
                      ? "bg-gradient-to-br from-amber-300 to-amber-600 text-amber-950"
                      : "bg-zinc-800 text-zinc-600"
                  }`}
                >
                  ★
                </span>
                <span
                  className={`text-sm font-semibold ${
                    isUnlocked ? "text-amber-200" : "text-zinc-500"
                  }`}
                >
                  {t(a.nameKey)}
                </span>
              </div>
              <p
                className={`mt-1.5 text-xs leading-relaxed ${
                  isUnlocked ? "text-zinc-400" : "text-zinc-600"
                }`}
              >
                {t(a.descKey)}
              </p>
              {isUnlocked && (
                <p className="mt-1 text-[11px] text-amber-500/80">
                  {t("achieve.unlockedAt", { date: fmtDate(at) })}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
