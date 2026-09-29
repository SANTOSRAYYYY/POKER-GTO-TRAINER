/**
 * src/lib/store/notebook.ts — 对手笔记本：AI 对 hero 的长期画像（跨 session 持久化）
 *
 * 背景：gameStore.tableStats 累积各座位（含 hero）的 OpponentStats 对手建模，
 * 但 startTable 换桌即清零——AI 对 hero 的了解不跨桌。本模块把 hero 的画像
 * 持久化到统一设置存储（键 pokergto_hero_notebook，原生 Preferences +
 * localStorage 镜像，见 lib/storage/settings.ts），让 AI 越打越懂 hero：
 *
 * 数据流：
 *   finalizeHand（hero 每手）→ scheduleNotebookSave（防抖 1s 合批）→ 写笔记本
 *   startTable → loadDecayedHeroStats（读笔记本 + 流逝衰减补偿）
 *     → 注入 tableStats[HERO_SEAT]（AI 座位照旧清零）
 *   resumeSession → tableStats 随存档恢复（存档内已含长期画像）
 *     → syncNotebook 原样同步（不重复衰减）
 *   gameStore.resetNotebook / /stats 展示卡 → clearNotebook
 *
 * 衰减补偿（与 adapt.ts 的近因加权同口径）：笔记本计数本身是 λ 衰减后的
 * 「有效计数」。加载时按流逝手数 n 对全部计数乘 λ^n 近似——等价于两次写入
 * 之间又流逝了 n 手且没有新信息，记忆自然变淡。HandRecord 没有全局手数
 * 字段，流逝量用「historyStore 已加载总手数 − 笔记本水位线 handsRecorded」
 * 估算；historyStore 未加载/不可用时无法估算，按原值返回不做衰减（保守：
 * 宁可不忘，也不因估算失真把画像洗掉）。
 *
 * 水位线语义：handsRecorded = max(写入时 historyStore 总手数, 前水位 + 新增
 * 手数)，单调不减。正常路径下笔记本每手随历史同步推进，流逝量 ≈ 0；只有
 * 「历史已落盘但笔记本防抖未来得及写」（结算后 1s 内关页）等情形下流逝量
 * >0，对应轻微遗忘。showdownsSeen 亮牌环形缓冲自带近因性（上限 30 条，
 * 见 adapt.ts），不随 λ 衰减。
 */
import type { OpponentStats } from "@/lib/types";
import {
  DEFAULT_RECENCY_LAMBDA,
  getAdaptRecencyLambda,
  normalizeStats,
} from "@/lib/ai/adapt";
import { useHistoryStore } from "@/lib/store/historyStore";
import { getItemSync, removeItem, setItem } from "@/lib/storage/settings";

/** 笔记本存储键 */
export const NOTEBOOK_STORAGE_KEY = "pokergto_hero_notebook";
/** 笔记本结构版本（结构变更时递增并在校验处拒绝旧本） */
export const NOTEBOOK_VERSION = 1;
/** 每手结算后写笔记本的防抖间隔（合批连续手） */
export const NOTEBOOK_SAVE_DEBOUNCE_MS = 1000;

/** hero 长期画像的持久化结构 */
export interface HeroNotebook {
  version: number;
  /** hero 的 OpponentStats（λ 衰减后的有效计数；showdownsSeen 扩展字段随对象走） */
  stats: OpponentStats;
  /** 写入时刻（Unix 毫秒，展示用） */
  updatedAt: number;
  /** 历史总手数水位线：笔记本统计已吸收到的位置（对照 historyStore 总手数算流逝量） */
  handsRecorded: number;
}

/** vitest 环境下写笔记本改为同步落盘（测试断言无需推进防抖计时器） */
const IS_TEST = typeof process !== "undefined" && !!process.env?.VITEST;

/** 浏览器存储可用性（SSR/单测无 window 时读写全跳过） */
function storageAvailable(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return !!window.localStorage;
  } catch {
    return false;
  }
}

