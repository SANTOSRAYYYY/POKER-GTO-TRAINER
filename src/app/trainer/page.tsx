"use client";

import { useState } from "react";
import { Nav } from "@/components/history/Nav";
import { useI18n } from "@/lib/i18n";
import type { DictKey } from "@/lib/i18n/dict";
import { PushFoldTrainer } from "./PushFoldTrainer";
import { Preflop3BetTrainer } from "./Preflop3BetTrainer";
import { PostflopTrainer } from "./PostflopTrainer";
import { TurnTrainer } from "./TurnTrainer";
import { RiverTrainer } from "./RiverTrainer";

/**
 * 五个独立 tab 而非「转牌·河牌合并」：每族题型的统计与错题回顾要求独立计数，
 * 独立 tab 下各组件沿用同一模式（各自 StatsBar + 错题列表）即可满足；
 * 合并 tab 需要在组件内再切分两套计数，结构与既有组件不一致。
 * 标签保持短词（翻前 Push/Fold / 翻前 3bet / 翻牌圈 / 转牌圈 / 河牌圈），
 * 移动端用 text-xs 收窄。首个 tab 仍是 Push/Fold（e2e 依赖默认页的「全下」按钮）。
 */
type Mode = "pushfold" | "threebet" | "postflop" | "turn" | "river";

const TABS: { key: Mode; labelKey: DictKey }[] = [
  { key: "pushfold", labelKey: "trainer.tab.pushfold" },
  { key: "threebet", labelKey: "trainer.tab.threebet" },
  { key: "postflop", labelKey: "trainer.tab.postflop" },
  { key: "turn", labelKey: "trainer.tab.turn" },
  { key: "river", labelKey: "trainer.tab.river" },
];

export default function TrainerPage() {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>("pushfold");

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <Nav />
      <div className="mx-auto max-w-3xl px-4 py-6">
        <h1 className="mb-1 text-2xl font-bold">{t("trainer.title")}</h1>
        <p className="mb-4 text-sm text-zinc-400">
          {t("trainer.subtitle")}
        </p>

        {/* 模式切换 tab */}
        <div className="mb-5 flex gap-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-1">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setMode(tab.key)}
              className={`flex-1 rounded-md px-1 py-2 text-xs font-medium transition-colors sm:text-sm ${
                mode === tab.key
                  ? "bg-emerald-500/15 text-emerald-400"
                  : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
              }`}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>

        {mode === "pushfold" && <PushFoldTrainer />}
        {mode === "threebet" && <Preflop3BetTrainer />}
        {mode === "postflop" && <PostflopTrainer />}
        {mode === "turn" && <TurnTrainer />}
        {mode === "river" && <RiverTrainer />}
      </div>
    </main>
  );
}
