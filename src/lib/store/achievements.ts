/**
 * src/lib/store/achievements.ts — WSOP 金手链成就系统（纯本地）
 *
 * - checkAchievements(hands)：纯函数，输入 HandRecord 流（顺序不限，内部按
 *   时间升序重排），返回当前已满足条件的成就列表；判定口径见各条目注释。
 * - useAchievements：zustand 包装，负责 localStorage 持久化（键
 *   pokergto_achievements，值 = { 成就id: 解锁时间戳ms }）、与已解锁集合
 *   diff 出「新解锁」成就并推入 pending 队列供 AchievementToast 展示。
 * - 触发时机：页面侧在加载手牌后调用 checkNow（当前挂在 Nav 上，限定
 *   /stats 与 /history 路径，等价于“addHand 后由页面侧触发”的落地形态）。
 *
 * 「单场盈利 500bb」的场次界定：HandRecord 流没有显式场次边界，采用时间
 * 间隔切分——相邻两手间隔 ≤ 30 分钟视为同一 session；任一场次的归一化
 * 盈亏（Σ profit/bigBlind，兼容锦标赛升盲）≥ 500bb 即解锁。
 */
import { create } from "zustand";
import type { ConcreteAIStyle, HandRecord } from "@/lib/types";
import { isTournamentHand } from "@/components/history/labels";

/** 已解锁记录的 localStorage 键 */
export const ACHIEVEMENTS_KEY = "pokergto_achievements";

/** 场次切分间隔：相邻两手间隔超过 30 分钟视为新的一场 */
export const SESSION_GAP_MS = 30 * 60 * 1000;

export type AchievementId =
  | "first_win"
  | "first_title"
  | "nine_max_title"
  | "session_500bb"
  | "hands_1000"
  | "profit_10000bb"
  | "cash_streak_5"
  | "revenge";

export interface Achievement {
  id: AchievementId;
  name: string;
  description: string;
}

export const ACHIEVEMENTS: readonly Achievement[] = [
  { id: "first_win", name: "首胜", description: "赢下你的第一手牌" },
  { id: "first_title", name: "初次夺冠", description: "赢得任意一场锦标赛（SNG）冠军" },
  { id: "nine_max_title", name: "九人桌之王", description: "在 9 人桌锦标赛中夺冠" },
  { id: "session_500bb", name: "单场暴击", description: "单场（30 分钟间隔界定）累计盈利达到 500bb" },
  { id: "hands_1000", name: "千手磨砺", description: "累计打满 1000 手牌" },
  { id: "profit_10000bb", name: "万 bb 俱乐部", description: "累计盈利达到 10000bb（按各手大盲归一化）" },
  { id: "cash_streak_5", name: "现金局五连盈", description: "现金局连续 5 手盈利（平局不计入）" },
  { id: "revenge", name: "复仇", description: "输给某种风格的对手后，下次遇到该风格时赢回来" },
];

// ---------------------------------------------------------------------------
// 判定辅助（纯函数，导出供测试与潜在的 UI 展示）
// ---------------------------------------------------------------------------

/** 按时间升序排序（返回新数组） */
function byTimeAsc(hands: HandRecord[]): HandRecord[] {
  return [...hands].sort((a, b) => a.timestamp - b.timestamp);
}

/** hero 本手的归一化盈亏（bb）；bigBlind 非法时按 0 计 */
function profitInBb(h: HandRecord): number {
  return h.bigBlind > 0 ? h.profit / h.bigBlind : 0;
}

/** hero 在锦标赛中的最终名次（非锦标赛/未出局为 null） */
function heroFinishPlace(h: HandRecord): number | null {
  return h.players.find((p) => p.isHero)?.finishPlace ?? null;
}

/**
 * 按 30 分钟间隔把 HandRecord 流切成场次，返回每场 hero 的归一化盈亏（bb）。
 * 输入顺序不限。
 */
export function sessionProfitsBb(hands: HandRecord[]): number[] {
  const sorted = byTimeAsc(hands);
  const sessions: number[] = [];
  let cur = 0;
  let prevTs: number | null = null;
  for (const h of sorted) {
    if (prevTs !== null && h.timestamp - prevTs > SESSION_GAP_MS) {
      sessions.push(cur);
      cur = 0;
    }
    cur += profitInBb(h);
    prevTs = h.timestamp;
  }
  if (sorted.length > 0) sessions.push(cur);
  return sessions;
}

