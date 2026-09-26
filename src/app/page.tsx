"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Nav } from "@/components/history/Nav";
import { useI18n } from "@/lib/i18n";
import type { DictKey } from "@/lib/i18n/dict";
import { useHistoryStore } from "@/lib/store/historyStore";
import {
  loadSession,
  summarizeSession,
  type SessionSummary,
} from "@/lib/store/sessionPersistence";
import {
  DEFAULT_TOURNAMENT,
  extendLevelsInfinite,
  INFINITE_TOTAL_LEVELS,
} from "@/lib/poker/tournament";
import type { AIStyle, GameMode } from "@/lib/types";

const STYLE_OPTIONS: AIStyle[] = [
  "random",
  "nit",
  "tag",
  "lag",
  "maniac",
  "calling_station",
  "gto",
];

const STYLE_NAME_KEY: Record<AIStyle, DictKey> = {
  random: "lobby.style.random",
  nit: "lobby.style.nit",
  tag: "lobby.style.tag",
  lag: "lobby.style.lag",
  maniac: "lobby.style.maniac",
  calling_station: "lobby.style.calling_station",
  gto: "lobby.style.gto",
};

const STYLE_DESC_KEY: Record<AIStyle, DictKey> = {
  random: "lobby.styleDesc.random",
  nit: "lobby.styleDesc.nit",
  tag: "lobby.styleDesc.tag",
  lag: "lobby.styleDesc.lag",
  maniac: "lobby.styleDesc.maniac",
  calling_station: "lobby.styleDesc.calling_station",
  gto: "lobby.styleDesc.gto",
};

const SEAT_OPTIONS = [2, 6, 9] as const;

/** 升盲模式：限制级别（10 级表到顶停住）/ 无限升盲（顶级后大盲继续翻倍，预生成 40 级） */
type BlindMode = "limited" | "infinite";

/** 锦标赛结构展示数据：与引擎同源（DEFAULT_TOURNAMENT），不另设硬编码副本 */
const TOURNAMENT_START_STACK = DEFAULT_TOURNAMENT.startStack;
const TOURNAMENT_LEVELS = DEFAULT_TOURNAMENT.levels;

const DEFAULT_STYLE_KEY = "pokergto_default_style";

