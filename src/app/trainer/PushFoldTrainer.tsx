"use client";

import { useEffect, useState } from "react";
import { PlayingCard } from "@/components/history/PlayingCard";
import { useI18n } from "@/lib/i18n";
import type { DictKey } from "@/lib/i18n/dict";
import {
  PUSH_COMBO_PCT,
  cardsToHandType,
  nearestTableDepth,
  pushFoldAction,
  type PushFoldAction,
  type PushFoldDepth,
} from "@/lib/gto/pushfold";
import type { Card, Rank, Suit } from "@/lib/types";
import { TrainerStatsBar } from "./StatsBar";

const RANKS: Rank[] = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];
const SUITS: Suit[] = ["s", "h", "d", "c"];
const DECK: Card[] = SUITS.flatMap((s) => RANKS.map((r) => `${r}${s}` as Card));

type TFunc = (key: DictKey, vars?: Record<string, string | number>) => string;

interface Quiz {
  cards: [Card, Card];
  stackBB: number;
}

/** 随机出一道题：单挑 SB（BTN）位两张底牌 + 5-15bb 随机整数深度 */
function dealQuiz(): Quiz {
  const i = Math.floor(Math.random() * DECK.length);
  let j = Math.floor(Math.random() * (DECK.length - 1));
  if (j >= i) j++;
  return {
    cards: [DECK[i], DECK[j]],
    stackBB: 5 + Math.floor(Math.random() * 11),
  };
}

interface WrongEntry {
  label: string;
  stackBB: number;
  depth: number;
  chose: PushFoldAction;
  expected: PushFoldAction;
}

/** 判定后的一句话点评（Nash 近似表口径） */
function verdictText(
  label: string,
  pair: boolean,
  expected: PushFoldAction,
  stackBB: number,
  depth: PushFoldDepth,
  t: TFunc,
): string {
  const quant =
    stackBB !== depth ? t("trainer.pf.note.quant", { bb: stackBB, depth }) : "";
  if (pair) return t("trainer.pf.note.pair", { quant, label });
  const pct = PUSH_COMBO_PCT[depth];
  if (expected === "push") {
    return t("trainer.pf.note.push", { quant, label, depth, pct });
  }
  return t("trainer.pf.note.fold", { quant, label, depth, pct });
}

/** 翻前 push/fold 模式（单挑 SB 位 5-15bb，Nash 近似表） */
export function PushFoldTrainer() {
  const { t } = useI18n();
  // 首题在客户端挂载后再发（Math.random 出题，避免 SSR/hydration 不一致）
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  useEffect(() => {
    setQuiz(dealQuiz());
  }, []);
  const [answered, setAnswered] = useState<{
    chose: PushFoldAction;
    correct: boolean;
  } | null>(null);
  const [streak, setStreak] = useState(0);
  const [best, setBest] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [total, setTotal] = useState(0);
  const [wrongs, setWrongs] = useState<WrongEntry[]>([]);

  const answer = (chose: PushFoldAction) => {
    if (!quiz || answered) return;
    const hand = cardsToHandType(quiz.cards[0], quiz.cards[1]);
    const depth = nearestTableDepth(quiz.stackBB);
    const expected = pushFoldAction(hand.hi, hand.lo, hand.suited, depth);
    const correct = chose === expected;
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
            label: hand.label,
            stackBB: quiz.stackBB,
            depth,
            chose,
            expected,
          },
          ...w,
        ].slice(0, 30),
      );
    }
  };

  const next = () => {
    setQuiz(dealQuiz());
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
    const hand = cardsToHandType(quiz.cards[0], quiz.cards[1]);
    const depth = nearestTableDepth(quiz.stackBB);
    const expected = pushFoldAction(hand.hi, hand.lo, hand.suited, depth);
    return (
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <p className="mb-4 text-sm text-zinc-400">
          {t("trainer.pf.scene1")}
          <span className="font-medium text-zinc-200">{t("trainer.pf.scenePos")}</span>
          {t("trainer.pf.scene2")}
          <span className="font-bold text-emerald-400">{quiz.stackBB}bb</span>
          {t("trainer.pf.scene3")}
        </p>
        <div className="mb-5 flex items-center justify-center gap-3">
          <PlayingCard card={quiz.cards[0]} size="lg" />
          <PlayingCard card={quiz.cards[1]} size="lg" />
          <span className="ml-2 text-lg font-semibold text-zinc-300">
            {hand.label}
          </span>
        </div>

        {!answered ? (
          <div className="flex gap-3">
            <button
              onClick={() => answer("push")}
              className="flex-1 rounded-lg bg-emerald-500 py-2.5 font-semibold text-zinc-950 transition-colors hover:bg-emerald-400"
            >
              {t("action.allin")}
            </button>
            <button
              onClick={() => answer("fold")}
              className="flex-1 rounded-lg border border-zinc-700 py-2.5 font-semibold text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              {t("action.fold")}
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
                {expected === "push" ? t("trainer.pf.verdictPush") : t("trainer.pf.verdictFold")}
              </span>{" "}
              {verdictText(
                hand.label,
                hand.hi === hand.lo,
                expected,
                quiz.stackBB,
                depth,
                t,
              )}
            </div>
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
      <p className="mb-4 text-sm text-zinc-400">
        {t("trainer.pf.rule")}
      </p>

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
                key={`${w.label}-${w.stackBB}-${i}`}
                className="flex items-center justify-between gap-2 rounded-md bg-zinc-950/60 px-3 py-1.5"
              >
                <span className="font-medium text-zinc-200">{w.label}</span>
                <span className="text-zinc-500">
                  {t("trainer.pf.depthNote", { bb: w.stackBB, depth: w.depth })}
                </span>
                <span>
                  <span className="text-red-400">
                    {t("trainer.youChose", {
                      choice: t(w.chose === "push" ? "action.allin" : "action.fold"),
                    })}
                  </span>
                  <span className="text-zinc-600"> → </span>
                  <span className="text-emerald-400">
                    {t("trainer.expected", {
                      choice: t(w.expected === "push" ? "action.allin" : "action.fold"),
                    })}
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
