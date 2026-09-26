"use client";

import { useEffect, useState } from "react";
import { useGameStore } from "@/lib/store/gameStore";
import { useI18n } from "@/lib/i18n";

const BANNER_MS = 2000;

/**
 * 升盲横幅：finalizeHand 触发 levelUpEvent 时播出，2 秒滑入淡出。
 * 事件在下一手开牌时由 store 清除。
 */
export default function LevelUpBanner() {
  const { t } = useI18n();
  const levelUpEvent = useGameStore((s) => s.levelUpEvent);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!levelUpEvent) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), BANNER_MS);
    return () => clearTimeout(timer);
  }, [levelUpEvent]);

  if (!levelUpEvent) return null;

  const { blinds } = levelUpEvent;
  return (
    <div
      className={`pointer-events-none fixed inset-x-0 top-24 z-30 flex justify-center transition-all duration-300 ${
        visible ? "translate-y-0 opacity-100" : "-translate-y-4 opacity-0"
      }`}
    >
      <div className="rounded-2xl border border-amber-400/70 bg-amber-500/95 px-8 py-4 text-center shadow-2xl">
        <div className="text-lg font-black tracking-widest text-neutral-950">
          {t("tour.levelUp")}
        </div>
        <div className="mt-0.5 text-2xl font-black tabular-nums text-neutral-950">
          {blinds.smallBlind}/{blinds.bigBlind}
          {blinds.ante > 0 && (
            <span className="ml-2 text-base font-bold">(ante {blinds.ante})</span>
          )}
        </div>
      </div>
    </div>
  );
}
