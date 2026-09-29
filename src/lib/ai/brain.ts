/**
 * src/lib/ai/brain.ts — 胜率驱动的数学派 AI 决策引擎
 *
 * 与旧启发式（heuristic.ts 的 Chen 公式 + 模式匹配）不同，本模块以真实胜率
 * （蒙特卡洛 equity）与翻前范围表（gto/ranges.ts）为决策依据：
 *
 * 翻前（无公共牌，不走蒙特卡洛，零运行时开销）：
 * - 手牌归一化为 169 种标准牌型（"AKs"/"AKo"/"AA"），查静态胜率百分位表
 *   PREFLOP_ORDER（离线用 equity.ts 对随机单对手 1 万次模拟排序生成）。
 * - 无人入池：按位置（行动顺序推导「身后人数」→ 9 人桌开局范围表）决定
 *   开局加注/limp/弃牌；nit 收一档、lag/maniac 放一档。
 * - 面对一次加注：范围口径（preflopRangeModeEnabled，F5 闭环，默认开启——
 *   Phase 9 深筹复测（200bb）+29.7 [+9.7,+49.7] 过采纳线）按加注者身后人数
 *   推导其开局范围宽度（顶部 X%，range.ts preflopRaiserRangePct），用 169 牌型 ×
 *   5 档范围宽度的离线真实胜率表（PREFLOP_VS_RANGE_EQUITY）判定——对范围胜率
 *   ≥ 风格价值 3bet 门槛（0.58-0.67）→ 3bet（IP 3x / OOP 4x），≥ 跟注门槛
 *   （0.42-0.48）→ 跟注，边缘牌按风格诈唬 3bet，其余弃牌；中对子对紧范围缩水、
 *   同花连张保值等效应由静态表直接表达。默认旧口径：顶端 ~4%
 *   价值 3bet、按对随机百分位的中档跟注。
 * - 面对 3bet+：只继续顶端范围（~6.5% 跟注、~3% 4bet）。
 * - 短筹码（<12bb）push/fold 倾向：范围内直接 all-in 优先于小加注。
 *
 * 翻后：
 * - equityMulti 蒙特卡洛真实胜率；河牌单挑精确枚举全部对手底牌组合。
 *   迭代数按对手数缩放（单挑 flop 800 / turn 500，人多递减），并按
 *   (底牌, 公共牌, 对手数) 缓存，单次决策（翻牌圈单挑）约 35ms。
 * - 范围推断（rangeMode，range.ts）：只有面对下注/加注的决策启用——按
 *   本街再加注层级（streetRaisesSeen，与 warGuard 同源）/对手数/对手画像
 *   推断对手隐含范围（RangeSpec：强度前 topPct + bluffPct 诈唬混入），
 *   蒙特卡洛对范围采样得范围胜率；最终 equity = 范围胜率 × (1-rangeBlendRandom)
 *   + 随机胜率 × rangeBlendRandom（默认 blend 0 = 纯范围胜率；Phase 4 blend
 *   扫描 + 直接对决显示混随机单调变差，0.0 > 0.3 > 0.5）。
 *   跟注边际比较、价值再加注判定、warGuard 的 equity 输入均改用混合胜率；
 *   面注时的 SPR 承诺判定同样用混合胜率且置于 warGuard 升档门槛之后（F2：
 *   被再加注过的低 SPR 局面须先过护栏才允许 commit 全下）；
 *   无人下注的主动决策与 SPR 推进保持随机范围胜率（对手没给信息）。
 *   rangeModeEnabled=false 逐比特恢复旧行为。范围 MC 迭代数 = 随机 MC ×
 *   rangeItersScale（默认 0.5），单次 decide 预算 ≤120ms。
 *   多人池面注口径（multiwayDefenseV2Enabled，默认 false，与训练器
 *   2026-09-29 防守新框架对齐的实验机制）：facingBet 且 opponents>1 时只评估
 *   「对下注者」胜率（spec 不按人数收紧、只抽下注者 1 人），身后跟注者视为
 *   死钱（死钱改善直接赔率），跟注门槛步进降为 multiwayDefenseV2MarginPerOpp
 *   （0.01/人实现率税）——旧框架「联合压全场 + 全员 bettor 强 spec + 0.03/人
 *   步进」对多人摊薄重复计费（实测 3 人池 KsQh4h 中对 88：本口径 0.46 vs 旧
 *   口径 0.17）。但 Phase 10 台架（6max 混风格 12000 手 × seeds 42-44 配对）
 *   合并 -12.8 bb/100 [-19.0,-6.5]（n=36000）未过采纳线：对下注者口径在本
 *   台架环境下防守过宽、净效应显著为负 → 默认关闭，机制保留供 A/B。
 *   true 时 rangeMultiwayJoint 在多人池面注路径被取代；单挑（opponents=1）
 *   两侧逐比特一致。默认 false = 旧框架（rangeMultiwayJoint 联合摊薄生效）。
 * - 面对下注：所需胜率 = call/(pot+call) + 风格安全边际 → 跟注；
 *   胜率远超（单挑 ≥65%，每多一对手 +3%）→ 价值加注 ~0.7 池；
 *   极低胜率 + 风格诈唬掷签 + 弃牌率空间 → 诈唬加注；否则弃牌。
 * - 加注战护栏（warGuard，L3/L1/L2/L2' 修复）：翻后互加链会几何升级到全下并
 *   系统性选出被统治方。护栏按本街攻击性动作层级（streetRaisesSeen：bet 算
 *   第 1 次，每次再加注 +1）升级价值再加注门槛（被 3bet ≥0.78、被 4bet+
 *   ≥0.85、河牌单挑精确枚举 0.90），层级 ≥ warMaxRaises(3) 后禁止再加注
 *   （eq ≥ 0.97 坚果级豁免）；翻前被 4bet+ 时 premium 互加链封顶
 *   （pct ≥ 0.985 才继续，99-JJ 深筹码改跟注），面对 3bet+ 的非 premium
 *   跟注上限 25bb（L2'：premium 豁免收窄到 pct ≥ callVs3betPremiumExemptPct
 *   的约 QQ+ 档，99-JJ 档超额跟注额同样弃牌）。warGuardEnabled=false 整体
 *   恢复旧行为。护栏的 equity
 *   输入在 rangeMode 下为混合胜率——护栏与范围推断叠加生效。
 * - 无人下注：胜率 > 下注阈值（单挑 52%，每多一对手 +6%）→ 价值/保护下注
 *   0.5-0.67 池；中低胜率按激进度半诈唬；低胜率按风格诈唬率 × 多人衰减
 *   纯诈唬 0.5 池；否则过牌。
 * - SPR 管理：stack/pot < 2 且胜率 ≥ 60% 直接 all-in（面注时用混合胜率 eqF，
 *   且被再加注后须过 warGuard 升档门槛；无下注的主动推进用 vs 随机胜率）。
 * - 加注层级口径（F6）：streetRaisesSeen/preflopRaiseLevel 只计「完整加注」
 *   （增量 ≥ 当时 minRaise）；不足最小加注额的 short all-in 是跟注性质，不计入。
 * - 翻前位置修正（F5）：面对一次加注时按加注者位置线性调制跟注/价值 3bet 门槛
 *   （UTG +preflopPosAdjustUTG ↔ BTN +preflopPosAdjustBTN；单挑不生效）。
 *   默认关闭（preflopPosAdjustEnabled: false）：6max 配对验收未过采纳线
 *   （+4.8 bb/100 [-2.2,+11.8]，n=24000），机制保留供 A/B。
 *   preflopRangeModeEnabled 开启时本机制失效（被范围口径吸收，不叠加）。
 * - 绝对下限（任何风格不再犯蠢）：胜率 < 12% 且面对 >0.75 池注额 → 弃牌。
 *
 * 风格调制：HEURISTIC_PARAMS 继续生效，只调制阈值边际与诈唬频率，
 * 不改变下注尺度的数学逻辑（maniac 诈唬 ×2.5 但尺度不乱）。
 *
 * 对手建模（adapt.ts）：input.opponentModels 存在时，按在局对手的分类
 * （confidence 加权）剥削性调整——诈唬频率乘数、跟注边际、价值下注门槛、
 * 翻前后位开局范围档位。钳制在安全区间（诈唬率 ≤ 0.6、跟注边际 ≥ -6%），
 * 「不犯蠢」绝对底线不受调整影响；无 opponentModels 时行为与调整前完全一致。
 * 位置维度（Phase 6，旋钮 adaptPositionalEnabled，默认开）：模型按分桶
 * 校正重分类（correctedVpip），翻前面对加注时按加注者位置/画像调制门槛
 * （facingRaiseDelta：对 late 桶偷盲狂放宽防守、对 early 位 maniac 收紧）；
 * 近因加权 λ（adaptRecencyLambda，默认 0.92）作用于 updateStats 累积层，
 * brain 不直接读（台架开赛时按座位 0 tuning 应用，生产固定默认值）。
 * Phase 8：摊牌学习（showdownLearnEnabled）把对手亮牌按位置桶渲染为范围宽度
 * 乘数（adapt.ts showdownsSeen → showdownWidthMult），翻前面注缩放加注者开局
 * 范围宽度（preflopRangeMode 下 topPct 直接乘；百分位口径缩放 (1-callPct)），
 * 翻后面注缩放 facing spec 的 topPct；blocker 效应（blockerEnabled）在
 * equityVsRange 采样时按 hero 底牌对范围组合降权。两旋钮默认 false——
 * Phase 8 台架合并 CI 均跨零且中值 ≈0，未过采纳线（机制保留供 A/B，
 * 见 results/phase8-showdown-blocker-report.md）；开启/关闭均逐比特可复现。
 *
 * 参数化（BrainTuning）：决策用的全部魔法数字收敛为 DEFAULT_BRAIN_TUNING
 * 常量对象；brainDecide 接受可选第 4 参 tuning?: Partial<BrainTuning>
 * （浅合并默认值），供 self-play 台架做参数锦标赛。不传/传 {} 时两种调用
 * 逐比特一致（见 __tests__/brainTuning.test.ts）。
 *
 * 锦标赛上下文（Phase 7，轻量 ICM 风格调整）：input.tournament 存在且
 * T.icmEnabled 时生效（现金局/缺省零修正，逐比特回到旧行为；icmEnabled
 * 默认关闭——8 人 SNG 30 种子台架验收未过采纳线，机制保留供 A/B）。规则：
 * - bubble/final 阶段短码（myStackBB < 15）：面对加注/下注的跟注门槛收紧
 *   +icmBubbleCallTighten（翻前百分位门槛与翻后胜率边际同量）；push/fold
 *   与全下范围照旧不动。
 * - bubble/final 阶段大筹码（筹码排名前 1/3 且 myStackBB > 2×avgStackBB）：
 *   主动下注/诈唬类概率 × icmBigStackPressure（偷盲/垃圾开局/诈唬 3bet/
 *   半诈唬/纯诈唬/诈唬加注），施压短码。
 * - early/middle 阶段零修正。
 * 「不犯蠢」底线（foldFloorEq、warGuard、跟注上限）不受调整影响。
 */
import type {
  Card,
  ConcreteAIStyle,
  DecideInput,
  DecideResult,
  OpponentModel,
  PlayerAction,
  Seat,
} from "@/lib/types";
import { equityMulti, type EquityResult } from "@/lib/poker/equity";
import { evaluate7 } from "@/lib/poker/evaluator";
import { newDeck } from "@/lib/poker/cards";
import { AI_PROFILES, HEURISTIC_PARAMS, type HeuristicStyleParams } from "./profiles";
import { actOrderInfo, positionName, seatPositionName } from "./positions";
import { adjustments, bucketOfPreflop, classifyPositional, IDENTITY_ADJUSTMENT, showdownWidthMult, type Adjustment } from "./adapt";
import { handLabel, MATRIX_RANKS, RANGE_TABLES, type RangeAction } from "@/lib/gto/ranges";
import { equityVsRange, inferFacingSpec, preflopEquityVsOpenRange, preflopRaiserRangePct, resetRangeCaches } from "./range";

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

