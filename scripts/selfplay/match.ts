/**
 * scripts/selfplay/match.ts — 无头自对战台架（不走 React/zustand/gameStore）
 *
 * 直接用 src/lib/poker/game.ts 引擎 + src/lib/ai/brain.ts 决策跑整场比赛：
 *
 * 可复现性：
 * - 每手发牌：handSeed = masterSeed * 100000 + handIndex 派生 mulberry32，
 *   自己洗牌得到完整 52 张 deckPrefix 注入 createGame（引擎内部 shuffle 的
 *   随机抽签会被 deckPrefix 全覆盖，不影响发牌）。按钮按 handIndex 轮转。
 * - 每手决策：decisionSeed(handSeed) 派生的 rng 同时作为 brainDecide 的
 *   rng 参数与本手期间的 Math.random 补丁（brain 内部蒙特卡洛 equity 用的是
 *   Math.random）；每手开始复位补丁，保证同 seed 跨进程逐比特可复现。
 * - match 开始时调 resetBrainCaches()：equity 缓存命中与否会改变蒙特卡洛的
 *   随机数消耗量，复位消除进程内历史对后续 match 的污染。
 *
 * 筹码（现金桌）：默认跨手结转；座位筹码 < 大盲时破产重置回 startStack
 * （记账 rebuys）。config.resetStacksEachHand=true 时每手全员重置回 startStack
 * （不结转、不记 rebuy），消除滚雪球方差。引擎 createGame 只支持对称初始筹码，
 * 开局后用 correctStacksBench（复刻生产 gameStore.correctStacks，含 ante 口径）
 * 把每个座位的 stack 改为结转筹码 - 已付盲注/ante，并按 stack===0 重算 allIn。
 * （现金桌 ante 恒为 0；要求 smallBlind < bigBlind，否则单挑按钮=小盲恰好
 * 全下时引擎翻前首行动者会失效。）
 *
 * 锦标赛（config.tournament，与 cash 盲注参数二选一）：
 * - levels 升盲表（BlindLevel 语义同 poker/tournament），每 handsPerLevel 手
 *   升一级（到顶停住），ante 照引擎规则；
 * - 筹码严格跨手结转 ⇒ 强制顺序执行（handConcurrency 无效，>1 时告警并忽略）；
 * - rebuy：任何级别、每座位最多 rebuysAllowed 次，归零立即买回 startStack
 *   （台架定案，不用生产的前 4 级限制）；归零且次数用完 → 淘汰记名次
 *   （同手多人出局按开手筹码排，多者名次靠前），座位压缩映射继续比赛；
 * - 终局：只剩 1 人 = 冠军；或达 maxHands（= hands 字段）按当前筹码排名。
 * - 每手结束做筹码守恒断言：Σ stacks == seats×startStack + Σrebuys×startStack，
 *   失败即抛错（引擎零和 + rebuy 注入之外的筹码增减都是 bug）。
 *
 * 座位随机（config.shuffleSeats）：用 masterSeed 派生的洗牌把 seatBrains 随机
 * 映射到物理座位（同 seed 同映射，配对两臂一致），结果 JSON 记录 seatShuffle
 * （物理座位 → 配置下标），摘要按映射标注。
 *
 * 配对种子（paired deals）：runPaired 用同一 masterSeed 打两遍，第二遍把
 * 座位 0 换成 seat0Alt。发牌只依赖 (masterSeed, handIndex)，两遍逐手一致；
 * 座位 0 的盈亏差值序列做配对 t 置信区间，精确隔离「唯一变量 = 座位 0 参数」。
 * （锦标赛模式不支持配对：淘汰/升盲让两臂手数不对齐。）
 *
 * LLM 座位（llmSeat.ts）：seatBrains[i].llm 存在时该座位由真实 LLM 决策
 * （agent=生产 prompt 链路 / raw=裸模型对照），失败回退 style 启发式并计
 * fallbacks；token 用量与决策延迟按座位累计进结果 JSON。LLM 响应本身不可
 * 复现，含 LLM 座位的 match 不保证跨进程逐比特一致。
 * 近期回顾：每手完成后以赢家视角 summarizeHand（src/lib/ai/recentHands.ts），
 * 最新在前上限 20 条注入 input.recentHands——agent 模式 buildPrompt 渲染，
 * raw 模式不读（对照组不给近期动态）。底牌口径与生产 HandRecord 一致：
 * 仅摊牌且未弃牌者亮牌（含赢家——未摊牌赢池不亮，防跨座位信息泄露）。
 * LLM 运行时调节（meta.llmRuntime）：429 时按 provider:model 并发减半；
 * 400 且指明 max_tokens 时按阶梯降档重试并记录接受值。
 *
 * 手级并发（handConcurrency）：仅 resetStacksEachHand=true 时允许 >1
 * （各手筹码独立）；手内决策顺序执行，手间由 worker pool 并发，OpponentStats
 * 在单手完成后的同步块内更新（JS 单线程无竞态）。并发模式跳过逐手
 * Math.random 补丁（补丁是全局状态，跨手并发会互相污染；并发只为 LLM
 * 实验服务，其决策本就不可复现）。缺省值：含 LLM 座位时 4，否则 1
 * （纯启发式 match 保持原有顺序执行与比特级可复现）。
 */
import type {
  BlindLevel,
  Card,
  ConcreteAIStyle,
  DecideInput,
  GameState,
  HandRecord,
  OpponentStats,
  PlayerState,
  Seat,
  Street,
  StreetRecord,
  TournamentContext,
} from "@/lib/types";
import { computeTournamentPhase } from "@/lib/types";
import { applyAction, createGame, legalActions } from "@/lib/poker/game";
import { newDeck, shuffle } from "@/lib/poker/cards";
import {
  currentBlinds,
  nextLevel,
  shouldLevelUp,
} from "@/lib/poker/tournament";
import {
  brainDecide,
  resetBrainCaches,
  type BrainTuning,
} from "@/lib/ai/brain";
import {
  buildModel,
  createOpponentStats,
  DEFAULT_RECENCY_LAMBDA,
  updateStats,
} from "@/lib/ai/adapt";
import { seatPositionName } from "@/lib/ai/positions";
import { summarizeHand } from "@/lib/ai/recentHands";
import { appendFileSync } from "node:fs";
import { decisionSeed, handSeed, mulberry32 } from "./rng";
import {
  createLlmSeatStats,
  decideWithLlm,
  effectivePromptMode,
  getLlmRuntimeReport,
  isValidPromptMode,
  requireLlmKey,
  resetLlmRuntimeState,
  type LlmPromptMode,
  type LlmSeatSpec,
  type LlmSeatStats,
  type ModelRuntimeInfo,
} from "./llmSeat";

