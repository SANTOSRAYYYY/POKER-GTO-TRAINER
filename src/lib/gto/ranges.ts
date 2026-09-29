/**
 * 翻前范围表数据（静态启发式，供范围表页面展示用）
 *
 * 13x13 矩阵约定（与通用扑克范围图一致）：
 * - MATRIX_RANKS[row][col]，行/列均按 A..2 降序。
 * - 对角线 = 对子（如 "AA"）。
 * - 右上三角（col > row）= 同花（如 "AKs"）。
 * - 左下三角（col < row）= 杂色（如 "AKo"）。
 *
 * 两组范围：
 * - 9 人桌开局（raise-or-fold，SB 位带 limp）：UTG/UTG+1/LJ/HJ/CO/BTN/SB 七张表，
 *   从紧到松（UTG ~17%、CO ~31%、BTN ~48%、SB vs BB ~80% 可玩）。
 *   用标准范围记号（如 "66+,A2s+,KTs+,AQo+"）声明，由 expandRange 展开成矩阵。
 * - 单挑：BTN_OPEN（按钮位 = 小盲，翻前先行动，与 9 人桌 SB 对 BB 同一构成，
 *   82% 标签 / 76% 组合可玩）与 BB_DEFEND_VS_OPEN（大盲位对按钮位加注的
 *   防守范围，3-bet 用 raise 表示）。
 */
import type { Rank } from "@/lib/types";

/** 矩阵行列顺序（降序） */
export const MATRIX_RANKS: Rank[] = [
  "A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2",
];

/** 一格的建议动作 */
export type RangeAction = "raise" | "call" | "fold";

export const RANGE_ACTION_META: Record<
  RangeAction,
  { label: string; hint: string }
> = {
  raise: { label: "加注", hint: "主动进攻，加注开局 / 再加注" },
  call: { label: "跟注", hint: "可玩但偏被动，跟注进入翻后" },
  fold: { label: "弃牌", hint: "牌力太弱，直接弃牌" },
};

/** 手牌名（如 "AA" / "AKs" / "AKo"），row/col 为矩阵下标 */
export function handLabel(row: number, col: number): string {
  const r1 = MATRIX_RANKS[row];
  const r2 = MATRIX_RANKS[col];
  if (row === col) return `${r1}${r2}`;
  if (col > row) return `${r1}${r2}s`;
  return `${r2}${r1}o`;
}

type CellDecider = (row: number, col: number) => RangeAction;

function buildMatrix(decide: CellDecider): RangeAction[][] {
  return MATRIX_RANKS.map((_, row) => MATRIX_RANKS.map((_, col) => decide(row, col)));
}

/** 点数数值（A=14 … 2=2），hi/lo 为高/低牌 */
function cellRanks(row: number, col: number): { hi: number; lo: number; pair: boolean; suited: boolean } {
  const hiIdx = Math.min(row, col);
  const loIdx = Math.max(row, col);
  return {
    hi: 14 - hiIdx,
    lo: 14 - loIdx,
    pair: row === col,
    suited: col > row,
  };
}

/**
 * SB 对 BB / 单挑按钮开局范围（同一构成：82% 标签 / 76% 组合可玩——9 人桌
 * SB 位与单挑按钮位是同一种局面：翻前仅剩大盲一人）。单挑旧表曾实装
 * ~45%（9max BTN 级松紧度）而注释称「≈80%」，2026-09-29 审计发现后统一回本表：
 * - 加注集：全对子、A2s+/K2s+/Q2s+、J6s+/T6s+、96s+/86s+/75s+/64s+/54s、
 *   任意杂色 A、K7o+/Q8o+/J8o+/T8o+/98o；
 * - 跟注（limp）集：其余多数同花与 K2o-K6o/Q2o-Q7o/J2o-J7o/T2o-T7o/97o/87o；
 * - 仅最垃圾的同花（低点无连接）与 96o 以下无连接杂色弃牌。
 */
export const SB_OPEN_RAISE =
  "22+,A2s+,K2s+,Q2s+,J6s+,T6s+,96s+,86s+,75s+,64s+,54s,A2o+,K7o+,Q8o+,J8o+,T8o+,98o";
export const SB_OPEN_CALL =
  "J2s,J3s,J4s,J5s,T2s,T3s,T4s,T5s,92s,93s,94s,95s,82s,83s,84s,85s,72s,73s,74s,63s,53s,K2o,K3o,K4o,K5o,K6o,Q2o,Q3o,Q4o,Q5o,Q6o,Q7o,J2o,J3o,J4o,J5o,J6o,J7o,T2o,T3o,T4o,T5o,T6o,T7o,97o,87o";

