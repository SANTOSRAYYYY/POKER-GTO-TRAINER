/**
 * src/lib/gto/trainerDifficulty.ts — 出题难度过滤（反脑残题）共享口径
 *
 * 背景：纯随机发牌会出现「纯垃圾牌面对下注弃牌」这类用脚都能答的题
 * （如 72o 面对 A♣A♠Q♦5♦ 牌面的第二枪），训练价值为零。现在 hero 底牌
 * 已按行动线角色从范围抽（heroRange.ts），纯垃圾在发牌层消除；本模块的
 * 胜率带过滤继续保留——下限（<20%/<25%）防「范围底端听牌全空」的残留
 * 情形，上限（>75%/>85% 坚果级）防强范围照样会发出的无脑价值/加注题。
 * 各出题器在实算胜率后过一遍本模块的口径，显而易见的情形重发
 * （FILTER_MAX_ATTEMPTS 次上限兜底，防极端 rng 下死循环）。
 *
 * 三条纯函数口径（所有判定用各族自己的判定胜率，不是展示胜率）：
 * - 防守/抓诈题（isDefenseLikeObvious）：判定胜率 <20%（纯垃圾弃牌）
 *   或 >85%（坚果级无脑加注/跟注）→ 重发；
 * - 进攻/薄价值题（isOffenseLikeObvious）：>85%（无脑价值）或 <25% 且
 *   无强听牌（纯空气过牌毫无决策含量）→ 重发；河牌已无听牌可言，调用方
 *   对河牌题固定传 hasStrongDraw = false / true（见各 quiz 模块注记）；
 * - push/fold 与 3bet 题（isVsRangePreflopObvious）：对范围胜率 <25%
 *   （无脑弃）或 >75%（无脑推/4bet）→ 重发。
 */

/** 防守/抓诈题下限：判定胜率 <20% = 纯垃圾弃牌 */
export const OBVIOUS_DEFENSE_MAX = 0.2;
/** 坚果级无脑线：防守 >85% 无脑加注/跟注、进攻 >85% 无脑价值 */
export const OBVIOUS_NUTS_MIN = 0.85;
/** 进攻/薄价值题下限：<25% 且无强听牌 = 纯空气过牌 */
export const OBVIOUS_AIR_MAX = 0.25;
/** push/fold 与 3bet 题：对范围胜率 <25%（无脑弃）下限 */
export const OBVIOUS_VS_RANGE_MIN = 0.25;
/** push/fold 与 3bet 题：对范围胜率 >75%（无脑推/4bet）上限 */
export const OBVIOUS_VS_RANGE_MAX = 0.75;
/** 出题重发上限：连续抽到极端情形时按最后一次结果出题，保证不死循环 */
export const FILTER_MAX_ATTEMPTS = 10;

/** 防守/抓诈题：判定胜率 <20%（纯垃圾弃牌）或 >85%（坚果级无脑加注/跟注） */
export function isDefenseLikeObvious(win: number): boolean {
  return win < OBVIOUS_DEFENSE_MAX || win > OBVIOUS_NUTS_MIN;
}

/** 进攻/薄价值题：>85%（无脑价值）或 <25% 且无强听牌（纯空气过牌） */
export function isOffenseLikeObvious(win: number, hasStrongDraw: boolean): boolean {
  return win > OBVIOUS_NUTS_MIN || (win < OBVIOUS_AIR_MAX && !hasStrongDraw);
}

/** push/fold 与 3bet 题：对范围胜率 <25%（无脑弃）或 >75%（无脑推/4bet） */
export function isVsRangePreflopObvious(win: number): boolean {
  return win < OBVIOUS_VS_RANGE_MIN || win > OBVIOUS_VS_RANGE_MAX;
}
