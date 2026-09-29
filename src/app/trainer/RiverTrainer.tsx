"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PlayingCard } from "@/components/history/PlayingCard";
import { useI18n } from "@/lib/i18n";
import type { DictKey } from "@/lib/i18n/dict";
import {
  QUIZ_ITERATIONS,
  type PostflopChoice,
} from "@/lib/gto/postflopQuiz";
import {
  generateRiverQuiz,
  RIVER_BLUFFCATCH_CALL_THRESHOLD,
  RIVER_BLUFF_MAX_EQUITY,
  RIVER_SHOWDOWN_VALUE_MAX,
  RIVER_THIN_VALUE_MIN,
  RIVER_VALUE_BET_THRESHOLD,
  riverValueCallerSpecFor,
  type RiverQuiz,
  type RiverScenarioType,
} from "@/lib/gto/riverQuiz";
import {
  potPlayers,
  riverBluffcatchCallLine,
  riverValueBetLine,
} from "@/lib/gto/multiway";
import { ActionLineBlock } from "./ActionLine";
import { PotBadge } from "./PotBadge";
import { TrainerStatsBar } from "./StatsBar";

type TFunc = (key: DictKey, vars?: Record<string, string | number>) => string;

interface WrongEntry {
  hero: string[];
  board: string[];
  type: RiverScenarioType;
  winPct: number;
  chose: PostflopChoice;
  expected: PostflopChoice;
}

const SCENARIO_KEY: Record<RiverScenarioType, DictKey> = {
  value: "trainer.river.scenario.value",
  bluffcatch: "trainer.river.scenario.bluffcatch",
  bluff: "trainer.river.scenario.bluff",
};

const QUESTION_KEY: Record<RiverScenarioType, DictKey> = {
  value: "trainer.river.valueQ",
  bluffcatch: "trainer.river.bluffcatchQ",
  bluff: "trainer.river.bluffQ",
};

const WRONG_TYPE_KEY: Record<RiverScenarioType, DictKey> = {
  value: "trainer.river.valueShort",
  bluffcatch: "trainer.river.bluffcatchShort",
  bluff: "trainer.river.bluffShort",
};

const CHOICE_KEY: Record<PostflopChoice, DictKey> = {
  aggressive: "trainer.choice.aggressive",
  passive: "trainer.choice.passive",
  fold: "action.fold",
};

/** 判定后的一句话简评（与 lib/gto/riverQuiz.riverQuizComment 同逻辑、走字典双语；价值题范围宽度随行动线；多人池带底池人数提示与动态门槛） */
function quizCommentText(quiz: RiverQuiz, t: TFunc): string {
  const shown = quiz.rangeEquity ?? quiz.equity.win;
  const pct = (shown * 100).toFixed(1);
  const tie =
    quiz.equity.tie >= 0.005
      ? t("trainer.post.tieNote", { pct: (quiz.equity.tie * 100).toFixed(1) })
      : "";
  const rpct = Math.round(riverValueCallerSpecFor(quiz.lineKind).topPct * 100);
  const line =
    quiz.type === "value"
      ? Math.round(riverValueBetLine(quiz.opponents) * 100)
      : Math.round(riverBluffcatchCallLine(quiz.opponents) * 100);
  const note =
    quiz.opponents > 1
      ? t("trainer.pot.note", { n: potPlayers(quiz.opponents) })
      : "";
  const noteDefense =
    quiz.opponents > 1
      ? t("trainer.pot.noteDefense", { n: potPlayers(quiz.opponents) })
      : "";
  const vars = { pct, tie, rpct };
  switch (quiz.answer) {
    case "aggressive":
      if (quiz.type === "value")
        return note + t("trainer.river.comment.valueBet", { ...vars, line });
      if (quiz.type === "bluff" && quiz.equity.win < RIVER_BLUFF_MAX_EQUITY) {
        return t("trainer.river.comment.bluffBet", vars);
      }
      return note + t("trainer.river.comment.valueBetBig", vars);
    case "fold":
      return noteDefense + t("trainer.river.comment.bluffcatchFold", { ...vars, line });
    case "passive":
      if (quiz.type === "value") {
        return note + t(
          (quiz.rangeEquity ?? 0) >= RIVER_THIN_VALUE_MIN
            ? "trainer.river.comment.valueCheckThin"
            : "trainer.river.comment.valueCheckWeak",
          { ...vars, line },
        );
      }
      if (quiz.type === "bluffcatch") {
        return noteDefense + t("trainer.river.comment.bluffcatchCall", { ...vars, line });
      }
      return t("trainer.river.comment.bluffCheck", vars);
  }
}

