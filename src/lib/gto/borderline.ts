/**
 * src/lib/gto/borderline.ts — 判定胜率边界带高精度复核（抑制蒙特卡洛噪声，A3）
 *
 * 背景（审计 A3）：postflop/turn/river 的判定胜率都是 2000 次蒙特卡洛
 * （QUIZ_ITERATIONS），标准误 ≈1.1pp——判定胜率落在判定阈值 ±1pp 内时答案
 * 实为掷签，±3pp 边界带用 2 万次迭代复核的翻转率约 17%，折算全量约 2-3%
 * 的题目标签是错的（如 turn barrel 61.0% 越 61% 线判 aggressive，2 万it
 * 复核 60.7% 应为 passive）。
 *
 * 本模块是各族出题器共用的复核口径（re-judge 逻辑的唯一落点）：
 * 判定胜率距任一相关阈值 ≤ BORDERLINE_BAND（±3pp）时，用
 * REJUDGE_ITERATIONS（20000）次迭代重算一次，以复核值定答案并入库（点评
 * 展示的判定胜率与答案永远一致）；边界带外直接用原值，不触发额外开销。
 *
 * 复核函数由调用方注入（闭包携带 hero/board/spec/rng 与对手数），故 rng
 * 继续沿用出题器注入的随机源；对随机胜率的 equityMulti 引擎签名不接受
 * rng，属引擎层既有约束，与本模块无关。
 */

/** 边界带半宽：判定胜率距阈值 ≤ 3pp 即触发复核（审计实测翻转带） */
export const BORDERLINE_BAND = 0.03;
/** 复核迭代次数：2000 → 20000（标准误 ≈1.1pp → ≈0.35pp；须大于各族基础迭代数） */
export const REJUDGE_ITERATIONS = 20000;

/** 判定胜率是否落在任一阈值的 ±BORDERLINE_BAND 边界带内（含端点；1e-9 容差吸收浮点尾差） */
export function isBorderline(
  win: number,
  thresholds: readonly number[],
): boolean {
  return thresholds.some(
    (t) => Math.abs(win - t) <= BORDERLINE_BAND + 1e-9,
  );
}

/**
 * 边界带复核：win 落在任一阈值的 ±3pp 内时调用 recompute(REJUDGE_ITERATIONS)
 * 重算并返回复核值；否则原值返回（recompute 不被调用）。
 * @param win 基础精度（QUIZ_ITERATIONS 次）算出的判定胜率
 * @param thresholds 该题型判定用到的全部答案阈值（跟注线/加注线/进攻线/半诈唬带边）
 * @param recompute 用指定迭代数重算判定胜率的闭包（rng 由调用方闭包注入）
 */
export function rejudgeIfBorderline(
  win: number,
  thresholds: readonly number[],
  recompute: (iterations: number) => number,
): number {
  if (!isBorderline(win, thresholds)) return win;
  return recompute(REJUDGE_ITERATIONS);
}