export default function LobbyPage() {
  const router = useRouter();
  const { t } = useI18n();
  const { hands, loaded, loadAll, stats } = useHistoryStore();
  const [mode, setMode] = useState<GameMode>("cash");
  const [seats, setSeats] = useState<number>(6);
  const [style, setStyle] = useState<AIStyle>("random");
  const [sb, setSb] = useState(1);
  const [bb, setBb] = useState(2);
  const [buyin, setBuyin] = useState(200);
  const [rebuys, setRebuys] = useState<number>(0);
  const [handsPerLevel, setHandsPerLevel] = useState<number>(
    DEFAULT_TOURNAMENT.handsPerLevel,
  );
  const [blindMode, setBlindMode] = useState<BlindMode>("limited");
  const [rebuyPeriod, setRebuyPeriod] = useState<number>(4);
  const [activeSession, setActiveSession] = useState<SessionSummary | null>(null);

  /** 结构预览的升盲表：无限模式时展示预生成的 40 级扩展表 */
  const previewLevels = useMemo(
    () =>
      blindMode === "infinite"
        ? extendLevelsInfinite(TOURNAMENT_LEVELS, INFINITE_TOTAL_LEVELS)
        : TOURNAMENT_LEVELS,
    [blindMode],
  );

  useEffect(() => {
    void loadAll().catch(() => {});
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(DEFAULT_STYLE_KEY) : null;
    if (saved && (STYLE_OPTIONS as string[]).includes(saved)) {
      setStyle(saved as AIStyle);
    }
    // 进行中的对局存档（仅客户端可读）；有则显示「返回当前对战」入口
    const snap = loadSession();
    setActiveSession(snap ? summarizeSession(snap) : null);
  }, [loadAll]);

  const s = stats();

  const start = () => {
    const params = new URLSearchParams({
      mode,
      seats: String(seats),
      aiStyle: style,
      sb: String(sb),
      bb: String(bb),
      buyin: String(buyin),
      rebuys: String(rebuys),
      hpl: String(handsPerLevel),
      blindMode,
      rebuyPeriod: String(rebuyPeriod),
    });
    router.push(`/play?${params.toString()}`);
  };

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <Nav />
      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">
            PokerGTO <span className="text-emerald-400">{t("lobby.title")}</span>
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            {t("lobby.tagline")}
          </p>
        </div>

        {/* 最近战绩 */}
        <section className="mb-8 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <h2 className="mb-3 text-sm font-medium text-zinc-400">{t("lobby.recentStats")}</h2>
          {!loaded ? (
            <p className="text-sm text-zinc-500">{t("lobby.statsLoading")}</p>
          ) : s.totalHands === 0 ? (
            <p className="text-sm text-zinc-500">{t("lobby.noHands")}</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label={t("lobby.totalHands")} value={String(s.totalHands)} />
              <Stat
                label={t("lobby.totalProfit")}
                value={`${s.totalProfit >= 0 ? "+" : ""}${s.totalProfit}`}
                valueClass={s.totalProfit >= 0 ? "text-emerald-400" : "text-red-400"}
              />
              <Stat label={t("lobby.winRate")} value={`${(s.winRate * 100).toFixed(1)}%`} />
              <Stat label={t("lobby.showdownRate")} value={`${(s.showdownRate * 100).toFixed(1)}%`} />
            </div>
          )}
        </section>

        {/* 有进行中存档时的「返回当前对战」入口（绿色高亮，位于快速对战卡上方） */}
        {activeSession && (
          <section className="mb-6 rounded-xl border border-emerald-500/70 bg-emerald-950/40 p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-emerald-300">{t("lobby.resume.title")}</h2>
                <p className="mt-1 text-sm text-zinc-300">
                  {t("lobby.resume.info", {
                    mode: t(
                      activeSession.mode === "tournament"
                        ? "lobby.resume.modeTournament"
                        : "lobby.resume.modeCash",
                    ),
                    seats: activeSession.seats,
                    hands: activeSession.handsPlayed,
                  })}{" "}
                  <span
                    className={`font-bold tabular-nums ${
                      activeSession.heroProfit >= 0
                        ? "text-emerald-400"
                        : "text-red-400"
                    }`}
                  >
                    {activeSession.heroProfit >= 0 ? "+" : ""}
                    {activeSession.heroProfit}
                  </span>
                </p>
                <p className="mt-1 text-xs text-zinc-500">{t("lobby.resume.overwrite")}</p>
              </div>
              <Link
                href="/play?resume=1"
                className="shrink-0 rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-bold text-zinc-950 transition-colors hover:bg-emerald-400"
              >
                {t("lobby.resume.cta")}
              </Link>
            </div>
          </section>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          {/* 快速对战 */}
          <section className="rounded-xl border border-emerald-900/60 bg-zinc-900/50 p-5">
            <h2 className="mb-4 text-lg font-semibold text-emerald-400">{t("lobby.quickPlay")}</h2>

            <label className="mb-1 block text-sm text-zinc-400">{t("lobby.mode")}</label>
            <div className="mb-4 grid grid-cols-2 gap-2">
              {(
                [
                  { id: "cash", nameKey: "lobby.mode.cash", descKey: "lobby.mode.cashDesc" },
                  { id: "tournament", nameKey: "lobby.mode.tournament", descKey: "lobby.mode.tournamentDesc" },
                ] as { id: GameMode; nameKey: DictKey; descKey: DictKey }[]
              ).map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                    mode === m.id
                      ? "border-emerald-500 bg-emerald-500/10 text-emerald-300"
                      : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500"
                  }`}
                >
                  <div className="text-sm font-medium">{t(m.nameKey)}</div>
                  <div className="mt-0.5 text-xs text-zinc-500">{t(m.descKey)}</div>
                </button>
              ))}
            </div>

            <label className="mb-1 block text-sm text-zinc-400">{t("lobby.seats")}</label>
            <div className="mb-4 grid grid-cols-3 gap-2">
              {SEAT_OPTIONS.map((n) => (
                <button
                  key={n}
                  onClick={() => setSeats(n)}
                  className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                    seats === n
                      ? "border-emerald-500 bg-emerald-500/10 text-emerald-300"
                      : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500"
                  }`}
                >
                  {t("lobby.seatsTable", { n })}{n === 2 ? t("lobby.headsUp") : ""}
                </button>
              ))}
            </div>

            <label className="mb-1 block text-sm text-zinc-400">{t("lobby.aiStyle")}</label>
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {STYLE_OPTIONS.map((id) => (
                <button
                  key={id}
                  onClick={() => setStyle(id)}
                  className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    style === id
                      ? "border-emerald-500 bg-emerald-500/10 text-emerald-300"
                      : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500"
                  }`}
                >
                  {t(STYLE_NAME_KEY[id])}
                </button>
              ))}
            </div>
            <p className="mb-4 min-h-10 rounded-lg bg-zinc-950/60 p-2 text-xs leading-5 text-zinc-400">
              {t(STYLE_DESC_KEY[style])}
            </p>

            {mode === "cash" ? (
              <>
                <div className="mb-2 grid grid-cols-3 gap-3">
                  <NumberField label={t("lobby.sb")} value={sb} min={1} onChange={setSb} />
                  <NumberField label={t("lobby.bb")} value={bb} min={1} onChange={setBb} />
                  <NumberField label={t("lobby.buyin")} value={buyin} min={2} onChange={setBuyin} />
                </div>
                <p className="mb-4 text-xs text-zinc-500">
                  {t("lobby.cashHint")}
                </p>
              </>
            ) : (
              <div className="mb-4 rounded-lg bg-zinc-950/60 p-3">
                <p className="mb-2 text-xs leading-5 text-zinc-400">
                  {t("lobby.tourney.structure", {
                    stack: TOURNAMENT_START_STACK,
                    hands: handsPerLevel,
                    levels: previewLevels.length,
                  })}
                </p>
                <div className="flex flex-nowrap gap-1 overflow-x-auto pb-1 md:flex-wrap md:overflow-x-visible md:pb-0">
                  {previewLevels.map((lv, i) => (
                    <span
                      key={i}
                      className="shrink-0 rounded bg-zinc-800/80 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400"
                    >
                      {lv.smallBlind}/{lv.bigBlind}
                      {lv.ante > 0 ? `+${lv.ante}` : ""}
                    </span>
                  ))}
                </div>

                <div className="mt-3 grid grid-cols-2 gap-3">
                  <NumberField
                    label={t("lobby.tourney.handsPerLevel")}
                    value={handsPerLevel}
                    min={1}
                    max={50}
                    onChange={setHandsPerLevel}
                  />
                  <NumberField
                    label={t("lobby.tourney.rebuyPeriod")}
                    value={rebuyPeriod}
                    min={0}
                    max={10}
                    onChange={setRebuyPeriod}
                  />
                </div>

                <label className="mb-1 mt-3 block text-sm text-zinc-400">
                  {t("lobby.tourney.blindMode")}
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      {
                        id: "limited",
                        nameKey: "lobby.tourney.blindMode.limited",
                        descKey: "lobby.tourney.blindMode.limitedDesc",
                      },
                      {
                        id: "infinite",
                        nameKey: "lobby.tourney.blindMode.infinite",
                        descKey: "lobby.tourney.blindMode.infiniteDesc",
                      },
                    ] as { id: BlindMode; nameKey: DictKey; descKey: DictKey }[]
                  ).map((bm) => (
                    <button
                      key={bm.id}
                      onClick={() => setBlindMode(bm.id)}
                      className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                        blindMode === bm.id
                          ? "border-emerald-500 bg-emerald-500/10 text-emerald-300"
                          : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500"
                      }`}
                    >
                      <div className="text-sm font-medium">{t(bm.nameKey)}</div>
                      <div className="mt-0.5 text-xs text-zinc-500">{t(bm.descKey)}</div>
                    </button>
                  ))}
                </div>

                <div className="mt-3">
                  <NumberField
                    label={t("lobby.rebuys.label")}
                    value={rebuys}
                    min={0}
                    max={99}
                    onChange={setRebuys}
                  />
                </div>
                <p className="mt-1 text-xs text-zinc-500">
                  {rebuys > 0
                    ? t("lobby.rebuys.hintOn", { n: rebuys, levels: rebuyPeriod })
                    : t("lobby.rebuys.hintOff")}
                </p>
              </div>
            )}

            <button
              onClick={start}
              className="w-full rounded-lg bg-emerald-500 py-3 text-center text-lg font-bold text-zinc-950 transition-colors hover:bg-emerald-400"
            >
              {t("lobby.start")}
            </button>
          </section>

          {/* 功能入口 */}
          <section className="grid content-start gap-3">
            <EntryCard
              href="/history"
              title={t("lobby.entry.historyTitle")}
              desc={
                t("lobby.entry.historyDesc") +
                (hands.length > 0 ? t("lobby.entry.historyCount", { n: hands.length }) : "")
              }
            />
            <EntryCard
              href="/ranges"
              title={t("lobby.entry.rangesTitle")}
              desc={t("lobby.entry.rangesDesc")}
            />
            <EntryCard
              href="/equity"
              title={t("lobby.entry.equityTitle")}
              desc={t("lobby.entry.equityDesc")}
            />
            <EntryCard
              href="/settings"
              title={t("lobby.entry.settingsTitle")}
              desc={t("lobby.entry.settingsDesc")}
            />
          </section>
        </div>
      </div>
    </main>
  );
}

function Stat({ label, value, valueClass = "text-zinc-100" }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="rounded-lg bg-zinc-950/60 p-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`mt-1 text-xl font-bold ${valueClass}`}>{value}</div>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-zinc-400">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          let v = Math.floor(Number(e.target.value));
          if (!Number.isFinite(v) || v < min) v = min;
          if (max !== undefined && v > max) v = max;
          onChange(v);
        }}
        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
      />
    </label>
  );
}

function EntryCard({ href, title, desc }: { href: string; title: string; desc: string }) {
  return (
    <Link
      href={href}
      className="block rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 transition-colors hover:border-emerald-700 hover:bg-zinc-900"
    >
      <div className="font-semibold text-zinc-100">{title}</div>
      <div className="mt-1 text-sm text-zinc-400">{desc}</div>
    </Link>
  );
}