// ---------------------------------------------------------------------------
// 配置与结果类型
// ---------------------------------------------------------------------------

export interface SeatBrain {
  /** LLM 决策失败时的回退风格（也是该座位的统计标注风格） */
  style: ConcreteAIStyle;
  tuning?: Partial<BrainTuning>;
  /** 存在时该座位由真实 LLM 决策（agent/raw 见 llmSeat.ts） */
  llm?: LlmSeatSpec;
}

/**
 * 台架锦标赛配置。BlindLevel 语义复用 poker/tournament（sb/bb/ante 三级表），
 * 但 rebuy 规则是台架定案：任何级别、每座位最多 rebuysAllowed 次、归零立即
 * 买回 startStack（不用生产的前 4 级限制）。
 */
export interface BenchTourneyConfig {
  levels: BlindLevel[];
  handsPerLevel: number;
  startStack: number;
  rebuysAllowed: number;
}

export interface MatchConfig {
  /** 座位数 2-9 */
  seats: number;
  /** 手数（锦标赛模式 = maxHands 上限：提前出冠军则提前结束） */
  hands: number;
  /** 现金桌盲注（与 tournament 二选一；锦标赛模式下缺省） */
  smallBlind?: number;
  bigBlind?: number;
  startStack?: number;
  /** 每个座位的决策配置（长度必须等于 seats） */
  seatBrains: SeatBrain[];
  masterSeed: number;
  /** 每 N 手向 stderr 打印一次进度；0/缺省 = 静默 */
  progressEvery?: number;
  /**
   * true = 每手开始所有座位筹码重置为 startStack（不结转、不记 rebuy）。
   * 消掉深筹码滚雪球方差，配对 CI 显著收窄；缺省/false = 结转 + 破产重置。
   * 锦标赛模式禁止（筹码必然结转）。
   */
  resetStacksEachHand?: boolean;
  /**
   * 手级并发度（worker pool）。仅 resetStacksEachHand=true 允许 >1
   * （筹码结转依赖严格顺序）。缺省：含 LLM 座位时 4，否则 1。
   * 锦标赛模式强制 1（>1 时 stderr 告警并忽略）。
   */
  handConcurrency?: number;
  /** 锦标赛模式：升盲/ante/rebuy/淘汰（与 cash 盲注参数二选一） */
  tournament?: BenchTourneyConfig;
  /**
   * true = 用 masterSeed 派生的洗牌把 seatBrains 随机映射到物理座位
   * （同 seed 同映射），结果记录 seatShuffle（物理座位 → 配置下标）。
   */
  shuffleSeats?: boolean;
  /**
   * true = 每次 LLM 决策追加一行 JSONL 到 decisionsLogPath
   * （诊断用：含模型原文前 500 字符与解析结果；原文不含任何 key）。
   */
  logDecisions?: boolean;
  /** 决策日志路径（run.ts 由 --out 派生：`<out>.decisions.jsonl`） */
  decisionsLogPath?: string;
}

/** 配对模式：第二遍仅替换座位 0 的配置 */
export interface PairedMatchConfig extends MatchConfig {
  seat0Alt: SeatBrain;
}

/** 漏勺报告条目：盈亏贡献最大的手牌之一 */
export interface LeakHand {
  handIndex: number;
  /** 该座位本手净盈亏（筹码） */
  profit: number;
  /** 终局街道（fold 获胜时停留在弃牌发生街） */
  street: Street;
  showdown: boolean;
  /** 该座位本手位置短名（BTN/SB/BB/UTG/…） */
  position: string;
  holeCards: [Card, Card] | null;
  board: Card[];
  /** 本手总投入（Σ handBet，即底池规模） */
  pot: number;
  winners: Seat[] | null;
  /** 该座位本手动作序列："street:type amount" */
  actions: string[];
}

export interface SeatResult {
  seat: Seat;
  style: ConcreteAIStyle;
  tuning: Partial<BrainTuning> | null;
  hands: number;
  totalProfit: number;
  /** 每 100 手盈利（大盲数） */
  bb100: number;
  /** bb/100 的 95% 置信区间（按手盈亏序列的标准误） */
  ci95BB100: [number, number];
  /** 单手盈亏标准差（bb） */
  sdPerHandBB: number;
  vpip: number;
  pfr: number;
  vpipHands: number;
  pfrHands: number;
  rebuys: number;
  finalStack: number;
  /** 每手盈亏序列（筹码，按下标=handIndex），供配对差值/后续分析 */
  profitSeries: number[];
  /** 盈亏贡献最大的 20 手（按 |profit| 降序） */
  topHands: LeakHand[];
  /** LLM 座位记账；纯启发式座位全为 0 / null */
  llm: {
    model: string;
    agent: boolean;
    /** 生效的 prompt 变体（full/raw/slim/stats/models） */
    promptMode: LlmPromptMode;
    calls: number;
    tokensIn: number;
    tokensOut: number;
    fallbacks: number;
    /** 单次 LLM 决策平均耗时（含重试；无 LLM 决策时为 0） */
    avgDecisionMs: number;
  } | null;
}

export interface MatchResult {
  kind: "match";
  meta: {
    seats: number;
    hands: number;
    smallBlind: number;
    bigBlind: number;
    startStack: number;
    masterSeed: number;
    /** 生效的手级并发度（见 MatchConfig.handConcurrency） */
    handConcurrency: number;
    /**
     * LLM 运行时调节报告（429 降并发 / max_tokens 400 降档，按 provider:model）；
     * 无 LLM 座位或未发生任何 LLM 调用时为 null。
     */
    llmRuntime?: Record<string, ModelRuntimeInfo> | null;
    durationMs: number;
    handsPerSec: number;
    finishedAt: string;
  };
  mode: "cash" | "tournament";
  /** seatShuffle[i] = 物理座位 i 对应的 seatBrains 配置下标；未洗牌为 null */
  seatShuffle: number[] | null;
  /** 锦标赛结果；现金桌为 null */
  tournament: TourneyOutcome | null;
  seatBrains: SeatBrain[];
  seats: SeatResult[];
}

