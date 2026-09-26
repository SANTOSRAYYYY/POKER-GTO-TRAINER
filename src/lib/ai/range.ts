/**
 * src/lib/ai/range.ts — 范围推断（range-based equity）
 *
 * 解决旧实现「翻后 equity 一律按对手 = 随机范围」（equity.ts 的 equityMulti）
 * 的最大弱点：对手主动下注/加注后其隐含范围远强于随机，vs 随机胜率会系统性
 * 高估 hero（加注战漏勺的根因之一）。
 *
 * 模型：
 * - RangeSpec { topPct, bluffPct }：对手范围 = 对当前 board 强度前 topPct 的
 *   底牌组合 + 以 bluffPct 相对权重混入的弱可玩牌（诈唬）。
 * - inferFacingSpec：按本街攻击性层级（raisesSeen，与 warGuard 同源）、
 *   在局对手数（多人池收紧）与对手画像（cls × confidence 加权）估计范围。
 * - equityVsRange：枚举剩余牌堆的全部底牌组合，按「evaluate7 对 board 的
 *   强度分位（经验分位 = 该组合在全部组合中的排名，天然 board 相关）」
 *   划分强牌集/诈唬集，再按权重（强牌 1 / 诈唬 bluffPct）无放回加权采样
 *   做蒙特卡洛。加权采样与「强牌必接受、诈唬以 bluffPct 概率接受」的拒绝
 *   采样同分布，但无拒绝循环，天然避免死循环。
 *
 * 实现注记（对设计稿的两处偏离，均为等价或更优替代）：
 * 1. 强度分位用「对全部组合的经验排名」而非「打分值→类别阈值查表」。
 *    查表法在 board 主导牌力的牌面（如 222A6，任意底牌至少三条）会把 ~85%
 *    的组合误判为 top 15%，使设计的 88 葫芦测试场景不成立；经验排名严格
 *    符合 RangeSpec「按对当前 board 的强度取前 X%」的语义。
 * 2. 加权采样替代拒绝采样（同分布证明：拒绝采样下强牌接受概率 1、诈唬
 *    接受概率 bluffPct，归一化后正比于权重 1 / bluffPct）。
 *
 * 多人池口径（2026-09 修复）：equityVsRange 每轮抽 opponents 个互不共牌的
 * 范围对手，hero 需压过全部才计 win（与 equityMulti 多人口径一致）。
 * 旧近似「多人池 = 对收紧范围抽单个对手」把多人摊薄完全丢失（中对子 vs
 * 4 个 top28% 范围：旧口径 ≈0.51，联合口径 ≈0.14），导致多人池面对小注
 * 系统性过度跟注。brain 侧由 rangeMultiwayJoint 旋钮切换（默认 true）。
 *
 * blocker 效应（Phase 8，旋钮 brain 侧 blockerEnabled）：hero 底牌对范围组合
 * 的组合权重修正——hero 持某花色 A 时，对手该花色的同花听组合（hole+board
 * 恰 4 张该花色且 hole 至少 1 张）权重 ×0.55（同花听缺了关键 A，非坚果听）；
 * hero 持对子且其点数在 board 出现时，对手包含该点数的组合（三条组合）
 * 权重 ×0.5。实现为 buildRangePool 的逐组合权重数组（无规则命中时池标记
 * 为均匀，采样退回旧公式路径，与 blockerEnabled=false 逐比特一致）。
 * rng 消耗口径：每次抽牌仍恰好 1 次 rng()（权重只改变 t 到组合的映射），
 * 单挑（opponents=1）时随机数消耗序列长度与旧版一致；多人池冲突重抽的
 * 次数随权重分布可能不同（配对两臂同发牌、各自合法，差值 CI 不受影响）。
 */
import type { Card, OpponentModel, Street } from "@/lib/types";
import { newDeck } from "@/lib/poker/cards";
import { evaluate7 } from "@/lib/poker/evaluator";

// ---------------------------------------------------------------------------
// RangeSpec：对手隐含范围的参数化描述
// ---------------------------------------------------------------------------

