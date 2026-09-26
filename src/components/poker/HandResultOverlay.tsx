"use client";

import { useEffect, useMemo } from "react";
import Link from "next/link";
import { handName } from "@/lib/poker/evaluator";
import { HERO_SEAT, useGameStore } from "@/lib/store/gameStore";
import { clearSession } from "@/lib/store/sessionPersistence";
import type { Card, Seat } from "@/lib/types";
import { useI18n } from "@/lib/i18n";

/**
 * 结算展示层（全非阻挡横幅，仅冠军结算保留 modal）：
 * - 普通结算：桌面中央偏上横幅（赢家/hero 盈亏/摊牌牌型/淘汰播报），挂载即预约
 *   5 秒后自动推进下一手（store.scheduleAutoAdvance），也可点「立即下一手」；
 * - hero 锦标赛归零且有剩余重购：横幅决策「重购继续 / 认输观战」（决策前不推进）；
 * - hero 现金局破产：横幅决策「重置买入 / 下桌观战」；
 * - hero 下桌观战（锦标赛淘汰/认输、现金局下桌）：自动快进，持续横幅
 *   「你已获得第 X 名 · 观战中」+ 暂停/继续 + 返回大厅（不再弹观战选择 modal）；
 * - 锦标赛冠军结算保留全屏 modal 不动；其「返回大厅」点击时清除对局存档
 *   （终局不可恢复，大厅不再显示「返回当前对战」）。
 */
