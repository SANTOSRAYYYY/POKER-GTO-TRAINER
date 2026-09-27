/**
 * 游戏状态 store（牌桌 UI 组实现，v2：2-9 人桌 + 锦标赛 SNG 升盲）
 *
 * 状态机流转：
 *   startTable(config) → dealNextHand（createGame + 非对称筹码修正）
 *   → 行动循环：act(action)（人类）/ runAiLoop（依次推进所有 AI 座位）
 *   → handOver → finalizeHand（生成 HandRecord → historyStore.addHand；
 *     锦标赛在此判定淘汰/名次/冠军并推进升盲计数）
 *   → advanceToNextHand（现金局补码/hero 重置提示；按钮按 nextActiveSeat
 *     轮转到下一个未淘汰座位；开下一手）
 *
 * 关键约定：
 * - UI 约定桌面座位 0 = 人类（hero）。
 * - 引擎 createGame 只收对称 stack 且不理解淘汰：两手之间筹码结转沿用
 *   createGame(max) + 扣差额方案；锦标赛淘汰通过「座位压缩」实现——
 *   每一手只为未淘汰座位开局，seatMap[j] 记录引擎座位 j 对应的桌面座位。
 *   被淘汰玩家保留在桌面级状态（eliminated/finishPlaces/tableStacks）中。
 * - AI 风格保密：seatStyles 只在 store 内部使用（decide / HandRecord），
 *   UI 一律显示 "?"。
 * - 会话持久化：见 sessionPersistence.ts。浏览器端订阅本 store 变更
 *   防抖 300ms 写 localStorage；resumeSession() 读档恢复并断点续跑。
 * - 对手笔记本（lib/store/notebook.ts）：hero 的 tableStats 跨 session
 *   持久化到 localStorage。startTable 时注入（按流逝手数衰减补偿），
 *   finalizeHand 后防抖同步，resetNotebook() 清空；AI 座位仍随换桌清零。
 */
import { create } from "zustand";
import type {
  ActionType,
  AIStyle,
  BlindLevel,
  Card,
  ConcreteAIStyle,
  DecideInput,
  DecideResult,
  GameMode,
  GameState,
  HandPlayerRecord,
  HandRecord,
  LLMConfig,
  OpponentModel,
  OpponentStats,
  PlayerAction,
  PlayerState,
  Seat,
  SeatAction,
  Street,
  StreetRecord,
  TournamentConfig,
  TournamentContext,
} from "@/lib/types";
import {
  applyAction,
  createGame,
  legalActions,
  nextActiveSeat,
} from "@/lib/poker/game";
import { computeTournamentPhase } from "@/lib/types";
import {
  DEFAULT_TOURNAMENT,
  currentBlinds,
  nextLevel,
  shouldLevelUp,
} from "@/lib/poker/tournament";
import { decide } from "@/lib/ai/opponent";
import { heuristicDecide } from "@/lib/ai/heuristic";
import { assignStyles, AI_PROFILES } from "@/lib/ai/profiles";
import { summarizeHand } from "@/lib/ai/recentHands";
import { buildModel, createOpponentStats, updateStats } from "@/lib/ai/adapt";
import { useHistoryStore } from "@/lib/store/historyStore";
import { loadSession, saveSession } from "@/lib/store/sessionPersistence";
import { withRunoutStreets } from "@/lib/store/runout";
import { getStoredLang } from "@/lib/i18n/lang";
import {
  clearNotebook,
  loadDecayedHeroStats,
  scheduleNotebookSave,
  syncNotebook,
} from "@/lib/store/notebook";

// summarizeHand 抽到纯模块 @/lib/ai/recentHands（node 台架复用），此处 re-export 保持兼容
export { summarizeHand } from "@/lib/ai/recentHands";

export const HERO_SEAT: Seat = 0;

/** 与设置页共用的 localStorage 键（JSON: {apiKey, baseUrl, model}） */
const LLM_CONFIG_KEY = "pokergto_llm_config";
/** 与设置页共用的 localStorage 键（"heuristic" | "llm"） */
const AI_ENGINE_KEY = "pokergto_ai_engine";

/** AI 决策引擎：heuristic = 本地启发式直连（不碰网络）；llm = 走 decide（LLM 优先、启发式兜底） */
export type AIEngine = "heuristic" | "llm";

/**
 * hero 预操作（轮不到 hero 时提前选定；轮到 hero 且合法时自动执行）：
 * - fold 恒合法；
 * - check 仅在轮到时无跟注额才执行（有注则忽略）；
 * - call 有跟注额时按引擎封顶额跟注；无跟注额时降级为 check。
 */
export type PreAction = "fold" | "check" | "call";

/** 开桌配置：现金局用 cashBlinds/buyin；锦标赛忽略二者，使用 tournament（缺省 DEFAULT_TOURNAMENT） */
export interface TableConfig {
  mode: GameMode;
  /** 总座位数 2-9（含 hero，hero 固定桌面座位 0） */
  seats: number;
  /** 全场统一的风格选择；'random' 时由 assignStyles 每座独立抽取且保密 */
  aiStyle: AIStyle;
  /** 现金局盲注（锦标赛忽略） */
  cashBlinds?: { sb: number; bb: number };
  /** 现金局买入（锦标赛忽略） */
  buyin?: number;
  /** 锦标赛结构（缺省 DEFAULT_TOURNAMENT） */
  tournament?: TournamentConfig;
}

export interface AiActionInfo {
  /** 行动者的引擎座位 */
  seat: Seat;
  action: PlayerAction;
  reasoning: string;
  /** 决策来源（UI 以来源徽标区分展示；两种来源的 reasoning 都展示） */
  source: "llm" | "heuristic";
}

export interface SessionStats {
  handsPlayed: number;
  heroWins: number;
  /** 本会话 hero 累计净盈亏 */
  heroProfit: number;
  /** hero 重置买入的次数 */
  stackResets: number;
}

/** 升盲事件（UI 播横幅；开下一手时清除） */
export interface LevelUpEvent {
  level: number;
  blinds: BlindLevel;
}

/** 淘汰播报（桌面座位 + 名次） */
export interface BustEvent {
  seat: Seat;
  place: number;
}

/**
 * hero 归零后的待决淘汰（锦标赛重购期）：
 * hero 选择「认输离场」时才真正生效的淘汰结果（名次 / 可能的冠军）。
 */
export interface PendingHeroBust {
  place: number;
  championSeat: Seat | null;
}

export interface GameStore {
  /** 当前牌局状态（引擎座位视角，仅含未淘汰玩家）；未开局为 null */
  game: GameState | null;
  /** 本桌固定配置（startTable 时确定） */
  config: TableConfig | null;
  /** 对局模式 */
  mode: GameMode;
  /** 总座位数（含 hero） */
  seats: number;
  /** 现金局盲注 */
  cashBlinds: { sb: number; bb: number };
  /** 现金局买入 */
  buyin: number;
  /** 锦标赛结构（现金局为 null） */
  tournamentConfig: TournamentConfig | null;
  /** 用户选择的 AI 风格（可能是 'random'） */
  selectedStyle: AIStyle;
  /** 桌面座位 1..seats-1 的 AI 实际风格（保密，UI 显示 "?"） */
  seatStyles: ConcreteAIStyle[];
  /** 当前 LLM 配置（null 表示纯启发式） */
  llmConfig: LLMConfig | null;
  /** AI 决策引擎（开桌时从 localStorage pokergto_ai_engine 读取，默认 heuristic） */
  aiEngine: AIEngine;
  /** AI 是否正在思考（UI 显示 loading） */
  aiThinking: boolean;
  /** 最近一次 AI 的思考说明 */
  lastReasoning: string | null;
  /** 最近一次 AI 动作（含座位、reasoning 与来源） */
  lastAiAction: AiActionInfo | null;
  /** hero 当前跟注所需补的筹码（无需跟注/观战中为 0） */
  callAmount: number;
  /** hero 当前底池赔率 = callAmount / (pot + callAmount)，0-1 */
  potOdds: number;
  /** 本手 hero 净盈亏（结算后有效，正为赢；观战手为 null） */
  heroProfit: number | null;
  /** 本手开始前各引擎座位筹码（盈亏推导依据） */
  stacks: number[];
  /** 本会话统计（内存态；只计 hero 参与的手） */
  session: SessionStats;
  /** 已完结街道的行动记录（用于 HandRecord.streets） */
  streetLog: StreetRecord[];
  /** 当前街道已发生的动作（带行动者；街道归档时清空） */
  pendingActions: SeatAction[];
  /** 当前街道开始时的公共牌快照 */
  streetStartBoard: Card[];
  /** 当前 handOver 是否已 finalize（防重复写入历史） */
  handSettled: boolean;
  /** 最近手牌的一句话回顾（最新在前，上限 20 条；供 LLM 决策按 contextHands 注入） */
  recentHands: string[];

