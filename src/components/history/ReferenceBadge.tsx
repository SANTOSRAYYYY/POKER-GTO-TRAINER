"use client";

/**
 * src/components/history/ReferenceBadge.tsx — 决策点 GTO 参考线徽章
 *
 * 回放页 hero 决策点旁的引擎参考：实算胜率 + 建议动作倾向。
 * 惰性计算：初始只是一枚小按钮，点击后才跑 referenceLine（equityMulti
 * 蒙特卡洛，约几十 ms），期间显示「计算中…」；结果写入模块级缓存，
 * 同一点位（handId:streetIdx:actionIdx）不重复计算。
 */
import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { DictKey } from "@/lib/i18n/dict";
import {
  referenceLine,
  type GtoTendency,
  type ReferenceInput,
  type ReferenceLine,
} from "@/lib/gto/reference";

/** 同一点位的计算结果缓存（会话内有效；key = handId:streetIdx:actionIdx） */
const resultCache = new Map<string, ReferenceLine>();

function tendencyLabelKey(tendency: GtoTendency, facingBet: boolean): DictKey {
  switch (tendency) {
    case "raise":
      return facingBet ? "action.raise" : "action.bet";
    case "call":
      return "action.call";
    case "fold":
      return "action.fold";
    case "check":
      return "action.check";
  }
}

/** 配色：胜率高（strong 进攻/跟注）→ emerald；fold 建议 → rose；边际/过牌 → zinc */
function badgeClass(line: ReferenceLine): string {
  if (line.confidence === "marginal" || line.tendency === "check") {
    return "border-zinc-600 bg-zinc-800/40 text-zinc-400";
  }
  if (line.tendency === "fold") {
    return "border-rose-700 bg-rose-950/40 text-rose-300";
  }
  return "border-emerald-700 bg-emerald-950/40 text-emerald-300";
}

export function ReferenceBadge({
  input,
  cacheKey,
}: {
  input: ReferenceInput;
  cacheKey: string;
}) {
  const { t } = useI18n();
  const cached = resultCache.get(cacheKey);
  const [line, setLine] = useState<ReferenceLine | null>(cached ?? null);
  const [loading, setLoading] = useState(false);

  const onCompute = () => {
    if (loading || line) return;
    setLoading(true);
    // 让出一帧渲染 loading 微态，再同步跑蒙特卡洛
    window.setTimeout(() => {
      const result = referenceLine(input);
      resultCache.set(cacheKey, result);
      setLine(result);
      setLoading(false);
    }, 30);
  };

  if (line) {
    const facingBet = input.callAmount > 0;
    return (
      <span
        title={t("ref.disclaimer")}
        className={`ml-2 inline-flex items-center gap-1 rounded border px-1.5 py-0 text-[10px] ${badgeClass(line)}`}
      >
        {t("ref.badge", {
          pct: Math.round(line.equity * 100),
          tendency: t(tendencyLabelKey(line.tendency, facingBet)),
        })}
        {line.confidence === "marginal" ? t("ref.marginal") : ""}
      </span>
    );
  }

  if (loading) {
    return (
      <span className="ml-2 rounded border border-zinc-700 px-1.5 py-0 text-[10px] text-zinc-500">
        {t("ref.computing")}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onCompute}
      title={t("ref.buttonTitle", { disclaimer: t("ref.disclaimer") })}
      className="ml-2 rounded border border-dashed border-zinc-700 px-1.5 py-0 text-[10px] text-zinc-500 transition-colors hover:border-zinc-500 hover:text-zinc-300"
    >
      {t("ref.button")}
    </button>
  );
}
