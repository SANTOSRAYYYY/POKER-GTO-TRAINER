"use client";

import { useI18n } from "@/lib/i18n";

/** 训练模式共用的统计条（连对 / 正确率 / 错题数；各模式分开计数、各自实例化） */
export function TrainerStatsBar({
  streak,
  best,
  correctCount,
  total,
  wrongCount,
}: {
  streak: number;
  best: number;
  correctCount: number;
  total: number;
  wrongCount: number;
}) {
  const { t } = useI18n();
  const accuracy = total > 0 ? Math.round((correctCount / total) * 100) : null;
  return (
    <div className="mb-4 grid grid-cols-3 gap-2 text-center">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
        <div className="text-2xl font-bold text-emerald-400">{streak}</div>
        <div className="text-xs text-zinc-500">{t("trainer.stats.streak", { best })}</div>
      </div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
        <div className="text-2xl font-bold">
          {accuracy === null ? "—" : `${accuracy}%`}
        </div>
        <div className="text-xs text-zinc-500">
          {t("trainer.stats.accuracy", { correct: correctCount, total })}
        </div>
      </div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
        <div className="text-2xl font-bold text-red-400">{wrongCount}</div>
        <div className="text-xs text-zinc-500">{t("trainer.stats.wrong")}</div>
      </div>
    </div>
  );
}
