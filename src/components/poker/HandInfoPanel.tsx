"use client";

import { useEffect, useMemo, useState } from "react";
import { equityMulti, type EquityResult } from "@/lib/poker/equity";
import { HERO_SEAT, useGameStore } from "@/lib/store/gameStore";
import { useI18n } from "@/lib/i18n";
import type { DictKey } from "@/lib/i18n/dict";

/** 折叠状态持久化键（localStorage，跨刷新记住） */
const PANEL_COLLAPSED_KEY = "pokergto_panel_collapsed";
/** 小屏（<1024px，即 Tailwind lg 断点以下）默认折叠 */
const SMALL_SCREEN_QUERY = "(max-width: 1023px)";

function readCollapsedDefault(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const saved = window.localStorage.getItem(PANEL_COLLAPSED_KEY);
    if (saved !== null) return saved === "1";
  } catch {
    // localStorage 不可用时按默认处理
  }
  return window.matchMedia(SMALL_SCREEN_QUERY).matches;
}

/**
 * 面板折叠状态：挂载前为 undefined（按展开渲染，避免 hydration 不一致），
 * 挂载后从 localStorage / 屏幕宽度读取默认值；切换时持久化。
 */
export function usePanelCollapsed(): [
  boolean | undefined,
  (collapsed: boolean) => void,
] {
  const [collapsed, setCollapsed] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    setCollapsed(readCollapsedDefault());
  }, []);
  const toggle = (next: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(PANEL_COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // localStorage 不可用时仅内存态
    }
  };
  return [collapsed, toggle];
}

const ACTION_KEY: Record<string, DictKey> = {
  fold: "action.fold",
  check: "action.check",
  call: "action.call",
  bet: "action.bet",
  raise: "action.raise",
  allin: "action.allin",
};

/** 决策来源徽标：LLM = emerald，启发式 = zinc（LLM 失败/超时回退启发式时可辨） */
function SourceBadge({ source }: { source: "llm" | "heuristic" }) {
  const { t } = useI18n();
  const llm = source === "llm";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
        llm
          ? "bg-emerald-900/70 text-emerald-300"
          : "bg-zinc-800 text-zinc-400"
      }`}
      title={llm ? t("panel.sourceLlm") : t("panel.sourceHeuristic")}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${llm ? "bg-emerald-400" : "bg-zinc-500"}`}
      />
      {llm ? "LLM" : t("panel.heuristic")}
    </span>
  );
}

/**
 * 信息侧栏：胜率提示、底池赔率、AI 动作与决策说明（LLM / 启发式来源均展示，
 * 以来源徽标区分——LLM 超时会回退启发式，徽标可看出风格差异的原因）。
 * 可折叠：collapsed=true 时渲染右侧悬浮窄条（只留胜率/赔率迷你数字），
 * 折叠状态由 usePanelCollapsed 管理并持久化到 localStorage。
 */