export interface RangeSpec {
  /** 范围主体：按「对当前 board 的强度」取前 topPct 的底牌组合（0-1） */
  topPct: number;
  /** 诈唬混入：弱牌（强度分位 < 0.5 的可玩牌）以 bluffPct 相对权重进入范围 */
  bluffPct: number;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// ---------------------------------------------------------------------------
// inferFacingSpec：面对下注/加注时的范围估计
// ---------------------------------------------------------------------------

/**
 * 基础表（单挑，本街首次下注 = raisesSeen 0）：
 * - 一条街首次下注：topPct 0.55 / bluff 0.15（下注者范围略强于随机上半区）
 * - raisesSeen=1（被 raise/3bet 回来）：0.30 / 0.10
 * - raisesSeen=2（被 4bet）：0.15 / 0.05
 * - raisesSeen≥3（5bet+）：0.07 / 0.02（近似坚果化）
 * 暂不按街道分档（flop/turn/river 同表），street 参数保留为将来分档的钩子。
 */
const BASE_BY_RAISES: readonly RangeSpec[] = [
  { topPct: 0.55, bluffPct: 0.15 },
  { topPct: 0.30, bluffPct: 0.10 },
  { topPct: 0.15, bluffPct: 0.05 },
  { topPct: 0.07, bluffPct: 0.02 },
];

/** 单挑基础表（同一组数值按街道复制；分档调整时改这里） */
const BASE_TABLE: Record<"flop" | "turn" | "river", readonly RangeSpec[]> = {
  flop: BASE_BY_RAISES,
  turn: BASE_BY_RAISES,
  river: BASE_BY_RAISES,
};

/** 多人池收紧系数：每多一个额外对手 topPct × 0.8 */
const MULTIWAY_TIGHTEN = 0.8;
/** topPct 钳制区间（防模型修正后失真） */
const TOP_PCT_MIN = 0.03;
const TOP_PCT_MAX = 0.8;

/**
 * 面对对手下注/加注时的范围估计。
 * @param street 当前街道（翻后才有意义；当前不分档，保留钩子）
 * @param raisesSeen 本街再加注层级（0 = 首次面对下注；与 warGuard 的 streetRaisesSeen 同源）
 * @param aggressionLevel 本街在局对手数（含下注者；多人池收紧因子。命名沿设计稿口径）
 * @param oppModel 可选的对手画像（cls × confidence 加权修正）
 * @param widthMult 摊牌学习的范围宽度乘数（adapt.ts showdownWidthMult；缺省/1 = 不调整，
 *   作用于 topPct——亮牌显示对手该位置桶范围更宽时 >1）
 */
export function inferFacingSpec(
  street: Street,
  raisesSeen: number,
  aggressionLevel: number,
  oppModel?: OpponentModel,
  widthMult?: number,
): RangeSpec {
  const rows =
    street === "flop" || street === "turn" || street === "river"
      ? BASE_TABLE[street]
      : BASE_BY_RAISES; // preflop/showdown 兜底（正常不会走到）
  const base = rows[Math.min(Math.max(0, Math.floor(raisesSeen)), rows.length - 1)];

  let topPct = base.topPct;
  let bluffPct = base.bluffPct;

  // 多人池：每个额外对手（超过单挑的 1 个）topPct × 0.8——下注进多人池需要更强范围
  const extra = Math.max(0, Math.floor(aggressionLevel) - 1);
  topPct *= Math.pow(MULTIWAY_TIGHTEN, extra);

  // 对手画像修正（按 confidence 加权：factor = 1 + (f_cls - 1) × conf）
  if (oppModel && oppModel.confidence > 0) {
    const c = clamp(oppModel.confidence, 0, 1);
    const w = (f: number) => 1 + (f - 1) * c;
    switch (oppModel.cls) {
      case "nit":
        topPct *= w(0.7); // nit 下注/加注范围更紧
        break;
      case "maniac":
        topPct *= w(1.5); // maniac 范围更宽
        bluffPct *= w(2); // 且诈唬更多
        break;
      case "calling_station":
        bluffPct *= w(0.5); // 跟注站少诈唬
        break;
      default:
        break; // tag/lag/gto/unknown 不修正
    }
  }

  // 摊牌学习（Phase 8）：亮牌证据的范围宽度乘数（缺省/1 时跳过，逐比特旧行为）
  if (widthMult !== undefined && widthMult !== 1) topPct *= widthMult;

  return {
    topPct: clamp(topPct, TOP_PCT_MIN, TOP_PCT_MAX),
    bluffPct: clamp(bluffPct, 0, 1),
  };
}

// ---------------------------------------------------------------------------
// equityVsRange：对推断范围的蒙特卡洛胜率
// ---------------------------------------------------------------------------

const RANK_VALUES: Record<string, number> = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};

/** 诈唬候选的「可玩牌」下限：同花 / 对子 / 连张（间隔 ≤ 2），与 brain 翻前 playable 口径一致 */
function playableHole(c1: Card, c2: Card): boolean {
  if (c1[1] === c2[1]) return true;
  const v1 = RANK_VALUES[c1[0]];
  const v2 = RANK_VALUES[c2[0]];
  return v1 === v2 || Math.abs(v1 - v2) <= 2;
}

interface RangePool {
  /** 剩余牌（已排除 hero 与 board） */
  cards: Card[];
  /** 强牌集：底牌对编码（i*64+j，i<j 为 cards 下标），接受权重 1 */
  strong: number[];
  /** 诈唬集：弱可玩底牌对编码，接受权重 = spec.bluffPct */
  bluff: number[];
  /**
   * blocker 逐组合权重（与 strong/bluff 平行；仅 blockerEnabled 且有规则命中时
   * 非 null）。null = 均匀权重，采样走旧公式路径（与 blockerEnabled=false 逐比特一致）
   */
  strongW: Float64Array | null;
  bluffW: Float64Array | null;
}

const POOL_CACHE_LIMIT = 400;
const poolCache = new Map<string, RangePool>();

const EQUITY_CACHE_LIMIT = 1500;
const rangeEquityCache = new Map<string, number>();

