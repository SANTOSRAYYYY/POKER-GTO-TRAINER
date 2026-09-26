"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { HERO_SEAT, useGameStore, type TableConfig } from "@/lib/store/gameStore";
import { legalActions } from "@/lib/poker/game";
import { isSoundEnabled, playSound, setSoundEnabled } from "@/lib/audio";
import type { PlayerAction } from "@/lib/types";
import PokerTable from "./PokerTable";
import ActionBar from "./ActionBar";
import HandInfoPanel, { usePanelCollapsed } from "./HandInfoPanel";
import HandResultOverlay from "./HandResultOverlay";
import TournamentHud from "./TournamentHud";
import LevelUpBanner from "./LevelUpBanner";
import { useI18n } from "@/lib/i18n";

/** 当前街道 + 已归档街道的动作总数（音效订阅用，跨街道归档不回退） */
function totalActions(s: {
  streetLog: { actions: unknown[] }[];
  pendingActions: unknown[];
}): number {
  return (
    s.streetLog.reduce((n, r) => n + r.actions.length, 0) +
    s.pendingActions.length
  );
}

/** 牌桌整屏：顶部导航 + 锦标赛 HUD + 牌桌 + 信息侧栏（可折叠）+ 行动栏 + 结算层 + 升盲横幅 */
export default function TableScreen({
  config,
  resume = false,
}: {
  config: TableConfig;
  /** true：优先从 localStorage 存档恢复整局；无存档/损坏时回退为开新局 */
  resume?: boolean;
}) {
  const { t } = useI18n();
  const startTable = useGameStore((s) => s.startTable);
  const resumeSession = useGameStore((s) => s.resumeSession);
  const mode = useGameStore((s) => s.mode);
  const seats = useGameStore((s) => s.seats);
  const game = useGameStore((s) => s.game);
  const blindLevel = useGameStore((s) => s.blindLevel);
  const lastError = useGameStore((s) => s.lastError);
  const clearError = useGameStore((s) => s.clearError);
  const rebuysAllowed = useGameStore(
    (s) => s.tournamentConfig?.rebuysAllowed ?? 0,
  );
  const rebuyPeriodLevels = useGameStore(
    (s) => s.tournamentConfig?.rebuyPeriodLevels ?? 4,
  );
  const heroRebuysUsed = useGameStore((s) => s.rebuysUsed[HERO_SEAT] ?? 0);
  const heroEliminated = useGameStore((s) => s.eliminated[HERO_SEAT] ?? false);
  const [panelCollapsed, togglePanel] = usePanelCollapsed();
  // SSR 恒为 true 起步，挂载后同步 localStorage（避免 hydration 不一致）
  const [soundOn, setSoundOn] = useState(true);
  const handNumber = game?.handNumber ?? 0;
  const started = useRef(false);

  useEffect(() => {
    // 防 StrictMode 双调用导致开两手/重复恢复
    if (started.current) return;
    started.current = true;
    if (resume) {
      // 刷新/从大厅「返回当前对战」：优先读档恢复整局；无存档安全回退新局
      void resumeSession().then((ok) => {
        if (!ok) void startTable(config);
      });
    } else {
      void startTable(config);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 错误红条 6 秒后自动消失
  useEffect(() => {
    if (!lastError) return;
    const timer = setTimeout(clearError, 6000);
    return () => clearTimeout(timer);
  }, [lastError, clearError]);

  // 音效开关：挂载后读 localStorage 同步真实值
  useEffect(() => {
    setSoundOn(isSoundEnabled());
  }, []);

  // 牌桌音效：订阅 store 事件流（发牌 / 动作 / 结算胜负 / 升盲 / 淘汰），
  // WebAudio 合成播放；比较 prevState 触发，恢复会话/重挂载不误播历史。
  useEffect(() => {
    const unsub = useGameStore.subscribe((s, prev) => {
      // 发牌：handNumber 前进且新一手未结束
      const hn = s.game?.handNumber ?? 0;
      if (hn !== (prev.game?.handNumber ?? 0) && s.game && !s.game.handOver) {
        playSound("deal");
      }
      // 动作音：动作总数增加（街道归档不清零，总数单调）
      if (totalActions(s) > totalActions(prev)) {
        const last: PlayerAction | undefined =
          s.pendingActions.length > 0
            ? s.pendingActions[s.pendingActions.length - 1].action
            : s.streetLog[s.streetLog.length - 1]?.actions.slice(-1)[0]?.action;
        if (last) {
          if (last.type === "allin") playSound("allin");
          else if (
            last.type === "bet" ||
            last.type === "raise" ||
            last.type === "call"
          ) {
            playSound("chip");
          } else if (last.type === "check") playSound("check");
        }
      }
      // 结算胜负：finalize 落账瞬间按 hero 盈亏播音（观战手 heroProfit=null 不播）
      if (!prev.handSettled && s.handSettled && s.heroProfit !== null) {
        if (s.heroProfit > 0) playSound("win");
        else if (s.heroProfit < 0) playSound("lose");
      }
      // 升盲
      if (!prev.levelUpEvent && s.levelUpEvent) playSound("levelup");
      // 淘汰播报
      if (s.bustEvents.length > prev.bustEvents.length) playSound("bust");
    });
    return unsub;
  }, []);

  // 键盘快捷键：F 弃牌/提前弃牌 · C 过牌/跟注（或预操作）· B 聚焦加注滑杆 ·
  // Enter 确认当前主行动（滑杆展开时 = 确认滑杆）。输入框聚焦时忽略
  // （特赦：滑杆聚焦时 Enter 仍确认）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      const inInput =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        !!el?.isContentEditable;
      const sliderEnter = e.key === "Enter" && el?.id === "poker-bet-slider";
      if (inInput && !sliderEnter) return;

      const s = useGameStore.getState();
      const g = s.game;
      if (!g || g.handOver || s.heroSpectating) return;
      const heroTurn = g.currentSeat === HERO_SEAT && !s.aiThinking;
      const legal = (): PlayerAction[] => {
        if (!heroTurn) return [];
        try {
          return legalActions(g);
        } catch {
          return [];
        }
      };
      const key = e.key.toLowerCase();

      if (key === "f") {
        e.preventDefault();
        if (heroTurn) void s.act({ type: "fold", amount: 0 });
        else s.setPreAction(s.preAction === "fold" ? null : "fold");
        return;
      }
      if (key === "c") {
        e.preventDefault();
        if (heroTurn) {
          const call = legal().find((a) => a.type === "call");
          const check = legal().find((a) => a.type === "check");
          if (call) void s.act(call);
          else if (check) void s.act(check);
        } else {
          // 预操作：当前有跟注额预设「提前跟注」，否则「提前过牌」（再按取消）
          const toCall = g.currentBet - (g.players[HERO_SEAT]?.streetBet ?? 0);
          const want = toCall > 0 ? ("call" as const) : ("check" as const);
          s.setPreAction(s.preAction === want ? null : want);
        }
        return;
      }
      if (key === "b") {
        if (!heroTurn) return;
        const btn =
          document.getElementById("poker-raise-toggle") ??
          document.getElementById("poker-bet-toggle");
        if (!btn) return;
        e.preventDefault();
        btn.click();
        requestAnimationFrame(() =>
          document.getElementById("poker-bet-slider")?.focus(),
        );
        return;
      }
      if (e.key === "Enter") {
        if (!heroTurn) return;
        const confirmBtn = document.getElementById(
          "poker-bet-confirm",
        ) as HTMLButtonElement | null;
        if (confirmBtn && !confirmBtn.disabled) {
          e.preventDefault();
          confirmBtn.click();
          return;
        }
        // 主行动：跟注优先，否则过牌
        const primary =
          legal().find((a) => a.type === "call") ??
          legal().find((a) => a.type === "check");
        if (primary) {
          e.preventDefault();
          void s.act(primary);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const blindLabel =
    mode === "tournament"
      ? t("table.tournamentBlind", { seats, level: blindLevel + 1 })
      : game
        ? t("table.cashBlind", { sb: game.smallBlind, bb: game.bigBlind, seats })
        : t("table.opening");

  const heroRebuysLeft = Math.max(0, rebuysAllowed - heroRebuysUsed);

  return (
    <main className="flex min-h-screen flex-col">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-neutral-800 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm font-bold tracking-tight hover:text-emerald-300">
            PokerGTO Trainer
          </Link>
          <span className="rounded bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-300">
            {blindLabel} · {t("table.handNumber", { n: handNumber })}
          </span>
        </div>
        <nav className="flex items-center gap-4 text-xs text-neutral-400">
          <button
            type="button"
            onClick={() => {
              const next = !soundOn;
              setSoundEnabled(next);
              setSoundOn(next);
              if (next) playSound("chip"); // 打开时试听一声确认
            }}
            aria-label={soundOn ? t("table.soundOff") : t("table.soundOn")}
            title={soundOn ? t("table.soundStateOn") : t("table.soundStateOff")}
            className="rounded px-1.5 py-0.5 text-sm hover:bg-neutral-800"
          >
            {soundOn ? "🔊" : "🔇"}
          </button>
          <Link href="/" className="hover:text-neutral-100">
            {t("nav.home")}
          </Link>
          <Link href="/history" className="hover:text-neutral-100">
            {t("nav.history")}
          </Link>
          <Link href="/settings" className="hover:text-neutral-100">
            {t("nav.settings")}
          </Link>
        </nav>
      </header>

      {/* 锦标赛 HUD + hero 剩余重购次数徽标（叠在 HUD 条右端） */}
      <div className="relative">
        <TournamentHud />
        {mode === "tournament" && rebuysAllowed > 0 && (
          <span
            className="mx-auto mb-1 block w-fit rounded-full border border-purple-700/60 bg-purple-900/70 px-2.5 py-0.5 text-[11px] tabular-nums text-purple-200 md:absolute md:right-4 md:top-1/2 md:mb-0 md:-translate-y-1/2"
            title={t("tour.rebuyHint", { n: rebuyPeriodLevels })}
          >
            {heroEliminated
              ? t("tour.rebuyDisabled")
              : t("tour.rebuysLeft", { n: heroRebuysLeft })}
          </span>
        )}
      </div>

      <div className="mx-auto flex w-full max-w-7xl flex-1 items-start gap-4 px-2 py-3 md:px-4 md:py-4">
        <section className="min-w-0 flex-1">
          <PokerTable />
        </section>
        <aside
          className={`hidden shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out lg:block ${
            panelCollapsed ? "w-0" : "w-72"
          }`}
        >
          <HandInfoPanel collapsed={false} onToggle={togglePanel} />
        </aside>
      </div>
      {/* 折叠后的悬浮窄条（小屏默认折叠时同样可用） */}
      {panelCollapsed && (
        <HandInfoPanel collapsed onToggle={togglePanel} />
      )}
      {/* 小屏（<lg）展开时以抽屉形式悬浮展示面板 */}
      {panelCollapsed === false && (
        <div className="fixed inset-y-0 right-0 z-30 w-72 max-w-[85vw] overflow-y-auto border-l border-neutral-800 bg-neutral-950/95 p-3 transition-transform duration-300 lg:hidden">
          <HandInfoPanel collapsed={false} onToggle={togglePanel} />
        </div>
      )}

      <ActionBar />
      <HandResultOverlay />
      <LevelUpBanner />

      {/* 行动/推进链错误红条：6 秒自动消失，也可手动关闭 */}
      {lastError && (
        <div
          role="alert"
          className="fixed inset-x-0 top-14 z-40 mx-auto flex w-fit max-w-[90vw] items-center gap-3 rounded-lg border border-rose-700 bg-rose-950/95 px-4 py-2 text-sm text-rose-100 shadow-xl"
        >
          <span>{lastError}</span>
          <button
            type="button"
            onClick={clearError}
            aria-label={t("table.dismissError")}
            className="rounded px-1.5 font-bold text-rose-200 hover:bg-rose-900"
          >
            ×
          </button>
        </div>
      )}
    </main>
  );
}
