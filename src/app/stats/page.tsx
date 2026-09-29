"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Nav } from "@/components/history/Nav";
import { useI18n } from "@/lib/i18n";
import type { DictKey } from "@/lib/i18n/dict";
import { useHistoryStore } from "@/lib/store/historyStore";
import { useGameStore } from "@/lib/store/gameStore";
import { loadNotebook, type HeroNotebook } from "@/lib/store/notebook";
import { buildModel } from "@/lib/ai/adapt";
import { computeHeroHud } from "@/lib/ai/hudStats";
import { StatCard } from "@/components/stats/StatCard";
import { HudPanel } from "@/components/stats/HudPanel";
import { ProfitCurve } from "@/components/stats/ProfitCurve";
import { PositionTable } from "@/components/stats/PositionTable";
import { StyleTable } from "@/components/stats/StyleTable";
import { SessionReportPanel } from "@/components/stats/SessionReportPanel";
import { AchievementsPanel } from "./AchievementsPanel";
import { ComparePanel } from "./ComparePanel";
import { CLASS_LABEL } from "./classLabels";
import {
  compareSegments,
  filterHands,
  type GameFilter,
  type RangeFilter,
} from "./filterCompare";

const GAME_FILTERS: GameFilter[] = ["all", "cash", "tournament"];
const RANGE_FILTERS: RangeFilter[] = [50, 100, 0];
const SEGMENT_SIZES = [50, 100] as const;

const GAME_FILTER_KEY: Record<GameFilter, DictKey> = {
  all: "stats.filter.all",
  cash: "stats.filter.cash",
  tournament: "stats.filter.tournament",
};

const RANGE_FILTER_KEY: Record<RangeFilter, DictKey> = {
  0: "stats.range.all",
  50: "stats.range.50",
  100: "stats.range.100",
};

/**
 * 「AI 眼中的你（长期）」展示卡：读 localStorage 对手笔记本
 * （lib/store/notebook.ts，跨 session 持久化的 hero 画像），
 * 展示 VPIP/PFR/AF/WTSD、AI 的分类推测与置信度、样本量，
 * 并提供「清空笔记本」（confirm 后调 gameStore.resetNotebook）。
 */
function NotebookCard() {
  const { t, lang } = useI18n();
  const resetNotebook = useGameStore((s) => s.resetNotebook);
  const [nb, setNb] = useState<HeroNotebook | null>(null);

  useEffect(() => {
    setNb(loadNotebook());
  }, []);

  const model = useMemo(() => (nb ? buildModel(nb.stats) : null), [nb]);

  const onReset = () => {
    if (!window.confirm(t("nb.confirmClear"))) {
      return;
    }
    resetNotebook();
    setNb(null);
  };

  return (
    <section className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{t("nb.title")}</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            {t("nb.subtitle")}
          </p>
        </div>
        {nb && (
          <button
            onClick={onReset}
            className="shrink-0 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800/60 hover:text-zinc-200 max-md:py-3"
          >
            {t("nb.clear")}
          </button>
        )}
      </div>
      {!nb || !model ? (
        <p className="text-sm text-zinc-500">
          {t("nb.empty")}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="VPIP" value={`${(model.vpip * 100).toFixed(0)}%`} sub={t("nb.vpipSub")} />
            <StatCard label="PFR" value={`${(model.pfr * 100).toFixed(0)}%`} sub={t("nb.pfrSub")} />
            <StatCard label="AF" value={model.af.toFixed(2)} sub={t("nb.afSub")} />
            <StatCard label="WTSD" value={`${(model.wtsd * 100).toFixed(0)}%`} sub={t("nb.wtsdSub")} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
            <span>
              {t("nb.guess")}<span className="font-medium text-amber-400">{CLASS_LABEL[model.cls][lang]}</span>
              {model.confidence > 0 && t("nb.confidence", { pct: (model.confidence * 100).toFixed(0) })}
            </span>
            <span>
              {t("nb.sample", {
                total: nb.handsRecorded,
                eff: model.stats.hands.toFixed(1),
              })}
            </span>
            <span>{t("nb.updatedAt", { time: new Date(nb.updatedAt).toLocaleString() })}</span>
          </div>
        </>
      )}
    </section>
  );
}

function PillGroup<T extends string | number>({
  options,
  labels,
  value,
  onChange,
}: {
  options: readonly T[];
  labels: Record<string, string>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-1 rounded-md bg-zinc-950/60 p-0.5">
      {options.map((o) => (
        <button
          key={String(o)}
          onClick={() => onChange(o)}
          className={`rounded px-2.5 py-1 text-xs transition-colors max-md:px-3 max-md:py-3 ${
            value === o
              ? "bg-emerald-500/15 font-medium text-emerald-400"
              : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
          }`}
        >
          {labels[String(o)]}
        </button>
      ))}
    </div>
  );
}