/** 河牌圈模式（薄价值 / 抓诈 / 诈唬，精确枚举 + 对范围实算胜率判定） */
export function RiverTrainer() {
  const { t } = useI18n();
  // 首题在客户端挂载后再发（Math.random 出题 + 精确枚举/蒙特卡洛，避免 SSR/hydration 不一致）
  const [quiz, setQuiz] = useState<RiverQuiz | null>(null);
  const [loading, setLoading] = useState(true);
  const [answered, setAnswered] = useState<{
    chose: PostflopChoice;
    correct: boolean;
  } | null>(null);
  const [streak, setStreak] = useState(0);
  const [best, setBest] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [total, setTotal] = useState(0);
  const [wrongs, setWrongs] = useState<WrongEntry[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 出题时预计算胜率：先渲染 loading，再让出一拍同步实算（约几十 ms）
  const deal = useCallback(() => {
    setLoading(true);
    setAnswered(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setQuiz(generateRiverQuiz());
      setLoading(false);
    }, 30);
  }, []);

  useEffect(() => {
    deal();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [deal]);

  const answer = (chose: PostflopChoice) => {
    if (!quiz || answered || loading) return;
    const correct = chose === quiz.answer;
    setAnswered({ chose, correct });
    setTotal((v) => v + 1);
    if (correct) {
      setCorrectCount((c) => c + 1);
      setStreak((s) => {
        const next = s + 1;
        setBest((b) => Math.max(b, next));
        return next;
      });
    } else {
      setStreak(0);
      setWrongs((w) =>
        [
          {
            hero: [quiz.hero[0], quiz.hero[1]],
            board: [...quiz.board],
            type: quiz.type,
            // 错题记录判定口径的胜率：价值/抓诈题记对范围胜率，诈唬题记精确胜率
            winPct:
              Math.round((quiz.rangeEquity ?? quiz.equity.win) * 1000) / 10,
            chose,
            expected: quiz.answer,
          },
          ...w,
        ].slice(0, 30),
      );
    }
  };

  const quizSection = (() => {
    if (loading || !quiz) {
      return (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 text-center text-sm text-zinc-500">
          {t("trainer.post.dealing")}
        </section>
      );
    }
    return (
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-zinc-500">
            {t(QUESTION_KEY[quiz.type])}
          </p>
          <PotBadge opponents={quiz.opponents} />
        </div>
        <p className="mb-3 text-sm text-zinc-400">{t(SCENARIO_KEY[quiz.type])}</p>

        <ActionLineBlock lines={quiz.actionLine} />

        <div className="mb-5 space-y-3">
          <div className="flex items-center justify-center gap-2">
            <span className="w-14 text-right text-xs text-zinc-500">{t("trainer.post.board")}</span>
            {quiz.board.map((card) => (
              <PlayingCard key={card} card={card} size="lg" />
            ))}
          </div>
          <div className="flex items-center justify-center gap-2">
            <span className="w-14 text-right text-xs text-zinc-500">{t("trainer.post.yourHand")}</span>
            <PlayingCard card={quiz.hero[0]} size="lg" />
            <PlayingCard card={quiz.hero[1]} size="lg" />
          </div>
        </div>

        {!answered ? (
          <div className="flex gap-3">
            <button
              onClick={() => answer("aggressive")}
              className="flex-1 rounded-lg bg-emerald-500 py-2.5 font-semibold text-zinc-950 transition-colors hover:bg-emerald-400"
            >
              {t(CHOICE_KEY.aggressive)}
            </button>
            <button
              onClick={() => answer("passive")}
              className="flex-1 rounded-lg border border-zinc-700 py-2.5 font-semibold text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              {t(CHOICE_KEY.passive)}
            </button>
            <button
              onClick={() => answer("fold")}
              className="flex-1 rounded-lg border border-red-900 py-2.5 font-semibold text-red-300 transition-colors hover:bg-red-950/40"
            >
              {t(CHOICE_KEY.fold)}
            </button>
          </div>
        ) : (
          <div>
            <div
              className={`mb-3 rounded-lg border p-3 text-sm ${
                answered.correct
                  ? "border-emerald-800 bg-emerald-950/40 text-emerald-300"
                  : "border-red-900 bg-red-950/40 text-red-300"
              }`}
            >
              <span className="font-bold">
                {answered.correct ? t("trainer.correct") : t("trainer.wrong")}——
                {t("trainer.post.shouldBe", { choice: t(CHOICE_KEY[quiz.answer]) })}
              </span>{" "}
              {quizCommentText(quiz, t)}
            </div>
            <div className="mb-3 grid grid-cols-3 gap-2 text-center text-xs">
              <div className="rounded-md bg-zinc-950/60 p-2">
                <div className="text-base font-bold text-emerald-400">
                  {((quiz.rangeEquity ?? quiz.equity.win) * 100).toFixed(1)}%
                </div>
                <div className="text-zinc-500">
                  {/* 价值/抓诈题展示对范围胜率，诈唬题展示精确枚举胜率 */}
                  {t(
                    quiz.type === "value"
                      ? "trainer.river.winVsCaller"
                      : quiz.type === "bluffcatch"
                        ? "trainer.river.winVsPolar"
                        : "trainer.river.winExact",
                  )}
                </div>
              </div>
              <div className="rounded-md bg-zinc-950/60 p-2">
                <div className="text-base font-bold text-zinc-300">
                  {(quiz.equity.tie * 100).toFixed(1)}%
                </div>
                <div className="text-zinc-500">{t("trainer.post.tie")}</div>
              </div>
              <div className="rounded-md bg-zinc-950/60 p-2">
                <div className="text-base font-bold text-red-400">
                  {(quiz.equity.lose * 100).toFixed(1)}%
                </div>
                <div className="text-zinc-500">{t("trainer.post.lose")}</div>
              </div>
            </div>
            <p className="mb-3 text-center text-xs text-zinc-600">
              {t("trainer.river.method", {
                combos: 990,
                value: Math.round(RIVER_VALUE_BET_THRESHOLD * 100),
                catch: Math.round(RIVER_BLUFFCATCH_CALL_THRESHOLD * 100),
                bluff: Math.round(RIVER_BLUFF_MAX_EQUITY * 100),
                showdown: Math.round(RIVER_SHOWDOWN_VALUE_MAX * 100),
              })}
            </p>
            <button
              onClick={deal}
              className="w-full rounded-lg bg-emerald-500 py-2.5 font-semibold text-zinc-950 transition-colors hover:bg-emerald-400"
            >
              {t("trainer.next")}
            </button>
          </div>
        )}
      </section>
    );
  })();

  return (
    <div>
      <p className="mb-4 text-sm text-zinc-400">{t("trainer.river.rule")}</p>

      <TrainerStatsBar
        streak={streak}
        best={best}
        correctCount={correctCount}
        total={total}
        wrongCount={wrongs.length}
      />

      {quizSection}

      {/* 错题回顾 */}
      {wrongs.length > 0 && (
        <section className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <h2 className="mb-2 text-sm font-semibold text-zinc-300">
            {t("trainer.wrongReview", { n: wrongs.length })}
          </h2>
          <ul className="space-y-1 text-sm">
            {wrongs.map((w, i) => (
              <li
                key={`${w.hero.join("")}-${w.board.join("")}-${i}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-zinc-950/60 px-3 py-1.5"
              >
                <span className="font-medium text-zinc-200">
                  {w.hero.join(" ")}
                  <span className="mx-1 text-zinc-600">|</span>
                  <span className="text-zinc-400">{w.board.join(" ")}</span>
                </span>
                <span className="text-zinc-500">
                  {t("trainer.post.wrongMeta", {
                    type: t(WRONG_TYPE_KEY[w.type]),
                    pct: w.winPct,
                  })}
                </span>
                <span>
                  <span className="text-red-400">
                    {t("trainer.youChose", { choice: t(CHOICE_KEY[w.chose]) })}
                  </span>
                  <span className="text-zinc-600"> → </span>
                  <span className="text-emerald-400">
                    {t("trainer.expected", { choice: t(CHOICE_KEY[w.expected]) })}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