/** 锦标赛结果（名次/rebuy 按物理座位索引） */
export interface TourneyOutcome {
  /** 每物理座位名次（1 = 冠军）；正常打完的比赛全员都有名次 */
  finishPlaces: (number | null)[];
  rebuysUsed: number[];
  /** 冠军物理座位；maxHands 提前结束时为筹码领先者 */
  championSeat: Seat | null;
  handsPlayed: number;
  /** 终局盲注级别下标（levels 内） */
  finalLevel: number;
  endedBy: "champion" | "maxHands";
}

export interface PairedSeatDelta {
  seat: Seat;
  bb100A: number;
  bb100B: number;
  diffBB100: number;
  /** 配对差值序列（b - a，按手）的 95% 置信区间 */
  ci95DiffBB100: [number, number];
}

export interface PairedMatchResult {
  kind: "paired";
  meta: MatchResult["meta"];
  /** 第一遍：座位 0 = seatBrains[0] */
  a: MatchResult;
  /** 第二遍：座位 0 = seat0Alt，发牌与第一遍逐手一致 */
  b: MatchResult;
  /** 每座位 bb/100 差值（b - a）与配对 CI；关注 seat 0 */
  delta: PairedSeatDelta[];
}

// ---------------------------------------------------------------------------
// 统计工具
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** 样本标准差（n-1） */
function sampleSd(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) acc += (x - m) * (x - m);
  return Math.sqrt(acc / (n - 1));
}

/** 均值（bb/100）与 95% CI：mean ± 1.96 * sd/√n */
function bb100WithCI(series: number[], bigBlind: number): {
  bb100: number;
  ci: [number, number];
  sdBB: number;
} {
  const n = series.length;
  const sd = sampleSd(series);
  const se = n > 0 ? sd / Math.sqrt(n) : 0;
  const m = (mean(series) / bigBlind) * 100;
  const s = (se / bigBlind) * 100;
  return { bb100: m, ci: [m - 1.96 * s, m + 1.96 * s], sdBB: sd / bigBlind };
}

// ---------------------------------------------------------------------------
// 配置校验
// ---------------------------------------------------------------------------

const CONCRETE_STYLES: readonly string[] = [
  "nit", "tag", "lag", "maniac", "calling_station", "gto",
];

function validateSeatBrain(b: SeatBrain, where: string): void {
  if (!b || !CONCRETE_STYLES.includes(b.style)) {
    throw new Error(`${where}: style 必须是 ${CONCRETE_STYLES.join("/")} 之一（LLM 座位的回退风格）`);
  }
  if (b.llm !== undefined) {
    const { provider, model, agent } = b.llm;
    if (provider !== "deepseek" && provider !== "moonshot") {
      throw new Error(`${where}: llm.provider 必须是 deepseek/moonshot 之一`);
    }
    if (typeof model !== "string" || !model.trim()) {
      throw new Error(`${where}: llm.model 必须是非空字符串（服务商 model id）`);
    }
    if (typeof agent !== "boolean") {
      throw new Error(`${where}: llm.agent 必须是布尔（true=agent 链路 / false=裸模型）`);
    }
    if (b.llm.promptMode !== undefined && !isValidPromptMode(b.llm.promptMode)) {
      throw new Error(`${where}: llm.promptMode 必须是 full/raw/slim/stats/models 之一`);
    }
  }
}

function validateConfig(config: MatchConfig): void {
  if (!Number.isInteger(config.seats) || config.seats < 2 || config.seats > 9) {
    throw new Error("seats 必须是 2-9 的整数");
  }
  if (!Number.isInteger(config.hands) || config.hands < 1) {
    throw new Error("hands 必须是正整数");
  }
  if (config.tournament) {
    // 锦标赛模式：与 cash 盲注参数二选一，筹码必然结转、强制顺序执行
    if (config.smallBlind !== undefined || config.bigBlind !== undefined || config.startStack !== undefined) {
      throw new Error("tournament 与 smallBlind/bigBlind/startStack 二选一（锦标赛从 levels[0] 取盲注）");
    }
    if (config.resetStacksEachHand) {
      throw new Error("锦标赛模式禁止 resetStacksEachHand（筹码必然跨手结转）");
    }
    const t = config.tournament;
    if (!Array.isArray(t.levels) || t.levels.length === 0) {
      throw new Error("tournament.levels 必须是非空 BlindLevel 数组");
    }
    t.levels.forEach((lv, i) => {
      if (
        !Number.isInteger(lv.smallBlind) || !Number.isInteger(lv.bigBlind) ||
        lv.smallBlind <= 0 || lv.smallBlind > lv.bigBlind ||
        !Number.isInteger(lv.ante) || lv.ante < 0
      ) {
        throw new Error(`tournament.levels[${i}] 非法：需 0 < smallBlind ≤ bigBlind 且 ante ≥ 0（整数）`);
      }
    });
    if (!Number.isInteger(t.handsPerLevel) || t.handsPerLevel < 1) {
      throw new Error("tournament.handsPerLevel 必须是正整数");
    }
    if (!Number.isInteger(t.startStack) || t.startStack < t.levels[0].bigBlind) {
      throw new Error("tournament.startStack 必须是不小于 levels[0].bigBlind 的正整数");
    }
    if (!Number.isInteger(t.rebuysAllowed) || t.rebuysAllowed < 0) {
      throw new Error("tournament.rebuysAllowed 必须是非负整数");
    }
  } else {
    if (
      !Number.isInteger(config.smallBlind) || !Number.isInteger(config.bigBlind) ||
      config.smallBlind! <= 0 || config.smallBlind! >= config.bigBlind!
    ) {
      throw new Error("盲注必须为正整数且 smallBlind < bigBlind（或改用 tournament 配置）");
    }
    if (!Number.isInteger(config.startStack) || config.startStack! < config.bigBlind!) {
      throw new Error("startStack 必须是不小于 bigBlind 的正整数");
    }
  }
  if (!Array.isArray(config.seatBrains) || config.seatBrains.length !== config.seats) {
    throw new Error("seatBrains 长度必须等于 seats");
  }
  config.seatBrains.forEach((b, i) => validateSeatBrain(b, `seatBrains[${i}]`));
  if (!Number.isFinite(config.masterSeed)) {
    throw new Error("masterSeed 必须是有限数值");
  }
  if (
    config.progressEvery !== undefined &&
    (!Number.isInteger(config.progressEvery) || config.progressEvery < 0)
  ) {
    throw new Error("progressEvery 必须是非负整数");
  }
  const conc = effectiveConcurrency(config);
  if (conc > 12) {
    throw new Error("handConcurrency 上限为 12（LLM 瓶颈在网络等待，更高并发无意义）");
  }
  if (conc > 1 && !config.resetStacksEachHand) {
    throw new Error(
      "handConcurrency > 1 仅支持 resetStacksEachHand=true（筹码结转依赖严格顺序）",
    );
  }
}