export default function HandInfoPanel({
  collapsed,
  onToggle,
}: {
  collapsed?: boolean;
  onToggle?: (collapsed: boolean) => void;
}) {
  const { t } = useI18n();
  const game = useGameStore((s) => s.game);
  const potOdds = useGameStore((s) => s.potOdds);
  const callAmount = useGameStore((s) => s.callAmount);
  const lastAiAction = useGameStore((s) => s.lastAiAction);
  const seatMap = useGameStore((s) => s.seatMap);
  const heroSpectating = useGameStore((s) => s.heroSpectating);
  const session = useGameStore((s) => s.session);

  const result: EquityResult | null = useMemo(() => {
    if (!game || game.handOver || heroSpectating) return null;
    const heroCards = game.players[HERO_SEAT]?.holeCards;
    if (!heroCards) return null;
    // 仍在底池中的对手数（未弃牌、非 hero）；对手底牌未知，随机抽牌模拟
    const activeOpponents =
      game.players.filter((p) => !p.folded).length - 1;
    if (activeOpponents < 1) return null;
    try {
      return equityMulti(heroCards, game.board, activeOpponents, 800);
    } catch {
      // equity 模块未就绪时不显示胜率
      return null;
    }
  }, [game, heroSpectating]);

  const describeAction = (a: { type: string; amount: number }): string => {
    const key = ACTION_KEY[a.type];
    const label = key ? t(key) : a.type;
    return a.amount > 0 ? `${label} ${a.amount}` : label;
  };

  // 折叠窄条：悬浮在右缘，只留展开按钮与胜率迷你数字
  if (collapsed) {
    return (
      <div className="fixed right-3 top-1/3 z-30 flex w-11 flex-col items-center gap-2 rounded-xl border border-neutral-700 bg-neutral-900/95 py-2 shadow-xl transition-all duration-300">
        <button
          type="button"
          onClick={() => onToggle?.(false)}
          aria-label={t("panel.expand")}
          title={t("panel.expand")}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-sm text-neutral-300 transition hover:bg-neutral-800 hover:text-neutral-100"
        >
          «
        </button>
        <div className="flex flex-col items-center gap-0.5 text-[10px] leading-tight text-neutral-500">
          <span>{t("panel.equity")}</span>
          <span className="text-sm font-bold tabular-nums text-emerald-300">
            {result ? `${Math.round(result.win * 100)}%` : "--"}
          </span>
        </div>
        <div className="flex flex-col items-center gap-0.5 text-[10px] leading-tight text-neutral-500">
          <span>{t("panel.odds")}</span>
          <span className="text-sm font-bold tabular-nums text-amber-300">
            {`${Math.round(potOdds * 100)}%`}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3 transition-all duration-300">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => onToggle?.(true)}
          aria-label={t("panel.collapse")}
          title={t("panel.collapse")}
          className="flex h-7 w-7 items-center justify-center rounded-lg bg-neutral-900 text-sm text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-100"
        >
          »
        </button>
      </div>
      <section className="rounded-xl bg-neutral-900 p-4">
        <h3 className="mb-2 text-xs font-semibold tracking-widest text-neutral-400">
          {t("panel.equityTitle")}
        </h3>
        {result ? (
          <div className="flex flex-col gap-2">
            <div className="flex h-3 overflow-hidden rounded-full bg-neutral-800">
              <div
                className="bg-emerald-500 transition-all duration-500"
                style={{ width: `${result.win * 100}%` }}
              />
              <div
                className="bg-neutral-500 transition-all duration-500"
                style={{ width: `${result.tie * 100}%` }}
              />
              <div
                className="bg-rose-600 transition-all duration-500"
                style={{ width: `${result.lose * 100}%` }}
              />
            </div>
            <div className="flex justify-between text-xs tabular-nums text-neutral-300">
              <span className="text-emerald-300">
                {t("panel.winLabel")} {(result.win * 100).toFixed(1)}%
              </span>
              <span>{t("panel.tieLabel")} {(result.tie * 100).toFixed(1)}%</span>
              <span className="text-rose-300">
                {t("panel.loseLabel")} {(result.lose * 100).toFixed(1)}%
              </span>
            </div>
          </div>
        ) : (
          <p className="text-xs text-neutral-500">{t("panel.equityEmpty")}</p>
        )}
      </section>

      <section className="rounded-xl bg-neutral-900 p-4">
        <h3 className="mb-2 text-xs font-semibold tracking-widest text-neutral-400">
          {t("panel.potOdds")}
        </h3>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold tabular-nums text-amber-300">
            {(potOdds * 100).toFixed(1)}%
          </span>
          {callAmount > 0 && (
            <span className="text-xs text-neutral-400">
              {t("panel.needCall", { n: callAmount })}
            </span>
          )}
        </div>
        {callAmount === 0 && (
          <p className="mt-1 text-xs text-neutral-500">{t("panel.noCallNeeded")}</p>
        )}
      </section>

      <section className="rounded-xl bg-neutral-900 p-4">
        <h3 className="mb-2 text-xs font-semibold tracking-widest text-neutral-400">
          {t("panel.aiTitle")}
        </h3>
        {lastAiAction ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2 text-sm text-neutral-200">
              <span>
                {t("panel.lastAction", {
                  name:
                    seatMap[lastAiAction.seat] === 0 && !heroSpectating
                      ? t("common.you")
                      : `AI ${seatMap[lastAiAction.seat] ?? lastAiAction.seat}`,
                })}
                <span className="font-semibold text-rose-300">
                  {describeAction(lastAiAction.action)}
                </span>
              </span>
              <SourceBadge source={lastAiAction.source} />
            </div>
            {lastAiAction.reasoning &&
              (lastAiAction.source === "llm" ? (
                <div className="relative rounded-lg rounded-tl-none border border-emerald-700/50 bg-emerald-900/40 p-3 text-xs leading-relaxed text-emerald-100">
                  <span className="mb-1 block text-[10px] font-semibold tracking-widest text-emerald-400">
                    {t("panel.aiReasoningLlm")}
                  </span>
                  {lastAiAction.reasoning}
                </div>
              ) : (
                <div className="relative rounded-lg rounded-tl-none border border-zinc-700 bg-zinc-800/60 p-3 text-xs leading-relaxed text-zinc-200">
                  <span className="mb-1 block text-[10px] font-semibold tracking-widest text-zinc-400">
                    {t("panel.aiReasoningHeuristic")}
                  </span>
                  {lastAiAction.reasoning}
                </div>
              ))}
          </div>
        ) : (
          <p className="text-xs text-neutral-500">{t("panel.aiIdle")}</p>
        )}
      </section>

      <section className="rounded-xl bg-neutral-900 p-4">
        <h3 className="mb-2 text-xs font-semibold tracking-widest text-neutral-400">
          {t("panel.session")}
        </h3>
        <div className="grid grid-cols-3 gap-2 text-center text-xs text-neutral-400">
          <div>
            <div className="text-base font-bold tabular-nums text-neutral-100">
              {session.handsPlayed}
            </div>
            {t("panel.hands")}
          </div>
          <div>
            <div className="text-base font-bold tabular-nums text-neutral-100">
              {session.heroWins}
            </div>
            {t("panel.wins")}
          </div>
          <div>
            <div
              className={`text-base font-bold tabular-nums ${
                session.heroProfit > 0
                  ? "text-emerald-400"
                  : session.heroProfit < 0
                    ? "text-rose-400"
                    : "text-neutral-100"
              }`}
            >
              {session.heroProfit > 0 ? `+${session.heroProfit}` : session.heroProfit}
            </div>
            {t("result.profit")}
          </div>
        </div>
      </section>
    </div>
  );
}
