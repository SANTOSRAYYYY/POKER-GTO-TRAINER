/**
 * src/lib/gto/multiway.ts — 多路底池（multiway）共享口径
 *
 * 背景：三个翻后题族（postflop/turn/river）过去只出单挑场景（hero vs 1 对手）。
 * 本模块提供多路底池的共享原料：
 * - OpponentCount / drawOpponentCount：场景对手数 1|2|3，按 55%/30%/15% 抽；
 * - 按对手数的判定阈值函数（别写死三张表——单挑基准 + 每多一对手的固定步进）：
 *   - 翻牌防守：加注线 0.68 +0.06/人，跟注线 0.28 +0.03/人；
 *   - 翻牌进攻 / 转牌第二枪：进攻线 0.55 +0.06/人；
 *   - 转牌防守：加注线 0.68 +0.06/人，跟注线 0.30 +0.03/人；
 *   - 河牌：薄价值下注线 0.60 +0.05/人，抓诈跟注线 0.33 +0.03/人；
 *   - 半诈唬放宽仅单挑生效（semibluffAllowed）——多人底池诈唬成功率大幅
 *     下降，强听牌不再放宽进攻线；河牌纯诈唬题干脆只出现在单挑池（各出题器
 *     在题型抽取层排除，见 riverQuiz.dealRiverScenario）。
 * - drawMultiwayOpenerPos：多人池行动线里的开局位（剔除 BTN——多人线里
 *   hero 常以 BTN 跟注者身份出现，开局位与 hero 位置不能撞车）。
 *
 * 胜率计算不在本模块。多人池两套口径（2026-09-29 修正）：
 * - 进攻侧（翻牌 attack / 转牌 barrel / 河牌 value）：主动进攻要赢全场，
 *   各出题器把 opponents 传给引擎联合采样（hero 需压过全部对手才算 win），
 *   阈值步进不变；
 * - 防守侧（翻牌 defense / 转牌 defense / 河牌 bluffcatch）：面对下注只评估
 *   hero 对下注者的胜率（opponents=1）——身后尚未行动的跟注者视为死钱，
 *   死钱反而改善直接赔率，实现率税体现为跟注线 +0.03/人的小幅上调（加注线
 *   保持 +0.06/人：加注是打全场，仍需碾压级牌力）。旧框架「联合胜率 + 阈值
 *   +4-6pp/人步进」对多人摊薄重复计费，任何合理范围都无法让顶两对级强牌
 *   得到跟注答案。
 * 单挑（opponents=1）时各阈值函数返回既有单挑常量，判定与旧版逐点一致。
 */
import { OPEN_POS_OPTS, type OpenPos } from "@/lib/gto/actionLine";

/** 场景对手数：1 = 单挑，2 = 三人池，3 = 四人池 */
export type OpponentCount = 1 | 2 | 3;

/** 对手数抽取概率：单挑 55% / 三人池 30% / 四人池 15% */
export const OPPONENT_COUNT_WEIGHTS = { 1: 0.55, 2: 0.3, 3: 0.15 } as const;

/** 抽本题的对手数（rng 注入可复现）：1 人 55% / 2 人 30% / 3 人 15% */
export function drawOpponentCount(
  rng: () => number = Math.random,
): OpponentCount {
  const t = rng();
  if (t < OPPONENT_COUNT_WEIGHTS[1]) return 1;
  if (t < OPPONENT_COUNT_WEIGHTS[1] + OPPONENT_COUNT_WEIGHTS[2]) return 2;
  return 3;
}

/** 底池总人数（hero + 对手）：徽标与点评文案用（2 = 单挑 / 3 = 三人池 / 4 = 四人池） */
export function potPlayers(opponents: OpponentCount): number {
  return opponents + 1;
}

// ---------------------------------------------------------------------------
// 判定阈值：单挑基准 + 每多一对手的固定步进（函数化，不写死三张表）
// ---------------------------------------------------------------------------

/** 翻牌进攻线基准（对随机胜率 ≥ 55%）；每多一对手 +0.06 */
export function flopAttackLine(opponents: OpponentCount): number {
  return 0.55 + 0.06 * (opponents - 1);
}
/** 翻牌防守加注线基准 0.68；每多一对手 +0.06 */
export function flopDefenseRaiseLine(opponents: OpponentCount): number {
  return 0.68 + 0.06 * (opponents - 1);
}
/** 翻牌防守跟注线基准 0.28；每多一对手 +0.03（对下注者胜率 + 实现率税，2026-09-29 由 +0.04 下调） */
export function flopDefenseCallLine(opponents: OpponentCount): number {
  return 0.28 + 0.03 * (opponents - 1);
}
/** 转牌第二枪进攻线基准 0.55；每多一对手 +0.06 */
export function turnBarrelLine(opponents: OpponentCount): number {
  return 0.55 + 0.06 * (opponents - 1);
}
/** 转牌面对第二枪加注线基准 0.68；每多一对手 +0.06 */
export function turnDefenseRaiseLine(opponents: OpponentCount): number {
  return 0.68 + 0.06 * (opponents - 1);
}
/** 转牌面对第二枪跟注线基准 0.30；每多一对手 +0.03（对下注者胜率 + 实现率税，2026-09-29 由 +0.04 下调） */
export function turnDefenseCallLine(opponents: OpponentCount): number {
  return 0.3 + 0.03 * (opponents - 1);
}
/** 河牌薄价值下注线基准 0.60；每多一对手 +0.05 */
export function riverValueBetLine(opponents: OpponentCount): number {
  return 0.6 + 0.05 * (opponents - 1);
}
/** 河牌抓诈跟注线基准 0.33；每多一对手 +0.03（对下注者胜率 + 实现率税，2026-09-29 由 +0.05 下调） */
export function riverBluffcatchCallLine(opponents: OpponentCount): number {
  return 0.33 + 0.03 * (opponents - 1);
}

/**
 * 半诈唬放宽是否生效：仅单挑池。多人底池诈唬成功率大幅下降（需要全部
 * 对手弃牌），强听牌不再放宽进攻线——翻牌进攻题与转牌第二枪题共用。
 */
export function semibluffAllowed(opponents: OpponentCount): boolean {
  return opponents === 1;
}

/** 多人池行动线里的开局位：剔除 BTN（多人线里 hero 常是 BTN 跟注者，不能撞位） */
export function drawMultiwayOpenerPos(
  rng: () => number = Math.random,
): OpenPos {
  const opts = OPEN_POS_OPTS.filter((p) => p !== "BTN");
  return opts[Math.min(opts.length - 1, Math.floor(rng() * opts.length))];
}