/** historyStore 已加载的历史总手数（未加载/不可用返回 null） */
function historyTotalHands(): number | null {
  try {
    const hs = useHistoryStore.getState();
    return hs.loaded ? hs.hands.length : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 衰减补偿（纯函数）
// ---------------------------------------------------------------------------

/**
 * 计数衰减（纯函数）：全部有效计数乘 λ^elapsedHands（含位置分桶），与
 * updateStats 每手乘 λ 的近因加权同口径——等价于流逝 n 手且无新信息。
 * λ 钳制 [0.5, 1]（与 updateStats/setAdaptRecencyLambda 一致）；
 * elapsedHands 负值按 0 计（水位线高于总手数，如历史被清空后）。
 * elapsedHands=0 或 λ=1 时原样返回（引用不变）。
 * 旧对象缺分桶字段时先归一化（normalizeStats）；showdownsSeen 环形缓冲
 * 自带近因性不衰减，随展开原引用前滚。
 */
export function decayStats(
  stats: OpponentStats,
  elapsedHands: number,
  lambda: number,
): OpponentStats {
  const n = Math.max(0, elapsedHands);
  const lam = Number.isFinite(lambda)
    ? Math.min(1, Math.max(0.5, lambda))
    : DEFAULT_RECENCY_LAMBDA;
  if (n === 0 || lam === 1) return stats;
  const f = Math.pow(lam, n);
  const s = normalizeStats(stats);
  return {
    ...s,
    hands: s.hands * f,
    vpipHands: s.vpipHands * f,
    pfrHands: s.pfrHands * f,
    postflopAggressive: s.postflopAggressive * f,
    postflopPassive: s.postflopPassive * f,
    showdowns: s.showdowns * f,
    showdownsSeenFlop: s.showdownsSeenFlop * f,
    pfBucketHands: {
      early: s.pfBucketHands.early * f,
      middle: s.pfBucketHands.middle * f,
      late: s.pfBucketHands.late * f,
    },
    pfBucketVpip: {
      early: s.pfBucketVpip.early * f,
      middle: s.pfBucketVpip.middle * f,
      late: s.pfBucketVpip.late * f,
    },
    pfBucketPfr: {
      early: s.pfBucketPfr.early * f,
      middle: s.pfBucketPfr.middle * f,
      late: s.pfBucketPfr.late * f,
    },
  };
}

// ---------------------------------------------------------------------------
// 读写统一设置存储（原生 Preferences + localStorage 镜像）
// ---------------------------------------------------------------------------

/** 笔记本结构校验（版本 + 关键字段形状；缺分桶字段由 normalizeStats 补齐） */
function isHeroNotebook(x: unknown): x is HeroNotebook {
  if (!x || typeof x !== "object") return false;
  const n = x as Partial<HeroNotebook>;
  if (n.version !== NOTEBOOK_VERSION) return false;
  if (typeof n.updatedAt !== "number" || typeof n.handsRecorded !== "number") {
    return false;
  }
  const s = n.stats;
  if (!s || typeof s !== "object") return false;
  return (
    typeof s.hands === "number" &&
    typeof s.vpipHands === "number" &&
    typeof s.pfrHands === "number" &&
    typeof s.postflopAggressive === "number" &&
    typeof s.postflopPassive === "number" &&
    typeof s.showdowns === "number" &&
    typeof s.showdownsSeenFlop === "number"
  );
}

/** 读取笔记本；无存档或损坏/版本不符时清除坏档并返回 null（分桶字段归一化） */
export function loadNotebook(): HeroNotebook | null {
  if (!storageAvailable()) return null;
  let raw: string | null;
  try {
    raw = getItemSync(NOTEBOOK_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isHeroNotebook(parsed)) {
      throw new Error("[notebook] 笔记本结构校验失败");
    }
    return { ...parsed, stats: normalizeStats(parsed.stats) };
  } catch (err) {
    console.error("[notebook] 笔记本不可用，已清除:", err);
    void removeItem(NOTEBOOK_STORAGE_KEY);
    return null;
  }
}

/** 写入笔记本（无浏览器存储/配额超限时静默跳过，不阻断牌局） */
export function saveNotebook(notebook: HeroNotebook): void {
  if (!storageAvailable()) return;
  // 同步更新镜像 + 内存缓存，原生异步落 Preferences
  void setItem(NOTEBOOK_STORAGE_KEY, JSON.stringify(notebook));
}

/** 删除笔记本（resetNotebook / /stats 清空按钮） */
export function clearNotebook(): void {
  if (!storageAvailable()) return;
  void removeItem(NOTEBOOK_STORAGE_KEY);
}

/**
 * 以水位线口径写入 hero 最新画像：
 * handsRecorded = max(当前 historyStore 总手数, 前水位 + 新增手数)，单调不减。
 * 旧会话（功能上线前的存档）首次同步时水位直接抬到历史总手数，避免把
 * 「历史全部手数」误算成流逝量把画像洗空。
 */
function writeNotebook(stats: OpponentStats, newlyAbsorbed: number): void {
  const prevMark = loadNotebook()?.handsRecorded ?? 0;
  const total = historyTotalHands();
  const handsRecorded = Math.max(total ?? 0, prevMark + newlyAbsorbed);
  saveNotebook({
    version: NOTEBOOK_VERSION,
    stats,
    updatedAt: Date.now(),
    handsRecorded,
  });
}

// ---------------------------------------------------------------------------
// 对外接线口（gameStore 调用）
// ---------------------------------------------------------------------------

/**
 * 加载 hero 长期画像（startTable 注入用）：读笔记本并按流逝手数做衰减补偿。
 * 无笔记本返回 null（调用方按零统计开局）。
 * historyStore 未加载时无法估算流逝量：按原值返回，不做衰减补偿。
 */
export function loadDecayedHeroStats(
  lambda: number = getAdaptRecencyLambda(),
): OpponentStats | null {
  const nb = loadNotebook();
  if (!nb) return null;
  const total = historyTotalHands();
  if (total === null) return nb.stats;
  return decayStats(nb.stats, total - nb.handsRecorded, lambda);
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingHands = 0;

/**
 * hero 每手结算后同步写笔记本（gameStore.finalizeHand 调用）：
 * 防抖 1s 合批连续手（pendingHands 记录合批内吸收的手数）；
 * 测试环境同步落盘（断言无需推进计时器）。
 */
export function scheduleNotebookSave(stats: OpponentStats): void {
  pendingHands += 1;
  if (IS_TEST) {
    writeNotebook(stats, pendingHands);
    pendingHands = 0;
    return;
  }
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeNotebook(stats, pendingHands);
    pendingHands = 0;
  }, NOTEBOOK_SAVE_DEBOUNCE_MS);
}

/**
 * 把 tableStats 中的 hero 画像原样同步进笔记本（resumeSession 用）：
 * 存档内 hero 统计已是长期画像，不吸收新手数（newlyAbsorbed=0）、
 * 不做衰减补偿（防「存档衰减一次 + 笔记本再衰减一次」的双重衰减）。
 */
export function syncNotebook(stats: OpponentStats): void {
  writeNotebook(stats, 0);
}