/** 生效并发度：锦标赛强制 1（结转顺序）；缺省含 LLM 座位 4、纯启发式 1 */
function effectiveConcurrency(config: MatchConfig): number {
  let conc: number;
  if (config.handConcurrency !== undefined) {
    if (!Number.isInteger(config.handConcurrency) || config.handConcurrency < 1) {
      throw new Error("handConcurrency 必须是正整数");
    }
    conc = config.handConcurrency;
  } else {
    conc = config.seatBrains.some((b) => b.llm) ? 4 : 1;
  }
  return config.tournament ? 1 : conc;
}

/** 现金桌/锦标赛的盲注与起始筹码（锦标赛取 levels[0]） */
function baseBlinds(config: MatchConfig): {
  smallBlind: number;
  bigBlind: number;
  startStack: number;
} {
  if (config.tournament) {
    return {
      smallBlind: config.tournament.levels[0].smallBlind,
      bigBlind: config.tournament.levels[0].bigBlind,
      startStack: config.tournament.startStack,
    };
  }
  return {
    smallBlind: config.smallBlind!,
    bigBlind: config.bigBlind!,
    startStack: config.startStack!,
  };
}

/**
 * 筹码 fix-up（复刻生产 gameStore.correctStacks 的 ante 口径）：
 * createGame 对称开局 → 各座位改为真实结转筹码，重算 streetBet/handBet/pot/
 * currentBet/allIn；翻前首行动者若被盲注/ante 压成全下则顺延。
 */
function correctStacksBench(game: GameState, stacks: number[]): void {
  for (let i = 0; i < game.players.length; i++) {
    const p = game.players[i];
    const real = stacks[i];
    const antePaid = Math.min(game.ante, real);
    const blindPaid = Math.min(p.streetBet, real - antePaid);
    p.streetBet = blindPaid;
    p.handBet = antePaid + blindPaid;
    p.stack = real - antePaid - blindPaid;
    p.allIn = p.stack === 0;
  }
  game.pot = game.players.reduce((sum, p) => sum + p.handBet, 0);
  game.currentBet = Math.max(...game.players.map((p) => p.streetBet));
  if (game.currentSeat !== null && !game.handOver) {
    const canAct = (p: PlayerState) => !p.folded && !p.allIn;
    if (!canAct(game.players[game.currentSeat])) {
      let found: Seat | null = null;
      for (let k = 1; k < game.players.length; k++) {
        const s = ((game.currentSeat + k) % game.players.length) as Seat;
        if (canAct(game.players[s])) {
          found = s;
          break;
        }
      }
      if (found === null) {
        throw new Error("[selfplay] 盲注/ante 已让全员全下，无法开出这一手");
      }
      game.currentSeat = found;
    }
  }
}

/**
 * 座位洗牌：masterSeed 派生的 Fisher-Yates（与发牌/决策流分离的第三支流），
 * 返回 order（物理座位 → 配置下标）。同 seed 同映射（配对两臂一致）。
 */
