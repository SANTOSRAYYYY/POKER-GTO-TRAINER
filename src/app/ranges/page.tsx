"use client";

import { useMemo, useState } from "react";
import { Nav } from "@/components/history/Nav";
import { useI18n } from "@/lib/i18n";
import type { DictKey } from "@/lib/i18n/dict";
import {
  MATRIX_RANKS,
  RANGE_TABLES,
  handLabel,
  type PreflopRangeTable,
  type RangeAction,
} from "@/lib/gto/ranges";

const ACTION_CELL_CLASS: Record<RangeAction, string> = {
  raise: "bg-emerald-500/80 text-zinc-950 hover:bg-emerald-400",
  call: "bg-sky-800/70 text-sky-100 hover:bg-sky-700",
  fold: "bg-zinc-800/50 text-zinc-600 hover:bg-zinc-800",
};

const GROUP_LABEL_KEY: Record<PreflopRangeTable["group"], DictKey> = {
  nine_max: "ranges.group.nine_max",
  heads_up: "ranges.group.heads_up",
};

/** 范围表名称/说明的字典 key（lib/gto/ranges 的 name/description 为内容数据，这里按 id 做双语展示映射） */
const TABLE_NAME_KEY: Record<string, DictKey> = {
  utg: "ranges.table.utg",
  utg1: "ranges.table.utg1",
  lj: "ranges.table.lj",
  hj: "ranges.table.hj",
  co: "ranges.table.co",
  btn: "ranges.table.btn",
  sb: "ranges.table.sb",
  btn_open: "ranges.table.btn_open",
  bb_defend: "ranges.table.bb_defend",
};

const TABLE_DESC_KEY: Record<string, DictKey> = {
  utg: "ranges.desc.utg",
  utg1: "ranges.desc.utg1",
  lj: "ranges.desc.lj",
  hj: "ranges.desc.hj",
  co: "ranges.desc.co",
  btn: "ranges.desc.btn",
  sb: "ranges.desc.sb",
  btn_open: "ranges.desc.btn_open",
  bb_defend: "ranges.desc.bb_defend",
};

const ACTION_LABEL_KEY: Record<RangeAction, DictKey> = {
  raise: "action.raise",
  call: "action.call",
  fold: "action.fold",
};

const ACTION_HINT_KEY: Record<RangeAction, DictKey> = {
  raise: "ranges.hint.raise",
  call: "ranges.hint.call",
  fold: "ranges.hint.fold",
};

export default function RangesPage() {
  const { t } = useI18n();
  const [tableId, setTableId] = useState(RANGE_TABLES[0].id);
  const [hovered, setHovered] = useState<{ row: number; col: number } | null>(null);

  const table = useMemo(
    () => RANGE_TABLES.find((tb) => tb.id === tableId) ?? RANGE_TABLES[0],
    [tableId],
  );

  const summary = useMemo(() => {
    const count: Record<RangeAction, number> = { raise: 0, call: 0, fold: 0 };
    for (const row of table.matrix) for (const a of row) count[a] += 1;
    const playable = 169 - count.fold;
    return { count, playablePct: Math.round((playable / 169) * 100) };
  }, [table]);

  const hoverInfo = hovered
    ? {
        hand: handLabel(hovered.row, hovered.col),
        action: table.matrix[hovered.row][hovered.col],
      }
    : null;

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <Nav />
      <div className="mx-auto max-w-4xl px-4 py-6">
        <h1 className="mb-1 text-2xl font-bold">{t("ranges.title")}</h1>
        <p className="mb-4 text-sm text-zinc-400">
          {t("ranges.subtitle")}
        </p>

        {/* 范围切换（按牌桌规模分组） */}
        <div className="mb-3 space-y-2">
          {(["nine_max", "heads_up"] as const).map((g) => (
            <div key={g} className="flex flex-wrap items-center gap-2">
              <span className="w-20 shrink-0 text-xs text-zinc-500">{t(GROUP_LABEL_KEY[g])}</span>
              {RANGE_TABLES.filter((tb) => tb.group === g).map((tb) => (
                <button
                  key={tb.id}
                  onClick={() => setTableId(tb.id)}
                  className={`rounded-lg px-3 py-1.5 text-sm transition-colors max-md:py-2.5 ${
                    tb.id === tableId
                      ? "bg-emerald-500/15 font-medium text-emerald-400"
                      : "bg-zinc-800/60 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {t(TABLE_NAME_KEY[tb.id] ?? "ranges.title")}
                </button>
              ))}
            </div>
          ))}
        </div>
        <p className="mb-3 text-sm text-zinc-500">{t(TABLE_DESC_KEY[table.id] ?? "ranges.title")}</p>

        {/* 悬停信息 + 统计 */}
        <div className="mb-4 flex min-h-12 flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-2">
          {hoverInfo ? (
            <>
              <span className="font-mono text-lg font-bold text-zinc-100">{hoverInfo.hand}</span>
              <ActionBadge action={hoverInfo.action} />
              <span className="text-sm text-zinc-400">{t(ACTION_HINT_KEY[hoverInfo.action])}</span>
            </>
          ) : (
            <span className="text-sm text-zinc-500">{t("ranges.hoverTip")}</span>
          )}
          <span className="ml-auto text-xs text-zinc-500">
            {t("ranges.summary", {
              pct: summary.playablePct,
              raise: summary.count.raise,
              call: summary.count.call,
              fold: summary.count.fold,
            })}
          </span>
        </div>

        {/* 13x13 矩阵：桌面 min-w-560；移动端抬到 596px 使每格触控边长 ≥44px
            （容器 overflow-x-auto 横向滑动查看） */}
        <div className="overflow-x-auto">
          <div
            className="grid min-w-[560px] gap-0.5 max-md:min-w-[596px]"
            style={{ gridTemplateColumns: "repeat(13, minmax(0, 1fr))" }}
          >
            {MATRIX_RANKS.map((_, row) =>
              MATRIX_RANKS.map((_, col) => {
                const action = table.matrix[row][col];
                const label = handLabel(row, col);
                return (
                  <button
                    key={`${row}-${col}`}
                    title={`${label} — ${t(ACTION_LABEL_KEY[action])}`}
                    onMouseEnter={() => setHovered({ row, col })}
                    onFocus={() => setHovered({ row, col })}
                    className={`flex aspect-square items-center justify-center rounded-sm font-mono text-[11px] font-semibold transition-colors sm:text-xs ${ACTION_CELL_CLASS[action]}`}
                  >
                    {label}
                  </button>
                );
              }),
            )}
          </div>
        </div>

        {/* 图例 */}
        <div className="mt-4 flex flex-wrap gap-4 text-sm">
          {(["raise", "call", "fold"] as RangeAction[]).map((a) => (
            <span key={a} className="flex items-center gap-2 text-zinc-400">
              <span className={`inline-block h-4 w-4 rounded-sm ${ACTION_CELL_CLASS[a].split(" ")[0]}`} />
              {t(ACTION_LABEL_KEY[a])}
            </span>
          ))}
        </div>
      </div>
    </main>
  );
}

function ActionBadge({ action }: { action: RangeAction }) {
  const { t } = useI18n();
  const cls: Record<RangeAction, string> = {
    raise: "bg-emerald-500/15 text-emerald-300",
    call: "bg-sky-500/15 text-sky-300",
    fold: "bg-zinc-700/40 text-zinc-400",
  };
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls[action]}`}>
      {t("ranges.suggest", { action: t(ACTION_LABEL_KEY[action]) })}
    </span>
  );
}