  // ---- N 人桌 / 锦标赛 ----
  /** 引擎座位 j → 桌面座位 seatMap[j]（淘汰座位不参与新一手，故需压缩映射） */
  seatMap: Seat[];
  /** 桌面座位是否已退出后续手（锦标赛淘汰保留名次；现金局 hero 下桌观战也复用此压缩机制） */
  eliminated: boolean[];
  /** 桌面座位名次（锦标赛；1 = 冠军，出局/夺冠时写入） */
  finishPlaces: (number | null)[];
  /** 桌面座位当前筹码（两手之间维护；现金局含 AI 补码/hero 重置） */
  tableStacks: number[];
  /** 当前盲注级别索引（锦标赛） */
  blindLevel: number;
  /** 当前级别已进行手数 */
  handsPlayedAtLevel: number;
  /** 距升盲剩余手数 */
  levelHandsLeft: number;
  /** 最近一手结束后触发的升盲事件 */
  levelUpEvent: LevelUpEvent | null;
  /** 最近一手产生的淘汰播报 */
  bustEvents: BustEvent[];
  /** hero 已下桌观战（锦标赛淘汰/认输、现金局破产后下桌；之后的 AI 手不再写入历史） */
  heroSpectating: boolean;
  /** 锦标赛已结束（冠军产生） */
  tournamentOver: boolean;
  /** 冠军桌面座位（tournamentOver 时有效） */
  championSeat: Seat | null;
  /** 现金局 hero 筹码不足大盲，等待「重置买入 / 下桌观战」决策（UI 横幅而非弹窗） */
  heroRebuyPrompt: boolean;
  /** 桌面座位已用重购次数（锦标赛；现金局恒为 0） */
  rebuysUsed: number[];
  /**
   * 桌面座位跨手打法统计（对手建模，索引 = 桌面座位）。
   * 跨手累积；现金局补码/锦标赛 rebuy 不清零（打法惯性跨重购）；
   * startTable 新开局时 AI 座位清零，hero 座位注入「对手笔记本」
   * （lib/store/notebook.ts）的长期画像——AI 第一手拿到的就是 hero 的
   * 跨 session 画像。观战手（无 HandRecord）不更新。
   */
  tableStats: OpponentStats[];
  /** hero 归零且尚有剩余重购次数，等待「重购继续 / 认输观战」决策（锦标赛，UI 横幅） */
  pendingHeroBust: PendingHeroBust | null;
  /** 观战快进开关（hero 下桌观战时自动开启，连续 auto 推进直到冠军产生/用户暂停） */
  fastForward: boolean;
  /** 最近一次行动/推进链的未捕获错误信息（UI 红条短暂显示；null 表示无错误） */
  lastError: string | null;
  /** hero 预操作（轮不到 hero 时预设；轮到 hero 且合法即自动执行并清空；跨手清空） */
  preAction: PreAction | null;

  /** 开桌（重置会话；第 1 手 hero 坐按钮位） */
  startTable: (config: TableConfig) => Promise<void>;
  /**
   * 从 localStorage 存档恢复整局（刷新/离开后的断点续跑）。
   * 无存档或存档损坏返回 false（调用方回退开新局）。恢复成功时按存档
   * 所处状态重入状态机：轮到 AI 则重启 AI 循环；普通结算横幅重新预约
   * AUTO_ADVANCE；观战快进链续跑；pendingHeroBust/heroRebuyPrompt/
   * tournamentOver 等交互/终局态原样等待（UI 横幅/弹窗照常渲染）。
   */
  resumeSession: () => Promise<boolean>;
  /** 人类玩家执行动作，随后驱动 AI 行动直至轮到人类或本手结束 */
  act: (action: PlayerAction) => Promise<void>;
  /** 推进到下一手：结算收尾、补码/提示、按钮轮转、开新一手并驱动 AI */
  advanceToNextHand: () => Promise<void>;
  /** 现金局 hero 筹码不足时的决策：重置买入或短码继续 */
  resolveRebuy: (rebuy: boolean) => Promise<void>;
  /**
   * 锦标赛 hero 归零后的重购决策：重购继续（买回起始筹码，消耗一次次数）
   * 或认输观战（按 pendingHeroBust 记账淘汰与名次，随后自动进入快进观战）。
   */
  resolveTournamentRebuy: (rebuy: boolean) => Promise<void>;
  /**
   * 现金局 hero 破产后下桌观战：hero 座位退出后续手（按淘汰座位压缩），
   * 自动开启快进看 AI 互打（不写历史），只能从横幅「返回大厅」离开。
   */
  spectateCash: () => Promise<void>;
  /** 观战快进开关 */
  setFastForward: (on: boolean) => void;
  /** 设置 AI 风格（对下一桌生效） */
  setStyle: (style: AIStyle) => void;
  /** 设置 LLM 配置 */
  setLLMConfig: (config: LLMConfig | null) => void;
  /** 清除 lastError（UI 红条自动消失时调用） */
  clearError: () => void;
  /** 本手结束后结算桌面状态并生成 HandRecord（由 act/runAiLoop 内部触发） */
  finalizeHand: () => HandRecord | null;
  /**
   * 普通结算后预约 AUTO_ADVANCE_MS 自动推进下一手（UI 横幅挂载时调用）。
   * 交互决策情形（heroRebuyPrompt / pendingHeroBust / tournamentOver / hero 观战）
   * 不预约；触发时复查同样条件，且 advanceToNextHand 自身仍有兜底拦截。
   * 重复调用会先取消上一笔预约（防重复触发）。
   */
  scheduleAutoAdvance: () => void;
  /** 取消预约的自动推进（横幅卸载/用户手动点下一手时调用） */
  cancelAutoAdvance: () => void;
  /** 设置/取消 hero 预操作（传 null 取消；设置时若恰已轮到 hero 则立即尝试执行） */
  setPreAction: (a: PreAction | null) => void;
  /**
   * 清空「对手笔记本」：删除 localStorage 长期画像，并把当前桌 hero 的
   * tableStats 清零——AI 立即失去对 hero 的跨 session 记忆（其他座位不受影响）。
   */
  resetNotebook: () => void;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** vitest 环境下跳过假延迟（测试需要连续打完多手） */
const IS_TEST = typeof process !== "undefined" && !!process.env?.VITEST;

/** AI 行动前的假延迟，制造节奏感（400-900ms） */
const AI_THINK_MIN_MS = 400;
const AI_THINK_MAX_MS = 900;
/** 观战快进每步间隔 */
const SPECTATE_STEP_MS = 800;
/** 普通结算横幅展示时长：到期自动推进下一手（5 秒，留足看摊牌牌面的时间） */
export const AUTO_ADVANCE_MS = 5000;

/**
 * 锦标赛重购期级数默认值：只有前 N 个盲注级别（blindLevel 索引 0..N-1）
 * 允许重购，进入第 N+1 级（索引 ≥ N）后归零即正常淘汰。按出局手所在级别
 * 判定（升盲结算发生在一手结束之后，故用升盲前的级别）。
 * 实际级数以 tournamentConfig.rebuyPeriodLevels 为准，缺省回退本常量。
 */
export const REBUY_PERIOD_LEVELS = 4;

const thinkDelay = () =>
  IS_TEST
    ? Promise.resolve()
    : delay(AI_THINK_MIN_MS + Math.random() * (AI_THINK_MAX_MS - AI_THINK_MIN_MS));
const spectateDelay = () => (IS_TEST ? Promise.resolve() : delay(SPECTATE_STEP_MS));

export function readLLMConfig(): LLMConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LLM_CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LLMConfig> | null;
    if (!parsed || typeof parsed.apiKey !== "string" || parsed.apiKey === "") {
      return null;
    }
    return {
      apiKey: parsed.apiKey,
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
      model: typeof parsed.model === "string" ? parsed.model : "",
      ...(typeof parsed.temperature === "number"
        ? { temperature: parsed.temperature }
        : {}),
      ...(parsed.reasoningEffort === "low" ||
      parsed.reasoningEffort === "medium" ||
      parsed.reasoningEffort === "high" ||
      parsed.reasoningEffort === "max"
        ? { reasoningEffort: parsed.reasoningEffort }
        : {}),
      ...(typeof parsed.maxTokens === "number" &&
      Number.isFinite(parsed.maxTokens) &&
      parsed.maxTokens > 0
        ? { maxTokens: Math.floor(parsed.maxTokens) }
        : {}),
      ...(typeof parsed.thinkingEnabled === "boolean"
        ? { thinkingEnabled: parsed.thinkingEnabled }
        : {}),
      ...(typeof parsed.jsonOutput === "boolean"
        ? { jsonOutput: parsed.jsonOutput }
        : {}),
      ...(typeof parsed.contextHands === "number" &&
      Number.isFinite(parsed.contextHands) &&
      parsed.contextHands > 0
        ? { contextHands: Math.min(20, Math.floor(parsed.contextHands)) }
        : {}),
      ...(parsed.promptStyle === "full" || parsed.promptStyle === "slim"
        ? { promptStyle: parsed.promptStyle }
        : {}),
    };
  } catch {
    return null;
  }
}

