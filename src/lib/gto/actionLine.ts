/**
 * src/lib/gto/actionLine.ts — 出题器「行动路线」共享基元
 *
 * 背景：翻牌/转牌/河牌题过去只发牌不给前文，判断缺关键上下文（谁翻前加注、
 * 谁持续下注、尺度多大），范围推断也无从谈起。现在每个出题器在发牌的同时
 * 随机抽一条真实常见路线（2-3 种，rng 注入可复现），并把对手范围 spec 随
 * 路线收窄（如「对手翻前 3bet 后连开两枪」的下注者范围比「翻前跟注者」紧）。
 *
 * 本模块只提供共享原料：
 * - LocalizedText：行动线双语文本（zh/en），题目对象携带它，页面按当前语言渲染；
 * - OPEN_POS_OPTS / BET_SIZE_OPTS：开局位置（UTG+1~BTN）与下注尺度（1/2 或 2/3 池）；
 * - drawOpenPos / drawBetSize / threeBetToText：随机抽取与通用文案。
 *
 * 各族自己的路线清单（kind 枚举 + 模板函数）定义在各出题器模块内，与范围
 * spec 的联动紧挨着放，避免跨文件对照。
 */

/** 双语文本（行动线的单行）：zh 中文 / en 英文 */
export interface LocalizedText {
  zh: string;
  en: string;
}

/** 开局位置候选：UTG+1 ~ BTN（6 人桌真实常见开局位） */
export const OPEN_POS_OPTS = ["UTG+1", "HJ", "CO", "BTN", "LJ"] as const;
export type OpenPos = (typeof OPEN_POS_OPTS)[number];

/** 下注尺度候选：1/2 底池 / 2/3 底池（训练器最常见的两档） */
export const BET_SIZE_OPTS: readonly LocalizedText[] = [
  { zh: "1/2 底池", en: "half pot" },
  { zh: "2/3 底池", en: "2/3 pot" },
];

/** 从候选中抽一个（rng 注入；越界钳到末位，防 rng()===1 的极端实现） */
function pick<T>(opts: readonly T[], rng: () => number): T {
  return opts[Math.min(opts.length - 1, Math.floor(rng() * opts.length))];
}

/** 随机开局位（UTG+1~BTN） */
export function drawOpenPos(rng: () => number = Math.random): OpenPos {
  return pick(OPEN_POS_OPTS, rng);
}

/** 随机下注尺度（1/2 或 2/3 底池） */
export function drawBetSize(rng: () => number = Math.random): LocalizedText {
  return pick(BET_SIZE_OPTS, rng);
}

/** 3bet 尺度文案（翻前 3bet 统一 9bb，约 3.6 倍开局） */
export function threeBetToText(): LocalizedText {
  return { zh: "9bb", en: "9bb" };
}
