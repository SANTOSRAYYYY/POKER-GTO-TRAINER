"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { useAchievements, type Achievement } from "@/lib/store/achievements";
import { useHistoryStore } from "@/lib/store/historyStore";

/** 单条 toast：金色徽章，3 秒自动消失 */
function ToastItem({ achievement }: { achievement: Achievement }) {
  const { t } = useI18n();
  const dismiss = useAchievements((s) => s.dismissToast);
  useEffect(() => {
    const timer = setTimeout(() => dismiss(achievement.id), 3000);
    return () => clearTimeout(timer);
  }, [achievement.id, dismiss]);

  return (
    <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-amber-400/60 bg-gradient-to-r from-amber-950/95 to-zinc-900/95 p-3 shadow-lg shadow-amber-500/10">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-300 to-amber-600 text-lg font-bold text-amber-950">
        ★
      </span>
      <div className="min-w-0">
        <div className="text-xs font-medium text-amber-400">{t("achieve.toastTitle")}</div>
        <div className="truncate text-sm font-bold text-amber-200">
          {t(achievement.nameKey)}
        </div>
        <div className="truncate text-xs text-zinc-400">
          {t(achievement.descKey)}
        </div>
      </div>
    </div>
  );
}

/**
 * 成就 toast 挂载点：读取 useAchievements 的 pending 队列，
 * 右上角堆叠展示新解锁成就（每条 3 秒自动消失）。
 * 移动端（max-md）：w-80 会盖住导航与页面标题，改为底部左右留白横条
 * （toast 仅在 /stats 与 /history 触发，两页均无底部吸附栏，不遮操作）。
 */
export function AchievementToastHost() {
  const pending = useAchievements((s) => s.pending);
  if (pending.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 top-16 z-50 flex w-80 flex-col gap-2 max-md:inset-x-4 max-md:bottom-4 max-md:top-auto max-md:w-auto">
      {pending.map((a) => (
        <ToastItem key={a.id} achievement={a} />
      ))}
    </div>
  );
}

/**
 * 成就自动检查：在 /stats 与 /history 页加载时读取全部历史手牌，
 * 与已解锁集合 diff，新解锁的成就进入 pending 队列触发 toast。
 */
export function useAchievementAutoCheck() {
  const pathname = usePathname();
  const checkNow = useAchievements((s) => s.checkNow);
  useEffect(() => {
    if (!pathname.startsWith("/stats") && !pathname.startsWith("/history")) {
      return;
    }
    let cancelled = false;
    useHistoryStore
      .getState()
      .listHands()
      .then((hands) => {
        if (!cancelled) checkNow(hands);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pathname, checkNow]);
}