function readAIEngine(): AIEngine {
  if (typeof window === "undefined") return "heuristic";
  try {
    const raw = window.localStorage.getItem(AI_ENGINE_KEY);
    return raw === "llm" ? "llm" : "heuristic";
  } catch {
    return "heuristic";
  }
}

/** 开桌配置归一化（默认值 + 钳制） */
function normalizeConfig(config: TableConfig): {
  mode: GameMode;
  seats: number;
  cashBlinds: { sb: number; bb: number };
  buyin: number;
  tournamentConfig: TournamentConfig | null;
} {
  const mode: GameMode = config.mode === "tournament" ? "tournament" : "cash";
  const seatsRaw = Math.floor(config.seats);
  const seats = Number.isFinite(seatsRaw) ? Math.min(9, Math.max(2, seatsRaw)) : 2;
  if (mode === "tournament") {
    // 锦标赛：重购次数归一化（缺省/非法按 0，不允许负数）；
    // 重购期级数缺省保留 undefined（使用时回退 REBUY_PERIOD_LEVELS），
    // 显式传入时归一化为非负整数
    const raw = config.tournament ?? DEFAULT_TOURNAMENT;
    const rebuysAllowed = Math.max(
      0,
      Math.floor(Number.isFinite(raw.rebuysAllowed) ? raw.rebuysAllowed! : 0),
    );
    const rebuyPeriodLevels =
      raw.rebuyPeriodLevels === undefined
        ? undefined
        : Math.max(
            0,
            Math.floor(
              Number.isFinite(raw.rebuyPeriodLevels) ? raw.rebuyPeriodLevels : 0,
            ),
          );
    return {
      mode,
      seats,
      cashBlinds: { sb: 0, bb: 0 },
      buyin: 0,
      tournamentConfig: {
        ...raw,
        rebuysAllowed,
        ...(rebuyPeriodLevels === undefined ? {} : { rebuyPeriodLevels }),
      },
    };
  }
  const bb = Math.max(1, Math.floor(config.cashBlinds?.bb ?? 2));
  const sb = Math.min(Math.max(1, Math.floor(config.cashBlinds?.sb ?? 1)), bb);
  const buyin = Math.max(bb, Math.floor(config.buyin ?? bb * 100));
  return { mode, seats, cashBlinds: { sb, bb }, buyin, tournamentConfig: null };
}

/**
 * createGame 只收对称 stack：以 max(stacks) 开局后，把每个座位修正回真实筹码。
 * 引擎先从对称筹码收 ante 再收盲注，修正按同一顺序折算实付额；
 * 各座所欠 ante 从对称局的死钱部分（handBet − streetBet）推出——全体模式每人
 * 相同，BBA 模式仅大盲位非零，修正逻辑因此对两种模式一致。
 * 实付不足者按全下处理（allIn），并同步 pot/currentBet。
 * 若翻前起点（UTG）因 ante/盲注全下，顺推到下一个可行动座位。
 */
function correctStacks(game: GameState, stacks: number[]): void {
  for (let i = 0; i < game.players.length; i++) {
    const p = game.players[i];
    const real = stacks[i];
    const antePaid = Math.min(p.handBet - p.streetBet, real);
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
        // DEFAULT_TOURNAMENT 下不可达（总筹码守恒保证最大筹码者必然可行动）；
        // 仅可能由盲注/ante 比例极端的自定义锦标赛配置触发。
        throw new Error("[gameStore] 盲注/ante 已让全员全下，无法开出这一手");
      }
      game.currentSeat = found;
    }
  }
}

/**
 * 由结算后的 GameState 推导 hero 净盈亏。
 * 引擎终局结算（settleShowdown/settleFold）已把底池计入胜者 stack 并将 pot 清零，
 * 因此盈亏 = 结算后 stack − 本手开始前 stack（对 N 人、边池、平局均成立）。
 */
export function computeHeroProfit(
  game: GameState,
  heroSeat: Seat,
  startStacks: number[],
): number {
  return game.players[heroSeat].stack - startStacks[heroSeat];
}

/**
 * 某座位面对当前下注实际需补的筹码（按剩余筹码封顶）。
 * 与引擎 legalActions 的 call 口径一致：min(currentBet - streetBet, stack)——
 * 对手 bet-to 超过其剩余筹码时（深打浅的 overbet/全下），只按实际可跟注额计价。
 */
export function cappedCallAmount(state: GameState, seat: Seat): number {
  const me = state.players[seat];
  if (!me) return 0;
  return Math.max(0, Math.min(state.currentBet - me.streetBet, me.stack));
}

/**
 * 补齐全下跑马被跳过的空动作街记录。
 * 实现已移至独立模块 @/lib/store/runout（避免 gameStore ↔ historyStore
 * 循环引用），此处 re-export 保持既有调用方兼容。
 */
export { withRunoutStreets } from "@/lib/store/runout";

/**
 * 预操作合法性解析（须在轮到 currentSeat 行动时调用，通常即 hero）：
 * - fold 恒合法；
 * - check 仅在无跟注额时合法（有注 → 返回 null 忽略）；
 * - call 有跟注额时取引擎 legalActions 的 call（短码已封顶）；
 *   无跟注额时降级为 check（无注可跟，贴合「跟到底」意图）；
 * - 返回 null = 当前局面下不可执行（调用方清空预操作并等待手动）。
 */
export function resolvePreAction(
  game: GameState,
  pre: PreAction,
): PlayerAction | null {
  if (game.handOver || game.currentSeat === null) return null;
  const me = game.players[game.currentSeat];
  if (!me) return null;
  const toCall = Math.max(0, game.currentBet - me.streetBet);
  if (pre === "fold") return { type: "fold", amount: 0 };
  if (pre === "check") return toCall === 0 ? { type: "check", amount: 0 } : null;
  // pre === "call"
  if (toCall === 0) return { type: "check", amount: 0 };
  try {
    return legalActions(game).find((a) => a.type === "call") ?? null;
  } catch {
    return null;
  }
}

