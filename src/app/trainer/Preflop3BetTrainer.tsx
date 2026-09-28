"use client";

import { useEffect, useState } from "react";
import { PlayingCard } from "@/components/history/PlayingCard";
import { useI18n } from "@/lib/i18n";
import type { DictKey } from "@/lib/i18n/dict";
import {
  FOURBET_THRESHOLD,
  generatePreflop3BetQuiz,
  THREEBET_CALL_THRESHOLD,
  THREEBET_RANGE_TIGHT,
  type Preflop3BetQuiz,
  type ThreeBetChoice,
} from "@/lib/gto/preflop3betQuiz";
import { ActionLineBlock } from "./ActionLine";
import { TrainerStatsBar } from "./StatsBar";

type TFunc = (key: DictKey, vars?: Record<string, string | number>) => string;

interface WrongEntry {
  label: string;
  position: string;
  tight: boolean;
  eqPct: number;
  chose: ThreeBetChoice;
  expected: ThreeBetChoice;
}

const CHOICE_KEY: Record<ThreeBetChoice, DictKey> = {
  fourbet: "trainer.3bet.choice.fourbet",
  call: "action.call",
  fold: "action.fold",
};

function rangeKey(tight: boolean): DictKey {
  return tight ? "trainer.3bet.range.tight" : "trainer.3bet.range.loose";
}

/** 判定后的一句话点评（与 lib/gto/preflop3betQuiz.threeBetQuizComment 同逻辑、走字典双语） */
function quizCommentText(quiz: Preflop3BetQuiz, t: TFunc): string {
  const vars = {
    label: quiz.handLabel,
    range: t(rangeKey(quiz.threeBetRangePct === THREEBET_RANGE_TIGHT)),
    pct: Math.round(quiz.threeBetRangePct * 100),
    eq: (quiz.equity * 100).toFixed(1),
  };
  switch (quiz.answer) {
    case "fourbet":
      return t("trainer.3bet.comment.fourbet", vars);
    case "call":
      return t("trainer.3bet.comment.call", vars);
    case "fold":
      return t("trainer.3bet.comment.fold", vars);
  }
}

/** 翻前 3bet 应对模式（BTN/CO 开局遇盲注位 3bet，静态表胜率判定） */
export function Preflop3BetTrainer() {
  const { t } = useI18n();
  // 首题在客户端挂载后再发（Math.random 出题，避免 SSR/hydration 不一致）
  const [quiz, setQuiz] = useState<Preflop3BetQuiz | null>(null);
  useEffect(() => {
    setQuiz(generatePreflop3BetQuiz());
  }, []);
  const [answered, setAnswered] = useState<{
    chose: ThreeBetChoice;
    correct: boolean;
  } | null>(null);
  const [streak, setStreak] = useState(0);
  const [best, setBest] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [total, setTotal] = useState(0);
  const [wrongs, setWrongs] = useState<WrongEntry[]>([]);

  const answer = (chose: ThreeBetChoice) => {
    if (!quiz || answered) return;
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
            label: quiz.handLabel,
            position: quiz.position,
            tight: quiz.threeBetRangePct === THREEBET_RANGE_TIGHT,
            eqPct: Math.round(quiz.equity * 1000) / 10,
            chose,
            expected: quiz.answer,
          },
          ...w,
        ].slice(0, 30),
      );
    }
  };

  const next = () => {
    setQuiz(generatePreflop3BetQuiz());
    setAnswered(null);
  };

  const quizSection = (() => {
    if (!quiz) {
      return (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 text-center text-sm text-zinc-500">
          {t("trainer.pf.dealing")}
        </section>
      );
    }
    return (
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <ActionLineBlock lines={quiz.actionLine} />
        <p className="mb-4 text-sm text-zinc-400">
          {t("trainer.3bet.scene", {
            range: t(rangeKey(quiz.threeBetRangePct === THREEBET_RANGE_TIGHT)),
            pct: Math.round(quiz.threeBetRangePct * 100),
          })}
        </p>
        <div className="mb-5 flex items-center justify-center gap-3">
          <PlayingCard card={quiz.hero[0]} size="lg" />
          <PlayingCard card={quiz.hero[1]} size="lg" />
          <span className="ml-2 text-lg font-semibold text-zinc-300">
            {quiz.handLabel}
          </span>
        </div>

        {!answered ? (
          <div className="flex gap-3">
            <button
              onClick={() => answer("fourbet")}
              className="flex-1 rounded-lg bg-emerald-500 py-2.5 font-semibold text-zinc-950 transition-colors hover:bg-emerald-400"
            >
              {t(CHOICE_KEY.fourbet)}
            </button>
            <button
              onClick={() => answer("call")}
              className="flex-1 rounded-lg border border-zinc-700 py-2.5 font-semibold text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              {t(CHOICE_KEY.call)}
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
            <div className="mb-3 text-center">
              <div className="inline-block rounded-md bg-zinc-950/60 px-4 py-2">
                <div className="text-base font-bold text-emerald-400">
                  {(quiz.equity * 100).toFixed(1)}%
                </div>
                <div className="text-xs text-zinc-500">{t("trainer.3bet.winVs3bet")}</div>
              </div>
            </div>
            <p className="mb-3 text-center text-xs text-zinc-600">
              {t("trainer.3bet.method", {
                fourbet: Math.round(FOURBET_THRESHOLD * 100),
                call: Math.round(THREEBET_CALL_THRESHOLD * 100),
              })}
            </p>
            <button
              onClick={next}
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
      <p className="mb-4 text-sm text-zinc-400">{t("trainer.3bet.rule")}</p>

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
                key={`${w.label}-${w.position}-${i}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-zinc-950/60 px-3 py-1.5"
              >
                <span className="font-medium text-zinc-200">{w.label}</span>
                <span className="text-zinc-500">
                  {t("trainer.3bet.wrongMeta", {
                    pos: w.position,
                    range: t(rangeKey(w.tight)),
                    pct: w.eqPct,
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