function poolCacheKey(
  hero: [Card, Card],
  board: Card[],
  spec: RangeSpec,
  blocker: boolean,
): string {
  const h = [...hero].sort().join("");
  const b = [...board].sort().join("");
  return `${h}|${b}|${spec.topPct.toFixed(4)}|${spec.bluffPct.toFixed(4)}|blk${blocker ? 1 : 0}`;
}

// ---- blocker 效应（Phase 8）：hero 底牌对范围组合的降权规则 ----
/** hero 持该花色 A 时，对手该花色同花听组合的权重乘数（同花听缺关键 A，非坚果听） */
export const BLOCKER_FLUSH_DRAW_MULT = 0.55;
/** hero 对子点数在 board 出现时，对手含该点数组合（三条）的权重乘数 */
export const BLOCKER_TRIPS_MULT = 0.5;

/**
 * 计算单个对手组合（cards 下标 i,j）的 blocker 权重乘数：
 * - 同花听 blocker：hero 持花色 s 的 A，且该组合 hole+board 恰 4 张 s 花色
 *   （hole 至少 1 张——纯 board 四同花的「公共听」不降权）→ ×0.55（每花色一次）；
 * - 三条 blocker：hero 对子点数 R 在 board 出现，组合 hole 含 R → ×0.5。
 * 两条规则可叠加（同组合同时命中时连乘）。
 */
function comboBlockerMult(
  c1: Card,
  c2: Card,
  hero: [Card, Card],
  board: Card[],
  boardSuitCnt: Record<string, number>,
): number {
  let w = 1;
  for (const hc of hero) {
    if (hc[0] !== "A") continue;
    const s = hc[1];
    const held = (c1[1] === s ? 1 : 0) + (c2[1] === s ? 1 : 0);
    if (held >= 1 && held + boardSuitCnt[s] === 4) w *= BLOCKER_FLUSH_DRAW_MULT;
  }
  if (hero[0][0] === hero[1][0]) {
    const rank = hero[0][0];
    if (
      board.some((c) => c[0] === rank) &&
      (c1[0] === rank || c2[0] === rank)
    ) {
      w *= BLOCKER_TRIPS_MULT;
    }
  }
  return w;
}

/**
 * 构建范围牌池：枚举剩余牌堆的全部底牌组合，按 evaluate7 对 board 打分
 * 的经验分位（该组合在全部组合中的降序排名 / 组合数）划分：
 * - 强牌集 = 前 ceil(nPairs × topPct) 名（topPct=1 时 = 全部组合，退化为随机范围）
 * - 诈唬集 = 经验分位 < 0.5（较弱的一半）且底牌可玩的组合
 * blocker=true 时逐组合计算 blocker 权重；无规则命中（常见情形）保持均匀
 * （strongW/bluffW = null），采样退回旧公式路径。
 */
function buildRangePool(
  hero: [Card, Card],
  board: Card[],
  spec: RangeSpec,
  blocker: boolean,
): RangePool {
  const dead = new Set<string>([...hero, ...board]);
  const cards = newDeck().filter((c) => !dead.has(c));
  const n = cards.length;

  // 全部组合打分，按分数降序排列（分数相同按编码升序，保证确定性）
  const scored: { idx: number; score: number }[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      scored.push({ idx: i * 64 + j, score: evaluate7([cards[i], cards[j], ...board]) });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);

  // blocker：预计算 board 各花色张数（无 A/无对子命中时整池均匀，逐组合判断免算）
  const boardSuitCnt: Record<string, number> = { s: 0, h: 0, d: 0, c: 0 };
  let blockerActive = blocker;
  if (blockerActive) {
    for (const c of board) boardSuitCnt[c[1]] += 1;
    const hasAce = hero[0][0] === "A" || hero[1][0] === "A";
    const pairOnBoard =
      hero[0][0] === hero[1][0] && board.some((c) => c[0] === hero[0][0]);
    blockerActive = hasAce || pairOnBoard;
  }

  const nPairs = scored.length;
  const strongCount = Math.max(1, Math.ceil(nPairs * clamp(spec.topPct, 0, 1)));
  const strong: number[] = [];
  const bluff: number[] = [];
  for (let rank = 0; rank < nPairs; rank++) {
    const { idx } = scored[rank];
    if (rank < strongCount) {
      strong.push(idx);
      continue;
    }
    // 经验分位 = 1 - rank/(nPairs-1)；< 0.5 即较弱的一半
    const q = nPairs > 1 ? 1 - rank / (nPairs - 1) : 1;
    if (q < 0.5 && playableHole(cards[idx >> 6], cards[idx & 63])) bluff.push(idx);
  }

  // blocker 权重：逐组合计算；全部组合乘数均为 1 时保持 null（均匀，旧路径）
  let strongW: Float64Array | null = null;
  let bluffW: Float64Array | null = null;
  if (blockerActive) {
    const sw = new Float64Array(strong.length).fill(1);
    const bw = new Float64Array(bluff.length).fill(1);
    let any = false;
    for (let k = 0; k < strong.length; k++) {
      const idx = strong[k];
      const m = comboBlockerMult(cards[idx >> 6], cards[idx & 63], hero, board, boardSuitCnt);
      if (m !== 1) {
        sw[k] = m;
        any = true;
      }
    }
    for (let k = 0; k < bluff.length; k++) {
      const idx = bluff[k];
      const m = comboBlockerMult(cards[idx >> 6], cards[idx & 63], hero, board, boardSuitCnt);
      if (m !== 1) {
        bw[k] = m;
        any = true;
      }
    }
    if (any) {
      strongW = sw;
      bluffW = bw;
    }
  }
  return { cards, strong, bluff, strongW, bluffW };
}

