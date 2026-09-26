"use client";

import { useEffect, useMemo, useState } from "react";
import { legalActions } from "@/lib/poker/game";
import { callDisplayInfo } from "@/lib/poker/callDisplay";
import { HERO_SEAT, useGameStore } from "@/lib/store/gameStore";
import type { PlayerAction } from "@/lib/types";
import { useI18n } from "@/lib/i18n";

type SizingMode = "bet" | "raise" | null;

/**
 * 行动按钮栏：
 * - fold / check / call（显示金额）为直接按钮；
 * - bet / raise 选中后展开滑杆与快捷尺度（1/2 池、3/4 池、全下）；
 * - 不在回合或 AI 思考中全部禁用；非法动作不渲染。
 */
export default function ActionBar() {
  const { t } = useI18n();
  const game = useGameStore((s) => s.game);
  const aiThinking = useGameStore((s) => s.aiThinking);
  const heroSpectating = useGameStore((s) => s.heroSpectating);
  const act = useGameStore((s) => s.act);
  const preAction = useGameStore((s) => s.preAction);
  const setPreAction = useGameStore((s) => s.setPreAction);

  const heroTurn =
    !!game && !game.handOver && game.currentSeat === HERO_SEAT && !aiThinking;

  const legal = useMemo<PlayerAction[]>(() => {
    if (!game || game.handOver || game.currentSeat !== HERO_SEAT) return [];
    try {
      return legalActions(game);
    } catch {
      // 引擎未就绪时不渲染动作（集成后由 legalActions 提供真实值）
      return [];
    }
  }, [game]);

  const hero = game?.players[HERO_SEAT];
  const has = (t: PlayerAction["type"]) => legal.some((a) => a.type === t);
  const minOf = (t: PlayerAction["type"]) =>
    legal.find((a) => a.type === t)?.amount ?? 0;

  // 跟注额必须取引擎 legalActions 的 call.amount：短码时引擎已截断为全部
  // 剩余筹码（all-in 跟注）；自行用 currentBet - streetBet 会超出 stack，
  // applyAction 将拒绝该动作（用户无法跟注的 bug 根因）。
  const callInfo = useMemo(
    () => (game ? callDisplayInfo(game, HERO_SEAT) : null),
    [game],
  );
  const callAmount = callInfo?.amount ?? 0;
  const maxBetTo = hero ? hero.streetBet + hero.stack : 0;
  const canBet = has("bet");
  const canRaise = has("raise");
  const sizingType: SizingMode = canRaise ? "raise" : canBet ? "bet" : null;
  const minSizing = sizingType ? minOf(sizingType) : 0;

  const [mode, setMode] = useState<SizingMode>(null);
  const [amount, setAmount] = useState(0);

  // 街道/下注额变化时收起滑杆并复位金额
  useEffect(() => {
    setMode(null);
    setAmount(minSizing);
  }, [game?.street, game?.currentBet, game?.handNumber, minSizing]);

  if (!game || !hero) return null;
  // hero 观战（锦标赛淘汰）时没有行动权，隐藏行动栏
  if (heroSpectating) return null;

  const clamp = (v: number) => Math.min(maxBetTo, Math.max(minSizing, v));

  /** 快捷尺度：bet 按底池比例；raise 按「跟注后底池」比例加到 currentBet 之上 */
  const quickAmount = (frac: number) => {
    if (mode === "raise") {
      const potAfterCall = game.pot + callAmount;
      return clamp(game.currentBet + Math.round(potAfterCall * frac));
    }
    return clamp(Math.round(game.pot * frac));
  };

  const commitSizing = () => {
    if (!mode) return;
    const a = clamp(amount);
    // 金额即全下额时优先使用 allin 动作类型（与引擎动作区分约定一致）
    if (a >= maxBetTo && has("allin")) {
      void act({ type: "allin", amount: maxBetTo });
    } else {
      void act({ type: mode, amount: a });
    }
  };

  const btnBase =
    "min-h-11 rounded-lg px-5 py-2.5 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-35 md:min-h-0";

  return (
    <div className="sticky bottom-0 z-10 border-t border-neutral-800 bg-neutral-950/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
        {mode && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl bg-neutral-900 p-3">
            <span className="text-sm font-semibold text-neutral-200">
              {mode === "bet" ? t("action.betTo") : t("action.raiseTo")}
              <span className="ml-2 text-lg tabular-nums text-amber-300">
                {amount}
              </span>
            </span>
            <input
              id="poker-bet-slider"
              type="range"
              min={minSizing}
              max={maxBetTo}
              step={1}
              value={amount}
              disabled={!heroTurn}
              onChange={(e) => setAmount(Number(e.target.value))}
              className="min-w-40 flex-1 accent-amber-400 max-md:min-w-full"
              aria-label={t("action.betAmount")}
            />
            {([["action.halfPot", 0.5], ["action.threeQuarterPot", 0.75]] as const).map(([key, f]) => (
              <button
                key={key}
                type="button"
                disabled={!heroTurn}
                onClick={() => setAmount(quickAmount(f))}
                className="min-h-11 rounded-md bg-neutral-800 px-3 py-1.5 text-xs font-semibold text-neutral-200 hover:bg-neutral-700 disabled:opacity-35 md:min-h-0"
              >
                {t(key)}
              </button>
            ))}
            <button
              type="button"
              disabled={!heroTurn}
              onClick={() => setAmount(maxBetTo)}
              className="min-h-11 rounded-md bg-rose-900/70 px-3 py-1.5 text-xs font-semibold text-rose-100 hover:bg-rose-800 disabled:opacity-35 md:min-h-0"
            >
              {t("action.allin")}
            </button>
            <button
              id="poker-bet-confirm"
              type="button"
              disabled={!heroTurn}
              onClick={commitSizing}
              className="min-h-11 rounded-lg bg-amber-500 px-4 py-1.5 text-sm font-bold text-neutral-950 hover:bg-amber-400 disabled:opacity-35 md:min-h-0"
            >
              {t("action.confirmBet")}
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-center gap-3 max-md:gap-2">
          {has("fold") && (
            <button
              type="button"
              disabled={!heroTurn}
              onClick={() => void act({ type: "fold", amount: 0 })}
              className={`${btnBase} bg-neutral-800 text-neutral-200 hover:bg-neutral-700`}
            >
              {t("action.fold")}
            </button>
          )}
          {has("check") && (
            <button
              type="button"
              disabled={!heroTurn}
              onClick={() => void act({ type: "check", amount: 0 })}
              className={`${btnBase} bg-sky-800 text-sky-100 hover:bg-sky-700`}
            >
              {t("action.check")}
            </button>
          )}
          {callInfo && (
            <button
              type="button"
              disabled={!heroTurn}
              onClick={() => void act({ type: "call", amount: callInfo.amount })}
              className={`${btnBase} ${
                callInfo.isAllIn
                  ? "bg-rose-700 text-rose-50 hover:bg-rose-600"
                  : "bg-sky-800 text-sky-100 hover:bg-sky-700"
              }`}
            >
              {callInfo.isAllIn
                ? t("action.allInCallAmount", { n: callInfo.amount })
                : t("action.callAmount", { n: callInfo.amount })}
            </button>
          )}
          {canBet && (
            <button
              id="poker-bet-toggle"
              type="button"
              disabled={!heroTurn}
              onClick={() => {
                setMode(mode === "bet" ? null : "bet");
                setAmount(minOf("bet"));
              }}
              className={`${btnBase} ${
                mode === "bet"
                  ? "bg-amber-500 text-neutral-950"
                  : "bg-emerald-700 text-emerald-50 hover:bg-emerald-600"
              }`}
            >
              {t("action.bet")}
            </button>
          )}
          {canRaise && (
            <button
              id="poker-raise-toggle"
              type="button"
              disabled={!heroTurn}
              onClick={() => {
                setMode(mode === "raise" ? null : "raise");
                setAmount(minOf("raise"));
              }}
              className={`${btnBase} ${
                mode === "raise"
                  ? "bg-amber-500 text-neutral-950"
                  : "bg-emerald-700 text-emerald-50 hover:bg-emerald-600"
              }`}
            >
              {t("action.raise")}
            </button>
          )}
          {has("allin") && !canBet && !canRaise && (
            <button
              type="button"
              disabled={!heroTurn}
              onClick={() => void act({ type: "allin", amount: maxBetTo })}
              className={`${btnBase} bg-rose-700 text-rose-50 hover:bg-rose-600`}
            >
              {t("action.allInAmount", { n: maxBetTo })}
            </button>
          )}
          {!heroTurn && !game.handOver && (
            <div className="flex flex-wrap items-center justify-center gap-2">
              <span className="text-xs text-neutral-500">
                {aiThinking ? t("action.aiThinking") : t("action.waitingOpponents")}{" "}
                {t("action.preActionLabel")}
              </span>
              {(
                [
                  ["fold", "action.preFold"],
                  ["check", "action.preCheck"],
                  ["call", "action.preCall"],
                ] as const
              ).map(([key, label]) => {
                const active = preAction === key;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setPreAction(active ? null : key)}
                    className={`min-h-11 rounded-lg px-4 py-2 text-sm font-bold transition md:min-h-0 ${
                      active
                        ? "bg-amber-500 text-neutral-950 ring-2 ring-amber-300"
                        : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
                    }`}
                  >
                    {t(label)}
                    {active && " ✓"}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 快捷键提示条（移动端无键盘，隐藏） */}
        <div className="hidden text-center text-[10px] text-neutral-600 md:block">
          {t("action.hotkeys")}
        </div>
      </div>
    </div>
  );
}
