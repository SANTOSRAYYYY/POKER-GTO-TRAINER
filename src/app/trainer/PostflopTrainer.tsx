"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PlayingCard } from "@/components/history/PlayingCard";
import { useI18n } from "@/lib/i18n";
import type { DictKey } from "@/lib/i18n/dict";
import {
  ATTACK_EQUITY_THRESHOLD,
  DEFENSE_CALL_THRESHOLD,
  DEFENSE_RAISE_THRESHOLD,
  defenseRangeSpecFor,
  generatePostflopQuiz,
  isStrongDraw,
  type PostflopChoice,
  type PostflopQuiz,
  type ScenarioType,
} from "@/lib/gto/postflopQuiz";
import {
  flopAttackLine,
  flopDefenseCallLine,
  flopDefenseRaiseLine,
  potPlayers,
} from "@/lib/gto/multiway";
import { ActionLineBlock } from "./ActionLine";
import { PotBadge } from "./PotBadge";
import { TrainerStatsBar } from "./StatsBar";

type TFunc = (key: DictKey, vars?: Record<string, string | number>) => string;

interface WrongEntry {
  hero: string[];
  board: string[];
  type: ScenarioType;
  winPct: number;
  chose: PostflopChoice;
  expected: PostflopChoice;
}

const SCENARIO_KEY: Record<ScenarioType, DictKey> = {
  attack: "trainer.post.scenario.attack",
  defense: "trainer.post.scenario.defense",
};

const CHOICE_KEY: Record<PostflopChoice, DictKey> = {
  aggressive: "trainer.choice.aggressive",
  passive: "trainer.choice.passive",
  fold: "action.fold",
};

/** 判定后的一句话简评（与 lib/gto/postflopQuiz.quizComment 同逻辑、走字典双语；范围宽度随行动线；多人池带底池人数提示与动态门槛） */
function quizCommentText(quiz: PostflopQuiz, t: TFunc): string {
  const pct = (quiz.equity.win * 100).toFixed(1);
  const dPct =
    quiz.defenseEquity !== null
      ? (quiz.defenseEquity * 100).toFixed(1)
      : pct;
  const tie =
    quiz.equity.tie >= 0.005
      ? t("trainer.post.tieNote", { pct: (quiz.equity.tie * 100).toFixed(1) })
      : "";
  const rpct = Math.round(defenseRangeSpecFor(quiz.lineKind).topPct * 100);
  const atk = Math.round(flopAttackLine(quiz.opponents) * 100);
  const raise = Math.round(flopDefenseRaiseLine(quiz.opponents) * 100);
  const call = Math.round(flopDefenseCallLine(quiz.opponents) * 100);
  const note =
    quiz.opponents > 1
      ? t("trainer.pot.note", { n: potPlayers(quiz.opponents) })
      : "";
  const noteDefense =
    quiz.opponents > 1
      ? t("trainer.pot.noteDefense", { n: potPlayers(quiz.opponents) })
      : "";
  switch (quiz.answer) {
    case "aggressive":
      if (quiz.type === "attack") {
        if (
          quiz.equity.win < flopAttackLine(quiz.opponents) &&
          isStrongDraw(quiz.draws)
        ) {
          // 半诈唬进攻（仅单挑可达：多人池不放宽）
          const drawParts: string[] = [];
          if (quiz.draws.straightOuts >= 8)
            drawParts.push(t("trainer.post.draw.straight", { outs: quiz.draws.straightOuts }));
          if (quiz.draws.flushDraw) drawParts.push(t("trainer.post.draw.flush"));
          return t("trainer.post.comment.attackSemibluff", {
            pct,
            tie,
            draw: drawParts.join(" + "),
          });
        }
        return note + t("trainer.post.comment.attackAggressive", { pct, tie, atk });
      }
      return noteDefense + t("trainer.post.comment.defenseAggressive", {
        pct: quiz.defenseEquity !== null ? dPct : pct,
        tie,
        rpct,
        raise,
      });
    case "fold":
      return noteDefense + t("trainer.post.comment.fold", { pct: dPct, tie, rpct, call });
    case "passive":
      if (quiz.type === "attack") {
        if (quiz.opponents > 1 && isStrongDraw(quiz.draws)) {
          // 多人池不放宽半诈唬：强听牌也只够过牌
          const drawParts: string[] = [];
          if (quiz.draws.straightOuts >= 8)
            drawParts.push(t("trainer.post.draw.straight", { outs: quiz.draws.straightOuts }));
          if (quiz.draws.flushDraw) drawParts.push(t("trainer.post.draw.flush"));
          return note + t("trainer.post.comment.attackPassiveMulti", {
            pct,
            tie,
            draw: drawParts.join(" + "),
          });
        }
        return note + t("trainer.post.comment.attackPassive", { pct, tie });
      }
      return noteDefense + t("trainer.post.comment.defensePassive", {
        pct: dPct,
        tie,
        rpct,
        call,
        raise,
      });
  }
}

/** 翻后特训模式（翻牌圈场景，实算胜率判定） */
export function PostflopTrainer() {
  const { t } = useI18n();
  // 首题在客户端挂载后再发（Math.random 出题 + 蒙特卡洛，避免 SSR/hydration 不一致）
  const [quiz, setQuiz] = useState<PostflopQuiz | null>(null);
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

  // 出题时预计算胜率：先渲染 loading，再让出一拍同步跑 2000 次蒙特卡洛（约几十 ms）
  const deal = useCallback(() => {
    setLoading(true);
    setAnswered(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setQuiz(generatePostflopQuiz());
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
            board: [quiz.board[0], quiz.board[1], quiz.board[2]],
            type: quiz.type,
            winPct: Math.round(quiz.equity.win * 1000) / 10,
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
            {quiz.type === "attack" ? t("trainer.post.attackQ") : t("trainer.post.defenseQ")}
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
                  {/* 防守题展示对下注者范围的判定胜率（与点评/答案同口径） */}
                  {(
                    (quiz.defenseEquity ?? quiz.equity.win) * 100
                  ).toFixed(1)}
                  %
                </div>
                <div className="text-zinc-500">
                  {quiz.defenseEquity !== null
                    ? t("trainer.post.winVsRange")
                    : t("trainer.post.win")}
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
              {t("trainer.post.method", {
                attack: Math.round(ATTACK_EQUITY_THRESHOLD * 100),
                raise: Math.round(DEFENSE_RAISE_THRESHOLD * 100),
                call: Math.round(DEFENSE_CALL_THRESHOLD * 100),
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
      <p className="mb-4 text-sm text-zinc-400">
        {t("trainer.post.rule")}
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
                    type: t(w.type === "attack" ? "trainer.post.attackQ" : "trainer.post.defenseShort"),
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