const RANK_VALUES: Record<string, number> = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};

function rankValue(card: Card): number {
  return RANK_VALUES[card[0]];
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** 归一化手牌名（"AKs"/"AKo"/"AA"），与 ranges.ts 的矩阵记号一致 */
function canonicalLabel(c1: Card, c2: Card): string {
  const v1 = rankValue(c1);
  const v2 = rankValue(c2);
  const hi = Math.max(v1, v2);
  const lo = Math.min(v1, v2);
  const R = (v: number) => MATRIX_RANKS[14 - v];
  if (v1 === v2) return `${R(v1)}${R(v1)}`;
  const suited = c1[1] === c2[1];
  return `${R(hi)}${R(lo)}${suited ? "s" : "o"}`;
}

// ---------------------------------------------------------------------------
// 翻前静态胜率百分位表（离线生成：每手牌型对随机单对手蒙特卡洛 1 万次）
// PREFLOP_ORDER 从强到弱排列全部 169 种牌型；百分位 = (168 - index) / 168。
// ---------------------------------------------------------------------------

/** 导出供离线工具（scripts/selfplay/gen-preflop-range-table.ts）按同一口径生成对范围胜率表 */
export const PREFLOP_ORDER: readonly string[] = [
  "AA","KK","QQ","JJ","TT","99","88","AKs","AQs","77","AJs","ATs",
  "AQo","AKo","KQs","66","AJo","A9s","ATo","KJs","A8s","KQo","KTs","A9o",
  "55","A7s","K9s","A6s","QJs","KJo","QTs","A8o","A4s","A5s","KTo","K8s",
  "A6o","A5o","A7o","QJo","A3s","Q9s","JTs","44","K7s","A4o","K9o","QTo",
  "A2s","K8o","K5s","K6s","Q8s","K7o","A3o","JTo","J9s","K4s","A2o","K6o",
  "Q9o","T9s","Q7s","K3s","J8s","K5o","K2s","Q8o","Q5s","33","Q6s","K4o",
  "J7s","Q4s","J9o","T8s","K3o","Q7o","Q6o","T9o","J8o","98s","Q3s","K2o",
  "J5s","Q5o","Q4o","J6s","J7o","22","T8o","T7s","Q2s","98o","T6s","T7o",
  "87s","J4s","J3s","97s","J5o","96s","T5s","Q2o","J6o","J2s","Q3o","97o",
  "J4o","86s","T4s","T6o","T3s","95s","76s","87o","J3o","85s","T5o","T2s",
  "J2o","75s","T4o","96o","86o","94s","84s","93s","95o","65s","T3o","92s",
  "T2o","74s","54s","76o","83s","64s","85o","94o","75o","73s","82s","65o",
  "93o","84o","53s","63s","92o","72s","74o","43s","62s","54o","64o","83o",
  "52s","82o","73o","42s","32s","63o","72o","53o","43o","52o","62o","42o",
  "32o",
];

const PREFLOP_PERCENTILE: ReadonlyMap<string, number> = new Map(
  PREFLOP_ORDER.map((label, idx) => [label, (PREFLOP_ORDER.length - 1 - idx) / (PREFLOP_ORDER.length - 1)]),
);

/** 手牌翻前百分位 0-1（1 = 最强 AA；未知牌型保守取 0.3） */
function preflopPercentile(label: string): number {
  return PREFLOP_PERCENTILE.get(label) ?? 0.3;
}

// ---------------------------------------------------------------------------
// 范围表查询（gto/ranges.ts → 牌型集合）
// ---------------------------------------------------------------------------

interface TableSets {
  raise: Set<string>;
  call: Set<string>;
}

const TABLE_SETS: ReadonlyMap<string, TableSets> = (() => {
  const map = new Map<string, TableSets>();
  for (const t of RANGE_TABLES) {
    const raise = new Set<string>();
    const call = new Set<string>();
    t.matrix.forEach((rowArr, row) =>
      rowArr.forEach((act: RangeAction, col) => {
        const label = handLabel(row, col);
        if (act === "raise") raise.add(label);
        else if (act === "call") call.add(label);
      }),
    );
    map.set(t.id, { raise, call });
  }
  return map;
})();

/**
 * 「身后人数」→ 开局范围表 id。
 * 9 人桌 UTG 身后 8 人用最紧表；人数少的桌子自动映射到等价松紧度的表
 * （如 6 人桌 UTG 身后 5 人 ≈ 9 人桌 LJ）。单挑按钮用单挑专属表。
 */
function openTableId(behind: number, headsUp: boolean): string {
  if (headsUp) return "btn_open";
  if (behind >= 8) return "utg";
  if (behind === 7) return "utg1";
  if (behind === 6 || behind === 5) return "lj";
  if (behind === 4) return "hj";
  if (behind === 3) return "co";
  if (behind === 2) return "btn";
  if (behind === 1) return "sb";
  return "hj"; // BB 面对全员 limp 的罕见情形
}

/** 风格档位偏移：nit 收一档（用更紧的表），lag/maniac 放一档（用更松的表） */
function shiftedBehind(behind: number, style: ConcreteAIStyle, headsUp: boolean): number {
  if (headsUp) return behind;
  if (style === "nit") return Math.min(8, behind + 1);
  if (style === "lag" || style === "maniac") return Math.max(1, behind - 1);
  return behind;
}

// ---------------------------------------------------------------------------
// 胜率计算（蒙特卡洛 + 河牌精确枚举 + 缓存）
// ---------------------------------------------------------------------------

const EQUITY_CACHE_LIMIT = 1500;
const equityCache = new Map<string, EquityResult>();
/** 翻前「牌型 × 对手数」对随机范围的胜率缓存（供 prompt 数据注入） */
const preflopEquityCache = new Map<string, number>();

function equityCacheKey(hero: [Card, Card], board: Card[], opp: number): string {
  const h = [...hero].sort().join("");
  const b = [...board].sort().join("");
  return `${h}|${b}|${opp}`;
}

/**
 * 迭代数预算：按对手数缩放，保证单次决策冷缓存也远低于 80ms。
 * 实测（Node 24）：flop 单挑 800 次 ≈ 36ms；每多一名对手成本近似线性上升。
 * scale 为调参/台架用的缩放因子（BrainTuning.equityIterationsScale，
 * 默认 1 = 生产精度）；下限 50 保证蒙特卡洛估计不退化。
 * 河牌单挑走精确枚举，不经此函数。
 */
function iterationsFor(board: Card[], opp: number, scale: number = 1): number {
  const tier = board.length === 3
    ? [800, 600, 450, 350, 300, 250]
    : board.length === 4
      ? [500, 400, 320, 260, 220, 200]
      : [420, 330, 260, 220, 200, 180];
  return Math.max(50, Math.round(tier[clamp(opp - 1, 0, tier.length - 1)] * scale));
}

/** 河牌单挑精确枚举：遍历对手全部底牌组合（C(45,2)=990），hero 牌型分只算一次 */
function riverEquityExact(hero: [Card, Card], board: Card[]): EquityResult {
  const dead = new Set<string>([...hero, ...board]);
  const remaining = newDeck().filter((c) => !dead.has(c));
  const heroScore = evaluate7([...hero, ...board]);
  let win = 0;
  let tie = 0;
  let lose = 0;
  for (let i = 0; i < remaining.length - 1; i++) {
    for (let j = i + 1; j < remaining.length; j++) {
      const s = evaluate7([remaining[i], remaining[j], ...board]);
      if (heroScore > s) win++;
      else if (heroScore === s) tie++;
      else lose++;
    }
  }
  const total = win + tie + lose;
  return { win: win / total, tie: tie / total, lose: lose / total };
}

/**
 * hero 对 opp 名未知底牌对手的有效胜率（win + tie/2），带缓存。
 * scale 缩放蒙特卡洛迭代数（默认 1 = 生产行为）；缓存 key 含有效迭代数，
 * 不同 scale 的条目互不混用（河牌单挑精确枚举与 scale 无关，用独立命名空间）。
 */
function heroEquity(hero: [Card, Card], board: Card[], opp: number, scale: number = 1): number {
  const exact = board.length === 5 && opp === 1;
  const iters = exact ? 0 : iterationsFor(board, opp, scale);
  const key = `${equityCacheKey(hero, board, opp)}|${exact ? "X" : iters}`;
  const hit = equityCache.get(key);
  if (hit) return hit.win + hit.tie / 2;
  const r = exact
    ? riverEquityExact(hero, board)
    : equityMulti(hero, board, opp, iters);
  if (equityCache.size >= EQUITY_CACHE_LIMIT) equityCache.clear();
  equityCache.set(key, r);
  return r.win + r.tie / 2;
}

/**
 * 清空全部 equity 缓存。供自对战台架/测试在每场 match 前复位：
 * 缓存命中与否会改变蒙特卡洛的随机数消耗量，复位保证同 seed 的跨进程可复现性。
 */
export function resetBrainCaches(): void {
  equityCache.clear();
  preflopEquityCache.clear();
  resetRangeCaches();
}

/** 翻前手牌对 opp 名随机范围对手的有效胜率（缓存；供 prompt 注入展示） */
function preflopEquityVs(hero: [Card, Card], opp: number): number {
  const key = `${canonicalLabel(hero[0], hero[1])}|${opp}`;
  const hit = preflopEquityCache.get(key);
  if (hit !== undefined) return hit;
  const r = equityMulti(hero, [], opp, 400);
  const e = r.win + r.tie / 2;
  if (preflopEquityCache.size >= 500) preflopEquityCache.clear();
  preflopEquityCache.set(key, e);
  return e;
}

// ---------------------------------------------------------------------------
// 局面分析
// ---------------------------------------------------------------------------

interface LegalSet {
  has: (t: PlayerAction["type"]) => boolean;
  amount: (t: PlayerAction["type"]) => number | undefined;
  /** 指定下注类型的合法区间 [min, max]（bet-to 语义） */
  range: (t: "bet" | "raise") => { min: number; max: number } | null;
  first: PlayerAction | null;
}

function analyzeLegal(input: DecideInput, myStreetBet: number, myStack: number): LegalSet {
  const map = new Map(input.legalActions.map((a) => [a.type, a.amount]));
  const maxTo = myStreetBet + myStack;
  const allinTo = map.get("allin") ?? maxTo;
  return {
    has: (t) => map.has(t),
    amount: (t) => map.get(t),
    range: (t) => {
      const min = map.get(t);
      if (min === undefined) return null;
      return { min, max: Math.max(min, allinTo) };
    },
    first: input.legalActions[0] ?? null,
  };
}

/** 在局对手数（未淘汰且未弃牌，含已全下者——他们仍能赢下底池） */
function countOpponents(input: DecideInput, mySeat: number): number {
  return input.state.players.filter(
    (p) => p.seat !== mySeat && !p.eliminated && !p.folded,
  ).length;
}

/**
 * 本街下注线回放：逐条过 streetActions（F4 起带座位），追踪下注线与最小加注增量。
 * - raises：「完整加注」次数——bet/raise/增量足够的 allin 才计；不足最小加注额的
 *   short all-in 在引擎里是跟注性质（不重开下注轮、不更新 minRaise），不计入
 *   加注层级（F6：否则短码全下会被误当再加注，触发护栏升档/范围收紧）。
 * - lastRaiser：最后一次抬高下注线（amount > 当时下注线）的座位，即 hero 当前
 *   面对的下注来源（short all-in 抬线也算）；无攻击性动作时为 null。
 */
function bettingLineInfo(input: DecideInput): {
  raises: number;
  lastRaiser: Seat | null;
} {
  const bb = input.state.bigBlind;
  // 盲注/ante 不产生动作记录（契约）：翻前下注线从大盲起算；翻后每街归零
  let line = input.state.street === "preflop" ? bb : 0;
  let minR = bb; // 每街 minRaise 重置为大盲（引擎 advanceStreet 口径）
  let raises = 0;
  let lastRaiser: Seat | null = null;
  for (const sa of input.state.streetActions) {
    const a = sa.action;
    if (a.type !== "bet" && a.type !== "raise" && a.type !== "allin") continue;
    // 与引擎 fullRaise 判定一致：本街首笔投入（line===0）必为完整下注；
    // 之后增量 ≥ 当时 minRaise 才是完整加注
    if (line === 0 || a.amount - line >= minR) {
      raises++;
      if (line > 0) minR = a.amount - line;
    }
    if (a.amount > line) {
      line = a.amount;
      lastRaiser = sa.seat;
    }
  }
  return { raises, lastRaiser };
}

/**
 * 翻前加注层级推断：0 = 无人加注（可有 limper），1 = 面对一次加注，2+ = 面对 3bet+。
 * 优先数本街行动序列里的完整加注次数（short all-in 不计，见 bettingLineInfo）；
 * 序列为空（合成快照）时按当前下注额相对大盲的倍数估算。
 */
function preflopRaiseLevel(input: DecideInput): number {
  const aggro = bettingLineInfo(input).raises;
  const cb = input.state.currentBet;
  const bb = input.state.bigBlind;
  const sizeEst = input.callAmount > 0
    ? cb <= bb ? 0 : cb <= 4 * bb ? 1 : 2
    : 0;
  return Math.max(aggro, sizeEst);
}

/**
 * 本街「再加注层级」：本街完整加注次数 - 1（bet 算第 1 次）。
 * 0 = 首次面对下注（无人再加注），1 = 被再加注（翻前即面对 3bet），
 * 2 = 被 4bet+，依此递增。加注战护栏（warGuard）按此层级升级 equity 门槛。
 */
function streetRaisesSeen(input: DecideInput): number {
  return Math.max(0, bettingLineInfo(input).raises - 1);
}

/**
 * 范围推断的对手画像对象：streetActions 携带座位（F4），优先取本街最后一名
 * 抬高下注线者（hero 当前面对的下注来源）的画像——多人池中避免「张冠李戴」。
 * 该座位无画像或已弃牌/淘汰时，回退到「在局对手中置信度最高者」的旧逻辑；
 * 都无画像返回 undefined（inferFacingSpec 按零修正处理）。
 */
function facingOpponentModel(input: DecideInput): OpponentModel | undefined {
  const models = input.opponentModels;
  if (!models || models.length === 0) return undefined;
  const raiser = bettingLineInfo(input).lastRaiser;
  if (raiser !== null) {
    const p = input.state.players[raiser];
    const m = models.find((mm) => mm.seat === raiser);
    if (m && p && !p.folded && !p.eliminated) return m;
  }
  let best: OpponentModel | undefined;
  for (const m of models) {
    const p = input.state.players[m.seat];
    if (!p || p.folded || p.eliminated) continue;
    if (!best || m.confidence > best.confidence) best = m;
  }
  return best;
}

/**
 * 摊牌学习（Phase 8）：某座位的范围宽度乘数。
 * 旋钮关闭 / 无该座位画像 / 画像对象已弃牌淘汰 / 无亮牌调整 → 精确返回 1
 * （调用方据此跳过乘法，保证这些情形下行为逐比特不变）。桶口径 = 该座位
 * 本手的翻前位置桶（与 updateStats 亮牌记录的分桶同源）。
 */
function showdownWidth(input: DecideInput, seat: Seat | null, T: BrainTuning): number {
  if (!T.showdownLearnEnabled || seat === null) return 1;
  const p = input.state.players[seat];
  if (!p || p.folded || p.eliminated) return 1;
  const m = input.opponentModels?.find((mm) => mm.seat === seat);
  if (!m) return 1;
  return showdownWidthMult(
    m,
    bucketOfPreflop(seat, input.state.buttonSeat, input.state.players.length),
  );
}

// ---------------------------------------------------------------------------
// 全局调参旋钮（BrainTuning）
//
// 决策树中的全部魔法数字集中于此；brainDecide 第 4 参可浅合并覆盖，
// 供 self-play 台架做大规模参数锦标赛。DEFAULT_BRAIN_TUNING 的每个值
// 都等于参数化前的硬编码行为（回归测试保证 tuning={} 时逐比特一致）。
// ---------------------------------------------------------------------------

export interface BrainTuning {
  // ---- 翻前：无人入池 ----
  /** 单挑 nit 把 limp 边缘牌弃掉的概率 */
  huNitLimpCullProb: number;
  /** 单挑垃圾牌混入开局：诈唬率系数（maniac / lag） */
  huJunkOpenManiacK: number;
  huJunkOpenLagK: number;
  /** 非单挑后位偷盲：behind ≤ stealMaxBehind 且 lag/maniac 时可垃圾开局 */
  stealMaxBehind: number;
  stealManiacK: number;
  stealLagK: number;
  /** limp 档转加注概率 = 激进度 × 系数（跟注站 / 其余风格） */
  limpRaiseStationK: number;
  limpRaiseK: number;
  /** 短筹码 push/fold：stackBB < pushFoldBB 时范围内优先全下
   *  （< pushFoldAlwaysBB 必全下，否则按 pushFoldProb 概率） */
  pushFoldBB: number;
  pushFoldAlwaysBB: number;
  pushFoldProb: number;
  /** 开局加注尺度（bb 倍数）：单挑 / 非单挑 / 每个 limper 追加 */
  openBBHeadsUp: number;
  openBB: number;
  openPerLimperBB: number;
  /** limper 数估算偏移：limpers = max(0, round(pot/bb - limperOffset)) */
  limperOffset: number;

  // ---- 翻前：面对一次加注 ----
  /** 单挑大盲防守表 3bet 尺度（× 当前下注）与中等牌诈唬 3bet 系数 */
  bbDefend3betMult: number;
  bbDefendBluffK: number;
  /** 大盲关门行动的跟注百分位放宽量 */
  callVsRaiseBBDiscount: number;
  /** 便宜跟注放宽：call ≤ pot × cheapCallFrac 时门槛 -cheapCallDiscount */
  cheapCallFrac: number;
  cheapCallDiscount: number;
  /** 短筹码面对加注：stackBB < shortAllinBB 且 pct ≥ shortAllinPct → 直接全下 */
  shortAllinBB: number;
  shortAllinPct: number;
  /** 价值 3bet 尺度：有利位置 × threeBetIPMult / 不利位置 × threeBetOOPMult */
  threeBetIPMult: number;
  threeBetOOPMult: number;
  /** behind ≥ ipMinBehind 视为有利位置 */
  ipMinBehind: number;
  /** 诈唬 3bet：pct ≥ callPct - bluff3betBand 且牌面可玩，概率 = 有效诈唬率 × bluff3betK */
  bluff3betBand: number;
  bluff3betK: number;
  /** 翻前面对一次加注时，按加注者位置调制跟注/价值 3bet 门槛（F5；单挑桌不生效）。
   *  默认关闭：6max 配对验收 +4.8 bb/100 [-2.2,+11.8]（n=24000，seed 42+43）未过
   *  采纳线（CI 全正且 >+15），机制保留供 A/B（results/phase5-posadj-*）。
   *  注意：preflopRangeModeEnabled 开启时本旋钮失效（新机制已按加注者范围直接
   *  计算真实胜率，加注者位置信息被更准确地吸收，二者不叠加） */
  preflopPosAdjustEnabled: boolean;
  /** 加注者为本桌最前位（UTG）时的门槛增量（正值 = 对其收紧） */
  preflopPosAdjustUTG: number;
  /** 加注者为 BTN（或更后）时的门槛增量（负值 = 对其放宽；中间位置线性插值） */
  preflopPosAdjustBTN: number;
  /** 翻前范围推断闭环（F5 真闭环）：面对一次加注时，跟注/价值 3bet/诈唬 3bet 判定
   *  从「对随机胜率的静态百分位」换成「对加注者开局范围（顶部 X%，按加注者身后
   *  人数分档，range.ts preflopRaiserRangePct）的真实胜率」（169 牌型 × 5 档范围
   *  离线静态表 PREFLOP_VS_RANGE_EQUITY）。开启时 preflopPosAdjustEnabled 失效。
   *  false 逐比特回旧行为。
   *  默认开启：Phase 8（6max 100bb，n=36000）+5.3 [-6.2,+16.9] 未过线保留；
   *  Phase 9 深筹复测（6max 200bb 不结转，12000 手 × seeds 42-44 合并 n=36000）
   *  diff **+29.7 bb/100，95% CI [+9.7, +49.7]**——CI 全正且中值 >+15 采纳线，
   *  翻前决策代价随筹码深度放大（results/phase9-deep-retest-report.md）。
   *  false 逐比特回旧行为。 */
  preflopRangeModeEnabled: boolean;

  // ---- 翻前：面对 3bet+ ----
  /** 顶端范围 pct ≥ premiumPct：stackBB < premiumAllinBB 全下，否则 × fourBetMult */
  premiumPct: number;
  premiumAllinBB: number;
  fourBetMult: number;
  /** maniac 诈唬 4bet：pct ≥ maniac4betPct，概率 = 诈唬率 × 剥削乘数 × maniac4betK */
  maniac4betPct: number;
  maniac4betK: number;

  // ---- 加注战护栏（L3/L1/L2 机制修复；warGuardEnabled=false 整体恢复旧行为，用于 A/B）----
  /** 加注战护栏总开关：翻后再加注升级门槛 + 翻前 premium 互加封顶 + 3bet 跟注上限 */
  warGuardEnabled: boolean;
  /** 被再加注（raisesSeen ≥ 1，翻前 3bet/翻后 raise 回来）后，价值再加注的 equity 门槛 */
  warRaiseEq3bet: number;
  /** 被 4bet+（raisesSeen ≥ 2）后，价值再加注的 equity 门槛 */
  warRaiseEq4bet: number;
  /** 河牌单挑（精确枚举）被 4bet+ 时的再加注门槛（取代 warRaiseEq4bet） */
  warRaiseEq4betRiverHU: number;
  /** raisesSeen ≥ 此值后禁止再加注（除非 eq ≥ warNutsEq） */
  warMaxRaises: number;
  /** 坚果级豁免：eq ≥ 此值时无视 warMaxRaises 封顶 */
  warNutsEq: number;
  /** 翻前被 4bet+（raisesSeen ≥ 2）时，pct ≥ 此值（约 QQ+/KK+）才允许继续加注/全下；
   *  0.965–此值档（99-JJ）在深筹码（≥ premiumAllinBB）下降级为跟注 */
  premium5betPct: number;
  /** 面对 3bet+ 的跟注数额上限（bb）：跟注额超过且 pct < premiumPct 时弃牌 */
  callVs3betMaxBB: number;
  /** premium 档对 callVs3betMaxBB 的豁免下限（L2'）：pct ≥ 此值（约 QQ+ 档，
   *  QQ 百分位 0.9881 ≥ 0.985 同在豁免档）才豁免 25bb 跟注上限；
   *  premiumPct–此值档（99-JJ）面对超额 3bet+ 跟注额同样弃牌。
   *  0 = 全部 premium 豁免（恢复 L2 原行为，用于 A/B） */
  callVs3betPremiumExemptPct: number;

  // ---- 翻后：SPR 承诺 ----
  /** stack ≤ sprThreshold × pot 且 eq ≥ commitEq → 直接全下（按风格分档） */
  sprThreshold: number;
  sprCommitEqStation: number;
  sprCommitEqNit: number;
  sprCommitEqDefault: number;

  // ---- 翻后：面对下注 ----
  /** 跟注安全边际随对手数递增：+ callMarginPerOpp × (opponents-1)。
   *  仅旧框架（multiwayDefenseV2Enabled=false）生效；V2 框架改用
   *  multiwayDefenseV2MarginPerOpp（实现率税，步进已降低） */
  callMarginPerOpp: number;
  /** 绝对下限（不犯蠢）：eq < foldFloorEq 且注额 > foldFloorBetFrac × 池 → 必弃 */
  foldFloorEq: number;
  foldFloorBetFrac: number;
  /** 价值加注 equity 门槛：单挑基准 + 每多一对手增量 - 河牌减项 */
  valueRaiseEqHU: number;
  valueRaiseEqPerOpp: number;
  valueRaiseRiverDiscount: number;
  /** 风格特化的价值加注门槛 */
  valueRaiseEqStation: number;
  valueRaiseEqNit: number;
  valueRaiseEqManiac: number;
  /** 价值加注执行概率：默认 / 跟注站（坚果级 eq ≥ stationNutsEq 时 / 其余） */
  valueRaiseProb: number;
  stationNutsEq: number;
  stationNutsRaiseProb: number;
  stationRaiseProb: number;
  /** 价值加注尺度（池比例）：gto 混合二选一 / 默认 */
  valueRaiseFracGtoA: number;
  valueRaiseFracGtoB: number;
  valueRaiseFrac: number;
  /** 诈唬加注条件与尺度：对手数上限、注额池比上限、eq 下限、概率系数、池比例 */
  bluffRaiseMaxOpps: number;
  bluffRaiseMaxBetFrac: number;
  bluffRaiseMinEq: number;
  bluffRaiseK: number;
  bluffRaiseFrac: number;

  // ---- 翻后：无人下注 ----
  /** 价值下注 equity 门槛：单挑基准 + 每多一对手增量 - 河牌减项 */
  valueBetEqHU: number;
  valueBetEqPerOpp: number;
  valueBetRiverDiscount: number;
  /** 价值下注尺度（池比例）：gto 混合二选一 / maniac / nit / 默认 */
  valueBetFracGtoA: number;
  valueBetFracGtoB: number;
  valueBetFracManiac: number;
  valueBetFracNit: number;
  valueBetFrac: number;
  /** 半诈唬：eq 下限、概率 = 激进度 × semiBluffK × 多人衰减、池比例尺度 */
  semiBluffMinEq: number;
  semiBluffK: number;
  semiBluffFrac: number;
  /** 纯诈唬：eq 上限、概率 = 有效诈唬率 × pureBluffK × 衰减 ×（河牌 pureBluffRiverK）、池比例尺度 */
  pureBluffMaxEq: number;
  pureBluffK: number;
  pureBluffRiverK: number;
  pureBluffFrac: number;
  /** 多人底池诈唬衰减基数：bluffScale = bluffMultiwayBase^(opponents-1) */
  bluffMultiwayBase: number;

  // ---- 范围推断（range-based equity；rangeModeEnabled=false 整体恢复旧行为，用于 A/B）----
  /** 范围推断总开关：面对下注/加注时用「vs 推断范围」与「vs 随机」混合胜率做决策 */
  rangeModeEnabled: boolean;
  /** 混合比例：最终 equity = 范围胜率 × (1-rangeBlendRandom) + 随机胜率 × rangeBlendRandom
   *  （默认 0 = 纯范围胜率；1 = 完全退回随机范围胜率） */
  rangeBlendRandom: number;
  /** 范围蒙特卡洛迭代数 = 随机蒙特卡洛迭代数 × 此系数（范围 MC 有枚举建池开销） */
  rangeItersScale: number;
  /** 多人池口径：true = 每轮抽 N 个不共牌的范围对手联合摊薄（hero 需压过全部）；
   *  false = 旧近似（多人池 = 对收紧范围抽单个对手，会高估多人池胜率，A/B 用）。
   *  注意：multiwayDefenseV2Enabled 开启时多人池面注改走「只对下注者」口径，
   *  本旋钮在该路径被取代（不再联合采样）；单挑路径本旋钮无作用 */
  rangeMultiwayJoint: boolean;
  /** 多人池面注防守 V2 框架（与训练器 2026-09-29 新框架对齐，gto/multiway.ts
   *  防守侧）：facingBet 且 opponents>1 时，胜率评估改为「只对下注者」口径——
   *  inferFacingSpec 的 aggressionLevel 按 1 传（spec 不做多人池 ×0.8 收紧）
   *  且 equityVsRange 只抽下注者 1 人，不再「联合压全场 + 全员 bettor 强 spec」
   *  双重收紧；身后尚未行动的跟注者视为死钱（死钱改善直接赔率），多人摊薄由
   *  「对下注者 + 死钱赔率」框架计价，跟注门槛步进相应降为
   *  multiwayDefenseV2MarginPerOpp（实现率税）。false = 旧框架（联合摊薄 +
   *  全员强 spec + callMarginPerOpp 0.03/人步进）。单挑（opponents=1）两侧
   *  逐比特一致。
   *  默认关闭：Phase 10 台架（6max 混风格 12000 手 × seeds 42-44 配对）
   *  合并 -12.8 bb/100 [-19.0,-6.5]（n=36000）未过采纳线，机制保留供 A/B。 */
  multiwayDefenseV2Enabled: boolean;
  /** V2 框架的跟注安全边际每多一对手步进（实现率税；旧框架为 callMarginPerOpp） */
  multiwayDefenseV2MarginPerOpp: number;

  // ---- 通用 ----
  /** 目标额 ≥ allinTriggerFrac × 全下额时直接 all-in（而非小注） */
  allinTriggerFrac: number;
  /** 蒙特卡洛迭代数缩放（台架提速；1 = 生产默认精度；不影响河牌单挑精确枚举） */
  equityIterationsScale: number;

  // ---- 风格表增量（叠加在 StyleTuning 上；0 / 1 = 当前行为）----
  /** 跟注安全边际增量（正值更紧） */
  callMarginDelta: number;
  /** 主动价值下注门槛边际增量 */
  betMarginDelta: number;
  /** 价值 3bet 百分位门槛增量（范围口径开启时同量叠加到对范围胜率门槛） */
  value3betPctDelta: number;
  /** 面对加注的跟注百分位门槛增量（范围口径开启时同量叠加到对范围胜率门槛） */
  callVsRaisePctDelta: number;
  /** 面对 3bet+ 的跟注百分位门槛增量 */
  callVs3betPctDelta: number;
  /** 风格诈唬频率基数乘数（作用于 HEURISTIC_PARAMS[style].bluffFreq） */
  bluffFreqMult: number;

  // ---- 对手建模剥削（adapt.ts；无 opponentModels 时两项均不生效）----
  /**
   * 位置维度建模总开关（Phase 6）：开启时对模型按分桶校正重分类
   * （classifyPositional：BTN 松 + UTG 紧不再误判为全面松浪），并启用位置
   * 敏感剥削——加注者 late 桶偷盲频率超基线 → 盲位防守放宽；maniac 在
   * early 位加注 → 收紧给尊重（facingRaiseDelta）。false = 总体口径旧行为。
   */
  adaptPositionalEnabled: boolean;
  /**
   * 近因衰减 λ（adapt.ts updateStats 每手更新前旧计数 ×λ；1.0 = 关闭，
   * 整数累加旧口径）。brain 不直接读该值：统计衰减发生在 updateStats，
   * 台架在每场 match 开始按座位 0 的此值调 setAdaptRecencyLambda
   * （见 match.ts）；生产 gameStore 路径固定用 adapt.ts 模块默认值 0.92。
   */
  adaptRecencyLambda: number;

  // ---- Phase 8：摊牌学习 + blocker 效应 ----
  /**
   * 摊牌学习总开关（showdown-calibrated ranges）：对手摊牌亮牌按位置桶累积
   * （adapt.ts showdownsSeen 环形缓冲，上限 30 条/座位），rangeWidthAdjustment
   * 把该桶亮牌中弱牌（翻前强度百分位 < 0.5）占比渲染为范围宽度乘数
   * （0.9 微收 — 1.5 放宽），经 showdownWidthMult 按模型置信度缩放后作用于：
   * 翻前面对加注——preflopRangeMode 下对加注者开局范围宽度（topPct）直接乘，
   * 百分位口径下继续范围宽度 (1-callPct) 同比例缩放；翻后——facing spec 的
   * topPct（inferFacingSpec 第 5 参）。false = 全部跳过，逐比特旧行为。
   * 默认 false：Phase 8 台架（6max 混风格 × 12000 手 × 3 种子配对）合并
   * +0.0 bb/100 [-3.0, +3.1] 未过采纳线，机制保留供 A/B
   * （见 results/phase8-showdown-blocker-report.md）。
   */
  showdownLearnEnabled: boolean;
  /**
   * blocker 效应开关：equityVsRange 采样时按 hero 底牌对范围组合降权
   * （hero 持某花色 A → 对手该花色同花听组合 ×0.55；hero 对子点数在 board
   * 出现 → 对手含该点数的三条组合 ×0.5）。池内无规则命中时走均匀旧路径，
   * false = 完全旧行为（逐比特）。
   * 默认 false：Phase 8 台架（同上配置）合并 -0.3 bb/100 [-1.3, +0.7]
   * 未过采纳线，机制保留供 A/B（同上报告）。
   */
  blockerEnabled: boolean;

  // ---- 锦标赛上下文（轻量 ICM 风格调整；input.tournament 存在且 icmEnabled 时生效）----
  /** 锦标赛调整总开关：false 或 input.tournament 缺省时全部零修正（现金局行为）。
   *  默认关闭：Phase 7 台架（8 人 SNG × 30 种子）名次差 CI [0,0] 未过采纳线，
   *  机制保留供 A/B（见 results/phase7-icm-report.md） */
  icmEnabled: boolean;
  /** bubble/final 短码（myStackBB < 15）面对加注/下注的跟注门槛收紧量
   *  （翻前百分位门槛与翻后胜率边际同量；0.04 ≈ 收紧 4 个百分点） */
  icmBubbleCallTighten: number;
  /** bubble/final 大筹码（排名前 1/3 且 myStackBB > 2×avgStackBB）的
   *  主动下注/诈唬类概率乘数（大筹码施压短码；1 = 不上调） */
  icmBigStackPressure: number;
}

/**
 * 默认调参：每个值等于参数化之前的硬编码行为。
 * 台架锦标赛只覆盖需要的字段（Partial），未覆盖字段保持此表行为。
 */
export const DEFAULT_BRAIN_TUNING: BrainTuning = {
  huNitLimpCullProb: 0.5,
  huJunkOpenManiacK: 0.5,
  huJunkOpenLagK: 0.3,
  stealMaxBehind: 2,
  stealManiacK: 0.3,
  stealLagK: 0.2,
  limpRaiseStationK: 0.15,
  limpRaiseK: 0.8,
  pushFoldBB: 12,
  pushFoldAlwaysBB: 10,
  pushFoldProb: 0.5,
  openBBHeadsUp: 2.5,
  openBB: 3,
  openPerLimperBB: 1,
  limperOffset: 1.5,
  bbDefend3betMult: 4,
  bbDefendBluffK: 0.35,
  callVsRaiseBBDiscount: 0.06,
  cheapCallFrac: 0.2,
  cheapCallDiscount: 0.04,
  shortAllinBB: 15,
  shortAllinPct: 0.88,
  threeBetIPMult: 3,
  threeBetOOPMult: 4,
  ipMinBehind: 2,
  bluff3betBand: 0.10,
  bluff3betK: 0.3,
  preflopPosAdjustEnabled: false,
  preflopPosAdjustUTG: 0.04,
  preflopPosAdjustBTN: -0.04,
  // 默认开启：Phase 9 深筹复测（6max 200bb，12000 手 × seeds 42-44 合并 n=36000）
  // +29.7 bb/100 [+9.7,+49.7] CI 全正且中值 >+15 过采纳线
  // （见 results/phase9-deep-retest-report.md；Phase 8 100bb 档 +5.3 [-6.2,+16.9] 未过线保留）
  preflopRangeModeEnabled: true,
  premiumPct: 0.965,
  premiumAllinBB: 30,
  fourBetMult: 2.2,
  maniac4betPct: 0.80,
  maniac4betK: 0.15,
  warGuardEnabled: true,
  warRaiseEq3bet: 0.78,
  warRaiseEq4bet: 0.85,
  warRaiseEq4betRiverHU: 0.90,
  warMaxRaises: 3,
  warNutsEq: 0.97,
  premium5betPct: 0.985,
  callVs3betMaxBB: 25,
  callVs3betPremiumExemptPct: 0.985,
  sprThreshold: 2,
  sprCommitEqStation: 0.75,
  sprCommitEqNit: 0.68,
  sprCommitEqDefault: 0.60,
  callMarginPerOpp: 0.03,
  foldFloorEq: 0.12,
  foldFloorBetFrac: 0.75,
  valueRaiseEqHU: 0.65,
  valueRaiseEqPerOpp: 0.03,
  valueRaiseRiverDiscount: 0.03,
  valueRaiseEqStation: 0.85,
  valueRaiseEqNit: 0.70,
  valueRaiseEqManiac: 0.60,
  valueRaiseProb: 0.8,
  stationNutsEq: 0.9,
  stationNutsRaiseProb: 0.5,
  stationRaiseProb: 0.3,
  valueRaiseFracGtoA: 0.6,
  valueRaiseFracGtoB: 0.75,
  valueRaiseFrac: 0.7,
  bluffRaiseMaxOpps: 2,
  bluffRaiseMaxBetFrac: 1.2,
  bluffRaiseMinEq: 0.10,
  bluffRaiseK: 0.35,
  bluffRaiseFrac: 0.6,
  valueBetEqHU: 0.52,
  valueBetEqPerOpp: 0.06,
  valueBetRiverDiscount: 0.03,
  valueBetFracGtoA: 0.5,
  valueBetFracGtoB: 0.67,
  valueBetFracManiac: 0.67,
  valueBetFracNit: 0.5,
  valueBetFrac: 0.6,
  semiBluffMinEq: 0.30,
  semiBluffK: 0.35,
  semiBluffFrac: 0.5,
  pureBluffMaxEq: 0.30,
  pureBluffK: 0.6,
  pureBluffRiverK: 0.8,
  pureBluffFrac: 0.5,
  bluffMultiwayBase: 0.5,
  rangeModeEnabled: true,
  rangeBlendRandom: 0,
  rangeItersScale: 0.5,
  rangeMultiwayJoint: true,
  // Phase 10 验收未过采纳线：6max 混风格 12000 手 × seeds 42-44 配对（座位 0
  // V2 开 vs 关），合并 -12.8 bb/100 [-19.0, -6.5]（s42 -19.3 [-29.3,-9.2] /
  // s43 -12.4 [-23.2,-1.7] / s44 -6.6 [-18.2,+4.9]，n=36000）——CI 全负，
  // 远离「CI 全正且中值 >+15」采纳线：对下注者口径在本台架环境下防守过宽。
  // 机制保留供 A/B（见 results/phase10-multiway-defense-v2-report.md）
  multiwayDefenseV2Enabled: false,
  multiwayDefenseV2MarginPerOpp: 0.01,
  allinTriggerFrac: 0.65,
  equityIterationsScale: 1,
  callMarginDelta: 0,
  betMarginDelta: 0,
  value3betPctDelta: 0,
  callVsRaisePctDelta: 0,
  callVs3betPctDelta: 0,
  bluffFreqMult: 1,
  adaptPositionalEnabled: true,
  adaptRecencyLambda: 0.92,
  // Phase 8 验收：两机制合并 CI 均跨零且中值 ≈0（showdown +0.0 [-3.0,+3.1]、
  // blocker -0.3 [-1.3,+0.7]，n=36000，seeds 42-44），未过采纳线 → 默认关闭，
  // 机制保留供 A/B（见 results/phase8-showdown-blocker-report.md）
  showdownLearnEnabled: false,
  blockerEnabled: false,
  // Phase 7 验收未过采纳线：8 人 SNG × 30 种子（42-71）座位 0 icmEnabled
  // false→true 名次差 mean 0.000，95% CI [0,0]（见 results/phase7-icm-report.md）。
  // 根因：phase 口径下 8 人桌 bubble/final 仅覆盖单挑，调整触发面太窄。
  // 机制保留供 A/B；注入（gameStore/match）与 prompt 事实段不受此开关影响。
  icmEnabled: false,
  icmBubbleCallTighten: 0.04,
  icmBigStackPressure: 1.3,
};

// ---------------------------------------------------------------------------
// 风格调制参数
// ---------------------------------------------------------------------------

interface StyleTuning {
  /** 跟注所需胜率的安全边际（正值更紧，负值更松） */
  callMargin: number;
  /** 无人下注时主动价值下注阈值的边际（正值更被动） */
  betMargin: number;
  /** 面对加注做价值 3bet 的百分位门槛（preflopRangeModeEnabled 关闭时口径） */
  value3betPct: number;
  /** 面对加注的跟注百分位门槛（preflopRangeModeEnabled 关闭时口径） */
  callVsRaisePct: number;
  /** 面对 3bet+ 的跟注百分位门槛 */
  callVs3betPct: number;
  /** 诈唬频率倍率（maniac ×2.5，其余 1） */
  bluffMult: number;
  /** 范围口径（preflopRangeModeEnabled 开启）：面对加注的跟注门槛——
   *  手牌对加注者开局范围的真实胜率下限（绝对口径，重新标定；
   *  callVsRaisePctDelta / facingRaiseDelta / icm.callTighten / BB 与便宜跟注
   *  折扣继续以同量叠加到本胜率门槛上） */
  callVsOpenRangeEq: number;
  /** 范围口径：价值 3bet 的对范围胜率门槛 */
  value3betVsRangeEq: number;
}

function styleTuning(style: ConcreteAIStyle): StyleTuning {
  switch (style) {
    case "nit":
      return { callMargin: 0.08, betMargin: 0.08, value3betPct: 0.97, callVsRaisePct: 0.78, callVs3betPct: 0.96, bluffMult: 1, callVsOpenRangeEq: 0.48, value3betVsRangeEq: 0.66 };
    case "tag":
      return { callMargin: 0.04, betMargin: 0, value3betPct: 0.955, callVsRaisePct: 0.68, callVs3betPct: 0.90, bluffMult: 1, callVsOpenRangeEq: 0.46, value3betVsRangeEq: 0.63 };
    case "lag":
      return { callMargin: 0.05, betMargin: -0.04, value3betPct: 0.93, callVsRaisePct: 0.58, callVs3betPct: 0.88, bluffMult: 1, callVsOpenRangeEq: 0.44, value3betVsRangeEq: 0.60 };
    case "maniac":
      return { callMargin: 0.06, betMargin: -0.10, value3betPct: 0.90, callVsRaisePct: 0.52, callVs3betPct: 0.85, bluffMult: 2.5, callVsOpenRangeEq: 0.42, value3betVsRangeEq: 0.58 };
    case "calling_station":
      return { callMargin: -0.04, betMargin: 0.12, value3betPct: 0.975, callVsRaisePct: 0.60, callVs3betPct: 0.92, bluffMult: 1, callVsOpenRangeEq: 0.42, value3betVsRangeEq: 0.67 };
    case "gto":
      return { callMargin: 0.03, betMargin: 0, value3betPct: 0.95, callVsRaisePct: 0.66, callVs3betPct: 0.90, bluffMult: 1, callVsOpenRangeEq: 0.45, value3betVsRangeEq: 0.62 };
  }
}

// ---------------------------------------------------------------------------
// 对手建模剥削调整（adapt.ts 接入点）
// ---------------------------------------------------------------------------

/** 剥削调整生效时的诈唬频率上限（无对手模型时不钳制，保持原有行为） */
export const BLUFF_FREQ_CAP = 0.6;

/**
 * 聚合在局对手的画像为剥削性修正。
 * 只采纳本手仍在局的对手（已弃牌/淘汰者不再是剥削对象）；
 * 无模型或对手全部 unknown 时返回 IDENTITY_ADJUSTMENT（零修正）。
 *
 * 位置维度建模（T.adaptPositionalEnabled，Phase 6）：开启时对模型按分桶
 * 校正重分类（classifyPositional），并把翻前加注者信息（本街最后抬线者
 * 及其身后人数）传给 adjustments 做位置敏感剥削；关闭时两个机制都不生效，
 * 行为与 Phase 6 前逐比特一致。
 */
function opponentAdjustment(
  input: DecideInput,
  mySeat: Seat,
  T: BrainTuning,
): Adjustment {
  const models = input.opponentModels;
  if (!models || models.length === 0) return IDENTITY_ADJUSTMENT;
  const active = models.filter((m) => {
    const p = input.state.players[m.seat];
    return !!p && !p.folded && !p.eliminated;
  });
  if (active.length === 0) return IDENTITY_ADJUSTMENT;
  const isPreflop = input.state.board.length === 0;

  // 分桶校正重分类（开启时）；校正结果与原分类一致则保留原对象引用
  const effModels = T.adaptPositionalEnabled
    ? active.map((m) => {
        const c = classifyPositional(m.stats);
        return c.cls === m.cls ? m : { ...m, cls: c.cls };
      })
    : active;

  // 翻前面对加注时，向 adjustments 提供加注者位置（其身后人数 → 分桶口径）
  let raiser: { seat: Seat; behind: number } | undefined;
  if (T.adaptPositionalEnabled && isPreflop && preflopRaiseLevel(input) >= 1) {
    const r = bettingLineInfo(input).lastRaiser;
    if (r !== null && r !== mySeat) {
      const order = actOrderInfo(r, input.state);
      if (order) {
        raiser = { seat: r, behind: order.activeCount - order.preflopRank };
      }
    }
  }

  return adjustments(effModels, {
    isPreflop,
    position: seatPositionName(mySeat, input.state.buttonSeat, input.state.players.length),
    activeOpponents: active.length,
    positionalEnabled: T.adaptPositionalEnabled,
    raiser,
  });
}

// ---------------------------------------------------------------------------
// 锦标赛上下文调整（轻量 ICM 风格；Phase 7）
// ---------------------------------------------------------------------------

/** ICM 风格修正量：跟注门槛收紧量（百分点）与主动下注/诈唬概率乘数 */
interface IcmAdjust {
  /** 加到跟注门槛上（翻前百分位 / 翻后胜率边际）；0 = 不收紧 */
  callTighten: number;
  /** 主动下注/诈唬类概率乘数；1 = 不上调 */
  pressure: number;
}

/** 短码阈值（大盲倍数）：bubble/final 低于此值收紧跟注 */
const ICM_SHORT_STACK_BB = 15;

/**
 * 由 TournamentContext 推导修正量。tournament 缺省（现金局）、icmEnabled=false、
 * 或 early/middle 阶段时返回零修正（callTighten 0 / pressure 1），调用点
 * 行为与无锦标赛逐比特一致。
 *
 * 大筹码判定：myRankByChips × 3 ≤ playersRemaining（严格前 1/3）且
 * myStackBB > 2 × avgStackBB。注意在 8-9 人 SNG 的 phase 口径下 bubble/final
 * 只剩 ≤2-3 人，「> 2×平均」在单挑时数学上不可达——该规则主要为更大场设计。
 */
function icmAdjust(input: DecideInput, T: BrainTuning): IcmAdjust {
  const t = input.tournament;
  if (!t || !T.icmEnabled) return { callTighten: 0, pressure: 1 };
  if (t.phase !== "bubble" && t.phase !== "final") {
    return { callTighten: 0, pressure: 1 };
  }
  const shortStack = t.myStackBB < ICM_SHORT_STACK_BB;
  const bigStack =
    t.myRankByChips * 3 <= t.playersRemaining &&
    t.myStackBB > 2 * t.avgStackBB;
  return {
    callTighten: shortStack ? T.icmBubbleCallTighten : 0,
    pressure: bigStack ? T.icmBigStackPressure : 1,
  };
}

// ---------------------------------------------------------------------------
// 对外数据快照（供 opponent.ts 注入 LLM prompt）
// ---------------------------------------------------------------------------

export interface BrainStats {
  /** 当前有效胜率 0-1（翻后为蒙特卡洛/精确枚举；翻前为对 N 个随机范围的模拟） */
  equity: number;
  /** 在局对手数 */
  opponents: number;
  /** 跟注所需胜率（无需跟注时为 null） */
  required: number | null;
  /** 是否翻前 */
  preflop: boolean;
  /**
   * 面对下注/加注时的混合胜率（与 postflop 决策同一口径：vs 推断范围 × (1-blend)
   * + vs 随机 × blend，默认 blend 0 即纯范围胜率）；非面注/翻前为 null（F3）。
   */
  equityVsRange: number | null;
}

/** 计算当前局面的胜率与所需胜率，供 prompt 注入；信息不足时返回 null */
export function brainStats(input: DecideInput): BrainStats | null {
  const seat = input.state.currentSeat;
  if (seat === null) return null;
  const me = input.state.players[seat];
  if (!me?.holeCards) return null;
  const opp = Math.max(1, countOpponents(input, seat));
  const preflop = input.state.board.length === 0;
  const equity = preflop
    ? preflopEquityVs(me.holeCards, opp)
    : heroEquity(me.holeCards, input.state.board, opp);
  const required = input.callAmount > 0
    ? input.callAmount / (input.state.pot + input.callAmount)
    : null;
  // F3：面注时补范围口径胜率（与 postflopDecide 的 eqF 同公式、同默认参数），
  // 消除「prompt 展示的胜率」与「决策实际使用的胜率」不一致
  let eqVsRange: number | null = null;
  if (!preflop && input.callAmount > 0) {
    const faceModel = facingOpponentModel(input);
    // 多人池面注 V2（与 postflopDecide 同一判定，走全局默认旋钮）
    const v2 = DEFAULT_BRAIN_TUNING.multiwayDefenseV2Enabled && opp > 1;
    const spec = inferFacingSpec(
      input.state.street,
      streetRaisesSeen(input),
      v2 ? 1 : opp,
      faceModel,
      // 摊牌学习宽度修正（brainStats 走全局默认旋钮，与决策路径同口径展示）
      showdownWidth(input, faceModel?.seat ?? null, DEFAULT_BRAIN_TUNING),
    );
    const rangeIters = Math.max(
      30,
      Math.round(iterationsFor(input.state.board, opp, 1) *
        DEFAULT_BRAIN_TUNING.rangeItersScale),
    );
    const eqRange = equityVsRange(
      me.holeCards,
      input.state.board,
      spec,
      rangeIters,
      Math.random,
      v2 ? 1 : DEFAULT_BRAIN_TUNING.rangeMultiwayJoint ? opp : 1,
      DEFAULT_BRAIN_TUNING.blockerEnabled,
    );
    eqVsRange = eqRange * (1 - DEFAULT_BRAIN_TUNING.rangeBlendRandom) +
      equity * DEFAULT_BRAIN_TUNING.rangeBlendRandom;
  }
  return { equity, opponents: opp, required, preflop, equityVsRange: eqVsRange };
}

// ---------------------------------------------------------------------------
// 决策主体
// ---------------------------------------------------------------------------

export type Rng = () => number;

interface Ctx {
  input: DecideInput;
  style: ConcreteAIStyle;
  rng: Rng;
  me: DecideInput["state"]["players"][number];
  legal: LegalSet;
  tune: StyleTuning;
  /** 全局调参旋钮（无覆盖时为 DEFAULT_BRAIN_TUNING，行为与历史版本一致） */
  T: BrainTuning;
  /** 风格参数（bluffFreq 已乘 T.bluffFreqMult） */
  params: HeuristicStyleParams;
  /** 对手建模剥削修正（无模型时为 IDENTITY_ADJUSTMENT，行为不变） */
  adj: Adjustment;
  /** 锦标赛 ICM 风格修正（无 tournament / icmEnabled=false / early-middle 时零修正） */
  icm: IcmAdjust;
  /**
   * 有效诈唬频率 = 风格诈唬率 × 风格倍率 × 剥削乘数；
   * 剥削生效时钳制 ≤ BLUFF_FREQ_CAP。
   */
  bluffFreqEff: number;
  opponents: number;
  profileName: string;
  position: string;
  /** 面注时决策实际使用的混合胜率（postflopDecide 写入；供 reasoning 双口径展示，F3） */
  facingEqF: number | null;
}

function sizeTo(ctx: Ctx, t: "bet" | "raise", target: number): number | null {
  const r = ctx.legal.range(t);
  if (!r) return null;
  return clamp(Math.round(target), r.min, r.max);
}

/** 全下额（bet-to 语义） */
function allinTo(ctx: Ctx): number {
  return ctx.legal.amount("allin") ?? ctx.me.streetBet + ctx.me.stack;
}

/** 目标额接近/超过全下额时直接 all-in，否则给 bet/raise */
function betOrAllin(ctx: Ctx, t: "bet" | "raise", target: number): PlayerAction | null {
  const total = ctx.me.streetBet + ctx.me.stack;
  if (ctx.legal.has("allin") && target >= ctx.T.allinTriggerFrac * total) {
    return { type: "allin", amount: allinTo(ctx) };
  }
  const amount = sizeTo(ctx, t, target);
  if (amount === null) return null;
  if (ctx.legal.has("allin") && amount >= allinTo(ctx)) {
    return { type: "allin", amount: allinTo(ctx) };
  }
  return { type: t, amount };
}

// ---------------------------------------------------------------------------
// 翻前决策树
// ---------------------------------------------------------------------------

function preflopDecide(ctx: Ctx, label: string): PlayerAction | null {
  const { input, style, rng, me, legal, tune, adj, T, params, icm } = ctx;
  const bb = input.state.bigBlind;
  const pct = preflopPercentile(label);
  const order = actOrderInfo(me.seat, input.state);
  const headsUp = (order?.activeCount ?? input.state.players.length) === 2;
  const behind = order ? order.activeCount - order.preflopRank : 2;
  const raiseLevel = preflopRaiseLevel(input);
  const stackBB = (me.streetBet + me.stack) / bb;

  // F5：面对加注时按「加注者位置」调制门槛——对 UTG（紧范围）收紧、对 BTN（宽范围）
  // 放宽，中间位置按行动顺序线性插值。单挑不加该修正（HU 面注恒走 BB 防守表分支）；
  // 序列为空（合成快照）或找不到加注者时零修正。
  // preflopRangeModeEnabled 开启时本机制失效（范围口径已按加注者位置推导范围宽度，
  // 位置信息被直接吸收，二者不叠加）。
  let posAdjust = 0;
  if (!headsUp && T.preflopPosAdjustEnabled && !T.preflopRangeModeEnabled && raiseLevel >= 1) {
    const raiser = bettingLineInfo(input).lastRaiser;
    const raiserOrder = raiser !== null ? actOrderInfo(raiser, input.state) : null;
    if (raiserOrder) {
      const raiserBehind = raiserOrder.activeCount - raiserOrder.preflopRank;
      const latest = 2; // BTN 锚点（behind=2）
      const earliest = Math.max(latest, raiserOrder.activeCount - 1); // 本桌 UTG 锚点
      const t = (clamp(raiserBehind, latest, earliest) - latest) /
        Math.max(1, earliest - latest);
      posAdjust = T.preflopPosAdjustBTN +
        (T.preflopPosAdjustUTG - T.preflopPosAdjustBTN) * t;
    }
  }

  // ---- 无人入池（可有 limper）----
  if (raiseLevel === 0) {
    // 剥削修正：对 nit 在翻前后位开局范围放宽一档（负向偏移 = 用更松的表）；
    // 无修正时沿用原值（behind 可为 0，不能无脑钳制，否则 BB 面对 limp 的表会变化）
    const styleBehind = shiftedBehind(behind, style, headsUp);
    const effBehind = adj.openRangeShift !== 0
      ? clamp(styleBehind + Math.round(adj.openRangeShift), 1, 8)
      : styleBehind;
    const sets = TABLE_SETS.get(openTableId(effBehind, headsUp))!;
    let act: RangeAction = sets.raise.has(label)
      ? "raise"
      : sets.call.has(label)
        ? "call"
        : "fold";

    // 单挑风格微调：nit 把 limp 边缘砍掉一半；lag/maniac 把垃圾牌混入开局
    // （icm.pressure：锦标赛 bubble/final 大筹码上调混入频率，×1 时逐比特不变）
    if (headsUp) {
      if (style === "nit" && act === "call" && rng() < T.huNitLimpCullProb) act = "fold";
      if ((style === "lag" || style === "maniac") && act === "fold" &&
        rng() < params.bluffFreq * adj.bluffMult * icm.pressure *
          (style === "maniac" ? T.huJunkOpenManiacK : T.huJunkOpenLagK)) act = "raise";
    } else if (act === "fold" && behind <= T.stealMaxBehind &&
      (style === "lag" || style === "maniac")) {
      // 后位偷盲：按诈唬率小概率用垃圾牌开局（前位绝不）；icm.pressure 同上
      if (rng() < params.bluffFreq * adj.bluffMult * icm.pressure *
        (style === "maniac" ? T.stealManiacK : T.stealLagK)) act = "raise";
    }
    // limp 档（SB 补全 / 单挑按钮）：进攻型按比例转为加注，被动型保留 limp
    if (act === "call" && input.callAmount > 0) {
      const raiseProb = style === "calling_station"
        ? params.aggression * T.limpRaiseStationK
        : params.aggression * T.limpRaiseK;
      if (legal.has("raise") && rng() < raiseProb) act = "raise";
    }

    if (act === "raise" && legal.has("raise")) {
      // 短筹码 push/fold：范围内直接 all-in 优先于小加注
      if (stackBB < T.pushFoldBB && legal.has("allin") &&
        (stackBB < T.pushFoldAlwaysBB || rng() < T.pushFoldProb)) {
        return { type: "allin", amount: allinTo(ctx) };
      }
      const base = headsUp ? T.openBBHeadsUp : T.openBB;
      const limpers = !headsUp && input.state.currentBet === bb
        ? Math.max(0, Math.round(input.state.pot / bb - T.limperOffset))
        : 0;
      return betOrAllin(ctx, "raise", base * bb + limpers * T.openPerLimperBB * bb);
    }
    if (act === "call" && input.callAmount > 0 && legal.has("call")) {
      return { type: "call", amount: legal.amount("call") ?? input.callAmount };
    }
    if (input.callAmount === 0 && legal.has("check")) return { type: "check", amount: 0 };
    if (legal.has("fold")) return { type: "fold", amount: 0 };
    return null;
  }

  // ---- 面对一次加注 ----
  if (raiseLevel === 1) {
    // 单挑大盲：使用专属防守表
    if (headsUp && behind === 0) {
      const sets = TABLE_SETS.get("bb_defend")!;
      const act: RangeAction = sets.raise.has(label)
        ? "raise"
        : sets.call.has(label)
          ? "call"
          : "fold";
      if (act === "raise" && legal.has("raise")) {
        return betOrAllin(ctx, "raise", input.state.currentBet * T.bbDefend3betMult); // OOP 4x（默认）
      }
      if (act === "call" || (act === "raise" && !legal.has("raise"))) {
        if (legal.has("call")) return { type: "call", amount: legal.amount("call") ?? input.callAmount };
      }
      // 松凶用大盲防守表里中等牌做 3bet 诈唬
      if ((style === "lag" || style === "maniac") && act === "call" && legal.has("raise") &&
        rng() < params.bluffFreq * T.bbDefendBluffK) {
        return betOrAllin(ctx, "raise", input.state.currentBet * T.bbDefend3betMult);
      }
      if (legal.has("fold")) return { type: "fold", amount: 0 };
      return null;
    }

    const inPosition = behind >= T.ipMinBehind;

    // 范围口径（F5 闭环，preflopRangeModeEnabled）：跟注/3bet 判定用手牌对
    // 「加注者开局范围（顶部 X%）」的真实胜率（range.ts 离线静态表），而非对随机
    // 胜率的静态百分位。范围宽度按加注者身后人数分档（preflopRaiserRangePct）；
    // 合成快照/行动序列缺失找不到加注者时按中位档 behind=3（≈28%）近似。
    // 风格门槛（callVsOpenRangeEq/value3betVsRangeEq）是绝对胜率口径的重新标定；
    // 剥削（facingRaiseDelta）、ICM 收紧、大盲关门折扣、便宜跟注折扣沿用旧路径
    // 的叠加项，同量作用于胜率门槛（单位从百分位换成胜率，增量量级相当）。
    // 本分支开启时 preflopPosAdjustEnabled 失效（posAdjust 恒 0，二者不叠加）。
    if (T.preflopRangeModeEnabled) {
      const raiser = bettingLineInfo(input).lastRaiser;
      const raiserOrder = raiser !== null ? actOrderInfo(raiser, input.state) : null;
      const raiserBehind = raiserOrder
        ? raiserOrder.activeCount - raiserOrder.preflopRank
        : 3;
      // 摊牌学习（Phase 8）：亮牌证据修正加注者开局范围宽度——topPct 直接乘
      // （旋钮关/无画像/无调整时 width=1 精确跳过，逐比特不变）；查表按最近档位吸附
      const width = showdownWidth(input, raiser, T);
      const raiserPct = width === 1
        ? preflopRaiserRangePct(raiserBehind)
        : clamp(preflopRaiserRangePct(raiserBehind) * width, 0.05, 1);
      const eqR = preflopEquityVsOpenRange(label, raiserPct);
      const callEq = tune.callVsOpenRangeEq
        + adj.facingRaiseDelta // 位置敏感剥削：对偷盲狂放宽 / 对 maniac 前位加注收紧
        + icm.callTighten // 锦标赛 bubble/final 短码收紧（+0 时不生效）
        - (behind === 0 ? T.callVsRaiseBBDiscount : 0) // 大盲关门行动，赔率好，放宽
        - (input.callAmount <= input.state.pot * T.cheapCallFrac ? T.cheapCallDiscount : 0); // 便宜跟注放宽

      // 短筹码面对加注：顶端范围直接 all-in（沿用对随机百分位口径——push/fold
      // 关心的是对全范围的牌力排名，不在本闭环范围）
      if (stackBB < T.shortAllinBB && pct >= T.shortAllinPct && legal.has("allin")) {
        return { type: "allin", amount: allinTo(ctx) };
      }
      if (eqR >= tune.value3betVsRangeEq + adj.facingRaiseDelta && legal.has("raise")) {
        return betOrAllin(ctx, "raise",
          input.state.currentBet * (inPosition ? T.threeBetIPMult : T.threeBetOOPMult));
      }
      if (eqR >= callEq && legal.has("call")) {
        return { type: "call", amount: legal.amount("call") ?? input.callAmount };
      }
      // 边缘可玩牌按风格诈唬 3bet（同花/连张/对子才有诈唬资格；带宽旋钮在
      // 胜率口径下复用）
      const [c1, c2] = me.holeCards!;
      const playable = c1[1] === c2[1] || Math.abs(rankValue(c1) - rankValue(c2)) <= 2;
      if (eqR >= callEq - T.bluff3betBand && playable && legal.has("raise") &&
        rng() < ctx.bluffFreqEff * T.bluff3betK) {
        return betOrAllin(ctx, "raise",
          input.state.currentBet * (inPosition ? T.threeBetIPMult : T.threeBetOOPMult));
      }
      if (legal.has("fold")) return { type: "fold", amount: 0 };
      return null;
    }

    let callPct = tune.callVsRaisePct
      + posAdjust // F5：加注者越靠前门槛越高
      + adj.facingRaiseDelta // 位置敏感剥削：对偷盲狂放宽 / 对 maniac 前位加注收紧
      + icm.callTighten // 锦标赛 bubble/final 短码：收紧跟注门槛（+0 时不生效）
      - (behind === 0 ? T.callVsRaiseBBDiscount : 0) // 大盲关门行动，赔率好，放宽
      - (input.callAmount <= input.state.pot * T.cheapCallFrac ? T.cheapCallDiscount : 0); // 便宜跟注放宽

    // 摊牌学习（Phase 8）：加注者位置桶亮牌越宽，hero 继续范围同比例放宽
    // （继续范围宽度 (1-callPct) 直接乘宽度乘数；width=1 精确跳过，逐比特不变）
    {
      const width = showdownWidth(input, bettingLineInfo(input).lastRaiser, T);
      if (width !== 1) callPct = clamp(1 - (1 - callPct) * width, 0, 1);
    }

    // 短筹码面对加注：顶端范围直接 all-in
    if (stackBB < T.shortAllinBB && pct >= T.shortAllinPct && legal.has("allin")) {
      return { type: "allin", amount: allinTo(ctx) };
    }
    if (pct >= tune.value3betPct + posAdjust + adj.facingRaiseDelta && legal.has("raise")) {
      return betOrAllin(ctx, "raise",
        input.state.currentBet * (inPosition ? T.threeBetIPMult : T.threeBetOOPMult));
    }
    if (pct >= callPct && legal.has("call")) {
      return { type: "call", amount: legal.amount("call") ?? input.callAmount };
    }
    // 边缘可玩牌按风格诈唬 3bet（同花/连张/对子才有诈唬资格）
    const [c1, c2] = me.holeCards!;
    const playable = c1[1] === c2[1] || Math.abs(rankValue(c1) - rankValue(c2)) <= 2;
    if (pct >= callPct - T.bluff3betBand && playable && legal.has("raise") &&
      rng() < ctx.bluffFreqEff * T.bluff3betK) {
      return betOrAllin(ctx, "raise",
        input.state.currentBet * (inPosition ? T.threeBetIPMult : T.threeBetOOPMult));
    }
    if (legal.has("fold")) return { type: "fold", amount: 0 };
    return null;
  }

  // ---- 面对 3bet+：只继续顶端范围 ----
  // 加注战护栏（L1）：被 4bet+（raisesSeen ≥ 2）时 premium 互加链封顶——
  // 只有 pct ≥ premium5betPct（约 QQ+/KK+）允许继续加注/全下；
  // 99-JJ 档在深筹码（≥ premiumAllinBB）下降级为跟注，不再 ×fourBetMult 几何互加。
  const pfWarCapped = T.warGuardEnabled &&
    Math.max(0, raiseLevel - 1) >= 2 &&
    pct < T.premium5betPct &&
    stackBB >= T.premiumAllinBB;
  if (pct >= T.premiumPct) {
    if (!pfWarCapped) {
      if (legal.has("allin") && stackBB < T.premiumAllinBB) return { type: "allin", amount: allinTo(ctx) };
      if (legal.has("raise")) return betOrAllin(ctx, "raise", input.state.currentBet * T.fourBetMult);
      if (legal.has("allin")) return { type: "allin", amount: allinTo(ctx) };
    }
    // 加注战护栏（L2'）：premium 的 callVs3betMaxBB 跟注上限豁免收窄到
    // pct ≥ callVs3betPremiumExemptPct（约 QQ+ 档）；99-JJ 档面对超额 3bet+
    // 跟注额不再无限跟注（深筹码跟注链实测单手 -26100bb），直接弃牌。
    const premiumCallBlocked = T.warGuardEnabled &&
      pct < T.callVs3betPremiumExemptPct &&
      input.callAmount > T.callVs3betMaxBB * bb;
    if (legal.has("call") && !premiumCallBlocked) {
      return { type: "call", amount: legal.amount("call") ?? input.callAmount };
    }
    if (premiumCallBlocked && legal.has("fold")) return { type: "fold", amount: 0 };
  }
  // 加注战护栏（L2）：面对 3bet+ 的跟注数额上限——非 premium 手牌不跟超额重注
  // （icm.callTighten：锦标赛 bubble/final 短码同样收紧对 3bet+ 的跟注门槛）
  if (pct >= tune.callVs3betPct + icm.callTighten && legal.has("call") &&
    !(T.warGuardEnabled && pct < T.premiumPct &&
      input.callAmount > T.callVs3betMaxBB * bb)) {
    return { type: "call", amount: legal.amount("call") ?? input.callAmount };
  }
  if (style === "maniac" && pct >= T.maniac4betPct && legal.has("raise") &&
    rng() < params.bluffFreq * adj.bluffMult * T.maniac4betK) {
    return betOrAllin(ctx, "raise", input.state.currentBet * T.fourBetMult);
  }
  if (legal.has("fold")) return { type: "fold", amount: 0 };
  return null;
}

// ---------------------------------------------------------------------------
// 翻后决策树
// ---------------------------------------------------------------------------

function postflopDecide(ctx: Ctx): PlayerAction | null {
  const { input, style, rng, me, legal, tune, opponents, adj, T, params, icm } = ctx;
  const hero = me.holeCards!;
  const board = input.state.board;
  const river = board.length === 5;
  const eq = heroEquity(hero, board, opponents, T.equityIterationsScale);
  const pot = Math.max(1, input.state.pot);
  const bluffScale = Math.pow(T.bluffMultiwayBase, Math.max(0, opponents - 1));

  const facingBet = input.callAmount > 0 && legal.has("call");

  // 范围推断（rangeMode）：只有面对下注/加注的决策才用混合胜率——对手的动作
  // 泄露了范围信息；无人下注的主动决策保持 vs 随机范围胜率（对手没给信息）。
  // 混合公式：eqF = 范围胜率 × (1-rangeBlendRandom) + 随机胜率 × rangeBlendRandom，
  // 防范围模型过自信。面注场景的 SPR 承诺判定同样改用 eqF（F2，见 facingBet 分支）。
  let eqF = eq;
  if (facingBet && T.rangeModeEnabled) {
    const faceModel = facingOpponentModel(input);
    // 多人池面注防守 V2（默认开）：只评估对下注者的胜率——spec 不按在局人数
    // 收紧（aggressionLevel=1）、equityVsRange 只抽下注者 1 人；身后跟注者视为
    // 死钱。旧框架（V2 关）：全员按下注者强 spec（×0.8^(N-1) 收紧）联合摊薄。
    const v2 = T.multiwayDefenseV2Enabled && opponents > 1;
    const spec = inferFacingSpec(
      input.state.street,
      streetRaisesSeen(input),
      v2 ? 1 : opponents,
      faceModel,
      // 摊牌学习（Phase 8）：面注对手位置桶的亮牌宽度乘数作用于 topPct
      // （旋钮关/无画像/无调整时 = 1，inferFacingSpec 内精确跳过）
      showdownWidth(input, faceModel?.seat ?? null, T),
    );
    const rangeIters = Math.max(
      30,
      Math.round(
        iterationsFor(board, opponents, T.equityIterationsScale) * T.rangeItersScale,
      ),
    );
    const eqRange = equityVsRange(
      hero, board, spec, rangeIters, Math.random,
      // V2：只对下注者（opponents=1）。旧框架：rangeMultiwayJoint=true 时每轮
      // 抽 N 个不共牌的范围对手联合摊薄；false 退回「对收紧范围抽单对手」近似
      v2 ? 1 : T.rangeMultiwayJoint ? opponents : 1,
      // blocker 效应（Phase 8）：hero 底牌对范围组合降权；false = 旧均匀采样
      T.blockerEnabled,
    );
    eqF = eqRange * (1 - T.rangeBlendRandom) + eq * T.rangeBlendRandom;
  }
  // 供 reasoning 双口径展示（F3）：面注时记录决策实际使用的混合胜率
  ctx.facingEqF = facingBet ? eqF : null;

  // SPR 管理（无下注的主动推进）：stack/pot 低于阈值且 vs 随机胜率足够 → 直接全下。
  // 面注场景的 commit 判定在 facingBet 分支内、warGuard 门槛之后进行（F2）。
  const commitEq = style === "calling_station"
    ? T.sprCommitEqStation
    : style === "nit" ? T.sprCommitEqNit : T.sprCommitEqDefault;
  if (!facingBet && eq >= commitEq && me.stack <= T.sprThreshold * pot &&
    legal.has("allin")) {
    return { type: "allin", amount: allinTo(ctx) };
  }

  if (facingBet) {
    const required = input.callAmount / (pot + input.callAmount);
    // 剥削修正：对 maniac/lag 放宽跟注边际抓诈唬（下限 -6%，见 adapt.ts 钳制）；
    // icm.callTighten：锦标赛 bubble/final 短码收紧跟注（+0 时不生效）。
    // 多人池步进：V2 框架（默认开，面注多人池）用实现率税
    // multiwayDefenseV2MarginPerOpp（摊薄已由「对下注者+死钱赔率」计价，步进
    // 相应降低）；旧框架用 callMarginPerOpp（叠加在联合摊薄之上）
    const marginPerOpp = T.multiwayDefenseV2Enabled && opponents > 1
      ? T.multiwayDefenseV2MarginPerOpp
      : T.callMarginPerOpp;
    const margin = tune.callMargin + adj.callMarginDelta + icm.callTighten +
      marginPerOpp * Math.max(0, opponents - 1);
    const threshold = required + margin;

    // 绝对下限：胜率过低且面对大注额，任何风格都弃牌
    const betFrac = input.callAmount / Math.max(1, pot - input.callAmount);
    if (eqF < T.foldFloorEq && betFrac > T.foldFloorBetFrac && legal.has("fold")) {
      return { type: "fold", amount: 0 };
    }

    // 价值加注：胜率远超门槛（单挑基准 65%，每多一对手 +3%，河牌略放宽）
    let vr = T.valueRaiseEqHU + T.valueRaiseEqPerOpp * Math.max(0, opponents - 1) -
      (river ? T.valueRaiseRiverDiscount : 0);
    if (style === "calling_station") vr = T.valueRaiseEqStation;
    else if (style === "nit") vr = T.valueRaiseEqNit;
    else if (style === "maniac") vr = T.valueRaiseEqManiac;
    // 加注战护栏（L3）：对手每再加注一次，价值再加注的 equity 门槛升档
    // （输入 equity 为混合胜率 eqF：范围推断收紧后护栏继续叠加升级门槛）。
    // 坚果级（eqF ≥ warNutsEq）豁免封顶。
    const warSeen = T.warGuardEnabled ? streetRaisesSeen(input) : 0;
    if (warSeen >= 2) {
      vr = Math.max(vr,
        river && opponents === 1 ? T.warRaiseEq4betRiverHU : T.warRaiseEq4bet);
    } else if (warSeen >= 1) {
      vr = Math.max(vr, T.warRaiseEq3bet);
    }
    const warCapped = T.warGuardEnabled && warSeen >= T.warMaxRaises && eqF < T.warNutsEq;
    // SPR 承诺（面注，F2）：低 SPR + 混合胜率足够 → 直接全下。
    // 位于 warGuard 升档之后（护栏先判，commit 后判）：被再加注过（warSeen ≥ 1）
    // 须同时过护栏升档后的价值门槛 vr，避免绕过护栏全下进强范围。
    const warGate = warSeen >= 1 ? vr : 0;
    if (!warCapped && eqF >= commitEq && eqF >= warGate &&
      me.stack <= T.sprThreshold * pot && legal.has("allin")) {
      return { type: "allin", amount: allinTo(ctx) };
    }
    if (!warCapped && eqF >= vr && legal.has("raise")) {
      const raiseProb = style === "calling_station"
        ? (eqF >= T.stationNutsEq ? T.stationNutsRaiseProb : T.stationRaiseProb)
        : T.valueRaiseProb;
      if (rng() < raiseProb) {
        const frac = style === "gto"
          ? (rng() < 0.5 ? T.valueRaiseFracGtoA : T.valueRaiseFracGtoB)
          : T.valueRaiseFrac;
        return betOrAllin(ctx, "raise",
          input.state.currentBet + Math.max(input.state.minRaise, Math.round(pot * frac)));
      }
    }

    if (eqF >= threshold && legal.has("call")) {
      return { type: "call", amount: legal.amount("call") ?? input.callAmount };
    }

    // 诈唬加注：有弃牌率空间（对手少、注额不超池）且风格掷签命中
    // （加注战封顶后不再诈唬加注——封顶层级下对手已表明强范围）
    if (!warCapped && legal.has("raise") && opponents <= T.bluffRaiseMaxOpps &&
      betFrac <= T.bluffRaiseMaxBetFrac && eqF >= T.bluffRaiseMinEq &&
      rng() < ctx.bluffFreqEff * T.bluffRaiseK * bluffScale) {
      return betOrAllin(ctx, "raise",
        input.state.currentBet + Math.max(input.state.minRaise, Math.round(pot * T.bluffRaiseFrac)));
    }

    if (legal.has("fold")) return { type: "fold", amount: 0 };
    return null;
  }

  // ---- 无人下注 ----
  if (legal.has("check")) {
    // 剥削修正：对跟注站/maniac 价值下注门槛打薄（负向修正）
    const vb = T.valueBetEqHU + T.valueBetEqPerOpp * Math.max(0, opponents - 1) +
      tune.betMargin + adj.valueBetDelta - (river ? T.valueBetRiverDiscount : 0);
    if (eq >= vb && legal.has("bet")) {
      const frac = style === "gto"
        ? (rng() < 0.5 ? T.valueBetFracGtoA : T.valueBetFracGtoB)
        : style === "maniac" ? T.valueBetFracManiac
          : style === "nit" ? T.valueBetFracNit : T.valueBetFrac;
      return betOrAllin(ctx, "bet", pot * frac);
    }
    // 半诈唬：有一定胜率（听牌）按激进度下注（icm.pressure：大筹码上调频率）
    if (eq >= T.semiBluffMinEq && !river && legal.has("bet") &&
      rng() < params.aggression * T.semiBluffK * bluffScale * icm.pressure) {
      return betOrAllin(ctx, "bet", pot * T.semiBluffFrac);
    }
    // 纯诈唬：低胜率按风格诈唬率 × 多人衰减（剥削生效时已钳制上限）
    if (eq < T.pureBluffMaxEq && legal.has("bet") &&
      rng() < ctx.bluffFreqEff * T.pureBluffK * bluffScale * (river ? T.pureBluffRiverK : 1)) {
      return betOrAllin(ctx, "bet", pot * T.pureBluffFrac);
    }
    return { type: "check", amount: 0 };
  }

  return null;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 胜率驱动决策（生产入口，使用 Math.random）。
 * tuning 为可选的全局调参覆盖（浅合并到 DEFAULT_BRAIN_TUNING）；
 * 不传或传 {} 时行为与历史版本逐比特一致（见 __tests__/brainTuning.test.ts）。
 */
export function brainDecide(
  input: DecideInput,
  style: ConcreteAIStyle,
  rng: Rng = Math.random,
  tuning?: Partial<BrainTuning>,
): DecideResult {
  const T: BrainTuning = tuning ? { ...DEFAULT_BRAIN_TUNING, ...tuning } : DEFAULT_BRAIN_TUNING;
  const profile = AI_PROFILES[style];
  const seat = input.state.currentSeat ?? 0;
  const me = input.state.players[seat];
  const legal = analyzeLegal(input, me.streetBet, me.stack);
  const opponents = Math.max(1, countOpponents(input, seat));
  const adj = opponentAdjustment(input, seat, T);
  const icm = icmAdjust(input, T);
  const baseParams = HEURISTIC_PARAMS[style];
  const params: HeuristicStyleParams = T.bluffFreqMult === 1
    ? baseParams
    : { ...baseParams, bluffFreq: baseParams.bluffFreq * T.bluffFreqMult };
  const st = styleTuning(style);
  const tune: StyleTuning = {
    callMargin: st.callMargin + T.callMarginDelta,
    betMargin: st.betMargin + T.betMarginDelta,
    value3betPct: st.value3betPct + T.value3betPctDelta,
    callVsRaisePct: st.callVsRaisePct + T.callVsRaisePctDelta,
    callVs3betPct: st.callVs3betPct + T.callVs3betPctDelta,
    bluffMult: st.bluffMult,
    // 范围口径门槛与百分位门槛共用同一组 delta 旋钮（单位不同、量级相当）
    callVsOpenRangeEq: st.callVsOpenRangeEq + T.callVsRaisePctDelta,
    value3betVsRangeEq: st.value3betVsRangeEq + T.value3betPctDelta,
  };
  const bluffRaw = params.bluffFreq * tune.bluffMult * adj.bluffMult;

  const ctx: Ctx = {
    input, style, rng, me, legal,
    tune,
    T,
    params,
    adj,
    icm,
    // 剥削生效时钳制诈唬率上限；无模型（恒等修正）时保持原值，行为逐比特不变。
    // icm.pressure：锦标赛 bubble/final 大筹码施压上调（===1 时跳过乘法保证逐比特）
    bluffFreqEff: (() => {
      const base = adj === IDENTITY_ADJUSTMENT ? bluffRaw : Math.min(BLUFF_FREQ_CAP, bluffRaw);
      return icm.pressure === 1 ? base : base * icm.pressure;
    })(),
    opponents,
    profileName: profile.name,
    position: positionName(seat, input.state),
    facingEqF: null,
  };

  let chosen: PlayerAction | null = null;
  let detail = "";

  if (!me.holeCards) {
    // 无底牌信息（异常快照）：保守过牌/弃牌
    chosen = null;
  } else if (input.state.board.length === 0) {
    const label = canonicalLabel(me.holeCards[0], me.holeCards[1]);
    chosen = preflopDecide(ctx, label);
    detail = `手牌 ${label}（翻前百分位 ${(preflopPercentile(label) * 100).toFixed(0)}%）`;
  } else {
    chosen = postflopDecide(ctx);
    const eq = heroEquity(me.holeCards, input.state.board, opponents, T.equityIterationsScale);
    detail = `胜率约 ${(eq * 100).toFixed(0)}%（对 ${opponents} 名对手）`;
    // F3：面注时决策实际使用的是混合胜率 eqF，reasoning 双口径展示，
    // 避免「胜率约 65%，选择弃牌」（实际按 eqF=40% 弃的）这类自相矛盾
    if (ctx.facingEqF !== null && ctx.facingEqF !== undefined) {
      detail += `，对手下注后 vs 推断范围胜率约 ${(ctx.facingEqF * 100).toFixed(0)}%`;
    }
  }

  // 兜底链：保证任何局面都返回合法动作
  let fallback = false;
  if (!chosen || !legal.has(chosen.type)) {
    fallback = true;
    if (legal.has("check")) chosen = { type: "check", amount: 0 };
    else if (legal.has("call")) chosen = { type: "call", amount: legal.amount("call") ?? input.callAmount };
    else if (legal.has("fold")) chosen = { type: "fold", amount: 0 };
    else if (legal.has("allin")) chosen = { type: "allin", amount: allinTo(ctx) };
    else if (legal.first) chosen = legal.first;
    else chosen = { type: "fold", amount: 0 };
  }

  if (chosen.type === "fold" || chosen.type === "check") chosen = { ...chosen, amount: 0 };

  const oddsText = input.callAmount > 0
    ? `，跟注所需胜率 ${((input.callAmount / (input.state.pot + input.callAmount)) * 100).toFixed(0)}%`
    : "";
  const reasoning = fallback
    ? `${profile.name}（${ctx.position}）：选择当前局面下的合法动作。`
    : `${profile.name}（${ctx.position}）：${detail}${oddsText}，选择${actionCn(chosen)}。`;

  return { action: chosen, reasoning, source: "heuristic" };
}

function actionCn(a: PlayerAction): string {
  switch (a.type) {
    case "fold": return "弃牌";
    case "check": return "过牌";
    case "call": return "跟注";
    case "bet": return `下注 ${a.amount}`;
    case "raise": return `加注到 ${a.amount}`;
    case "allin": return `全下 ${a.amount}`;
  }
}