/**
 * 大盲位 vs 按钮位加注的防守范围：
 * - 对子 66+ 3-bet（raise），小对子跟注；
 * - 同花：AJs+/KQs 3-bet，其余同花基本全跟注（大盲位赔率好）；
 * - 杂色：AKo 3-bet，AQo+ 跟注，A 小杂色、K9o+、Q9o+、J9o+、T9o、98o 跟注，其余弃牌。
 */
function bbDefendDecide(row: number, col: number): RangeAction {
  const { hi, lo, pair, suited } = cellRanks(row, col);
  if (pair) return hi >= 6 ? "raise" : "call";
  if (suited) {
    if (hi === 14) return lo >= 11 ? "raise" : "call"; // AJs+ 3-bet
    if (hi === 13) return lo >= 12 ? "raise" : "call"; // KQs 3-bet
    return "call"; // 其余同花全部跟注防守
  }
  // 杂色
  if (hi === 14) {
    if (lo >= 13) return "raise"; // AKo 3-bet
    return "call"; // 其余 Ax 全部跟注
  }
  if (hi === 13) return lo >= 9 ? "call" : "fold";
  if (hi === 12) return lo >= 9 ? "call" : "fold";
  if (hi === 11) return lo >= 9 ? "call" : "fold";
  if (hi === 10) return lo >= 9 ? "call" : "fold";
  if (hi === 9) return lo >= 8 ? "call" : "fold";
  return "fold";
}

/** 大盲位对按钮位加注的防守范围矩阵 */
export const BB_DEFEND_VS_OPEN: RangeAction[][] = buildMatrix(bbDefendDecide);

// ---------------------------------------------------------------------------
// 9 人桌开局范围（标准范围记号 → 矩阵）
// ---------------------------------------------------------------------------

const RANK_INDEX: ReadonlyMap<Rank, number> = new Map(
  MATRIX_RANKS.map((r, i) => [r, i]),
);

/**
 * 展开单个范围记号，返回覆盖到的手牌名列表。
 * 支持形式：
 * - 对子："66" / "66+"（+ 表示到 AA）
 * - 同花："KTs" / "KTs+"（+ 表示同高点、低点向上到次高点，如 KTs+ = KTs/KJs/KQs）
 * - 杂色："AQo" / "AQo+"
 */
function expandRangeToken(token: string): string[] {
  const m = /^([2-9TJQKA])([2-9TJQKA]?)([so]?)(\+?)$/.exec(token);
  if (!m) throw new Error(`非法范围记号：${token}`);
  const [, r1, r2, kind, plus] = m;
  const i1 = RANK_INDEX.get(r1 as Rank)!;
  const out: string[] = [];
  if (!r2 || r1 === r2) {
    for (let i = i1; i >= (plus ? 0 : i1); i--) {
      out.push(`${MATRIX_RANKS[i]}${MATRIX_RANKS[i]}`);
    }
    return out;
  }
  if (!kind) throw new Error(`非法范围记号（缺少 s/o 后缀）：${token}`);
  const i2 = RANK_INDEX.get(r2 as Rank)!;
  if (i2 <= i1) throw new Error(`非法范围记号（第二张应小于第一张）：${token}`);
  const end = plus ? i1 + 1 : i2;
  for (let i = i2; i >= end; i--) {
    out.push(`${r1}${MATRIX_RANKS[i]}${kind}`);
  }
  return out;
}

/** 展开逗号分隔的范围记号串（如 "66+,A2s+,KTs+,AQo+"）为手牌名集合 */
export function expandRange(notation: string): Set<string> {
  const set = new Set<string>();
  for (const tok of notation.split(",")) {
    const t = tok.trim();
    if (!t) continue;
    for (const label of expandRangeToken(t)) set.add(label);
  }
  return set;
}

/** 由范围记号生成矩阵：raise 集 → 加注，call 集 → 跟注，其余弃牌 */
function matrixFromNotation(raise: string, call?: string): RangeAction[][] {
  const raiseSet = expandRange(raise);
  const callSet = call ? expandRange(call) : new Set<string>();
  return buildMatrix((row, col) => {
    const label = handLabel(row, col);
    if (raiseSet.has(label)) return "raise";
    if (callSet.has(label)) return "call";
    return "fold";
  });
}

