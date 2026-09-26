/**
 * 牌局会话持久化（localStorage 快照 + 恢复，v1）
 *
 * 解决两个痛点：
 * - 切到大厅/历史后可经「返回当前对战」回到同一局（/play?resume=1）；
 * - 刷新页面后手牌不变（牌堆/底牌/筹码/按钮位原样恢复）。
 *
 * 存档内容：gameStore 中「重建整局所必需」的字段（含引擎 GameState——
 * 剩余牌堆 deck、各座位 holeCards/stack 等，均为可 JSON 序列化的纯数据）。
 * 瞬态字段不存档：aiThinking、lastError、levelUpEvent、自动推进计时器。
 * llmConfig / aiEngine 不存档（前者避免复制 API Key，后者是全局设置）——
 * 恢复时与 startTable 一样从各自 localStorage 键重新读取。
 *
 * 写入：gameStore 模块底部订阅 store 变更，防抖 300ms 落盘；
 * startTable 开新局后立即同步覆盖（防「开局即关页」残留旧局）。
 * 清除：锦标赛冠军弹窗「返回大厅」点击时 clearSession（终局不再可恢复）。
 */
import type {
  AIStyle,
  Card,
  ConcreteAIStyle,
  GameMode,
  GameState,
  OpponentStats,
  Seat,
  SeatAction,
  StreetRecord,
  TournamentConfig,
} from "@/lib/types";
import type {
  AiActionInfo,
  BustEvent,
  GameStore,
  PendingHeroBust,
  SessionStats,
  TableConfig,
} from "@/lib/store/gameStore";

/** 进行中对局的 localStorage 存档键 */
export const SESSION_STORAGE_KEY = "pokergto_active_session";
/** 存档格式版本（结构变更时递增并在校验处拒绝旧档） */
export const SESSION_SNAPSHOT_VERSION = 1;

/**
 * 进行中对局的完整快照。除 version/savedAt/buttonSeat 外，
 * 字段名与 gameStore 状态一一对应（buttonSeat 为桌面级导出值）。
 */
export interface SessionSnapshot {
  version: number;
  /** 写入时刻（Unix 毫秒） */
  savedAt: number;

  /** 引擎牌局状态（含剩余牌堆、各座位底牌/筹码、当前行动方、handOver） */
  game: GameState;
  /** 开桌配置 */
  config: TableConfig;
  mode: GameMode;
  seats: number;
  cashBlinds: { sb: number; bb: number };
  buyin: number;
  tournamentConfig: TournamentConfig | null;
  selectedStyle: AIStyle;
  /** AI 实际风格（保密值也随档恢复，恢复后绝不重抽） */
  seatStyles: ConcreteAIStyle[];

  /** 本手开始前各引擎座位筹码（finalizeHand 盈亏推导依据） */
  stacks: number[];
  streetLog: StreetRecord[];
  pendingActions: SeatAction[];
  streetStartBoard: Card[];
  handSettled: boolean;
  heroProfit: number | null;

  seatMap: Seat[];
  eliminated: boolean[];
  finishPlaces: (number | null)[];
  tableStacks: number[];
  /** 桌面级按钮位（导出时由 seatMap[game.buttonSeat] 换算；恢复后 dealNextHand 仍按 game+seatMap 重推） */
  buttonSeat: Seat;
  blindLevel: number;
  handsPlayedAtLevel: number;
  levelHandsLeft: number;
  bustEvents: BustEvent[];
  rebuysUsed: number[];
  tableStats: OpponentStats[];
  pendingHeroBust: PendingHeroBust | null;
  heroSpectating: boolean;
  fastForward: boolean;
  heroRebuyPrompt: boolean;
  tournamentOver: boolean;
  championSeat: Seat | null;
  session: SessionStats;

  lastReasoning: string | null;
  lastAiAction: AiActionInfo | null;
  /** 最近手牌回顾（可选以兼容旧档；缺省视为空） */
  recentHands?: string[];
}

/** 大厅「返回当前对战」卡片的展示数据 */
export interface SessionSummary {
  mode: GameMode;
  seats: number;
  /** 已进行手数（hero 参与的手） */
  handsPlayed: number;
  /** hero 累计净盈亏 */
  heroProfit: number;
  /** 当前手编号 */
  handNumber: number;
  savedAt: number;
  heroSpectating: boolean;
}