export default function HandResultOverlay() {
  const { t, lang } = useI18n();
  const game = useGameStore((s) => s.game);
  const heroProfit = useGameStore((s) => s.heroProfit);
  const advanceToNextHand = useGameStore((s) => s.advanceToNextHand);
  const seatMap = useGameStore((s) => s.seatMap);
  const bustEvents = useGameStore((s) => s.bustEvents);
  const heroSpectating = useGameStore((s) => s.heroSpectating);
  const tournamentOver = useGameStore((s) => s.tournamentOver);
  const championSeat = useGameStore((s) => s.championSeat);
  const finishPlaces = useGameStore((s) => s.finishPlaces);
  const heroRebuyPrompt = useGameStore((s) => s.heroRebuyPrompt);
  const tableStacks = useGameStore((s) => s.tableStacks);
  const buyin = useGameStore((s) => s.buyin);
  const resolveRebuy = useGameStore((s) => s.resolveRebuy);
  const spectateCash = useGameStore((s) => s.spectateCash);
  const pendingHeroBust = useGameStore((s) => s.pendingHeroBust);
  const rebuysUsed = useGameStore((s) => s.rebuysUsed);
  const rebuysAllowed = useGameStore(
    (s) => s.tournamentConfig?.rebuysAllowed ?? 0,
  );
  const startStack = useGameStore((s) => s.tournamentConfig?.startStack ?? 0);
  const resolveTournamentRebuy = useGameStore((s) => s.resolveTournamentRebuy);
  const fastForward = useGameStore((s) => s.fastForward);
  const setFastForward = useGameStore((s) => s.setFastForward);
  const scheduleAutoAdvance = useGameStore((s) => s.scheduleAutoAdvance);
  const cancelAutoAdvance = useGameStore((s) => s.cancelAutoAdvance);

  const handOver = game?.handOver ?? false;
  const handNumber = game?.handNumber ?? 0;
  // 需要用户决策/观战的情形不自动推进（冠军 modal、重购决策、观战横幅）
  const interactive =
    tournamentOver || pendingHeroBust !== null || heroRebuyPrompt || heroSpectating;

  // 普通结算：横幅挂载期间预约自动推进；卸载/状态变化即取消（防泄漏防重复）
  useEffect(() => {
    if (!handOver || interactive) return;
    scheduleAutoAdvance();
    return () => cancelAutoAdvance();
  }, [handOver, handNumber, interactive, scheduleAutoAdvance, cancelAutoAdvance]);

  // 摊牌时所有未弃牌玩家的牌型名（评估失败时静默省略）
  const showdownNames = useMemo<Map<Seat, string> | null>(() => {
    if (!game || !game.handOver || !game.showdown || game.board.length < 3) {
      return null;
    }
    const names = new Map<Seat, string>();
    for (const p of game.players) {
      if (p.folded || !p.holeCards) continue;
      try {
        names.set(p.seat, handName([...p.holeCards, ...game.board] as Card[]));
      } catch {
        return null;
      }
    }
    return names;
  }, [game]);

  if (!game) return null;

  const seatName = (engineSeat: Seat): string => {
    const tableSeat = seatMap[engineSeat] ?? engineSeat;
    return engineSeat === HERO_SEAT && !heroSpectating ? t("common.you") : `AI ${tableSeat}`;
  };

  // ---- hero 下桌观战：持续非阻挡横幅（不只在 handOver 瞬间显示，避免快进闪屏）----
  if (heroSpectating && !tournamentOver) {
    const place = finishPlaces[HERO_SEAT];
    return (
      <div className="fixed inset-x-0 top-14 z-20 mx-auto flex w-fit items-center gap-3 rounded-full border border-neutral-700 bg-neutral-900/90 px-4 py-1.5 text-xs text-neutral-300 shadow-lg">
        <span>
          {place !== null
            ? t("result.spectatingPlace", { place })
            : t("result.spectating")}
        </span>
        <button
          type="button"
          onClick={() => setFastForward(!fastForward)}
          className="rounded bg-neutral-700 px-2 py-0.5 font-semibold text-neutral-100 hover:bg-neutral-600"
        >
          {fastForward ? t("result.pause") : t("result.resume")}
        </button>
        <Link
          href="/"
          className="rounded bg-neutral-700 px-2 py-0.5 font-semibold text-neutral-100 hover:bg-neutral-600"
        >
          {t("result.backToLobby")}
        </Link>
      </div>
    );
  }

  if (!handOver) return null;

  // ---- 锦标赛 hero 归零且有剩余重购：非阻挡横幅决策（决策前不推进）----
  if (pendingHeroBust) {
    const rebuysLeft = Math.max(0, rebuysAllowed - (rebuysUsed[HERO_SEAT] ?? 0));
    return (
      <div className="pointer-events-none fixed inset-x-0 top-16 z-20 flex justify-center px-4">
        <div className="pointer-events-auto flex w-full max-w-md flex-col items-center gap-2 rounded-xl border border-amber-600/50 bg-neutral-900/95 px-5 py-3 shadow-2xl">
          <div className="text-sm font-semibold text-neutral-100">
            {t("result.bustRebuyLeft", { n: rebuysLeft })}
          </div>
          <p className="text-[11px] text-neutral-400">
            {t("result.concedeNote", { place: pendingHeroBust.place })}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void resolveTournamentRebuy(true)}
              className="rounded-lg bg-amber-500 px-4 py-1.5 text-xs font-bold text-neutral-950 transition hover:bg-amber-400"
            >
              {t("result.rebuyContinue", { n: startStack })}
            </button>
            <button
              type="button"
              onClick={() => void resolveTournamentRebuy(false)}
              className="rounded-lg bg-neutral-700 px-4 py-1.5 text-xs font-bold text-neutral-100 transition hover:bg-neutral-600"
            >
              {t("result.concedeSpectate")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- 现金局 hero 破产：非阻挡横幅决策（决策前不推进）----
  if (heroRebuyPrompt) {
    const stack = tableStacks[HERO_SEAT] ?? 0;
    return (
      <div className="pointer-events-none fixed inset-x-0 top-16 z-20 flex justify-center px-4">
        <div className="pointer-events-auto flex w-full max-w-md flex-col items-center gap-2 rounded-xl border border-amber-600/50 bg-neutral-900/95 px-5 py-3 shadow-2xl">
          <div className="text-sm font-semibold text-neutral-100">
            {stack <= 0 ? t("result.busted") : t("result.belowBb", { n: stack })}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void resolveRebuy(true)}
              className="rounded-lg bg-amber-500 px-4 py-1.5 text-xs font-bold text-neutral-950 transition hover:bg-amber-400"
            >
              {t("result.resetBuyin", { n: buyin })}
            </button>
            <button
              type="button"
              onClick={() => void spectateCash()}
              className="rounded-lg bg-neutral-700 px-4 py-1.5 text-xs font-bold text-neutral-100 transition hover:bg-neutral-600"
            >
              {t("result.leaveSpectate")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const winners = game.winners ?? [];
  const profit = heroProfit ?? 0;

  // ---- 锦标赛冠军结算：保留全屏 modal ----
  if (tournamentOver) {
    return (
      <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div className="flex max-h-[85vh] w-96 flex-col items-center gap-3 overflow-y-auto rounded-2xl border border-amber-500/60 bg-neutral-900 p-6 shadow-2xl">
          <div className="text-2xl font-black tracking-wide text-neutral-100">
            {championSeat === HERO_SEAT
              ? t("result.youAreChampion")
              : t("result.tournamentOver")}
          </div>

          {winners.length > 0 && (
            <div className="text-sm text-neutral-300">
              {t("result.winnersLabel")}
              <span className="font-semibold text-amber-300">
                {winners.map(seatName).join(lang === "zh" ? "、" : ", ")}
              </span>
            </div>
          )}

          {showdownNames && showdownNames.size > 0 && (
            <div className="flex w-full flex-col gap-1 rounded-lg bg-black/30 p-3 text-sm">
              {[...showdownNames.entries()].map(([seat, name]) => (
                <div key={seat} className="flex justify-between">
                  <span className="text-neutral-400">{seatName(seat)}</span>
                  <span className="font-semibold text-neutral-100">{name}</span>
                </div>
              ))}
            </div>
          )}

          {bustEvents.length > 0 && (
            <div className="flex w-full flex-col gap-1 rounded-lg bg-black/30 p-3 text-sm">
              {bustEvents.map((b) => (
                <div key={b.seat} className="text-rose-200">
                  {t("result.bustPlace", {
                    name: b.seat === HERO_SEAT ? t("common.you") : `AI ${b.seat}`,
                    place: b.place,
                  })}
                </div>
              ))}
            </div>
          )}

          <div className="flex w-full flex-col items-center gap-2 rounded-lg bg-amber-500/10 p-4 text-center">
            <div className="text-lg font-bold text-amber-300">
              {t("result.championIs", {
                name:
                  championSeat === HERO_SEAT
                    ? t("common.you")
                    : `AI ${championSeat ?? "?"}`,
              })}
            </div>
            {finishPlaces[HERO_SEAT] !== null && (
              <div className="text-sm text-neutral-300">
                {t("result.yourFinalPlace", { place: finishPlaces[HERO_SEAT] ?? "?" })}
              </div>
            )}
            <Link
              href="/"
              onClick={() => clearSession()}
              className="mt-1 w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-bold text-white transition hover:bg-emerald-500"
            >
              {t("result.backToLobby")}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // ---- 普通结算：非阻挡横幅（不遮桌面，摊牌牌面保持可见），5 秒后自动下一手 ----
  const tone =
    profit === 0
      ? "border-neutral-600 bg-neutral-900/95"
      : profit > 0
        ? "border-emerald-500/60 bg-emerald-950/90"
        : "border-rose-600/60 bg-rose-950/90";
  return (
    <div className="pointer-events-none fixed inset-x-0 top-16 z-20 flex justify-center px-4">
      <div
        className={`pointer-events-auto flex w-full max-w-md flex-col items-center gap-1.5 rounded-xl border px-5 py-3 shadow-2xl ${tone}`}
      >
        <div className="flex items-baseline gap-3 text-sm text-neutral-300">
          {winners.length > 0 && (
            <span>
              {t("result.winnersLabel")}
              <span className="font-semibold text-amber-300">
                {winners.map(seatName).join(lang === "zh" ? "、" : ", ")}
              </span>
            </span>
          )}
          <span
            className={`text-xl font-black tabular-nums ${
              profit > 0
                ? "text-emerald-400"
                : profit < 0
                  ? "text-rose-400"
                  : "text-neutral-300"
            }`}
          >
            {profit > 0 ? `+${profit}` : profit}
          </span>
        </div>

        {showdownNames && showdownNames.size > 0 && (
          <div className="flex w-full flex-col gap-0.5 text-xs">
            {[...showdownNames.entries()].map(([seat, name]) => (
              <div key={seat} className="flex justify-between">
                <span className="text-neutral-400">{seatName(seat)}</span>
                <span className="font-semibold text-neutral-100">{name}</span>
              </div>
            ))}
          </div>
        )}
        {!game.showdown && winners.length > 0 && (
          <p className="text-[11px] text-neutral-400">{t("result.noShowdown")}</p>
        )}

        {/* 淘汰播报并入横幅一行 */}
        {bustEvents.length > 0 && (
          <div className="text-xs text-rose-200">
            {bustEvents
              .map((b) =>
                t("result.bustPlace", {
                  name: b.seat === HERO_SEAT ? t("common.you") : `AI ${b.seat}`,
                  place: b.place,
                }),
              )
              .join(lang === "zh" ? "，" : ", ")}
          </div>
        )}

        <button
          type="button"
          onClick={() => void advanceToNextHand()}
          className="mt-0.5 text-xs font-semibold text-amber-300 underline underline-offset-2 transition hover:text-amber-200"
        >
          {t("action.nextHand")}
        </button>
      </div>
    </div>
  );
}
