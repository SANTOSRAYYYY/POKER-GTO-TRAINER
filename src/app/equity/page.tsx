"use client";

import { useState } from "react";
import { Nav } from "@/components/history/Nav";
import { PlayingCard } from "@/components/history/PlayingCard";
import { useI18n } from "@/lib/i18n";
import type { DictKey } from "@/lib/i18n/dict";
import { equity, equityMulti, type EquityResult } from "@/lib/poker/equity";
import type { Card, Rank, Suit } from "@/lib/types";

const RANKS: Rank[] = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];
const SUITS: Suit[] = ["s", "h", "d", "c"];
const SUIT_LABEL: Record<Suit, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

/** 本地生成 52 张牌（引擎 cards.newDeck 由其他组实现，这里不依赖运行时） */
const DECK: Card[] = SUITS.flatMap((s) => RANKS.map((r) => `${r}${s}` as Card));

type Target = "hero" | "board" | "villain";

const TARGET_LABEL_KEY: Record<Target, DictKey> = {
  hero: "equity.target.hero",
  board: "equity.target.board",
  villain: "equity.target.villain",
};

const TARGET_MAX: Record<Target, number> = { hero: 2, board: 5, villain: 2 };

export default function EquityPage() {
  const { t } = useI18n();
  const [hero, setHero] = useState<Card[]>([]);
  const [board, setBoard] = useState<Card[]>([]);
  const [villain, setVillain] = useState<Card[]>([]);
  const [villainMode, setVillainMode] = useState<"random" | "exact">("random");
  const [opponents, setOpponents] = useState(1);
  const [target, setTarget] = useState<Target>("hero");
  const [computing, setComputing] = useState(false);
  const [result, setResult] = useState<EquityResult | null>(null);
  const [error, setError] = useState<DictKey | null>(null);

  const zone: Record<Target, Card[]> = { hero, board, villain };
  const used = new Set<Card>([...hero, ...board, ...villain]);

  const setZone = (target: Target, cards: Card[]) => {
    if (target === "hero") setHero(cards);
    else if (target === "board") setBoard(cards);
    else setVillain(cards);
    setResult(null);
  };

  const pick = (card: Card) => {
    if (used.has(card)) return;
    const list = zone[target];
    if (list.length >= TARGET_MAX[target]) return;
    setZone(target, [...list, card]);
    if (list.length + 1 >= TARGET_MAX[target]) {
      if (target === "hero") setTarget("board");
      else if (target === "board" && villainMode === "exact") setTarget("villain");
    }
  };

  const removeFrom = (target: Target, card: Card) => {
    setZone(target, zone[target].filter((c) => c !== card));
  };

  const reset = () => {
    setHero([]);
    setBoard([]);
    setVillain([]);
    setTarget("hero");
    setResult(null);
    setError(null);
  };

  const canCompute =
    hero.length === 2 &&
    (villainMode === "random" || villain.length === 2) &&
    (board.length === 0 || board.length >= 3);

  const compute = () => {
    setError(null);
    if (hero.length !== 2) {
      setError("equity.errHero");
      return;
    }
    if (villainMode === "exact" && villain.length !== 2) {
      setError("equity.errVillain");
      return;
    }
    if (board.length === 1 || board.length === 2) {
      setError("equity.errBoard");
      return;
    }
    setComputing(true);
    // 让出一帧渲染 loading，再做蒙特卡洛计算
    window.setTimeout(() => {
      try {
        const r =
          villainMode === "exact"
            ? equity(hero, villain, board, 10000)
            : equityMulti(hero, board, opponents, 10000);
        setResult(r);
      } catch (e) {
        setError(
          e instanceof Error && e.message.includes("not implemented")
            ? "equity.errNoEngine"
            : "equity.errFail",
        );
      } finally {
        setComputing(false);
      }
    }, 30);
  };

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <Nav />
      <div className="mx-auto max-w-5xl px-4 py-6">
        <h1 className="mb-1 text-2xl font-bold">{t("equity.title")}</h1>
        <p className="mb-5 text-sm text-zinc-400">
          {t("equity.subtitle")}
        </p>

        <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
          {/* 左：选牌区 */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            {/* 三个牌区 */}
            <Zone
              title={t("equity.zone.hero")}
              target="hero"
              cards={hero}
              active={target === "hero"}
              onActivate={() => setTarget("hero")}
              onRemove={(c) => removeFrom("hero", c)}
            />
            <Zone
              title={t("equity.zone.board")}
              target="board"
              cards={board}
              active={target === "board"}
              onActivate={() => setTarget("board")}
              onRemove={(c) => removeFrom("board", c)}
            />
            <div className="mb-4">
              <div className="mb-2 flex items-center gap-3">
                <span className="text-sm text-zinc-400">{t("equity.villainRange")}</span>
                <label className="flex items-center gap-1 text-sm text-zinc-300">
                  <input
                    type="radio"
                    checked={villainMode === "random"}
                    onChange={() => setVillainMode("random")}
                    className="accent-emerald-500"
                  />
                  {t("equity.random")}
                </label>
                <label className="flex items-center gap-1 text-sm text-zinc-300">
                  <input
                    type="radio"
                    checked={villainMode === "exact"}
                    onChange={() => {
                      setVillainMode("exact");
                      setTarget("villain");
                    }}
                    className="accent-emerald-500"
                  />
                  {t("equity.exact")}
                </label>
              </div>
              {villainMode === "exact" ? (
                <Zone
                  title={t("equity.zone.villain")}
                  target="villain"
                  cards={villain}
                  active={target === "villain"}
                  onActivate={() => setTarget("villain")}
                  onRemove={(c) => removeFrom("villain", c)}
                />
              ) : (
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <span className="text-xs text-zinc-500">{t("equity.opponentCount")}</span>
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                    <button
                      key={n}
                      onClick={() => {
                        setOpponents(n);
                        setResult(null);
                      }}
                      className={`h-7 w-7 rounded-md text-sm transition-colors ${
                        opponents === n
                          ? "bg-emerald-500/20 font-semibold text-emerald-300 ring-1 ring-emerald-500"
                          : "bg-zinc-800/60 text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                  <span className="text-xs text-zinc-600">{t("equity.opponentNote")}</span>
                </div>
              )}
            </div>

            {/* 52 张选择网格 */}
            <div className="rounded-lg bg-zinc-950/60 p-2">
              <div className="mb-1 px-1 text-xs text-zinc-500">
                {t("equity.pickHint", { zone: t(TARGET_LABEL_KEY[target]) })}
                {zone[target].length >= TARGET_MAX[target] && t("equity.full")}
              </div>
              {SUITS.map((s) => (
                <div key={s} className="mb-1 flex items-center gap-1">
                  <span className="w-5 text-center text-sm text-zinc-500">{SUIT_LABEL[s]}</span>
                  <div className="grid flex-1 grid-cols-13 gap-1">
                    {RANKS.map((r) => {
                      const card = `${r}${s}` as Card;
                      const isUsed = used.has(card);
                      return (
                        <button
                          key={card}
                          disabled={isUsed}
                          onClick={() => pick(card)}
                          className={`rounded transition-opacity ${isUsed ? "cursor-not-allowed opacity-25" : "hover:ring-2 hover:ring-emerald-400"}`}
                        >
                          <PlayingCard card={card} size="sm" />
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 flex gap-3">
              <button
                onClick={compute}
                disabled={computing || !canCompute}
                className="flex-1 rounded-lg bg-emerald-500 py-2.5 font-semibold text-zinc-950 transition-colors hover:bg-emerald-400 disabled:opacity-40"
              >
                {computing ? t("equity.computing") : t("equity.compute")}
              </button>
              <button
                onClick={reset}
                className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
              >
                {t("equity.reset")}
              </button>
            </div>
          </section>

          {/* 右：结果 */}
          <section className="h-fit rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
            <h2 className="mb-4 font-semibold">{t("equity.result")}</h2>
            {error && (
              <div className="mb-4 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
                {t(error)}
              </div>
            )}
            {!result && !error && (
              <p className="text-sm text-zinc-500">
                {t("equity.resultHint")}
              </p>
            )}
            {result && (
              <div className="space-y-4">
                <Bar label={t("equity.win")} value={result.win} barClass="bg-emerald-500" textClass="text-emerald-300" />
                <Bar label={t("equity.tie")} value={result.tie} barClass="bg-amber-500" textClass="text-amber-300" />
                <Bar label={t("equity.lose")} value={result.lose} barClass="bg-red-500" textClass="text-red-300" />
                <p className="text-xs text-zinc-500">
                  {t("equity.resultSummary", {
                    hero: hero.join(" "),
                    board: board.length ? board.join(" ") : t("equity.preflop"),
                    villain:
                      villainMode === "exact"
                        ? villain.join(" ")
                        : t("equity.randomN", { n: opponents }),
                  })}
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function Zone({
  title,
  cards,
  active,
  onActivate,
  onRemove,
}: {
  title: string;
  target: Target;
  cards: Card[];
  active: boolean;
  onActivate: () => void;
  onRemove: (c: Card) => void;
}) {
  const { t } = useI18n();
  return (
    <button
      onClick={onActivate}
      className={`mb-3 block w-full rounded-lg border p-3 text-left transition-colors ${
        active ? "border-emerald-500 bg-emerald-500/5" : "border-zinc-800 bg-zinc-950/60"
      }`}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm text-zinc-400">{title}</span>
        {active && <span className="text-xs text-emerald-400">{t("equity.pickToZone")}</span>}
      </div>
      <div className="flex min-h-12 items-center gap-2">
        {cards.length === 0 ? (
          <span className="text-xs text-zinc-600">{t("equity.empty")}</span>
        ) : (
          cards.map((c) => (
            <span
              key={c}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(c);
              }}
              title={t("equity.removeTitle")}
              className="cursor-pointer"
            >
              <PlayingCard card={c} />
            </span>
          ))
        )}
      </div>
    </button>
  );
}

function Bar({
  label,
  value,
  barClass,
  textClass,
}: {
  label: string;
  value: number;
  barClass: string;
  textClass: string;
}) {
  const pct = Math.max(0, Math.min(100, value * 100));
  return (
    <div>
      <div className="mb-1 flex justify-between text-sm">
        <span className="text-zinc-400">{label}</span>
        <span className={`font-bold ${textClass}`}>{pct.toFixed(1)}%</span>
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-zinc-800">
        <div className={`h-full ${barClass}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