/** 现金局（非锦标赛手）按时间序的最长连续盈利手数（profit > 0 计盈，平局/亏损断连） */
export function maxCashWinStreak(hands: HandRecord[]): number {
  let best = 0;
  let cur = 0;
  for (const h of byTimeAsc(hands)) {
    if (isTournamentHand(h)) continue; // 锦标赛手既不计入也不断连
    if (h.profit > 0) {
      cur += 1;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}

/**
 * 复仇判定：对每种 AI 风格维护「记仇」状态——hero 在有该风格在座的手牌中
 * 落败（result === "lose"）即记仇；之后第一手再遇该风格且获胜（"win"）即复仇成功。
 * 返回是否至少完成一次复仇。
 */
export function hasRevenge(hands: HandRecord[]): boolean {
  const grudge = new Set<ConcreteAIStyle>();
  for (const h of byTimeAsc(hands)) {
    const styles = new Set<ConcreteAIStyle>();
    for (const p of h.players) {
      if (!p.isHero && p.aiStyle) styles.add(p.aiStyle);
    }
    if (h.result === "lose") {
      for (const s of styles) grudge.add(s);
    } else if (h.result === "win") {
      for (const s of styles) {
        if (grudge.has(s)) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 判定入口
// ---------------------------------------------------------------------------

const CHECKS: Record<AchievementId, (sorted: HandRecord[]) => boolean> = {
  first_win: (hs) => hs.some((h) => h.result === "win"),
  first_title: (hs) =>
    hs.some((h) => isTournamentHand(h) && heroFinishPlace(h) === 1),
  nine_max_title: (hs) =>
    hs.some(
      (h) =>
        h.players.length === 9 &&
        isTournamentHand(h) &&
        heroFinishPlace(h) === 1,
    ),
  session_500bb: (hs) => sessionProfitsBb(hs).some((bb) => bb >= 500),
  hands_1000: (hs) => hs.length >= 1000,
  profit_10000bb: (hs) => hs.reduce((sum, h) => sum + profitInBb(h), 0) >= 10000,
  cash_streak_5: (hs) => maxCashWinStreak(hs) >= 5,
  revenge: (hs) => hasRevenge(hs),
};

/**
 * 纯函数：输入全部历史手牌（顺序不限），返回当前满足条件的成就列表
 * （按 ACHIEVEMENTS 定义顺序）。
 */
export function checkAchievements(hands: HandRecord[]): Achievement[] {
  const sorted = byTimeAsc(hands);
  return ACHIEVEMENTS.filter((a) => CHECKS[a.id](sorted));
}

// ---------------------------------------------------------------------------
// localStorage 持久化 + zustand 包装
// ---------------------------------------------------------------------------

/** 成就 id → 解锁时间戳（Unix ms） */
export type UnlockedMap = Partial<Record<AchievementId, number>>;

/** 读取已解锁集合；无窗口环境/脏数据返回 {} */
export function loadUnlocked(): UnlockedMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(ACHIEVEMENTS_KEY);
    if (!raw) return {};
    const obj: unknown = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return {};
    const out: UnlockedMap = {};
    for (const a of ACHIEVEMENTS) {
      const v = (obj as Record<string, unknown>)[a.id];
      if (typeof v === "number" && Number.isFinite(v)) out[a.id] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveUnlocked(map: UnlockedMap): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify(map));
  } catch {
    /* 隐私模式/配额满：本次解锁只留在内存 */
  }
}

export interface AchievementsStore {
  /** 已解锁集合（id → 解锁时间） */
  unlocked: UnlockedMap;
  /** 新解锁待 toast 展示的队列 */
  pending: Achievement[];
  /** 是否已从 localStorage 完成首次加载 */
  loaded: boolean;
  /** 从 localStorage 加载已解锁集合 */
  load: () => void;
  /**
   * 用全部历史手牌做检查：与已解锁集合 diff，新解锁的写入 localStorage
   * 并推入 pending 队列；返回本次新解锁的成就（无则空数组）。
   */
  checkNow: (hands: HandRecord[]) => Achievement[];
  /** 从 toast 队列移除一条 */
  dismissToast: (id: AchievementId) => void;
}

export const useAchievements = create<AchievementsStore>((set, get) => ({
  unlocked: {},
  pending: [],
  loaded: false,

  load: () => {
    set({ unlocked: loadUnlocked(), loaded: true });
  },

  checkNow: (hands) => {
    if (!get().loaded) get().load();
    const satisfied = checkAchievements(hands);
    const now = Date.now();
    const current = get().unlocked;
    const fresh: Achievement[] = [];
    const next: UnlockedMap = { ...current };
    for (const a of satisfied) {
      if (next[a.id] === undefined) {
        next[a.id] = now;
        fresh.push(a);
      }
    }
    if (fresh.length > 0) {
      saveUnlocked(next);
      set((s) => ({ unlocked: next, pending: [...s.pending, ...fresh] }));
    }
    return fresh;
  },

  dismissToast: (id) => {
    set((s) => ({ pending: s.pending.filter((p) => p.id !== id) }));
  },
}));
