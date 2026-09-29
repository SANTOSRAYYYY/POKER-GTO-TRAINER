"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CardBack, PlayingCard } from "@/components/history/PlayingCard";
import { Nav } from "@/components/history/Nav";
import { ReferenceBadge } from "@/components/history/ReferenceBadge";
import {
  actionText,
  buildSteps,
  foldedSeatsAt,
  isShowdownStep,
  replayText,
} from "@/components/history/replay";
import {
  heroDecisionInput,
  type ReferenceInput,
} from "@/lib/gto/reference";
import { useI18n } from "@/lib/i18n";
import type { DictKey } from "@/lib/i18n/dict";
import { useHistoryStore } from "@/lib/store/historyStore";
import {
  handStyles,
  isTournamentHand,
  seatPositionCn,
  styleName,
} from "@/components/history/labels";
import type {
  AnalysisResult,
  HandRecord,
  LLMConfig,
  Seat,
  Street,
  StreetRating,
} from "@/lib/types";

const LLM_CONFIG_KEY = "pokergto_llm_config";

const STREET_LABEL_KEY: Record<Street, DictKey> = {
  preflop: "history.street.preflop",
  flop: "history.street.flop",
  turn: "history.street.turn",
  river: "history.street.river",
  showdown: "history.street.showdown",
};

const RATING_STYLE: Record<StreetRating, { icon: string; className: string; labelKey: DictKey }> = {
  good: { icon: "✓", className: "text-emerald-400 border-emerald-700 bg-emerald-950/40", labelKey: "history.rating.good" },
  ok: { icon: "~", className: "text-amber-400 border-amber-700 bg-amber-950/40", labelKey: "history.rating.ok" },
  mistake: { icon: "✗", className: "text-red-400 border-red-700 bg-red-950/40", labelKey: "history.rating.mistake" },
};

interface AnalyzeError {
  key: DictKey;
  vars?: Record<string, string | number>;
  /** 是否显示「去设置」链接（缺 API Key 类错误） */
  showSettings?: boolean;
}