export default function StatsPage() {
  const { t } = useI18n();
  const { hands, loaded, loadError, loadAll } = useHistoryStore();
  const [gameFilter, setGameFilter] = useState<GameFilter>("all");
  const [rangeFilter, setRangeFilter] = useState<RangeFilter>(0);
  const [compareOn, setCompareOn] = useState(false);
  const [segmentSize, setSegmentSize] = useState<number>(50);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const filtered = useMemo(
    () => filterHands(hands, gameFilter, rangeFilter),
    [hands, gameFilter, rangeFilter],
  );
  const hud = useMemo(() => computeHeroHud(filtered), [filtered]);

  // 对比段只随局型筛选，不受时间范围筛选影响（段大小本身就是时间窗）
  const compare = useMemo(
    () =>
      compareOn
        ? compareSegments(filterHands(hands, gameFilter, 0), segmentSize)
        : null,
    [compareOn, hands, gameFilter, segmentSize],
  );

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <Nav />
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-5">
          <h1 className="text-2xl font-bold">{t("stats.title")}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {t("stats.subtitle")}
          </p>
        </div>

        {!loaded ? (
          <p className="py-16 text-center text-zinc-500">{t("common.loading")}</p>
        ) : loadError ? (
          <div className="rounded-xl border border-dashed border-red-900 py-16 text-center">
            <p className="text-red-400">{loadError}</p>
            <button
              onClick={() => void loadAll()}
              className="mt-3 rounded-lg border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800/60"
            >
              {t("common.retry")}
            </button>
          </div>
        ) : (
          <>
            {/* 金手链成就（全局口径，不受筛选影响） */}
            <AchievementsPanel />

            {/* AI 眼中的你（长期画像 · 对手笔记本，独立于历史手牌） */}
            <NotebookCard />

            {hands.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-800 py-16 text-center">
                <p className="text-zinc-500">{t("stats.empty")}</p>
                <Link href="/play" className="mt-2 inline-block text-sm text-emerald-400 hover:underline">
                  {t("stats.emptyCta")}
                </Link>
              </div>
            ) : (
              <>
                {/* 筛选与对比控制条 */}
                <section className="mb-2 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500">{t("stats.gameFilter")}</span>
                    <PillGroup
                      options={GAME_FILTERS}
                      labels={Object.fromEntries(
                        GAME_FILTERS.map((f) => [f, t(GAME_FILTER_KEY[f])]),
                      )}
                      value={gameFilter}
                      onChange={setGameFilter}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500">{t("stats.rangeFilter")}</span>
                    <PillGroup
                      options={RANGE_FILTERS}
                      labels={Object.fromEntries(
                        RANGE_FILTERS.map((f) => [f, t(RANGE_FILTER_KEY[f])]),
                      )}
                      value={rangeFilter}
                      onChange={setRangeFilter}
                    />
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    {compareOn && (
                      <PillGroup
                        options={SEGMENT_SIZES}
                        labels={{
                          50: t("stats.segment.50"),
                          100: t("stats.segment.100"),
                        }}
                        value={segmentSize}
                        onChange={setSegmentSize}
                      />
                    )}
                    <button
                      onClick={() => setCompareOn((v) => !v)}
                      className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors max-md:py-3 ${
                        compareOn
                          ? "bg-emerald-500/15 text-emerald-400"
                          : "border border-zinc-700 text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
                      }`}
                    >
                      {compareOn ? t("stats.compareOff") : t("stats.compareOn")}
                    </button>
                  </div>
                </section>
                <p className="mb-4 text-xs text-zinc-600">
                  {t("stats.sampleInfo", { n: filtered.length })}
                  {gameFilter !== "all" && t("stats.parenFilter", { name: t(GAME_FILTER_KEY[gameFilter]) })}
                  {rangeFilter !== 0 && ` · ${t(RANGE_FILTER_KEY[rangeFilter])}`}
                </p>

                {/* 分段对比（最近 N 手 vs 之前 N 手） */}
                {compareOn &&
                  (compare ? (
                    <ComparePanel compare={compare} />
                  ) : (
                    <section className="mb-6 rounded-xl border border-dashed border-zinc-800 p-5 text-center text-sm text-zinc-500">
                      {t("stats.compareNeed", { need: segmentSize + 1 })}
                      {gameFilter !== "all" ? t("stats.parenFilter", { name: t(GAME_FILTER_KEY[gameFilter]) }) : ""}
                      {t("stats.compareCurrent", { have: filterHands(hands, gameFilter, 0).length })}
                    </section>
                  ))}

                {filtered.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-zinc-800 py-12 text-center text-sm text-zinc-500">
                    {t("stats.noMatch")}
                  </div>
                ) : (
                  <>
                    {/* 核心指标卡 */}
                    <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                      <StatCard label={t("stats.totalHands")} value={String(hud.totalHands)} />
                      <StatCard
                        label={t("stats.totalProfit")}
                        value={`${hud.totalProfit >= 0 ? "+" : ""}${hud.totalProfit}`}
                        valueClass={hud.totalProfit >= 0 ? "text-emerald-400" : "text-red-400"}
                      />
                      <StatCard
                        label={t("stats.bbPer100")}
                        value={
                          hud.bbPer100 === null
                            ? "—"
                            : `${hud.bbPer100 >= 0 ? "+" : ""}${hud.bbPer100.toFixed(1)}`
                        }
                        sub={t("stats.bbPer100Sub")}
                        valueClass={
                          hud.bbPer100 === null
                            ? "text-zinc-100"
                            : hud.bbPer100 >= 0
                              ? "text-emerald-400"
                              : "text-red-400"
                        }
                      />
                      <StatCard label={t("stats.winRate")} value={`${(hud.winRate * 100).toFixed(1)}%`} sub={t("stats.winRateSub")} />
                      <StatCard label={t("stats.showdownRate")} value={`${(hud.showdownRate * 100).toFixed(1)}%`} />
                    </section>

                    {/* 整场复盘（Session 级 AI 教练，固定分析最近 N 手，不随筛选变化） */}
                    <SessionReportPanel handsCount={hands.length} />

                    {/* hero 打法 HUD */}
                    <HudPanel hud={hud} />

                    {/* 盈亏曲线 */}
                    <ProfitCurve points={hud.curve} />

                    {/* 位置 / 风格拆分 */}
                    <div className="grid gap-5 lg:grid-cols-2">
                      <PositionTable rows={hud.byPosition} />
                      <StyleTable rows={hud.byStyle} />
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}
