"use client";

import { useGameStore } from "@/lib/store/gameStore";
import { useI18n } from "@/lib/i18n";

/**
 * 锦标赛 HUD：当前盲注级别（sb/bb/ante）、距升级剩余手数、剩余人数、hero 名次。
 * 仅锦标赛模式渲染。
 */
export default function TournamentHud() {
  const { t } = useI18n();
  const mode = useGameStore((s) => s.mode);
  const game = useGameStore((s) => s.game);
  const tournamentConfig = useGameStore((s) => s.tournamentConfig);
  const blindLevel = useGameStore((s) => s.blindLevel);
  const levelHandsLeft = useGameStore((s) => s.levelHandsLeft);
  const eliminated = useGameStore((s) => s.eliminated);
  const seats = useGameStore((s) => s.seats);
  const finishPlaces = useGameStore((s) => s.finishPlaces);
  const tournamentOver = useGameStore((s) => s.tournamentOver);

  if (mode !== "tournament" || !tournamentConfig) return null;

  const aliveCount = eliminated.length > 0 ? eliminated.filter((e) => !e).length : seats;
  const totalLevels = tournamentConfig.levels.length;
  const heroPlace = finishPlaces[0];

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 border-b border-neutral-800 bg-purple-950/40 px-4 py-1.5 text-xs text-purple-200">
      <span className="font-semibold">
        {t("tour.level", { level: blindLevel + 1 })}
        <span className="text-purple-400">/{totalLevels}</span>
      </span>
      {game && (
        <span className="tabular-nums">
          {t("tour.blinds", { sb: game.smallBlind, bb: game.bigBlind })}
          {game.ante > 0 && ` (ante ${game.ante})`}
        </span>
      )}
      <span>
        {t("tour.toLevelUp")}{" "}
        <span className="font-bold tabular-nums text-amber-300">{levelHandsLeft}</span>{" "}
        {t("tour.handsSuffix")}
      </span>
      <span>
        {t("tour.remaining")}{" "}
        <span className="font-bold tabular-nums text-emerald-300">{aliveCount}</span>/{seats}{" "}
        {t("tour.playersSuffix")}
      </span>
      <span>
        {tournamentOver
          ? heroPlace === 1
            ? t("tour.youChampion")
            : t("tour.endedPlace", { place: heroPlace ?? "?" })
          : heroPlace !== null
            ? t("tour.eliminatedPlace", { place: heroPlace })
            : t("tour.goal", { n: aliveCount })}
      </span>
    </div>
  );
}
