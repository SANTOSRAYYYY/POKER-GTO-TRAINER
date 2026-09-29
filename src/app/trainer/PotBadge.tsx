"use client";

import { useI18n } from "@/lib/i18n";
import type { DictKey } from "@/lib/i18n/dict";
import type { OpponentCount } from "@/lib/gto/multiway";

const BADGE_KEY: Record<OpponentCount, DictKey> = {
  1: "trainer.pot.headsUp",
  2: "trainer.pot.threeWay",
  3: "trainer.pot.fourWay",
};

/**
 * 底池人数徽标：单挑 / 三人池 / 四人池。多人池用琥珀色强调——
 * 多人池判定口径见 lib/gto/multiway.ts（进攻联合采样压全场 / 防守只对下注者、
 * 身后跟注者视为死钱）。
 */
export function PotBadge({ opponents }: { opponents: OpponentCount }) {
  const { t } = useI18n();
  const cls =
    opponents === 1
      ? "border-zinc-700 text-zinc-400"
      : "border-amber-700 bg-amber-950/40 text-amber-300";
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cls}`}
    >
      {t(BADGE_KEY[opponents])}
    </span>
  );
}
