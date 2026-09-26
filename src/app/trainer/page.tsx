"use client";

import { useState } from "react";
import { Nav } from "@/components/history/Nav";
import { useI18n } from "@/lib/i18n";
import type { DictKey } from "@/lib/i18n/dict";
import { PushFoldTrainer } from "./PushFoldTrainer";
import { PostflopTrainer } from "./PostflopTrainer";

type Mode = "pushfold" | "postflop";

const TABS: { key: Mode; labelKey: DictKey }[] = [
  { key: "pushfold", labelKey: "trainer.tab.pushfold" },
  { key: "postflop", labelKey: "trainer.tab.postflop" },
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
              className={`flex-1 rounded-md py-2 text-sm font-medium transition-colors ${
                mode === tab.key
                  ? "bg-emerald-500/15 text-emerald-400"
                  : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
              }`}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>

        {mode === "pushfold" ? <PushFoldTrainer /> : <PostflopTrainer />}
      </div>
    </main>
  );
}