function getPool(
  hero: [Card, Card],
  board: Card[],
  spec: RangeSpec,
  blocker: boolean,
): RangePool {
  // 缓存键口径：均匀池（blocker 关闭或无规则命中）与加权池分离。均匀池同构
  // 同分布，统一存/查 blk0 键——「blocker 开但无命中」与「blocker 关」共享缓存，
  // 胜率结果逐比特一致（含 equity 层，见 equityVsRange 的 eqKey）
  if (blocker) {
    const hitW = poolCache.get(poolCacheKey(hero, board, spec, true));
    if (hitW) return hitW;
  }
  const key0 = poolCacheKey(hero, board, spec, false);
  const hit0 = poolCache.get(key0);
  if (hit0) return hit0;
  const pool = buildRangePool(hero, board, spec, blocker);
  const key = pool.strongW !== null ? poolCacheKey(hero, board, spec, true) : key0;
  if (poolCache.size >= POOL_CACHE_LIMIT) poolCache.clear();
  poolCache.set(key, pool);
  return pool;
}

/**
 * hero 对 RangeSpec 隐含范围的蒙特卡洛胜率（win + tie/2），带缓存。
 *
 * 每次迭代按权重无放回抽一对对手底牌（强牌权重 1、诈唬权重 bluffPct——
 * 与「强牌必接受、诈唬以 bluffPct 概率接受」的拒绝采样同分布，但无拒绝
 * 循环），再从剩余牌中补齐公共牌，evaluate7 比大小。
 *
 * 多人池（opponents > 1）：每轮独立加权采样 opponents 个互不共牌的对手
 * 底牌（物理不重复；冲突重抽，60 次兜底后顺序扫描强牌/诈唬集找无冲突
 * 组合），hero 必须压过全部对手才算 win、与最强对手并列算 tie——与
 * equityMulti 的多人口径一致。单挑（opponents=1）时随机数消耗与旧版
 * 逐比特一致。旧的「多人池 = 对收紧范围抽单个对手」近似会严重高估多人
 * 池胜率（中对子 vs 4 个 top28% 范围：单对手口径 ≈0.51，联合口径 ≈0.2），
 * 已由 brain 的 rangeMultiwayJoint 旋钮切换（默认 true = 联合口径）。
 *
 * 缓存 key 含 spec、迭代数、对手数与 blocker 开关（兼容 brain 的 equity 缓存
 * 风格：不同迭代数/对手数/开关的条目互不混用）。rng 可注入以便测试复现；
 * brain 生产路径传 Math.random（与 equityMulti 一致，不消耗决策用的种子随机流）。
 *
 * blockerEnabled（Phase 8）：hero 底牌对范围组合降权采样（见文件头 blocker 段）。
 * 池内无规则命中（权重均匀）时走旧公式路径，与 blockerEnabled=false 逐比特一致；
 * 命中时按逐组合权重线性扫描选牌（每次抽牌仍恰好 1 次 rng()）。
 */
