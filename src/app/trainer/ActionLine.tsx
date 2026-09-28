"use client";

import { useI18n } from "@/lib/i18n";
import type { LocalizedText } from "@/lib/gto/actionLine";

/**
 * 行动路线块：卡片内牌面上方，多行浅灰小字渲染出题器附带的完整前序行动
 * （谁翻前加注、谁持续下注、尺度多大），zh/en 按当前语言逐行切换。
 */
export function ActionLineBlock({ lines }: { lines: LocalizedText[] }) {
  const { t, lang } = useI18n();
  if (lines.length === 0) return null;
  return (
    <div className="mb-4 rounded-md bg-zinc-950/60 px-3 py-2">
      <p className="mb-1 text-xs font-medium text-zinc-500">
        {t("trainer.actionLine")}
      </p>
      <ul className="space-y-0.5 text-xs text-zinc-400">
        {lines.map((line, i) => (
          <li key={i}>{line[lang]}</li>
        ))}
      </ul>
    </div>
  );
}