export default function HandReplayPage() {
  const params = useParams();
  const id = String(params.id ?? "");
  const { t, lang } = useI18n();
  const { loaded, loadAll, getHand, getAnalysis, analyzeHand, analyses } = useHistoryStore();

  const [hand, setHand] = useState<HandRecord | null | undefined>(undefined);
  const [stepIdx, setStepIdx] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<AnalyzeError | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!loaded) await loadAll().catch(() => {});
      const h = await getHand(id).catch(() => null);
      if (cancelled) return;
      setHand(h);
      if (h) setStepIdx(Number.MAX_SAFE_INTEGER); // 渲染时钳到最后一步
      await getAnalysis(id).catch(() => {});
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, loaded]);

  const steps = useMemo(() => (hand ? buildSteps(hand, t, lang) : []), [hand, t, lang]);
  const cur = Math.min(stepIdx, Math.max(0, steps.length - 1));
  const step = steps[cur];
  /** 摊牌终局步骤（streetIdx = streets.length 哨兵） */
  const showdownStep = hand && step ? isShowdownStep(hand, step) : false;
  const street: Street | null =
    hand && step ? (showdownStep ? "showdown" : hand.streets[step.streetIdx].street) : null;
  const board =
    hand && step ? (showdownStep ? hand.finalBoard : hand.streets[step.streetIdx].board) : [];
  const analysis: AnalysisResult | null = analyses[id] ?? null;
  /** 当前步骤的行动者座位（无动作步骤为 null），用于座位卡片高亮 */
  const actorSeat: Seat | null = step?.actor ?? null;
  const folded = useMemo(
    () => (hand ? foldedSeatsAt(hand, steps, cur) : new Set<Seat>()),
    [hand, steps, cur],
  );
  /** 摊牌亮牌名单：终局时未弃牌且记录中亮出底牌的玩家 */
  const showdownPlayers = useMemo(() => {
    if (!hand || !hand.showdown) return [];
    const foldedFinal = foldedSeatsAt(hand, steps, steps.length - 1);
    return hand.players.filter(
      (p) => !foldedFinal.has(p.seat) && p.cards && p.cards.length > 0,
    );
  }, [hand, steps]);

  /**
   * 当前街 hero 决策点的参考线输入（actionIdx → ReferenceInput）。
   * potBefore / callAmount 由 heroDecisionInput 重放动作序列推导（含翻前盲注
   * 预置投入）；胜率在徽章点击后才惰性计算并缓存。
   * 摊牌终局步骤没有动作序列，返回空表。
   */
  const heroInputs = useMemo(() => {
    const m = new Map<number, ReferenceInput>();
    if (!hand || !step || isShowdownStep(hand, step)) return m;
    const si = step.streetIdx;
    hand.streets[si].actions.forEach((sa, ai) => {
      if (sa.seat !== hand.heroSeat) return;
      const input = heroDecisionInput(hand, si, ai);
      if (input) m.set(ai, input);
    });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hand, step?.streetIdx]);

  const onAnalyze = async () => {
    setAnalyzeError(null);
    let config: LLMConfig | null = null;
    try {
      const raw = window.localStorage.getItem(LLM_CONFIG_KEY);
      config = raw ? (JSON.parse(raw) as LLMConfig) : null;
    } catch {
      config = null;
    }
    if (!config || !config.apiKey) {
      setAnalyzeError({ key: "history.ai.noApiKey", showSettings: true });
      return;
    }
    setAnalyzing(true);
    try {
      await analyzeHand(id, config);
    } catch (e) {
      setAnalyzeError(
        e instanceof Error
          ? { key: "history.ai.rawError", vars: { msg: e.message } }
          : { key: "history.ai.failed" },
      );
    } finally {
      setAnalyzing(false);
    }
  };

  if (hand === undefined) {
    return (
      <main className="min-h-screen bg-zinc-950 text-zinc-100">
        <Nav />
        <p className="py-24 text-center text-zinc-500">{t("common.loading")}</p>
      </main>
    );
  }
  if (hand === null) {
    return (
      <main className="min-h-screen bg-zinc-950 text-zinc-100">
        <Nav />
        <div className="py-24 text-center">
          <p className="text-zinc-400">{t("history.notFound")}</p>
          <Link href="/history" className="mt-3 inline-block text-emerald-400 hover:underline">
            {t("history.notFoundBack")}
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <Nav />
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Link href="/history" className="text-sm text-zinc-400 hover:text-zinc-200">
            {t("history.backToList")}
          </Link>
          <h1 className="text-xl font-bold">{t("history.replayTitle")}</h1>
          <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">
            {t("history.seatsBadge", { n: hand.players.length })}
            {isTournamentHand(hand)
              ? ` · ${t("history.modeTournament")}`
              : ` · ${t("history.modeCash")}`}
          </span>
          {handStyles(hand).map((st) => (
            <span
              key={st}
              className="rounded bg-emerald-900/40 px-2 py-0.5 text-xs text-emerald-300"
            >
              {styleName(st, lang)}
            </span>
          ))}
          <span
            className={`text-sm font-semibold ${
              hand.result === "win" ? "text-emerald-400" : hand.result === "lose" ? "text-red-400" : "text-zinc-400"
            }`}
          >
            {hand.result === "win"
              ? t("history.win")
              : hand.result === "lose"
                ? t("history.lose")
                : t("history.tie")}{" "}
            {hand.profit >= 0 ? "+" : ""}
            {hand.profit}
          </span>
          <span className="text-xs text-zinc-500">
            {t("history.blinds", { sb: hand.smallBlind, bb: hand.bigBlind })}
            {hand.ante > 0 ? t("history.anteSuffix", { n: hand.ante }) : ""}
          </span>
        </div>

        <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
          {/* 左侧：回放器 */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
            {/* 街道切换（摊牌手追加「摊牌」tab，落点为终局步骤） */}
            <div className="mb-4 flex flex-wrap gap-2">
              {hand.streets.map((st, si) => {
                const startIdx = steps.findIndex((s) => s.streetIdx === si);
                const active = step && step.streetIdx === si;
                return (
                  <button
                    key={st.street}
                    onClick={() => setStepIdx(startIdx)}
                    className={`rounded-md px-3 py-1 text-sm transition-colors ${
                      active
                        ? "bg-emerald-500/15 font-medium text-emerald-400"
                        : "bg-zinc-800/60 text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    {t(STREET_LABEL_KEY[st.street])}
                  </button>
                );
              })}
              {hand.showdown && (
                <button
                  onClick={() => setStepIdx(steps.length - 1)}
                  className={`rounded-md px-3 py-1 text-sm transition-colors ${
                    showdownStep
                      ? "bg-emerald-500/15 font-medium text-emerald-400"
                      : "bg-zinc-800/60 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {t("history.street.showdown")}
                </button>
              )}
            </div>

            {/* 公共牌与底池 */}
            <div className="mb-4 flex min-h-20 items-center justify-center gap-2 rounded-lg bg-emerald-950/20 py-4">
              {board.length === 0 ? (
                <span className="text-sm text-zinc-600">{t("history.noBoard")}</span>
              ) : (
                board.map((c) => <PlayingCard key={c} card={c} size="lg" />)
              )}
            </div>
            <div className="mb-4 text-center">
              <span className="text-sm text-zinc-500">{t("common.pot")}</span>
              <div className="text-3xl font-bold text-amber-300">{step?.pot ?? 0}</div>
            </div>

            {/* 座位栏：每个座位一张卡片，高亮当前行动者 */}
            <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {hand.players.map((p) => {
                const isActor = actorSeat === p.seat;
                const isFolded = folded.has(p.seat);
                const posCn = seatPositionCn(p.seat, hand.buttonSeat, hand.players.length, lang);
                return (
                  <div
                    key={p.seat}
                    className={`rounded-lg border bg-zinc-950/60 p-2.5 transition-colors ${
                      isActor
                        ? "border-emerald-500 ring-1 ring-emerald-500/50"
                        : "border-zinc-800"
                    } ${isFolded ? "opacity-45" : ""}`}
                  >
                    <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                      <span className="font-semibold text-zinc-300">
                        {t("history.seat", { n: p.seat })}
                        {posCn ? ` · ${posCn}` : ""}
                      </span>
                      {p.seat === hand.buttonSeat && (
                        <span className="rounded-full bg-amber-500/20 px-1.5 text-[10px] font-bold text-amber-300">
                          D
                        </span>
                      )}
                      {p.isHero ? (
                        <span className="rounded bg-emerald-500/15 px-1.5 text-emerald-300">{t("common.you")}</span>
                      ) : (
                        p.aiStyle && (
                          <span className="rounded bg-zinc-800 px-1.5 text-zinc-400">
                            {styleName(p.aiStyle, lang)}
                          </span>
                        )
                      )}
                      {isFolded && <span className="text-zinc-500">{t("history.folded")}</span>}
                    </div>
                    <div className="flex items-center gap-1">
                      {p.cards && p.cards.length > 0
                        ? p.cards.map((c) => <PlayingCard key={c} card={c} size="sm" />)
                        : [<CardBack key="b1" size="sm" />, <CardBack key="b2" size="sm" />]}
                    </div>
                    <div className="mt-1.5 flex items-center gap-2 text-xs">
                      <span
                        className={`font-semibold ${
                          p.profit > 0 ? "text-emerald-400" : p.profit < 0 ? "text-red-400" : "text-zinc-500"
                        }`}
                      >
                        {p.profit >= 0 ? "+" : ""}
                        {p.profit}
                      </span>
                      {p.finishPlace != null && (
                        <span className="rounded bg-sky-900/40 px-1.5 text-sky-300">
                          {t("history.finishPlace", { n: p.finishPlace })}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 步进控制 */}
            <div className="mb-4 flex items-center justify-center gap-3">
              <button
                onClick={() => setStepIdx((v) => Math.max(0, v - 1))}
                disabled={cur <= 0}
                className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-800 disabled:opacity-40"
              >
                {t("history.prevStep")}
              </button>
              <span className="min-w-24 text-center text-sm text-zinc-400">
                {t("history.stepOf", { cur: cur + 1, total: steps.length })}
              </span>
              <button
                onClick={() => setStepIdx((v) => Math.min(steps.length - 1, v + 1))}
                disabled={cur >= steps.length - 1}
                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-400 disabled:opacity-40"
              >
                {t("history.nextStep")}
              </button>
            </div>
            <p className="mb-4 min-h-6 text-center text-sm text-emerald-300">
              {step?.text ??
                t("history.enterStreet", {
                  street: street ? t(STREET_LABEL_KEY[street]) : "",
                })}
            </p>

            {/* 当前街动作序列（摊牌步骤改为亮牌名单；空动作街标注跑马） */}
            {step && showdownStep && (
              <div className="rounded-lg bg-zinc-950/60 p-3">
                <div className="mb-2 text-xs text-zinc-500">
                  {replayText("replay.showdownReveal", lang)}
                </div>
                <ul className="space-y-1.5">
                  {showdownPlayers.map((p) => (
                    <li key={p.seat} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-zinc-300">
                        {p.isHero
                          ? t("common.you")
                          : `${t("history.seat", { n: p.seat })}${p.aiStyle ? ` · ${styleName(p.aiStyle, lang)}` : ""}`}
                      </span>
                      <span className="flex items-center gap-1">
                        {p.cards!.map((c) => (
                          <PlayingCard key={c} card={c} size="sm" />
                        ))}
                      </span>
                      <span
                        className={`font-semibold ${
                          p.profit > 0 ? "text-emerald-400" : p.profit < 0 ? "text-red-400" : "text-zinc-500"
                        }`}
                      >
                        {p.profit >= 0 ? "+" : ""}
                        {p.profit}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {step && !showdownStep && (
              <div className="rounded-lg bg-zinc-950/60 p-3">
                <div className="mb-2 text-xs text-zinc-500">
                  {t("history.streetActions", {
                    street: t(STREET_LABEL_KEY[hand.streets[step.streetIdx].street]),
                  })}
                </div>
                {hand.streets[step.streetIdx].actions.length === 0 ? (
                  <p className="text-sm text-zinc-500">
                    {replayText("replay.runoutNote", lang)}
                  </p>
                ) : (
                  <ol className="space-y-1">
                    {hand.streets[step.streetIdx].actions.map((sa, ai) => {
                      const done = ai <= step.actionIdx;
                      const isCurrent = ai === step.actionIdx;
                      const refInput = heroInputs.get(ai);
                      return (
                        <li
                          key={ai}
                          className={`rounded px-2 py-1 text-sm ${
                            isCurrent
                              ? "bg-emerald-500/15 font-medium text-emerald-300"
                              : done
                                ? "text-zinc-300"
                                : "text-zinc-600"
                          }`}
                        >
                          {ai + 1}. {actionText(sa, hand, t, lang)}
                          {refInput && (
                            <ReferenceBadge
                              input={refInput}
                              cacheKey={`${hand.id}:${step.streetIdx}:${ai}`}
                            />
                          )}
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
            )}
          </section>

          {/* 右侧：AI 分析 */}
          <aside className="h-fit rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 lg:sticky lg:top-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">{t("history.ai.title")}</h2>
              {analysis && (
                <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-sm font-bold text-emerald-300">
                  {t("history.ai.score", { n: analysis.score })}
                </span>
              )}
            </div>

            {!analysis && (
              <p className="mb-3 text-sm text-zinc-500">
                {t("history.ai.intro")}
              </p>
            )}

            <button
              onClick={() => void onAnalyze()}
              disabled={analyzing}
              className="mb-4 w-full rounded-lg bg-emerald-500 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-400 disabled:opacity-50"
            >
              {analyzing
                ? t("history.ai.analyzing")
                : analysis
                  ? t("history.ai.reanalyze")
                  : t("history.ai.start")}
            </button>

            {analyzeError && (
              <div className="mb-4 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
                <p className="mb-2 whitespace-pre-wrap break-all">
                  {t(analyzeError.key, analyzeError.vars)}
                </p>
                <details className="text-xs text-red-200/80">
                  <summary className="cursor-pointer select-none">{t("history.ai.troubleshoot")}</summary>
                  <ul className="mt-1 list-inside list-disc space-y-0.5">
                    <li>{t("history.ai.ts1")}</li>
                    <li>{t("history.ai.ts2")}</li>
                    <li>{t("history.ai.ts3")}</li>
                    <li>{t("history.ai.ts4")}</li>
                    <li>{t("history.ai.ts5")}</li>
                  </ul>
                </details>
                {analyzeError.showSettings && (
                  <Link href="/settings" className="mt-2 inline-block underline">
                    {t("history.ai.goSettings")}
                  </Link>
                )}
              </div>
            )}

            {analysis && (
              <div className="space-y-3">
                {analysis.streets.map((sa) => {
                  const rs = RATING_STYLE[sa.rating];
                  return (
                    <div key={sa.street} className={`rounded-lg border p-3 ${rs.className}`}>
                      <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
                        <span>{rs.icon}</span>
                        <span>{t(STREET_LABEL_KEY[sa.street])}</span>
                        <span className="text-xs font-normal opacity-80">{t(rs.labelKey)}</span>
                      </div>
                      <ul className="list-inside list-disc space-y-1 text-sm text-zinc-200">
                        {sa.comments.map((c, i) => (
                          <li key={i}>{c}</li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
                <div className="rounded-lg border border-zinc-700 bg-zinc-950/60 p-3">
                  <div className="mb-1 text-sm font-semibold text-zinc-300">{t("history.ai.overall")}</div>
                  <p className="text-sm leading-6 text-zinc-300">{analysis.overall}</p>
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}