function seatShuffleOrder(masterSeed: number, seats: number): number[] {
  const order = Array.from({ length: seats }, (_, i) => i);
  const rng = mulberry32(((masterSeed ^ 0x51ab3e9d) >>> 0) * 1000003 + 7);
  for (let i = seats - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

// ---------------------------------------------------------------------------
// 单手牌模拟
// ---------------------------------------------------------------------------

/** 每手最多动作数的安全上限（正常一手远低于此；兜底防死循环） */
const MAX_ACTIONS_PER_HAND = 1000;
/** 漏勺报告每座位保留的手数 */
const TOP_HANDS = 20;
/** 近期回顾携带上限（与生产 gameStore 的 20 条截断一致） */
const RECENT_HANDS_LIMIT = 20;

interface HandOutcome {
  /** 按引擎座位（调用方经 ctx.seatMap 换算物理座位；现金桌恒等） */
  profit: number[];
  vpip: boolean[];
  pfr: boolean[];
  /** 每座位动作摘要（含街道前缀），按引擎座位，供漏勺报告 */
  actionsBySeat: string[][];
  /** 按街道的动作记录：座位已换算为物理座位，供跨手对手建模（updateStats） */
  streets: StreetRecord[];
  finalState: GameState;
}

/** 单手上下文：盲注/ante/按钮（引擎座位）与座位压缩映射 */
interface HandContext {
  smallBlind: number;
  bigBlind: number;
  ante: number;
  /** 引擎座位号（压缩座位数组内的按钮下标） */
  buttonSeat: Seat;
  /** 引擎座位 j → 物理座位（现金桌 = 恒等映射） */
  seatMap: Seat[];
}

/**
 * 模拟一手牌。发牌由 handSeed 派生的 rng 决定（与决策流分离）；
 * patchRandom=true（顺序模式）时本手期间 Math.random 被补丁为决策流 rng
 * （brain 的蒙特卡洛 equity 使用），返回前恢复；并发模式跳过补丁（全局
 * 补丁会跨手互污染，且 LLM 决策本就不可复现）。
 *
 * F10：bench 注入 opponentModels——oppStats 为跨手累积的各物理座位统计
 * （与生产 gameStore 同一口径：每手结束后由调用方用本手记录 updateStats），
 * 决策时把本手其他座位的画像注入 DecideInput（模型的 seat 用引擎座位，与
 * DecideInput.state 对齐；统计取物理座位维度），让剥削路径进 bench 覆盖。
 *
 * Phase 7（每座位独立近因 λ）：oppStats 升级为 [观察者][对象] 二维表，
 * 观察者 o 的建模表用其自身 tuning.adaptRecencyLambda（缺省 0.92）衰减；
 * 配对模式下座位 0 是唯一变量 ⇒ 两臂只有座位 0 的建模表 λ 不同，其余座位
 * 的建模视角固定 0.92，不被座位 0 的旋钮污染。
 *
 * LLM 座位：decideWithLlm 失败（重试耗尽/解析失败）回退 style 启发式，
 * 记账进 llmStats[物理座位]（token/延迟/fallback）。
 *
 * carried 与 ctx.seatMap 对齐（引擎座位序的结转筹码）；brains/oppStats/
 * llmStats 按物理座位索引。
 */
async function playHand(
  config: MatchConfig,
  brains: SeatBrain[],
  handIndex: number,
  ctx: HandContext,
  carried: number[],
  oppStats: OpponentStats[][],
  llmStats: LlmSeatStats[],
  patchRandom: boolean,
  recentHands: string[],
): Promise<HandOutcome> {
  const { smallBlind, bigBlind, ante, buttonSeat, seatMap } = ctx;
  const seats = seatMap.length; // 本手在局（引擎）座位数
  const seed = handSeed(config.masterSeed, handIndex);

  // 发牌流：完整 52 张 deckPrefix → 引擎发牌完全确定
  const deckPrefix = shuffle(newDeck(), mulberry32(seed));

  let state = createGame({
    players: seats,
    smallBlind,
    bigBlind,
    ante,
    // createGame 只支持对称初始筹码：取最大值（≥bigBlind 保底），
    // 真实筹码由 correctStacksBench 改回（含「真实筹码不足盲注」的 min 口径）
    stack: Math.max(...carried, bigBlind),
    buttonSeat,
    deckPrefix,
  });

  // 筹码 fix-up：对称开局 → 各座位结转筹码。注意：盲注/ante 全员全下的极端
  // 情形引擎在 createGame 内已直接摊牌结算，此时不能做 fix-up。
  if (!state.handOver) {
    correctStacksBench(state, carried);
  }

  const rng = mulberry32(decisionSeed(seed));
  const vpip = new Array<boolean>(seats).fill(false);
  const pfr = new Array<boolean>(seats).fill(false);
  const actionsBySeat: string[][] = Array.from({ length: seats }, () => []);
  // 街道记录（SeatAction 序列，物理座位）：handOver 或换街时归档当前街
  const streetRecs: StreetRecord[] = [];
  let curStreet: StreetRecord = {
    street: state.street,
    board: [...state.board],
    actions: [],
  };
  // 翻前下注线（VPIP/PFR 口径与 adapt.ts 一致：盲注不算动作，从 bigBlind 起算）
  let preflopLine = bigBlind;

  const prevRandom = Math.random;
  if (patchRandom) Math.random = rng;
  try {
    let guard = 0;
    while (!state.handOver && guard++ < MAX_ACTIONS_PER_HAND) {
      const seat = state.currentSeat!;
      const phys = seatMap[seat];
      const legal = legalActions(state);
      const me = state.players[seat];
      // F1：callAmount 按实际可跟注额封顶（与引擎 legalActions 的 call 口径一致），
      // 否则深打浅的 overbet/全下会让 brain 按虚高金额计价
      const callAmount = Math.max(
        0,
        Math.min(state.currentBet - me.streetBet, me.stack),
      );
      const brain = brains[phys];
      // Phase 7：锦标赛模式组装 TournamentContext（与生产 gameStore 同一口径：
      // 筹码/排名按开手结转筹码 carried，引擎座位序；阶段按在局人数/总人数）
      let tournament: TournamentContext | undefined;
      if (config.tournament) {
        const myChips = carried[seat];
        const rank = 1 + carried.filter((c) => c > myChips).length;
        const avg = carried.reduce((sum, x) => sum + x, 0) / seats;
        tournament = {
          playersRemaining: seats,
          totalPlayers: config.seats,
          myRankByChips: rank,
          avgStackBB: avg / bigBlind,
          myStackBB: myChips / bigBlind,
          blindLevelBB: bigBlind,
          phase: computeTournamentPhase(seats, config.seats),
        };
      }
      // brain 只读自身底牌（不读对手 holeCards），直接传入完整 state，
      // 省去每决策一次的隐藏克隆开销
      const input: DecideInput = {
        state,
        legalActions: legal,
        callAmount,
        potOdds: callAmount > 0 ? callAmount / (state.pot + callAmount) : 0,
        style: brain.style,
        ...(tournament ? { tournament } : {}),
        // F10/Phase 7：注入本手其他座位的对手画像——取行动者本人视角的建模表
        // （oppStats[phys] 用该座位的 λ 衰减），统计取物理座位维度、模型 seat
        // 用引擎座位；样本不足 confidence=0 时自动零修正
        opponentModels: state.players
          .filter((p) => p.seat !== seat)
          .map((p) => ({
            ...buildModel(oppStats[phys][seatMap[p.seat]]),
            seat: p.seat,
          })),
        // 近期回顾（最新在前，上限 20 条）：agent 模式 buildPrompt 渲染该段；
        // raw 模式 prompt 不读此字段（对照组不给近期动态），启发式忽略
        ...(recentHands.length > 0
          ? { recentHands: recentHands.slice(0, RECENT_HANDS_LIMIT) }
          : {}),
      };
      const street = state.street;
      let a;
      if (brain.llm) {
        const st = llmStats[phys];
        const t = performance.now();
        const r = await decideWithLlm(brain.llm, input);
        st.calls++;
        st.msTotal += performance.now() - t;
        if (r.usage) {
          st.tokensIn += r.usage.promptTokens;
          st.tokensOut += r.usage.completionTokens;
        }
        if (r.decision) {
          a = r.decision.action;
        } else {
          // 重试耗尽或输出无法解析：回退该座位的 style 启发式
          st.fallbacks++;
          a = brainDecide(input, brain.style, rng, brain.tuning).action;
        }
        // 决策日志（诊断）：模型原文前 500 字符 + 解析结果 + 是否 fallback
        if (config.logDecisions && config.decisionsLogPath) {
          appendFileSync(
            config.decisionsLogPath,
            JSON.stringify({
              handIndex,
              seat: phys,
              street,
              holeCards: me.holeCards,
              board: [...state.board],
              pot: state.pot,
              currentBet: state.currentBet,
              callAmount,
              model: `${brain.llm.provider}:${brain.llm.model}`,
              promptMode: effectivePromptMode(brain.llm),
              content: r.content,
              action: r.decision?.action ?? null,
              fallback: r.decision === null,
            }) + "\n",
          );
        }
      } else {
        a = brainDecide(input, brain.style, rng, brain.tuning).action;
      }
      actionsBySeat[seat].push(
        `${street}:${a.type}${a.amount > 0 ? ` ${a.amount}` : ""}`,
      );
      curStreet.actions.push({ seat: phys, action: { ...a } });
      if (street === "preflop") {
        if (a.type === "call") vpip[seat] = true;
        else if (a.type === "bet" || a.type === "raise") {
          vpip[seat] = true;
          pfr[seat] = true;
        } else if (a.type === "allin") {
          vpip[seat] = true;
          if (a.amount > preflopLine) pfr[seat] = true;
        }
        if (a.type === "bet" || a.type === "raise" || a.type === "allin") {
          preflopLine = Math.max(preflopLine, a.amount);
        }
      }
      const prevStreet = state.street;
      state = applyAction(state, a);
      if (state.street !== prevStreet || state.handOver) {
        streetRecs.push(curStreet);
        if (!state.handOver) {
          curStreet = { street: state.street, board: [...state.board], actions: [] };
        }
      }
    }
    if (!state.handOver) {
      throw new Error(`第 ${handIndex} 手未在 ${MAX_ACTIONS_PER_HAND} 次动作内结束`);
    }
  } finally {
    Math.random = prevRandom;
  }

  const profit = state.players.map((p, i) => p.stack - carried[i]);
  return { profit, vpip, pfr, actionsBySeat, streets: streetRecs, finalState: state };
}

// ---------------------------------------------------------------------------
// 漏勺报告（top-K by |profit|）
// ---------------------------------------------------------------------------

function insertTopHand(list: LeakHand[], entry: LeakHand): void {
  const abs = Math.abs(entry.profit);
  if (list.length < TOP_HANDS) {
    list.push(entry);
    return;
  }
  let minIdx = 0;
  let minAbs = Math.abs(list[0].profit);
  for (let i = 1; i < list.length; i++) {
    const v = Math.abs(list[i].profit);
    if (v < minAbs) {
      minAbs = v;
      minIdx = i;
    }
  }
  if (abs > minAbs) list[minIdx] = entry;
}

// ---------------------------------------------------------------------------
// 比赛入口
// ---------------------------------------------------------------------------

export async function runMatch(config: MatchConfig): Promise<MatchResult> {
  validateConfig(config);
  resetBrainCaches();
  resetLlmRuntimeState();
  const concurrency = effectiveConcurrency(config);
  if (config.tournament && (config.handConcurrency ?? 1) > 1) {
    console.error(
      `[selfplay] 锦标赛筹码严格结转，handConcurrency=${config.handConcurrency} 无效，按 1 执行`,
    );
  }
  // 并发模式跳过逐手 Math.random 补丁（见 playHand 注释）
  const patchRandom = concurrency === 1;
  // LLM 座位开跑前验证 key 就绪（只报环境变量名，不打印值）
  for (const b of config.seatBrains) {
    if (b.llm) requireLlmKey(b.llm.provider);
  }
  // 近因加权 λ 改为每座位（观察者）独立：见下方 oppStats 二维表初始化。
  // 模块级旋钮保持 adapt.ts 默认值（updateStats 全部显式传 λ，不读模块态）。
  const { seats, hands } = config;
  // 现金桌盲注/起始筹码；锦标赛取 levels[0]（bb100 统一按 level0 大盲计价）
  const base = baseBlinds(config);
  const bigBlind = base.bigBlind;
  const t0 = performance.now();

  // 座位洗牌：物理座位 → 配置下标（缺省恒等；同 seed 同映射）
  const order = config.shuffleSeats
    ? seatShuffleOrder(config.masterSeed, seats)
    : Array.from({ length: seats }, (_, i) => i);
  /** brains[物理座位]（洗牌后的生效配置） */
  const brains = order.map((i) => config.seatBrains[i]);

  const stacks = new Array<number>(seats).fill(base.startStack);
  const rebuys = new Array<number>(seats).fill(0);
  const playedHands = new Array<number>(seats).fill(0);
  // 现金桌并发完成顺序 ≠ handIndex 顺序：profitSeries 按下标写入；
  // 锦标赛顺序执行且淘汰后不再参与：push 紧凑序列（两模式入账处各自处理）
  const series: number[][] = Array.from({ length: seats }, () =>
    config.tournament ? [] : new Array<number>(hands),
  );
  const vpipHands = new Array<number>(seats).fill(0);
  const pfrHands = new Array<number>(seats).fill(0);
  const topHands: LeakHand[][] = Array.from({ length: seats }, () => []);
  // F10 + Phase 7：跨手累积各物理座位打法统计，[观察者][对象] 二维表——
  // 观察者 o 的建模表用座位 o 自己的近因 λ（tuning.adaptRecencyLambda，
  // 缺省 DEFAULT_RECENCY_LAMBDA）衰减，实现每座位独立 λ：配对模式下座位 0
  // 的 λ 旋钮只换座位 0 的建模视角，其余座位的建模视角不被污染。
  // 与生产 gameStore 同一 updateStats 口径（生产不传第 4 参，走模块默认）。
  const lambdas = brains.map(
    (b) => b.tuning?.adaptRecencyLambda ?? DEFAULT_RECENCY_LAMBDA,
  );
  const oppStats: OpponentStats[][] = Array.from({ length: seats }, () =>
    Array.from({ length: seats }, (_, s) => createOpponentStats(s as Seat)),
  );
  const llmStats: LlmSeatStats[] = Array.from({ length: seats }, () =>
    createLlmSeatStats(),
  );
  // 近期回顾（最新在前）：每手完成后以赢家视角生成一句话总结，供 agent
  // 模式 prompt 注入（raw 模式不读）。并发模式下按完成顺序追加。
  const recentSummaries: string[] = [];

  let completed = 0;

  /**
   * 单手入账（两模式共用，await 之后同步执行无竞态）：本手记录 →
   * 对手建模 / 近期回顾 / 盈亏序列 / VPIP/PFR / 漏勺 / 筹码写回。
   */
  const recordHand = (h: number, ctx: HandContext, outcome: HandOutcome): void => {
    const fs = outcome.finalState;
    const potTotal = fs.players.reduce((sum, p) => sum + p.handBet, 0);

    // 本手记录（物理座位维度）→ 各观察者的建模表（各自 λ；时间顺序：本手
    // 决策只见此前手）。摊牌学习（Phase 8）：摊牌且未弃牌者亮牌（与生产
    // HandRecord 口径一致，见下方近期回顾段），updateStats 据此累积 showdownsSeen
    const record: HandRecord = {
      id: `bench-${config.masterSeed}-${h}`,
      timestamp: 0,
      players: fs.players.map((p) => ({
        seat: ctx.seatMap[p.seat],
        isHero: false,
        aiStyle: null,
        cards: fs.showdown && !p.folded ? p.holeCards : null,
        profit: outcome.profit[p.seat],
      })),
      heroSeat: ctx.seatMap[0],
      buttonSeat: ctx.seatMap[fs.buttonSeat],
      smallBlind: ctx.smallBlind,
      bigBlind: ctx.bigBlind,
      ante: ctx.ante,
      streets: outcome.streets,
      finalBoard: [...fs.board],
      result: "tie",
      profit: 0,
      showdown: fs.showdown,
    };
    for (const p of fs.players) {
      const phys = ctx.seatMap[p.seat];
      for (let o = 0; o < seats; o++) {
        oppStats[o][phys] = updateStats(oppStats[o][phys], record, phys, lambdas[o]);
      }
    }

    // 近期回顾：以本手赢家视角复用生产 summarizeHand（台架无 hero，赢家线
    // 最有信息量）。底牌口径与生产 HandRecord 一致（公平性修复）：仅摊牌且
    // 未弃牌者亮牌——赢家也不例外，未摊牌赢池不泄露底牌。
    {
      const winJ = outcome.profit.indexOf(Math.max(...outcome.profit));
      const summaryRecord: HandRecord = {
        ...record,
        players: fs.players.map((p) => ({
          seat: ctx.seatMap[p.seat],
          isHero: p.seat === winJ,
          aiStyle: null,
          cards: fs.showdown && !p.folded ? p.holeCards : null,
          profit: outcome.profit[p.seat],
        })),
        heroSeat: ctx.seatMap[winJ],
        result: "win",
        profit: outcome.profit[winJ],
      };
      recentSummaries.unshift(summarizeHand(summaryRecord, (s) => s));
      if (recentSummaries.length > RECENT_HANDS_LIMIT) {
        recentSummaries.length = RECENT_HANDS_LIMIT;
      }
    }

    const buttonPhys = ctx.seatMap[fs.buttonSeat];
    for (const p of fs.players) {
      const phys = ctx.seatMap[p.seat];
      stacks[phys] = p.stack;
      playedHands[phys]++;
      const profit = outcome.profit[p.seat];
      if (config.tournament) series[phys].push(profit);
      else series[phys][h] = profit;
      if (outcome.vpip[p.seat]) vpipHands[phys]++;
      if (outcome.pfr[p.seat]) pfrHands[phys]++;
      insertTopHand(topHands[phys], {
        handIndex: h,
        profit,
        street: fs.street,
        showdown: fs.showdown,
        position: seatPositionName(phys, buttonPhys, fs.players.length),
        holeCards: p.holeCards,
        board: fs.board,
        pot: potTotal,
        winners: fs.winners
          ? fs.winners.map((w) => ctx.seatMap[w])
          : null,
        actions: outcome.actionsBySeat[p.seat],
      });
    }

    completed++;
    if (config.progressEvery && completed % config.progressEvery === 0) {
      const dt = (performance.now() - t0) / 1000;
      // 进度走 stderr，stdout 留给最终摘要表
      console.error(`[selfplay] ${completed}/${hands} hands (${(completed / dt).toFixed(1)} hands/s)`);
    }
  };

  let tourneyOutcome: TourneyOutcome | null = null;
  let handsPlayed = hands;

  if (config.tournament) {
    // -----------------------------------------------------------------
    // 锦标赛：严格顺序（筹码结转），升盲/ante/rebuy/淘汰/守恒断言
    // -----------------------------------------------------------------
    const t = config.tournament;
    let levelIndex = 0;
    let handsAtLevel = 0;
    const finishPlaces: (number | null)[] = new Array(seats).fill(null);
    let alive: Seat[] = Array.from({ length: seats }, (_, i) => i as Seat);
    let buttonPhys: Seat = 0 as Seat; // 第 1 手按钮 = 物理座位 0（生产 HERO_SEAT 语义）
    let endedBy: TourneyOutcome["endedBy"] = "maxHands";
    handsPlayed = 0;

    for (let h = 0; h < hands && alive.length > 1; h++) {
      const blinds = currentBlinds(levelIndex, t.levels);
      // 按钮轮转：物理座位视角找下一个在局座位
      if (h > 0) {
        for (let k = 1; k <= seats; k++) {
          const s = ((buttonPhys + k) % seats) as Seat;
          if (alive.includes(s)) {
            buttonPhys = s;
            break;
          }
        }
      }
      const seatMap = alive; // 引擎座位 j = alive[j]
      const ctx: HandContext = {
        smallBlind: blinds.smallBlind,
        bigBlind: blinds.bigBlind,
        ante: blinds.ante,
        buttonSeat: alive.indexOf(buttonPhys) as Seat,
        seatMap,
      };
      const carried = alive.map((phys) => stacks[phys]);
      // 开手筹码快照：同手多人出局时按此排名（多者名次靠前）
      const handStart = new Map(alive.map((phys, j) => [phys, carried[j]]));

      const outcome = await playHand(
        config, brains, h, ctx, carried, oppStats, llmStats, true, recentSummaries,
      );
      recordHand(h, ctx, outcome);
      handsPlayed++;

      // rebuy（任何级别、归零立即买回 startStack）/ 淘汰（次数用完）
      const aliveBefore = alive.length;
      const busted: Seat[] = [];
      for (const phys of alive) {
        if (stacks[phys] === 0) {
          if (rebuys[phys] < t.rebuysAllowed) {
            rebuys[phys]++;
            stacks[phys] = t.startStack;
          } else {
            busted.push(phys);
          }
        }
      }
      if (busted.length > 0) {
        busted.sort((a, b) => handStart.get(b)! - handStart.get(a)!);
        busted.forEach((phys, i) => {
          finishPlaces[phys] = aliveBefore - i;
        });
        alive = alive.filter((phys) => !busted.includes(phys));
      }

      // 筹码守恒断言：引擎手内零和，筹码增减只应来自 rebuy 注入
      {
        const expected =
          seats * t.startStack + rebuys.reduce((sum, x) => sum + x, 0) * t.startStack;
        const actual = stacks.reduce((sum, x) => sum + x, 0);
        if (actual !== expected) {
          throw new Error(
            `第 ${h} 手筹码守恒断言失败：Σ stacks = ${actual}，` +
              `应为 ${expected}（${seats}×${t.startStack} + ${rebuys.reduce((sum, x) => sum + x, 0)}×${t.startStack}）`,
          );
        }
      }

      // 升盲（到顶停住）
      handsAtLevel++;
      if (shouldLevelUp(handsAtLevel, t.handsPerLevel)) {
        levelIndex = nextLevel(levelIndex, t.levels);
        handsAtLevel = 0;
      }
    }

    // 终局：只剩 1 人 = 冠军；否则按当前筹码排名
    let championSeat: Seat | null = null;
    if (alive.length === 1) {
      finishPlaces[alive[0]] = 1;
      championSeat = alive[0];
      endedBy = "champion";
    } else {
      const ranked = [...alive].sort((a, b) => stacks[b] - stacks[a]);
      ranked.forEach((phys, i) => {
        finishPlaces[phys] = i + 1;
      });
      championSeat = ranked[0] ?? null;
    }
    tourneyOutcome = {
      finishPlaces,
      rebuysUsed: [...rebuys],
      championSeat,
      handsPlayed,
      finalLevel: levelIndex,
      endedBy,
    };
  } else {
    // -----------------------------------------------------------------
    // 现金桌：顺序或手级 worker pool（resetStacksEachHand 才允许并发）
    // -----------------------------------------------------------------
    const identityMap: Seat[] = Array.from({ length: seats }, (_, i) => i as Seat);
    const cashCtx = (h: number): HandContext => ({
      smallBlind: base.smallBlind,
      bigBlind: base.bigBlind,
      ante: 0,
      buttonSeat: (h % seats) as Seat,
      seatMap: identityMap,
    });
    /** 单手全流程：发牌→决策→入账。await 之后的入账块是同步的，无竞态 */
    const runOne = async (h: number): Promise<void> => {
      // resetStacksEachHand：每手独立从 startStack 出发（用局部 carried，不碰
      // 共享 stacks，并发安全）；否则破产重置后按共享 stacks 结转
      let carried: number[];
      if (config.resetStacksEachHand) {
        carried = new Array<number>(seats).fill(base.startStack);
      } else {
        for (let s = 0; s < seats; s++) {
          if (stacks[s] < base.bigBlind) {
            stacks[s] = base.startStack;
            rebuys[s]++;
          }
        }
        carried = stacks;
      }
      const ctx = cashCtx(h);
      const outcome = await playHand(
        config, brains, h, ctx, carried, oppStats, llmStats, patchRandom, recentSummaries,
      );
      recordHand(h, ctx, outcome);
    };

    if (concurrency === 1) {
      for (let h = 0; h < hands; h++) await runOne(h);
    } else {
      let next = 0;
      const workers = Array.from({ length: Math.min(concurrency, hands) }, async () => {
        while (true) {
          const h = next++;
          if (h >= hands) break;
          await runOne(h);
        }
      });
      await Promise.all(workers);
    }
  }

  const durationMs = performance.now() - t0;
  const seatResults: SeatResult[] = [];
  for (let s = 0; s < seats; s++) {
    const ser = series[s];
    const played = playedHands[s];
    const { bb100, ci, sdBB } = ser.length > 0
      ? bb100WithCI(ser, bigBlind)
      : { bb100: 0, ci: [0, 0] as [number, number], sdBB: 0 };
    topHands[s].sort((x, y) => Math.abs(y.profit) - Math.abs(x.profit));
    const spec = brains[s].llm;
    const st = llmStats[s];
    seatResults.push({
      seat: s,
      style: brains[s].style,
      tuning: brains[s].tuning ?? null,
      hands: played,
      totalProfit: ser.reduce((sum, x) => sum + x, 0),
      bb100,
      ci95BB100: ci,
      sdPerHandBB: sdBB,
      vpip: played > 0 ? vpipHands[s] / played : 0,
      pfr: played > 0 ? pfrHands[s] / played : 0,
      vpipHands: vpipHands[s],
      pfrHands: pfrHands[s],
      rebuys: rebuys[s],
      finalStack: stacks[s],
      profitSeries: ser,
      topHands: topHands[s],
      llm: spec
        ? {
            model: `${spec.provider}:${spec.model}`,
            agent: spec.agent,
            promptMode: effectivePromptMode(spec),
            calls: st.calls,
            tokensIn: st.tokensIn,
            tokensOut: st.tokensOut,
            fallbacks: st.fallbacks,
            avgDecisionMs: st.calls > 0 ? st.msTotal / st.calls : 0,
          }
        : null,
    });
  }

  return {
    kind: "match",
    meta: {
      seats,
      hands,
      smallBlind: base.smallBlind,
      bigBlind: base.bigBlind,
      startStack: base.startStack,
      masterSeed: config.masterSeed,
      handConcurrency: concurrency,
      llmRuntime: getLlmRuntimeReport(),
      durationMs,
      handsPerSec: handsPlayed / (durationMs / 1000),
      finishedAt: new Date().toISOString(),
    },
    mode: config.tournament ? "tournament" : "cash",
    seatShuffle: config.shuffleSeats ? order : null,
    tournament: tourneyOutcome,
    seatBrains: brains,
    seats: seatResults,
  };
}

/**
 * 配对种子比较：同一 masterSeed 打两遍（发牌逐手一致），
 * 第二遍仅座位 0 换成 seat0Alt。座位 0 的差值用配对 t 区间评估。
 */
export async function runPaired(config: PairedMatchConfig): Promise<PairedMatchResult> {
  validateConfig(config);
  validateSeatBrain(config.seat0Alt, "seat0Alt");
  if (config.tournament) {
    throw new Error("锦标赛模式不支持配对（淘汰/升盲让两臂手数不对齐）");
  }
  const t0 = performance.now();

  const a = await runMatch(config);
  const brainsB = config.seatBrains.map((b, i) => (i === 0 ? config.seat0Alt : b));
  const b = await runMatch({ ...config, seatBrains: brainsB });

  const delta: PairedSeatDelta[] = [];
  for (let s = 0; s < config.seats; s++) {
    const diff = a.seats[s].profitSeries.map((p, i) => b.seats[s].profitSeries[i] - p);
    const { bb100: diffBB100, ci } = bb100WithCI(diff, config.bigBlind!);
    delta.push({
      seat: s,
      bb100A: a.seats[s].bb100,
      bb100B: b.seats[s].bb100,
      diffBB100,
      ci95DiffBB100: ci,
    });
  }

  const durationMs = performance.now() - t0;
  return {
    kind: "paired",
    meta: {
      ...a.meta,
      durationMs,
      handsPerSec: (config.hands * 2) / (durationMs / 1000),
      finishedAt: new Date().toISOString(),
    },
    a,
    b,
    delta,
  };
}