export function equityVsRange(
  hero: [Card, Card],
  board: Card[],
  spec: RangeSpec,
  iterations: number = 400,
  rng: () => number = Math.random,
  opponents: number = 1,
  blockerEnabled: boolean = false,
): number {
  if (board.length < 3 || board.length > 5) throw new Error("board 必须为 3-5 张");
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error("iterations 必须为正整数");
  }
  if (!Number.isInteger(opponents) || opponents < 1) {
    throw new Error("opponents 必须为不小于 1 的整数");
  }
  const pool = getPool(hero, board, spec, blockerEnabled);

  // 均匀池（无 blocker 命中）与 blk0 同键：开关两侧共享缓存，结果逐比特一致
  const eqKey = `${poolCacheKey(hero, board, spec, pool.strongW !== null)}|${iterations}|${opponents}`;
  const hit = rangeEquityCache.get(eqKey);
  if (hit !== undefined) return hit;

  const { cards, strong, bluff } = pool;
  const need = 5 - board.length;
  const bluffW = bluff.length > 0 ? clamp(spec.bluffPct, 0, 1) : 0;

  /** 按权重抽一对底牌（强牌权重 1 / 诈唬权重 bluffW） */
  let pickPair: () => number;
  if (pool.strongW === null || pool.bluffW === null) {
    // 均匀权重（blocker 关闭或无规则命中）：旧公式路径，与旧版逐比特一致
    const totalW = strong.length + bluff.length * bluffW;
    pickPair = (): number => {
      const t = rng() * totalW;
      if (t < strong.length) return strong[Math.floor(t)];
      const k = Math.floor((t - strong.length) / bluffW);
      return bluff[Math.min(k, bluff.length - 1)];
    };
  } else {
    // blocker 逐组合权重：线性扫描累计权重选牌（每次抽牌仍 1 次 rng()，
    // 权重只改变 t 到组合的映射）
    const strongW = pool.strongW;
    const bluffArrW = pool.bluffW;
    let strongTotal = 0;
    for (let i = 0; i < strongW.length; i++) strongTotal += strongW[i];
    let bluffBase = 0;
    for (let i = 0; i < bluffArrW.length; i++) bluffBase += bluffArrW[i];
    const totalW = strongTotal + bluffBase * bluffW;
    pickPair = (): number => {
      const t = rng() * totalW;
      if (t < strongTotal) {
        let acc = 0;
        for (let i = 0; i < strong.length; i++) {
          acc += strongW[i];
          if (t < acc) return strong[i];
        }
        return strong[strong.length - 1];
      }
      const u = t - strongTotal;
      let acc = 0;
      for (let i = 0; i < bluff.length; i++) {
        acc += bluffArrW[i] * bluffW;
        if (u < acc) return bluff[i];
      }
      return bluff[bluff.length - 1];
    };
  }

  let win = 0;
  let tie = 0;
  // 分配提升到迭代外（perf：单挑热点路径避免每轮新建 Set/数组）
  const villPairs: number[] = [];
  const usedCards = new Set<string>();
  for (let it = 0; it < iterations; it++) {
    // 抽 opponents 个互不共牌的对手底牌（物理不重复；冲突重抽 + 扫描兜底）
    villPairs.length = 0;
    usedCards.clear();
    for (let v = 0; v < opponents; v++) {
      let pairIdx = -1;
      for (let attempt = 0; attempt < 60; attempt++) {
        const cand = pickPair();
        if (!usedCards.has(cards[cand >> 6]) && !usedCards.has(cards[cand & 63])) {
          pairIdx = cand;
          break;
        }
      }
      if (pairIdx === -1) {
        // 极小范围池兜底：顺序扫描找无冲突组合（防死循环；正常不会走到）
        for (const cand of [...strong, ...bluff]) {
          if (!usedCards.has(cards[cand >> 6]) && !usedCards.has(cards[cand & 63])) {
            pairIdx = cand;
            break;
          }
        }
        if (pairIdx === -1) pairIdx = strong[0]; // 极端兜底：接受冲突（有偏但不停机）
      }
      usedCards.add(cards[pairIdx >> 6]);
      usedCards.add(cards[pairIdx & 63]);
      villPairs.push(pairIdx);
    }

    // 从剩余牌中抽 runout（无放回；排除全部对手底牌）
    let heroScore: number;
    let bestVillain = -1;
    if (need === 0) {
      heroScore = evaluate7([...hero, ...board]);
      for (const p of villPairs) {
        const s = evaluate7([cards[p >> 6], cards[p & 63], ...board]);
        if (s > bestVillain) bestVillain = s;
      }
    } else {
      const runPool: Card[] = [];
      for (const c of cards) if (!usedCards.has(c)) runPool.push(c);
      for (let k = 0; k < need; k++) {
        const j = k + Math.floor(rng() * (runPool.length - k));
        const tmp = runPool[k];
        runPool[k] = runPool[j];
        runPool[j] = tmp;
      }
      const fullBoard = [...board, ...runPool.slice(0, need)];
      heroScore = evaluate7([...hero, ...fullBoard]);
      for (const p of villPairs) {
        const s = evaluate7([cards[p >> 6], cards[p & 63], ...fullBoard]);
        if (s > bestVillain) bestVillain = s;
      }
    }

    if (heroScore > bestVillain) win++;
    else if (heroScore === bestVillain) tie++;
  }

  const eq = (win + tie / 2) / iterations;
  if (rangeEquityCache.size >= EQUITY_CACHE_LIMIT) rangeEquityCache.clear();
  rangeEquityCache.set(eqKey, eq);
  return eq;
}

/** 清空范围推断的全部缓存（brain 的 resetBrainCaches 会一并调用） */
export function resetRangeCaches(): void {
  poolCache.clear();
  rangeEquityCache.clear();
}

// ---------------------------------------------------------------------------
// 翻前：加注者开局范围宽度 + 169 牌型对范围胜率静态表（F5 闭环；新增，不涉及翻后逻辑）
// ---------------------------------------------------------------------------

/**
 * 翻前开局范围宽度档位（顶部 X% 牌型）：与 PREFLOP_VS_RANGE_EQUITY 表的列一一对应。
 * 由 preflopRaiserRangePct 按加注者身后人数映射到其中一档。
 */
export const PREFLOP_RANGE_TIERS = [0.15, 0.2, 0.28, 0.4, 0.55] as const;

/**
 * 加注者「身后人数」→ 其开局范围的近似宽度（顶部 X% 牌型）。
 * 近似口径：9 人桌 UTG 开局 ~15%、中位 ~20-28%、后位/盲位渐宽，单挑按钮 ~55%。
 * 只按身后人数分档（不区分具体座位名），是粗粒度但单调的近似——真实开局范围
 * 还受筹码深度/对手构成影响，且并非严格按「对随机胜率」截断（65s 常先于 K7o）。
 */