/** 构造 AI 决策输入：快照中隐藏其他所有玩家的底牌（信息隐藏约定） */
function buildDecideInput(
  state: GameState,
  seat: Seat,
  style: ConcreteAIStyle,
  opponentModels?: OpponentModel[],
  recentHands?: string[],
  tournament?: TournamentContext,
): DecideInput {
  const snapshot: GameState = {
    ...state,
    players: state.players.map((p, i) =>
      i === seat ? { ...p } : { ...p, holeCards: null },
    ),
  };
  let legal: PlayerAction[] = [];
  try {
    legal = legalActions(state);
  } catch {
    legal = [];
  }
  const callAmount = cappedCallAmount(state, seat);
  return {
    state: snapshot,
    legalActions: legal,
    callAmount,
    potOdds: callAmount > 0 ? callAmount / (state.pot + callAmount) : 0,
    style,
    ...(opponentModels && opponentModels.length > 0 ? { opponentModels } : {}),
    ...(recentHands && recentHands.length > 0 ? { recentHands } : {}),
    ...(tournament ? { tournament } : {}),
  };
}

/** decide 本身抛错时的保底动作（不破坏牌局流转） */
function fallbackDecide(input: DecideInput): DecideResult {
  const find = (t: ActionType) => input.legalActions.find((a) => a.type === t);
  const action = find("call") ??
    find("check") ??
    find("fold") ?? { type: "fold" as const, amount: 0 };
  return {
    action,
    reasoning: "决策服务异常，按保底策略选择合法动作。",
    source: "heuristic",
  };
}

/**
 * 一手牌的一句话回顾（供 LLM 决策的近期上下文）——实现已抽到
 * @/lib/ai/recentHands（纯模块，node 台架复用），顶部 re-export 保持兼容。
 */