/** 单挑按钮位（= 小盲，翻前先行动）开局范围矩阵：与 9 人桌 SB 对 BB 同一构成 */
export const BTN_OPEN: RangeAction[][] = matrixFromNotation(SB_OPEN_RAISE, SB_OPEN_CALL);

/** 9 人桌开局范围（前面无人入局时的 RFI；SB 位为对 BB 的开局策略，带 limp） */
const NINE_MAX_TABLES: { id: string; name: string; description: string; raise: string; call?: string }[] = [
  {
    id: "utg",
    name: "UTG 开局",
    description:
      "枪口位（9 人桌最先行动），约 17% 最紧开局：中以上对子、全部同花 A、两张大牌。身后 8 人未行动，宁紧勿松。",
    raise: "77+,A2s+,KTs+,QTs+,JTs,AQo+",
  },
  {
    id: "utg1",
    name: "UTG+1 开局",
    description:
      "约 20%：在 UTG 基础上放宽到小对子 66/55、K9s、J9s、98s 与 AJo/KQo 等杂色大牌。",
    raise: "66+,A2s+,K9s+,QTs+,J9s+,T9s,98s,AQo+,KQo",
  },
  {
    id: "lj",
    name: "LJ 开局",
    description:
      "约 23%：继续加入 55、K8s、Q9s、T8s、87s 等同花连接张，仍以同花牌与大牌为主。",
    raise: "55+,A2s+,K8s+,Q9s+,J9s+,T8s+,98s,87s,AQo+,KQo",
  },
  {
    id: "hj",
    name: "HJ 开局",
    description:
      "劫持位约 28%：对子到 44，K7s/Q8s/J8s 起，杂色 AJo/KQo/QJo/JTo 可开局。",
    raise: "44+,A2s+,K7s+,Q8s+,J8s+,T8s+,98s,87s,76s,AJo+,KQo,QJo,JTo",
  },
  {
    id: "co",
    name: "CO 开局",
    description:
      "关煞位约 31%：全部对子、K6s+、更多同花连张（65s），杂色放宽到 ATo/KJo/QJo/JTo/T9o。",
    raise: "22+,A2s+,K6s+,Q9s+,J8s+,T8s+,98s,87s,76s,65s,ATo+,KJo+,QJo,JTo,T9o",
  },
  {
    id: "btn",
    name: "BTN 开局",
    description:
      "按钮位约 48%：位置最好，任意同花 K、Q4s+、半连张同花、任意杂色 A、K8o+ 均可开局偷盲。",
    raise: "22+,A2s+,K2s+,Q4s+,J7s+,T7s+,97s+,87s,76s,65s,54s,A2o+,K8o+,Q9o+,J9o+,T9o,98o",
  },
  {
    id: "sb",
    name: "SB 开局（对 BB）",
    description:
      "小盲对大盲约 80% 起手牌可玩（82% 标签 / 76% 组合）：约一半加注（绿色），中等牌力补全 1BB 跟注（蓝色，limp），仅最差约两成弃牌。",
    raise: SB_OPEN_RAISE,
    call: SB_OPEN_CALL,
  },
];

export interface PreflopRangeTable {
  id: string;
  name: string;
  /** 分组：9 人桌开局 / 单挑 */
  group: "nine_max" | "heads_up";
  description: string;
  matrix: RangeAction[][];
}

export const RANGE_TABLES: PreflopRangeTable[] = [
  ...NINE_MAX_TABLES.map((t) => ({
    id: t.id,
    name: t.name,
    group: "nine_max" as const,
    description: t.description,
    matrix: matrixFromNotation(t.raise, t.call),
  })),
  {
    id: "btn_open",
    name: "按钮位开局",
    group: "heads_up",
    description:
      "单挑规则下按钮位 = 小盲，翻前先行动。约 80% 起手牌可玩（与 9 人桌 SB 对 BB 同一构成）：约一半加注，中等牌跟注（limp），仅最差约两成弃牌。",
    matrix: BTN_OPEN,
  },
  {
    id: "bb_defend",
    name: "大盲位防守（对按钮加注）",
    group: "heads_up",
    description:
      "大盲位面对按钮位加注时的应对：强牌 3-bet（再加注），中等牌利用好的底池赔率跟注，垃圾牌弃牌。",
    matrix: BB_DEFEND_VS_OPEN,
  },
];