export function preflopRaiserRangePct(behind: number): number {
  if (behind >= 6) return 0.15;
  if (behind >= 4) return 0.2;
  if (behind >= 2) return 0.28;
  if (behind >= 1) return 0.4;
  return 0.55; // behind = 0（单挑按钮 / 大盲关门面对偷盲的兜底）
}

/**
 * 169 牌型 × PREFLOP_RANGE_TIERS 的翻前真实胜率（win + tie/2）离线静态表。
 * 由 scripts/selfplay/gen-preflop-range-table.ts 蒙特卡洛生成（每格 4000 次迭代，
 * 固定种子可复现；范围 = PREFLOP_ORDER 前 ceil(169×X) 牌型的全部组合，天然组合
 * 加权），并对每行做「范围越宽胜率不减」的单调性修整（修正量 << 1 个标准误）。
 * 与 PREFLOP_ORDER（对随机范围）的关键差异：中对子（77-99）对紧范围显著缩水，
 * 同花连张/同花 A 相对保值——静态百分位表无法表达这一点。
 */
const PREFLOP_VS_RANGE_EQUITY: Record<string, readonly number[]> = {
  "AA": [0.843, 0.860, 0.860, 0.868, 0.868],
  "KK": [0.726, 0.740, 0.751, 0.787, 0.806],
  "QQ": [0.668, 0.685, 0.692, 0.719, 0.744],
  "JJ": [0.625, 0.634, 0.663, 0.680, 0.712],
  "TT": [0.560, 0.586, 0.609, 0.638, 0.676],
  "99": [0.547, 0.557, 0.592, 0.622, 0.649],
  "88": [0.508, 0.519, 0.558, 0.580, 0.619],
  "AKs": [0.606, 0.640, 0.661, 0.678, 0.678],
  "AQs": [0.549, 0.570, 0.612, 0.655, 0.670],
  "77": [0.474, 0.488, 0.539, 0.563, 0.594],
  "AJs": [0.502, 0.547, 0.598, 0.618, 0.626],
  "ATs": [0.460, 0.515, 0.572, 0.607, 0.618],
  "AQo": [0.531, 0.558, 0.596, 0.641, 0.641],
  "AKo": [0.592, 0.611, 0.637, 0.653, 0.653],
  "KQs": [0.420, 0.465, 0.503, 0.540, 0.583],
  "66": [0.440, 0.476, 0.520, 0.547, 0.561],
  "AJo": [0.470, 0.515, 0.570, 0.598, 0.624],
  "A9s": [0.404, 0.472, 0.528, 0.563, 0.590],
  "ATo": [0.425, 0.489, 0.552, 0.596, 0.596],
  "KJs": [0.390, 0.411, 0.465, 0.523, 0.571],
  "A8s": [0.373, 0.428, 0.501, 0.545, 0.585],
  "KQo": [0.386, 0.442, 0.480, 0.519, 0.550],
  "KTs": [0.386, 0.393, 0.459, 0.523, 0.563],
  "A9o": [0.372, 0.430, 0.508, 0.548, 0.563],
  "55": [0.426, 0.441, 0.498, 0.514, 0.543],
  "A7s": [0.382, 0.405, 0.482, 0.514, 0.567],
  "K9s": [0.347, 0.374, 0.419, 0.475, 0.544],
  "A6s": [0.368, 0.401, 0.460, 0.513, 0.554],
  "QJs": [0.387, 0.391, 0.448, 0.466, 0.528],
  "KJo": [0.369, 0.397, 0.449, 0.484, 0.554],
  "QTs": [0.382, 0.389, 0.407, 0.449, 0.503],
  "A8o": [0.351, 0.398, 0.463, 0.526, 0.563],
  "A4s": [0.373, 0.397, 0.446, 0.495, 0.535],
  "A5s": [0.378, 0.411, 0.458, 0.510, 0.559],
  "KTo": [0.342, 0.356, 0.429, 0.485, 0.543],
  "K8s": [0.345, 0.352, 0.394, 0.462, 0.515],
  "A6o": [0.326, 0.387, 0.435, 0.471, 0.521],
  "A5o": [0.337, 0.369, 0.431, 0.483, 0.524],
  "A7o": [0.346, 0.373, 0.438, 0.506, 0.549],
  "QJo": [0.346, 0.358, 0.402, 0.435, 0.505],
  "A3s": [0.371, 0.401, 0.453, 0.494, 0.523],
  "Q9s": [0.352, 0.355, 0.397, 0.435, 0.473],
  "JTs": [0.393, 0.393, 0.417, 0.433, 0.466],
  "44": [0.414, 0.427, 0.463, 0.495, 0.530],
  "K7s": [0.349, 0.354, 0.394, 0.442, 0.498],
  "A4o": [0.340, 0.391, 0.410, 0.480, 0.513],
  "K9o": [0.308, 0.336, 0.384, 0.453, 0.503],
  "QTo": [0.347, 0.353, 0.387, 0.423, 0.478],
  "A2s": [0.364, 0.394, 0.456, 0.495, 0.534],
  "K8o": [0.314, 0.317, 0.362, 0.421, 0.485],
  "K5s": [0.333, 0.343, 0.375, 0.412, 0.461],
  "K6s": [0.348, 0.348, 0.381, 0.439, 0.493],
  "Q8s": [0.356, 0.356, 0.375, 0.403, 0.460],
  "K7o": [0.301, 0.317, 0.352, 0.412, 0.468],
  "A3o": [0.319, 0.370, 0.405, 0.457, 0.504],
  "JTo": [0.352, 0.364, 0.375, 0.404, 0.441],
  "J9s": [0.364, 0.374, 0.380, 0.402, 0.448],
  "K4s": [0.338, 0.339, 0.360, 0.416, 0.456],
  "A2o": [0.329, 0.363, 0.407, 0.474, 0.508],
  "K6o": [0.311, 0.322, 0.357, 0.389, 0.447],
  "Q9o": [0.314, 0.334, 0.356, 0.403, 0.446],
  "T9s": [0.372, 0.372, 0.403, 0.415, 0.427],
  "Q7s": [0.332, 0.347, 0.370, 0.378, 0.434],
  "K3s": [0.334, 0.334, 0.375, 0.396, 0.461],
  "J8s": [0.341, 0.351, 0.381, 0.396, 0.429],
  "K5o": [0.304, 0.323, 0.339, 0.383, 0.445],
  "K2s": [0.333, 0.347, 0.368, 0.384, 0.457],
  "Q8o": [0.313, 0.326, 0.340, 0.370, 0.423],
  "Q5s": [0.327, 0.327, 0.358, 0.366, 0.418],
  "33": [0.394, 0.433, 0.449, 0.476, 0.518],
  "Q6s": [0.336, 0.336, 0.364, 0.390, 0.428],
  "K4o": [0.294, 0.305, 0.340, 0.381, 0.431],
  "J7s": [0.331, 0.339, 0.353, 0.377, 0.411],
  "Q4s": [0.324, 0.332, 0.352, 0.388, 0.414],
  "J9o": [0.339, 0.339, 0.357, 0.380, 0.423],
  "T8s": [0.375, 0.375, 0.381, 0.388, 0.410],
  "K3o": [0.289, 0.313, 0.327, 0.366, 0.433],
  "Q7o": [0.300, 0.312, 0.320, 0.344, 0.402],
  "Q6o": [0.293, 0.314, 0.314, 0.338, 0.392],
  "T9o": [0.327, 0.347, 0.361, 0.387, 0.413],
  "J8o": [0.330, 0.330, 0.351, 0.351, 0.391],
  "98s": [0.369, 0.369, 0.398, 0.398, 0.410],
  "Q3s": [0.320, 0.349, 0.349, 0.367, 0.408],
  "K2o": [0.288, 0.312, 0.324, 0.359, 0.420],
  "J5s": [0.318, 0.325, 0.344, 0.362, 0.370],
  "Q5o": [0.282, 0.289, 0.313, 0.343, 0.374],
  "Q4o": [0.286, 0.306, 0.306, 0.344, 0.367],
  "J6s": [0.326, 0.329, 0.349, 0.349, 0.390],
  "J7o": [0.309, 0.314, 0.337, 0.356, 0.362],
  "22": [0.399, 0.430, 0.443, 0.475, 0.480],
  "T8o": [0.326, 0.338, 0.357, 0.362, 0.370],
  "T7s": [0.358, 0.359, 0.365, 0.372, 0.387],
  "Q2s": [0.316, 0.338, 0.343, 0.361, 0.403],
  "98o": [0.331, 0.332, 0.363, 0.372, 0.382],
  "T6s": [0.331, 0.344, 0.376, 0.381, 0.382],
  "T7o": [0.314, 0.314, 0.342, 0.354, 0.354],
  "87s": [0.360, 0.360, 0.379, 0.397, 0.397],
  "J4s": [0.329, 0.329, 0.348, 0.348, 0.370],
  "J3s": [0.338, 0.338, 0.338, 0.362, 0.376],
  "97s": [0.343, 0.377, 0.377, 0.387, 0.404],
  "J5o": [0.292, 0.299, 0.321, 0.321, 0.356],
  "96s": [0.338, 0.354, 0.371, 0.371, 0.399],
  "T5s": [0.299, 0.322, 0.350, 0.365, 0.368],
  "Q2o": [0.288, 0.293, 0.311, 0.326, 0.369],
  "J6o": [0.289, 0.301, 0.314, 0.336, 0.351],
  "J2s": [0.305, 0.323, 0.355, 0.355, 0.365],
  "Q3o": [0.286, 0.294, 0.308, 0.329, 0.369],
  "97o": [0.304, 0.314, 0.348, 0.362, 0.367],
  "J4o": [0.284, 0.305, 0.312, 0.337, 0.338],
  "86s": [0.352, 0.355, 0.368, 0.386, 0.402],
  "T4s": [0.329, 0.329, 0.342, 0.351, 0.359],
  "T6o": [0.307, 0.308, 0.329, 0.329, 0.329],
  "T3s": [0.307, 0.328, 0.348, 0.348, 0.351],
  "95s": [0.321, 0.336, 0.355, 0.365, 0.367],
  "76s": [0.356, 0.374, 0.374, 0.397, 0.397],
  "87o": [0.320, 0.340, 0.354, 0.354, 0.363],
  "J3o": [0.266, 0.288, 0.300, 0.315, 0.343],
  "85s": [0.326, 0.326, 0.363, 0.364, 0.372],
  "T5o": [0.278, 0.286, 0.307, 0.324, 0.339],
  "T2s": [0.312, 0.320, 0.339, 0.339, 0.367],
  "J2o": [0.272, 0.288, 0.303, 0.308, 0.336],
  "75s": [0.341, 0.341, 0.366, 0.385, 0.386],
  "T4o": [0.281, 0.281, 0.295, 0.330, 0.330],
  "96o": [0.301, 0.312, 0.325, 0.332, 0.357],
  "86o": [0.312, 0.313, 0.329, 0.336, 0.358],
  "94s": [0.300, 0.316, 0.326, 0.347, 0.366],
  "84s": [0.322, 0.322, 0.328, 0.348, 0.357],
  "93s": [0.304, 0.328, 0.328, 0.348, 0.348],
  "95o": [0.299, 0.301, 0.307, 0.325, 0.335],
  "65s": [0.331, 0.368, 0.368, 0.381, 0.395],
  "T3o": [0.278, 0.290, 0.301, 0.319, 0.321],
  "92s": [0.310, 0.317, 0.342, 0.342, 0.350],
  "T2o": [0.279, 0.286, 0.298, 0.306, 0.307],
  "74s": [0.315, 0.332, 0.359, 0.359, 0.379],
  "54s": [0.336, 0.344, 0.351, 0.387, 0.387],
  "76o": [0.322, 0.335, 0.348, 0.354, 0.369],
  "83s": [0.295, 0.311, 0.336, 0.346, 0.358],
  "64s": [0.327, 0.339, 0.355, 0.359, 0.375],
  "85o": [0.288, 0.303, 0.330, 0.338, 0.343],
  "94o": [0.263, 0.286, 0.298, 0.317, 0.318],
  "75o": [0.301, 0.301, 0.325, 0.334, 0.341],
  "73s": [0.292, 0.324, 0.337, 0.337, 0.351],
  "82s": [0.323, 0.323, 0.331, 0.331, 0.352],
  "65o": [0.323, 0.323, 0.337, 0.350, 0.357],
  "93o": [0.277, 0.277, 0.296, 0.303, 0.314],
  "84o": [0.278, 0.281, 0.306, 0.319, 0.324],
  "53s": [0.325, 0.333, 0.345, 0.365, 0.369],
  "63s": [0.327, 0.327, 0.345, 0.356, 0.356],
  "92o": [0.268, 0.279, 0.293, 0.305, 0.325],
  "72s": [0.290, 0.304, 0.340, 0.340, 0.344],
  "74o": [0.277, 0.295, 0.312, 0.334, 0.334],
  "43s": [0.302, 0.323, 0.340, 0.365, 0.368],
  "62s": [0.299, 0.312, 0.334, 0.337, 0.340],
  "54o": [0.316, 0.316, 0.322, 0.350, 0.350],
  "64o": [0.300, 0.310, 0.318, 0.329, 0.347],
  "83o": [0.262, 0.282, 0.283, 0.308, 0.313],
  "52s": [0.323, 0.327, 0.347, 0.366, 0.366],
  "82o": [0.268, 0.273, 0.302, 0.303, 0.303],
  "73o": [0.268, 0.277, 0.297, 0.303, 0.311],
  "42s": [0.302, 0.323, 0.334, 0.342, 0.348],
  "32s": [0.286, 0.320, 0.330, 0.336, 0.339],
  "63o": [0.269, 0.287, 0.306, 0.331, 0.331],
  "72o": [0.253, 0.264, 0.287, 0.299, 0.299],
  "53o": [0.279, 0.299, 0.312, 0.320, 0.324],
  "43o": [0.282, 0.283, 0.309, 0.317, 0.327],
  "52o": [0.281, 0.301, 0.303, 0.312, 0.327],
  "62o": [0.265, 0.276, 0.298, 0.304, 0.306],
  "42o": [0.272, 0.296, 0.296, 0.308, 0.308],
  "32o": [0.258, 0.270, 0.287, 0.297, 0.305],
};

/**
 * 手牌牌型（canonicalLabel 口径，如 "AKs"/"77"）对顶部 rangePct% 开局范围的
 * 翻前真实胜率。rangePct 映射到最近的 PREFLOP_RANGE_TIERS 档位；
 * 未知牌型保守取 0.3（与 brain 的 preflopPercentile 兜底一致）。
 */
export function preflopEquityVsOpenRange(label: string, rangePct: number): number {
  const row = PREFLOP_VS_RANGE_EQUITY[label];
  if (!row) return 0.3;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < PREFLOP_RANGE_TIERS.length; i++) {
    const d = Math.abs(PREFLOP_RANGE_TIERS[i] - rangePct);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return row[best];
}