function storageOrNull(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * 由当前 store 状态导出快照（纯函数，不写存储）。
 * 调用方须保证 s.config / s.game 非空（有进行中的对局）。
 */
export function buildSnapshot(s: GameStore): SessionSnapshot {
  const game = s.game!;
  return {
    version: SESSION_SNAPSHOT_VERSION,
    savedAt: Date.now(),
    game,
    config: s.config!,
    mode: s.mode,
    seats: s.seats,
    cashBlinds: s.cashBlinds,
    buyin: s.buyin,
    tournamentConfig: s.tournamentConfig,
    selectedStyle: s.selectedStyle,
    seatStyles: s.seatStyles,
    stacks: s.stacks,
    streetLog: s.streetLog,
    pendingActions: s.pendingActions,
    streetStartBoard: s.streetStartBoard,
    handSettled: s.handSettled,
    heroProfit: s.heroProfit,
    seatMap: s.seatMap,
    eliminated: s.eliminated,
    finishPlaces: s.finishPlaces,
    tableStacks: s.tableStacks,
    buttonSeat: s.seatMap[game.buttonSeat] ?? game.buttonSeat,
    blindLevel: s.blindLevel,
    handsPlayedAtLevel: s.handsPlayedAtLevel,
    levelHandsLeft: s.levelHandsLeft,
    bustEvents: s.bustEvents,
    rebuysUsed: s.rebuysUsed,
    tableStats: s.tableStats,
    pendingHeroBust: s.pendingHeroBust,
    heroSpectating: s.heroSpectating,
    fastForward: s.fastForward,
    heroRebuyPrompt: s.heroRebuyPrompt,
    tournamentOver: s.tournamentOver,
    championSeat: s.championSeat,
    session: s.session,
    lastReasoning: s.lastReasoning,
    lastAiAction: s.lastAiAction,
    recentHands: s.recentHands,
  };
}

/** 写入存档（无进行中牌局 / 非浏览器环境 / 存储不可用时静默跳过） */
export function saveSession(s: GameStore): void {
  const ls = storageOrNull();
  if (!ls || !s.config || !s.game) return;
  try {
    ls.setItem(SESSION_STORAGE_KEY, JSON.stringify(buildSnapshot(s)));
  } catch {
    // 隐私模式/配额超限：放弃本次写入，不阻断牌局
  }
}

/** 读取并校验存档；无存档或存档损坏/版本不符时清除坏档并返回 null */
export function loadSession(): SessionSnapshot | null {
  const ls = storageOrNull();
  if (!ls) return null;
  let raw: string | null;
  try {
    raw = ls.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isSessionSnapshot(parsed)) {
      throw new Error("[sessionPersistence] 存档结构校验失败");
    }
    return parsed;
  } catch (err) {
    console.error("[sessionPersistence] 存档不可用，已清除:", err);
    try {
      ls.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // 忽略清除失败
    }
    return null;
  }
}

/** 删除存档（锦标赛冠军弹窗关闭/终局离场时调用） */
export function clearSession(): void {
  const ls = storageOrNull();
  if (!ls) return;
  try {
    ls.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // 忽略
  }
}

/** 大厅卡片数据：从快照提取模式/人数/已进行手数/hero 盈亏 */
export function summarizeSession(snap: SessionSnapshot): SessionSummary {
  return {
    mode: snap.mode,
    seats: snap.seats,
    handsPlayed: snap.session.handsPlayed,
    heroProfit: snap.session.heroProfit,
    handNumber: snap.game.handNumber,
    savedAt: snap.savedAt,
    heroSpectating: snap.heroSpectating,
  };
}

/** 存档结构校验（版本 + 关键字段形状/长度一致性） */
function isSessionSnapshot(x: unknown): x is SessionSnapshot {
  if (!x || typeof x !== "object") return false;
  const s = x as Partial<SessionSnapshot>;
  if (s.version !== SESSION_SNAPSHOT_VERSION) return false;
  if (s.mode !== "cash" && s.mode !== "tournament") return false;
  if (typeof s.seats !== "number" || s.seats < 2 || s.seats > 9) return false;
  if (!s.config || typeof s.config !== "object") return false;
  if (!s.session || typeof s.session !== "object") return false;
  const g = s.game;
  if (!g || typeof g !== "object") return false;
  if (!Array.isArray(g.players) || g.players.length < 2 || g.players.length > 9) {
    return false;
  }
  if (!Array.isArray(g.deck) || !Array.isArray(g.board)) return false;
  const arrLen = (a: unknown, n: number) => Array.isArray(a) && a.length === n;
  if (!arrLen(s.eliminated, s.seats)) return false;
  if (!arrLen(s.tableStacks, s.seats)) return false;
  if (!arrLen(s.finishPlaces, s.seats)) return false;
  if (!arrLen(s.rebuysUsed, s.seats)) return false;
  if (!arrLen(s.tableStats, s.seats)) return false;
  if (!arrLen(s.seatStyles, s.seats - 1)) return false;
  if (!arrLen(s.stacks, g.players.length)) return false;
  if (!Array.isArray(s.seatMap) || s.seatMap.length !== g.players.length) {
    return false;
  }
  if (!Array.isArray(s.streetLog) || !Array.isArray(s.pendingActions)) return false;
  if (!Array.isArray(s.streetStartBoard)) return false;
  return true;
}