export const useGameStore = create<GameStore>()((set, get) => {
  /** 桌面座位 t 的 AI 风格（seatStyles 索引 = 桌面座位 - 1；座位 0 为 hero） */
  const styleForTableSeat = (t: Seat): ConcreteAIStyle =>
    get().seatStyles[t - 1] ?? "gto";

  /** 引擎座位 j 的 AI 风格（经 seatMap 换算桌面座位） */
  const styleForEngineSeat = (j: Seat): ConcreteAIStyle =>
    styleForTableSeat(get().seatMap[j] ?? j);

  /**
   * 组装决策输入的对手画像：本手在局（未淘汰）的其他座位按桌面统计建模。
   * hero 座位也建模——AI 同样剥削 hero 的打法。
   * 模型的 seat 用引擎座位（与 DecideInput.state 对齐），统计取桌面座位维度。
   */
  const opponentModelsFor = (state: GameState, forSeat: Seat): OpponentModel[] => {
    const { tableStats, seatMap } = get();
    const out: OpponentModel[] = [];
    for (const p of state.players) {
      if (p.seat === forSeat || p.eliminated) continue;
      const t = seatMap[p.seat] ?? p.seat;
      const s = tableStats[t];
      if (!s) continue;
      out.push({ ...buildModel(s), seat: p.seat });
    }
    return out;
  };

  /**
   * 组装锦标赛上下文（Phase 7 轻量 ICM 输入）：仅锦标赛模式返回，
   * 现金局返回 undefined（DecideInput 不携带 tournament，行为与旧版一致）。
   * 筹码/排名取桌面级 tableStacks（两手之间维护的开手筹码），经 seatMap
   * 把引擎座位换算回桌面座位；当前大盲取本手 game.bigBlind。
   */
  const tournamentContextFor = (engineSeat: Seat): TournamentContext | undefined => {
    const st = get();
    if (st.mode !== "tournament" || !st.tournamentConfig) return undefined;
    const bb = st.game?.bigBlind ??
      currentBlinds(st.blindLevel, st.tournamentConfig.levels).bigBlind;
    if (bb <= 0) return undefined;
    const myTable = st.seatMap[engineSeat] ?? engineSeat;
    const myChips = st.tableStacks[myTable] ?? 0;
    const aliveStacks: number[] = [];
    for (let t = 0; t < st.seats; t++) {
      if (!st.eliminated[t]) aliveStacks.push(st.tableStacks[t] ?? 0);
    }
    const remaining = aliveStacks.length;
    if (remaining === 0) return undefined;
    const rank = 1 + aliveStacks.filter((c) => c > myChips).length;
    const avg = aliveStacks.reduce((sum, x) => sum + x, 0) / remaining;
    return {
      playersRemaining: remaining,
      totalPlayers: st.seats,
      myRankByChips: rank,
      avgStackBB: avg / bb,
      myStackBB: myChips / bb,
      blindLevelBB: bb,
      phase: computeTournamentPhase(remaining, st.seats),
    };
  };

  /** 由 game 派生的 hero 侧数据（callAmount / potOdds）；观战中恒为 0 */
  const heroDerived = (game: GameState): { callAmount: number; potOdds: number } => {
    if (get().heroSpectating) return { callAmount: 0, potOdds: 0 };
    const callAmount = cappedCallAmount(game, HERO_SEAT);
    const potOdds = callAmount > 0 ? callAmount / (game.pot + callAmount) : 0;
    return { callAmount, potOdds };
  };

  /**
   * 应用动作并维护街道记录：
   * - GameState.streetActions 自带行动者座位（SeatAction[]，F4），街道进行中
   *   直接作为 pendingActions；
   * - 街道推进 / 本手结束时引擎会清空 streetActions，故归档 = 换街前已有序列
   *   + 刚执行的动作（行动者 = prev.currentSeat），写入 streetLog。
   */
  const applyTracked = (prev: GameState, action: PlayerAction): GameState => {
    const next = applyAction(prev, action);
    const log = [...get().streetLog];
    let startBoard = get().streetStartBoard;
    let pending: SeatAction[];
    if (next.street !== prev.street || next.handOver) {
      const actor = prev.currentSeat;
      const actions = actor !== null
        ? [...prev.streetActions, { seat: actor, action }]
        : prev.streetActions;
      log.push({ street: prev.street, board: startBoard, actions });
      pending = [];
      if (next.street !== prev.street && !next.handOver) {
        startBoard = [...next.board];
      }
    } else {
      pending = [...next.streetActions];
    }
    set({
      game: next,
      streetLog: log,
      streetStartBoard: startBoard,
      pendingActions: pending,
      ...heroDerived(next),
    });
    return next;
  };

  /** AI 行动循环互斥标记（快进链与手动触发可能并发，单循环足以自驱） */
  let aiLoopRunning = false;

  /** 自动推进预约的计时器（同一时刻至多一笔；新手开局/取消时清理） */
  let autoAdvanceTimer: ReturnType<typeof setTimeout> | null = null;
  const clearAutoAdvanceTimer = (): void => {
    if (autoAdvanceTimer !== null) {
      clearTimeout(autoAdvanceTimer);
      autoAdvanceTimer = null;
    }
  };
  /** 当前状态是否允许自动推进（预约时与触发时各查一次） */
  const canAutoAdvance = (): boolean => {
    const st = get();
    return (
      !!st.game?.handOver &&
      st.handSettled &&
      !st.tournamentOver &&
      !st.pendingHeroBust &&
      !st.heroRebuyPrompt &&
      !st.heroSpectating
    );
  };

  /**
   * 观战快进推进链：hero 下桌观战期间，handOver 后间隔 800ms 连续 auto 推进，
   * 直到冠军产生（锦标赛）或用户暂停快进。每步推进前复查状态（防重入/防过期）。
   */
  const kickSpectateChain = async (): Promise<void> => {
    const st = get();
    if (
      st.heroSpectating &&
      st.fastForward &&
      !st.tournamentOver &&
      st.game?.handOver &&
      st.handSettled
    ) {
      await spectateDelay();
      const cur = get();
      if (
        cur.heroSpectating &&
        cur.fastForward &&
        !cur.tournamentOver &&
        cur.game?.handOver
      ) {
        await cur.advanceToNextHand();
      }
    }
  };

  /**
   * 预操作自动执行的防重入标记（act 为 async；执行期间再次触发直接跳过）
   */
  let preActionFiring = false;
  /**
   * 「轮到 hero」派生点的预操作钩子：轮到 hero 且设有预操作时自动执行。
   * 先清空再执行（防重入/防跨街残留）；非法预操作同样清空并等待手动。
   * 调用点：runAiLoop 尾部（AI 行动/开新一手后唯一轮转到 hero 的汇合点）
   * 与 setPreAction（设置时恰已轮到 hero 的立即执行）。
   */
  const maybeAutoPreAction = (): void => {
    if (preActionFiring) return;
    const st = get();
    const g = st.game;
    if (!g || g.handOver || st.heroSpectating || st.aiThinking) return;
    if (g.currentSeat !== HERO_SEAT) return;
    const pre = st.preAction;
    if (!pre) return;
    set({ preAction: null });
    let action: PlayerAction | null = null;
    try {
      action = resolvePreAction(g, pre);
    } catch {
      action = null;
    }
    if (!action) return;
    preActionFiring = true;
    void get()
      .act(action)
      .finally(() => {
        preActionFiring = false;
      });
  };

  /**
   * AI 行动循环：依次推进所有 AI 座位（每个 400-900ms 假延迟），
   * 直到轮到 hero 或 handOver。hero 观战中时所有座位都是 AI，循环到 handOver。
   * 任何未捕获异常（含 decide 之外的 applyAction 拒绝）都转为 lastError 并中断
   * 循环，aiThinking 在 finally 中复位——否则 UI 会永远停在「AI 思考中…」。
   */
  const runAiLoop = async (): Promise<void> => {
    if (aiLoopRunning) return;
    aiLoopRunning = true;
    try {
      for (;;) {
        const g = get().game;
        if (!g || g.handOver) break;
        const seat = g.currentSeat;
        if (seat === null) break;
        if (!get().heroSpectating && seat === HERO_SEAT) break;
        set({ aiThinking: true });
        await thinkDelay();
        // 延迟后复查（期间状态可能已变化）
        const cur = get().game;
        if (!cur || cur.handOver || cur.currentSeat !== seat) break;
        // 近期上下文：仅 LLM 引擎且用户配置了 contextHands 时注入（启发式不读该字段）
        const cfg = get().llmConfig;
        const recentHands =
          get().aiEngine === "llm" && (cfg?.contextHands ?? 0) > 0
            ? get().recentHands.slice(0, cfg!.contextHands)
            : undefined;
        const input = buildDecideInput(
          cur,
          seat,
          styleForEngineSeat(seat),
          opponentModelsFor(cur, seat),
          recentHands,
          tournamentContextFor(seat),
        );
        let result: DecideResult;
        try {
          // heuristic 引擎直连本地启发式（不碰网络）；llm 引擎走 decide（LLM 优先、启发式兜底）；
          // decide 第三个参数为当前 UI 语言：英文界面下 LLM 决策 prompt 与 reasoning 用英文
          result =
            get().aiEngine === "heuristic"
              ? heuristicDecide(input, input.style)
              : await decide(input, get().llmConfig, getStoredLang());
        } catch (err) {
          console.error("[gameStore] AI decide 失败，使用保底动作:", err);
          result = fallbackDecide(input);
        }
        let next: GameState;
        try {
          next = applyTracked(cur, result.action);
        } catch (err) {
          // 理论上不可达（decide/fallback 均从 legalActions 取动作）；
          // 防御：置错并中断循环，避免同一状态空转
          console.error("[gameStore] AI 动作被引擎拒绝:", err);
          set({
            lastError: `AI 动作执行失败：${err instanceof Error ? err.message : String(err)}`,
          });
          break;
        }
        set({
          lastAiAction: {
            seat,
            action: result.action,
            reasoning: result.reasoning,
            source: result.source,
          },
          lastReasoning: result.reasoning,
        });
        if (next.handOver) break;
      }
      if (get().game?.handOver) get().finalizeHand();
    } catch (err) {
      console.error("[gameStore] AI 行动循环异常:", err);
      set({
        lastError: `牌局推进失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      set({ aiThinking: false });
      aiLoopRunning = false;
    }
    // 观战快进：handOver 后间隔 800ms 连续推进，直到冠军产生或用户暂停快进
    await kickSpectateChain();
    // AI 行动/开新一手后若轮到 hero 且设有预操作：自动执行（内部防重入）
    maybeAutoPreAction();
  };

  /**
   * 开下一手：为未淘汰座位压缩开局（引擎座位 ↔ 桌面座位经 seatMap 映射），
   * 按钮按桌面座位 nextActiveSeat 轮转，createGame(max) + correctStacks 结转筹码。
   */
  const dealNextHand = (): void => {
    clearAutoAdvanceTimer(); // 新手开出后旧预约一律作废（防跨手误触发）
    const st = get();
    const { config, tournamentConfig, blindLevel } = st;
    if (!config) return;
    const seats = st.seats;
    const aliveSeats: Seat[] = [];
    for (let t = 0; t < seats; t++) {
      if (!st.eliminated[t]) aliveSeats.push(t);
    }
    if (aliveSeats.length < 2) {
      // 现金局 hero 下桌观战后只剩 1 个 AI（单挑桌）：无对手可打，
      // 停住快进并保持当前完结手，等用户从观战横幅返回大厅
      set({ fastForward: false });
      return;
    }
    const stacks = aliveSeats.map((t) => st.tableStacks[t]);

    // 按钮轮转：桌面座位视角找下一个未淘汰座位（第 1 手 hero 坐按钮位）
    const prevTableButton: Seat =
      st.game && st.seatMap.length > 0
        ? st.seatMap[st.game.buttonSeat]
        : HERO_SEAT;
    let buttonTable: Seat = HERO_SEAT;
    if (st.game) {
      const stub = st.eliminated.map(
        (e, seat) =>
          ({
            seat,
            eliminated: e,
          }) as PlayerState,
      );
      buttonTable = nextActiveSeat(stub, prevTableButton) ?? HERO_SEAT;
    }
    const buttonEngine = aliveSeats.indexOf(buttonTable);

    const blinds = tournamentConfig
      ? currentBlinds(blindLevel, tournamentConfig.levels)
      : {
          smallBlind: st.cashBlinds.sb,
          bigBlind: st.cashBlinds.bb,
          ante: 0,
        };

    const game = createGame({
      players: aliveSeats.length,
      smallBlind: blinds.smallBlind,
      bigBlind: blinds.bigBlind,
      ante: blinds.ante,
      anteMode: tournamentConfig?.anteMode ?? "all",
      stack: Math.max(...stacks),
      buttonSeat: buttonEngine,
    });
    correctStacks(game, stacks);
    game.handNumber = (st.game?.handNumber ?? 0) + 1;

    set({
      game,
      seatMap: aliveSeats,
      stacks,
      streetLog: [],
      streetStartBoard: [],
      pendingActions: [],
      lastAiAction: null,
      lastReasoning: null,
      heroProfit: null,
      handSettled: false,
      levelUpEvent: null,
      bustEvents: [],
      pendingHeroBust: null,
      preAction: null, // 预操作仅一手内有效，跨手清空
      ...heroDerived(game),
    });
  };

  return {
    game: null,
    config: null,
    mode: "cash",
    seats: 2,
    cashBlinds: { sb: 1, bb: 2 },
    buyin: 200,
    tournamentConfig: null,
    selectedStyle: "random",
    seatStyles: [],
    llmConfig: null,
    aiEngine: "heuristic",
    aiThinking: false,
    lastReasoning: null,
    lastAiAction: null,
    callAmount: 0,
    potOdds: 0,
    heroProfit: null,
    stacks: [],
    session: { handsPlayed: 0, heroWins: 0, heroProfit: 0, stackResets: 0 },
    streetLog: [],
    pendingActions: [],
    streetStartBoard: [],
    handSettled: false,
    recentHands: [],
    seatMap: [],
    eliminated: [],
    finishPlaces: [],
    tableStacks: [],
    blindLevel: 0,
    handsPlayedAtLevel: 0,
    levelHandsLeft: 0,
    levelUpEvent: null,
    bustEvents: [],
    heroSpectating: false,
    tournamentOver: false,
    championSeat: null,
    heroRebuyPrompt: false,
    rebuysUsed: [],
    tableStats: [],
    pendingHeroBust: null,
    fastForward: false,
    lastError: null,
    preAction: null,

    startTable: async (config) => {
      clearAutoAdvanceTimer(); // 换桌时作废上一桌可能残留的预约
      const norm = normalizeConfig(config);
      const startStack =
        norm.mode === "tournament"
          ? norm.tournamentConfig!.startStack
          : norm.buyin;
      // 分配 AI 风格（保密：UI 只显示 "?"，HandRecord 才记录真实风格）
      const seatStyles = assignStyles(norm.seats - 1, config.aiStyle);
      const llmConfig = readLLMConfig();
      set({
        config: { ...config, seats: norm.seats },
        mode: norm.mode,
        seats: norm.seats,
        cashBlinds: norm.cashBlinds,
        buyin: norm.buyin,
        tournamentConfig: norm.tournamentConfig,
        selectedStyle: config.aiStyle,
        seatStyles,
        llmConfig,
        aiEngine: readAIEngine(),
        aiThinking: false,
        lastReasoning: null,
        lastAiAction: null,
        callAmount: 0,
        potOdds: 0,
        heroProfit: null,
        stacks: [],
        session: { handsPlayed: 0, heroWins: 0, heroProfit: 0, stackResets: 0 },
        streetLog: [],
        pendingActions: [],
        streetStartBoard: [],
        handSettled: false,
        recentHands: [],
        game: null,
        seatMap: [],
        eliminated: Array(norm.seats).fill(false),
        finishPlaces: Array(norm.seats).fill(null),
        tableStacks: Array(norm.seats).fill(startStack),
        blindLevel: 0,
        handsPlayedAtLevel: 0,
        levelHandsLeft: norm.tournamentConfig?.handsPerLevel ?? 0,
        levelUpEvent: null,
        bustEvents: [],
        heroSpectating: false,
        tournamentOver: false,
        championSeat: null,
        heroRebuyPrompt: false,
        rebuysUsed: Array(norm.seats).fill(0),
        // 对手建模统计随新开局清零（补码/rebuy 等中途事件不清）；
        // hero 座位例外：注入「对手笔记本」的长期画像（按流逝手数衰减补偿），
        // AI 第一手拿到的就是 hero 的跨 session 画像；AI 座位照旧清零。
        tableStats: (() => {
          const stats = Array.from({ length: norm.seats }, (_, t) =>
            createOpponentStats(t),
          );
          const heroLongTerm = loadDecayedHeroStats();
          if (heroLongTerm) stats[HERO_SEAT] = { ...heroLongTerm, seat: HERO_SEAT };
          return stats;
        })(),
        pendingHeroBust: null,
        fastForward: false,
        lastError: null,
        preAction: null,
      });
      dealNextHand();
      // 开新局立即覆盖旧存档（不等防抖），防「开局即关页」残留上一局
      saveSession(get());
      await runAiLoop();
    },

    resumeSession: async () => {
      clearAutoAdvanceTimer(); // 新页面没有任何存活计时器
      const snap = loadSession();
      if (!snap) return false;
      // callAmount/potOdds 为派生数据不存档，按 heroSpectating 重算（同 heroDerived）
      const callAmount = snap.heroSpectating
        ? 0
        : cappedCallAmount(snap.game, HERO_SEAT);
      const potOdds =
        callAmount > 0 ? callAmount / (snap.game.pot + callAmount) : 0;
      set({
        game: snap.game,
        config: snap.config,
        mode: snap.mode,
        seats: snap.seats,
        cashBlinds: snap.cashBlinds,
        buyin: snap.buyin,
        tournamentConfig: snap.tournamentConfig,
        selectedStyle: snap.selectedStyle,
        seatStyles: snap.seatStyles,
        llmConfig: readLLMConfig(),
        aiEngine: readAIEngine(),
        aiThinking: false,
        lastReasoning: snap.lastReasoning,
        lastAiAction: snap.lastAiAction,
        callAmount,
        potOdds,
        heroProfit: snap.heroProfit,
        stacks: snap.stacks,
        session: snap.session,
        streetLog: snap.streetLog,
        pendingActions: snap.pendingActions,
        streetStartBoard: snap.streetStartBoard,
        handSettled: snap.handSettled,
        recentHands: snap.recentHands ?? [],
        seatMap: snap.seatMap,
        eliminated: snap.eliminated,
        finishPlaces: snap.finishPlaces,
        tableStacks: snap.tableStacks,
        blindLevel: snap.blindLevel,
        handsPlayedAtLevel: snap.handsPlayedAtLevel,
        levelHandsLeft: snap.levelHandsLeft,
        levelUpEvent: null, // 升盲横幅为瞬态，不恢复
        bustEvents: snap.bustEvents,
        heroSpectating: snap.heroSpectating,
        tournamentOver: snap.tournamentOver,
        championSeat: snap.championSeat,
        heroRebuyPrompt: snap.heroRebuyPrompt,
        rebuysUsed: snap.rebuysUsed,
        tableStats: snap.tableStats,
        pendingHeroBust: snap.pendingHeroBust,
        fastForward: snap.fastForward,
        lastError: null,
      });

      // 对手笔记本：tableStats 已随存档恢复（存档内 hero 统计即长期画像），
      // 笔记本在其后原样同步（不重复衰减补偿）
      const heroStats = snap.tableStats[HERO_SEAT];
      if (heroStats) syncNotebook(heroStats);

      // ---- 断点续跑（状态机重入）----
      let cur = get();
      if (cur.tournamentOver || !cur.game) return true; // 冠军弹窗终局态：无后续推进
      if (cur.game.handOver && !cur.handSettled) {
        // 防御：存档落在 handOver 与 finalize 之间时补结算（防抖下理论上不可达）
        cur.finalizeHand();
        cur = get();
        if (!cur.game) return true;
      }
      if (cur.game.handOver) {
        if (cur.heroSpectating) {
          await kickSpectateChain(); // 观战中：快进开则续推
        } else if (!cur.pendingHeroBust && !cur.heroRebuyPrompt) {
          cur.scheduleAutoAdvance(); // 普通结算横幅：重新预约自动推进
        }
        // pendingHeroBust / heroRebuyPrompt：交互横幅原样等待用户决策
        return true;
      }
      // 手牌进行中：轮到 AI（观战时所有在座座位都是 AI）→ 重启 AI 行动循环
      const seat = cur.game.currentSeat;
      if (cur.heroSpectating || (seat !== null && seat !== HERO_SEAT)) {
        await runAiLoop();
      }
      return true;
    },

    act: async (action) => {
      // applyAction 对非法动作抛错（金额越界/类型不允许）；必须兜住，
      // 否则未处理 rejection 会让 UI 表现为「点了没反应」
      try {
        const g = get().game;
        if (
          !g ||
          g.handOver ||
          get().heroSpectating ||
          g.currentSeat !== HERO_SEAT ||
          get().aiThinking
        ) {
          return;
        }
        // hero 行动落地即消费预操作（含自动执行路径；防跨街/跨手残留触发）
        if (get().preAction !== null) set({ preAction: null });
        const next = applyTracked(g, action);
        if (next.handOver) {
          get().finalizeHand();
          // hero 这一手可能把自己淘汰（锦标赛）：finalize 已自动开快进，在此启动推进链
          await kickSpectateChain();
          return;
        }
        await runAiLoop();
      } catch (err) {
        console.error("[gameStore] hero 动作执行失败:", err);
        set({
          lastError: `动作执行失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },

    advanceToNextHand: async () => {
      try {
        const st = get();
        if (!st.game || !st.config || !st.game.handOver) return;
        if (!st.handSettled) get().finalizeHand();
        const cur = get();
        if (cur.tournamentOver) return;
        // hero 归零待决重购时，必须先经 resolveTournamentRebuy 决策
        if (cur.pendingHeroBust) return;
        // hero 观战中只接受快进推进（UI 提供快进开关）
        if (cur.heroSpectating && !cur.fastForward) return;

        // 现金局：AI 筹码不足大盲自动补码回 buyin；hero 不足大盲则提示重置或下桌观战
        if (cur.mode === "cash") {
          const tableStacks = [...cur.tableStacks];
          for (let t = 1; t < cur.seats; t++) {
            if (tableStacks[t] < cur.cashBlinds.bb) tableStacks[t] = cur.buyin;
          }
          // hero 观战中已下桌，不再触发重置买入提示
          if (!cur.heroSpectating && tableStacks[HERO_SEAT] < cur.cashBlinds.bb) {
            set({ tableStacks, heroRebuyPrompt: true });
            return; // 等 resolveRebuy / spectateCash 继续
          }
          set({ tableStacks });
        }

        dealNextHand();
        await runAiLoop();
      } catch (err) {
        console.error("[gameStore] 推进下一手失败:", err);
        set({
          lastError: `推进下一手失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },

    resolveRebuy: async (rebuy) => {
      try {
        const st = get();
        if (!st.heroRebuyPrompt || st.mode !== "cash") return;
        const tableStacks = [...st.tableStacks];
        // 筹码为 0 无法继续，强制重置买入
        const doRebuy = rebuy || tableStacks[HERO_SEAT] <= 0;
        if (doRebuy) {
          tableStacks[HERO_SEAT] = st.buyin;
          set({
            tableStacks,
            heroRebuyPrompt: false,
            session: { ...st.session, stackResets: st.session.stackResets + 1 },
          });
        } else {
          set({ heroRebuyPrompt: false });
        }
        dealNextHand();
        await runAiLoop();
      } catch (err) {
        console.error("[gameStore] 现金局重置买入失败:", err);
        set({
          lastError: `重置买入失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },

    resolveTournamentRebuy: async (rebuy) => {
      try {
        const st = get();
        const pending = st.pendingHeroBust;
        if (!pending || st.mode !== "tournament" || !st.tournamentConfig) return;
        const tc = st.tournamentConfig;
        if (rebuy) {
          // 重购继续：买回起始筹码，消耗一次重购次数（筹码守恒基准随之 +startStack）
          const tableStacks = [...st.tableStacks];
          tableStacks[HERO_SEAT] = tc.startStack;
          const rebuysUsed = [...st.rebuysUsed];
          rebuysUsed[HERO_SEAT] = (rebuysUsed[HERO_SEAT] ?? 0) + 1;
          set({ tableStacks, rebuysUsed, pendingHeroBust: null });
          // 特例：同手全员出局后 hero 重购 → 唯一幸存者，直接夺冠
          if (st.eliminated.every((e, t) => t === HERO_SEAT || e)) {
            const finishPlaces = [...st.finishPlaces];
            finishPlaces[HERO_SEAT] = 1;
            set({
              finishPlaces,
              championSeat: HERO_SEAT,
              tournamentOver: true,
            });
            return;
          }
          dealNextHand();
          await runAiLoop();
          return;
        }
        // 认输观战：按结算时预计算的结果记账淘汰与名次/冠军，随后自动进入快进观战
        const eliminated = [...st.eliminated];
        const finishPlaces = [...st.finishPlaces];
        const tableStacks = [...st.tableStacks];
        eliminated[HERO_SEAT] = true;
        finishPlaces[HERO_SEAT] = pending.place;
        tableStacks[HERO_SEAT] = 0;
        let championSeat = st.championSeat;
        let tournamentOver = st.tournamentOver;
        if (pending.championSeat !== null) {
          championSeat = pending.championSeat;
          finishPlaces[pending.championSeat] = 1;
          tournamentOver = true;
        }
        set({
          eliminated,
          finishPlaces,
          tableStacks,
          championSeat,
          tournamentOver,
          heroSpectating: true,
          fastForward: true,
          pendingHeroBust: null,
          bustEvents: [...st.bustEvents, { seat: HERO_SEAT, place: pending.place }],
        });
        await kickSpectateChain();
      } catch (err) {
        console.error("[gameStore] 锦标赛重购决策失败:", err);
        set({
          lastError: `重购决策失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },

    spectateCash: async () => {
      try {
        const st = get();
        if (st.mode !== "cash" || st.heroSpectating || !st.game?.handOver) return;
        // hero 下桌：座位压缩排除 hero（复用淘汰机制），筹码清零，自动快进观战
        const eliminated = [...st.eliminated];
        eliminated[HERO_SEAT] = true;
        const tableStacks = [...st.tableStacks];
        tableStacks[HERO_SEAT] = 0;
        set({
          eliminated,
          tableStacks,
          heroSpectating: true,
          fastForward: true,
          heroRebuyPrompt: false,
        });
        await get().advanceToNextHand();
      } catch (err) {
        console.error("[gameStore] 现金局下桌观战失败:", err);
        set({
          lastError: `下桌观战失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },

    setFastForward: (on) => {
      set({ fastForward: on });
      const st = get();
      // 打开快进时若正停在一手结束处，立即启动推进链
      if (
        on &&
        st.heroSpectating &&
        !st.tournamentOver &&
        st.game?.handOver &&
        st.handSettled
      ) {
        void get().advanceToNextHand();
      }
    },

    setStyle: (style) => set({ selectedStyle: style }),
    setLLMConfig: (config) => set({ llmConfig: config }),
    clearError: () => set({ lastError: null }),

    resetNotebook: () => {
      clearNotebook();
      // 当前桌 hero 统计一并清零：AI 立即失去对 hero 的长期记忆
      const tableStats = get().tableStats;
      if (tableStats.length > 0) {
        const next = [...tableStats];
        next[HERO_SEAT] = createOpponentStats(HERO_SEAT);
        set({ tableStats: next });
      }
    },

    scheduleAutoAdvance: () => {
      clearAutoAdvanceTimer(); // 重复预约只保留最新一笔
      if (!canAutoAdvance()) return;
      autoAdvanceTimer = setTimeout(() => {
        autoAdvanceTimer = null;
        // 触发时复查：期间可能已进入交互决策（如重购提示）或被手动推进
        if (!canAutoAdvance()) return;
        void get().advanceToNextHand();
      }, AUTO_ADVANCE_MS);
    },

    cancelAutoAdvance: () => {
      clearAutoAdvanceTimer();
    },

    setPreAction: (a) => {
      set({ preAction: a });
      // 设置时若恰已轮到 hero（如 AI 已行动完的空档），立即尝试自动执行
      maybeAutoPreAction();
    },

    finalizeHand: () => {
      const st = get();
      const { game, config, streetLog, handSettled, session, stacks } = st;
      if (!game || !game.handOver || handSettled || !config) return null;

      const tc = st.tournamentConfig;
      const map = st.seatMap;
      // 引擎结算后 pot 已清零、底池计入胜者 stack：盈亏按 stack 差额推导
      const profits = game.players.map((p, j) => p.stack - stacks[j]);

      // ---- 桌面级状态收尾（锦标赛：淘汰/名次/冠军/升盲）----
      const eliminated = [...st.eliminated];
      const finishPlaces = [...st.finishPlaces];
      const tableStacks = [...st.tableStacks];
      for (let j = 0; j < game.players.length; j++) {
        tableStacks[map[j]] = game.players[j].stack;
      }

      const busts: BustEvent[] = [];
      let heroSpectating = st.heroSpectating;
      let fastForward = st.fastForward;
      let tournamentOver = st.tournamentOver;
      let championSeat = st.championSeat;
      let blindLevel = st.blindLevel;
      let handsPlayedAtLevel = st.handsPlayedAtLevel;
      let levelHandsLeft = st.levelHandsLeft;
      let levelUpEvent: LevelUpEvent | null = null;
      let rebuysUsed = st.rebuysUsed;
      let pendingHeroBust: PendingHeroBust | null = null;

      if (st.mode === "tournament" && tc) {
        // 本手结束后 stack===0 的玩家出局；同手多人出局按开手筹码排序，
        // 筹码少者名次靠后（place = 剩余人数 + 1 起）。
        // 重购规则：出局手所在级别处于重购期（前 rebuyPeriodLevels 级，
        // 缺省 REBUY_PERIOD_LEVELS=4）且该座位剩余重购次数 >0 时可重购——
        // AI 自动买回起始筹码；
        // hero 不立即记账淘汰，置 pendingHeroBust 等 resolveTournamentRebuy 决策。
        const startStack = tc.startStack;
        const rebuysAllowed = tc.rebuysAllowed ?? 0;
        const rebuyPeriodOpen =
          blindLevel < (tc.rebuyPeriodLevels ?? REBUY_PERIOD_LEVELS);
        rebuysUsed = [...st.rebuysUsed];
        const canRebuy = (t: Seat) =>
          rebuysAllowed - (rebuysUsed[t] ?? 0) > 0 && rebuyPeriodOpen;

        const zeroed = game.players
          .filter((p) => p.stack === 0)
          .map((p) => ({
            tableSeat: map[p.seat],
            startStack: stacks[p.seat],
          }))
          .sort((a, b) => a.startStack - b.startStack);
        // AI 重购立即发生（在统计幸存人数之前），hero 的淘汰记账延后到决策时
        const busted = zeroed.filter((b) => {
          if (!canRebuy(b.tableSeat)) return true;
          if (b.tableSeat !== HERO_SEAT) {
            rebuysUsed[b.tableSeat] += 1;
            tableStacks[b.tableSeat] = startStack;
            return false;
          }
          return true; // hero 暂留在出局列表，下方单独摘出
        });
        const heroBustIdx = busted.findIndex(
          (b) => b.tableSeat === HERO_SEAT && canRebuy(HERO_SEAT),
        );
        const heroPending = heroBustIdx >= 0;
        const heroEntry = heroPending ? busted[heroBustIdx] : null;
        if (heroPending) busted.splice(heroBustIdx, 1);

        const aliveAfter = game.players.length - busted.length;
        busted.forEach((b, idx) => {
          const place = aliveAfter + (busted.length - idx);
          eliminated[b.tableSeat] = true;
          finishPlaces[b.tableSeat] = place;
          tableStacks[b.tableSeat] = 0;
          busts.push({ seat: b.tableSeat, place });
        });
        if (heroPending && heroEntry) {
          // hero 若拒绝重购，其淘汰在决策时刻才正式记账（晚于同手其他出局者），
          // 故名次取「其余出局者记完名次的下一个」= aliveAfter（含 hero 的幸存数），
          // 与同手出局者不重名次。特例：同手全员出局（aliveAfter === 1）时按
          // 开手筹码定名次——筹码最多者即冠军（含 hero 自己）。
          // 若 hero 出局后只剩 1 人，该幸存座位成为冠军。
          // 结果暂存，待 resolveTournamentRebuy 决策。
          let place = aliveAfter;
          let pendingChampion: Seat | null = null;
          if (aliveAfter === 1) {
            place =
              1 +
              busted.filter((b) => b.startStack > heroEntry.startStack).length;
            if (place === 1) pendingChampion = HERO_SEAT;
          } else if (aliveAfter === 2) {
            const winner = game.players.find(
              (p) => !eliminated[map[p.seat]] && p.seat !== HERO_SEAT,
            );
            if (winner) pendingChampion = map[winner.seat];
          }
          pendingHeroBust = { place, championSeat: pendingChampion };
        }
        if (aliveAfter === 1 && busted.length > 0) {
          const champ = game.players.find((p) => p.stack > 0);
          if (champ) {
            championSeat = map[champ.seat];
            finishPlaces[championSeat] = 1;
            tournamentOver = true;
          }
        }
        heroSpectating = eliminated[HERO_SEAT];
        // hero 新出局（无剩余重购/重购期外）：不弹窗，直接下桌观战并自动快进；
        // 推进链由调用方（act/runAiLoop 尾部）启动
        if (heroSpectating && !st.heroSpectating) fastForward = true;

        // 升盲：打满 handsPerLevel 手升入下一级（到顶停住，盲注继续按顶级）
        handsPlayedAtLevel += 1;
        if (shouldLevelUp(handsPlayedAtLevel, tc.handsPerLevel)) {
          blindLevel = nextLevel(blindLevel, tc.levels);
          handsPlayedAtLevel = 0;
          levelUpEvent = { level: blindLevel, blinds: currentBlinds(blindLevel, tc.levels) };
        }
        levelHandsLeft = tc.handsPerLevel - handsPlayedAtLevel;
      }

      // ---- HandRecord（hero 参与的手才写入历史；观战手只更新桌面状态）----
      let record: HandRecord | null = null;
      let heroProfit: number | null = null;
      let tableStats = st.tableStats;
      let recentHands = st.recentHands;
      if (!st.heroSpectating) {
        heroProfit = computeHeroProfit(game, HERO_SEAT, stacks);
        const result: HandRecord["result"] =
          heroProfit > 0 ? "win" : heroProfit < 0 ? "lose" : "tie";
        const players: HandPlayerRecord[] = game.players.map((p, j) => ({
          seat: p.seat,
          isHero: p.seat === HERO_SEAT,
          aiStyle: p.seat === HERO_SEAT ? null : styleForEngineSeat(j),
          // 摊牌才亮对手底牌（已弃牌者不亮）；hero 底牌始终可见
          cards:
            p.seat === HERO_SEAT
              ? p.holeCards
              : game.showdown && !p.folded
                ? p.holeCards
                : null,
          profit: profits[j],
          ...(st.mode === "tournament"
            ? (() => {
                const place = finishPlaces[map[j]];
                return place !== null ? { finishPlace: place } : {};
              })()
            : {}),
        }));
        record = {
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          players,
          heroSeat: HERO_SEAT,
          buttonSeat: game.buttonSeat,
          smallBlind: game.smallBlind,
          bigBlind: game.bigBlind,
          ante: game.ante,
          anteMode: st.tournamentConfig?.anteMode ?? "all",
          // 全下跑马时被引擎跳过的空动作街在此补录（见 withRunoutStreets），
          // 保证 streets 覆盖每一张发出的公共牌，回放/教练复盘可见完整牌局
          streets: withRunoutStreets(streetLog, game.board),
          finalBoard: [...game.board],
          result,
          profit: heroProfit,
          showdown: game.showdown,
        };
        set({
          session: {
            ...session,
            handsPlayed: session.handsPlayed + 1,
            heroWins: session.heroWins + (result === "win" ? 1 : 0),
            heroProfit: session.heroProfit + heroProfit,
          },
        });
        // 对手建模：用本手记录更新所有在座座位（含 hero——AI 也剥削 hero 的打法）
        // 的跨手统计；HandRecord 的 seat 是引擎座位，经 seatMap 换算回桌面座位
        const nextStats = [...tableStats];
        for (const pr of record.players) {
          const t = map[pr.seat];
          const prev = t !== undefined ? nextStats[t] : undefined;
          if (prev) nextStats[t] = updateStats(prev, record, pr.seat);
        }
        tableStats = nextStats;
        // 对手笔记本：hero 长期画像随本手同步持久化（防抖 1s 合批，见 notebook.ts）
        if (nextStats[HERO_SEAT]) scheduleNotebookSave(nextStats[HERO_SEAT]);
        // 历史持久化失败不阻断牌局（IndexedDB 不可用 / 模块未就绪）
        void useHistoryStore
          .getState()
          .addHand(record)
          .catch((err) => console.error("[gameStore] 历史记录保存失败:", err));
        // 近期上下文：一句话回顾，最新在前，上限 20 条（供 LLM 决策按 contextHands 注入）
        const summary = summarizeHand(
          record,
          (s) => AI_PROFILES[s as ConcreteAIStyle]?.name ?? s,
        );
        recentHands = [summary, ...st.recentHands].slice(0, 20);
      }

      set({
        handSettled: true,
        heroProfit,
        eliminated,
        finishPlaces,
        tableStacks,
        tableStats,
        recentHands,
        rebuysUsed,
        pendingHeroBust,
        bustEvents: busts,
        heroSpectating,
        fastForward,
        tournamentOver,
        championSeat,
        blindLevel,
        handsPlayedAtLevel,
        levelHandsLeft,
        levelUpEvent,
      });
      return record;
    },
  };
});

/**
 * 会话存档自动写入（仅浏览器端；vitest/SSR 无 window 不安装）。
 * 任何状态变更后防抖 300ms 落盘；无进行中牌局（大厅等页面、未开桌）
 * 不动既有存档——大厅读取「返回当前对战」依赖它。
 */
const SESSION_SAVE_DEBOUNCE_MS = 300;
if (typeof window !== "undefined") {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  useGameStore.subscribe(() => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveSession(useGameStore.getState());
    }, SESSION_SAVE_DEBOUNCE_MS);
  });
}
