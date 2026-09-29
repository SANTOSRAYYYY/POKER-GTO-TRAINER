/**
 * 手牌历史 store（zustand + idb 持久化）
 *
 * 持久化：IndexedDB，库名 "pokergto"：
 * - 表 "hands"：主键 HandRecord.id，存完整手牌记录。
 * - 表 "analyses"：主键 handId，缓存 LLM 分析结果，避免重复调用。
 *
 * 内存中的 hands 按时间倒序（最新在前）。
 *
 * 说明：addHand/clear 为 Phase 1 空壳定义的原始签名，保留作别名；
 * 新代码请优先使用 saveHand/clearAll。
 */
import { create } from "zustand";
import { openDB, type IDBPDatabase } from "idb";
import type {
  AnalysisResult,
  Card,
  ChatMessage,
  ConcreteAIStyle,
  HandRecord,
  LLMConfig,
  Seat,
  SeatAction,
  SessionReport,
  Street,
  StreetRating,
} from "@/lib/types";
import { chatCompletion } from "@/lib/llm/client";
import { equityMulti } from "@/lib/poker/equity";
import { handReferenceLines } from "@/lib/gto/reference";
import { withRunoutStreets } from "@/lib/store/runout";
import { isTournamentHand, seatPosition, seatPositionCn, STYLE_NAME } from "@/components/history/labels";
import { summarizeHand } from "@/lib/ai/recentHands";
import { computeHeroHud } from "@/lib/ai/hudStats";
import { getStoredLang, type Lang } from "@/lib/i18n/lang";

const DB_NAME = "pokergto";
const DB_VERSION = 1;

interface AnalysisEntry {
  handId: string;
  result: AnalysisResult;
  createdAt: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("当前环境不支持 IndexedDB"));
  }
  if (!dbPromise) {
    const p = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("hands")) {
          db.createObjectStore("hands", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("analyses")) {
          db.createObjectStore("analyses", { keyPath: "handId" });
        }
      },
    });
    dbPromise = p;
    // 打开失败（配额满/隐私模式瞬态）不缓存 rejected promise：
    // 清掉缓存让下次调用重新尝试，避免一次失败瘫痪整个会话
    p.catch(() => {
      if (dbPromise === p) dbPromise = null;
    });
  }
  return dbPromise;
}

/**
 * 读入侧校验：IDB 数据可能被 DevTools/扩展/半截事务污染，
 * 缺 players/streets/finalBoard（或不是数组）的记录不能让整页渲染崩溃——
 * 跳过并 console.warn（仿 normalizeSessionReport 的宽容先例）。
 */
export function isValidHandRecord(x: unknown): x is HandRecord {
  if (!x || typeof x !== "object") return false;
  const h = x as Partial<HandRecord>;
  return (
    typeof h.id === "string" &&
    Array.isArray(h.players) &&
    Array.isArray(h.streets) &&
    Array.isArray(h.finalBoard)
  );
}

/** 过滤损坏记录（跳过 + warn），返回合法记录；输入不合法时原样计数告警 */
function filterValidHands(raw: unknown[]): HandRecord[] {
  const out: HandRecord[] = [];
  for (const r of raw) {
    if (isValidHandRecord(r)) {
      out.push(r);
    } else {
      console.warn(
        "[historyStore] 跳过损坏的手牌记录（缺 players/streets/finalBoard）:",
        (r as { id?: unknown })?.id ?? r,
      );
    }
  }
  return out;
}

function sortDesc(hands: HandRecord[]): HandRecord[] {
  return [...hands].sort((a, b) => b.timestamp - a.timestamp);
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

export interface HistoryStats {
  /** 总手数 */
  totalHands: number;
  /** 总盈亏（hero 视角筹码） */
  totalProfit: number;
  /** 胜率 0-1（平局按 0.5 计） */
  winRate: number;
  /** 摊牌率 0-1 */
  showdownRate: number;
}

export function computeStats(hands: HandRecord[]): HistoryStats {
  const totalHands = hands.length;
  if (totalHands === 0) {
    return { totalHands: 0, totalProfit: 0, winRate: 0, showdownRate: 0 };
  }
  let totalProfit = 0;
  let winScore = 0;
  let showdowns = 0;
  for (const h of hands) {
    totalProfit += h.profit;
    if (h.result === "win") winScore += 1;
    else if (h.result === "tie") winScore += 0.5;
    if (h.showdown) showdowns += 1;
  }
  return {
    totalHands,
    totalProfit,
    winRate: winScore / totalHands,
    showdownRate: showdowns / totalHands,
  };
}

// ---------------------------------------------------------------------------
// 分析 prompt 构造与解析
// ---------------------------------------------------------------------------

const STREET_LABEL: Record<Street, string> = {
  preflop: "翻前",
  flop: "翻牌",
  turn: "转牌",
  river: "河牌",
  showdown: "摊牌",
};

/** 行动者称呼：hero 显示“你”，AI 显示座位号与风格 */
function actorLabel(hand: HandRecord, seat: Seat): string {
  const p = hand.players.find((pl) => pl.seat === seat);
  if (!p) return `座位${seat}`;
  if (p.isHero) return `你（座位${seat}）`;
  const style = p.aiStyle ? `，风格：${STYLE_NAME[p.aiStyle]}` : "";
  return `座位${seat}（AI${style}）`;
}

function actionToText(sa: SeatAction, hand: HandRecord): string {
  const who = actorLabel(hand, sa.seat);
  const { type, amount } = sa.action;
  switch (type) {
    case "fold":
      return `${who} 弃牌`;
    case "check":
      return `${who} 过牌`;
    case "call":
      return `${who} 跟注 ${amount}`;
    case "bet":
      return `${who} 下注到 ${amount}`;
    case "raise":
      return `${who} 加注到 ${amount}`;
    case "allin":
      return `${who} 全下（本街累计 ${amount}）`;
  }
}

function cardsText(cards: Card[] | null | undefined): string {
  if (!cards || cards.length === 0) return "无";
  return cards.join(" ");
}

/** 把 HandRecord 渲染成供 LLM 复盘的中文文本（2-9 人桌通用） */
export function renderHandForPrompt(hand: HandRecord): string {
  const n = hand.players.length;
  const tournament = isTournamentHand(hand);
  const lines: string[] = [];
  lines.push(`牌桌：${n} 人桌 · ${tournament ? "锦标赛（SNG）" : "现金局"}`);
  lines.push(
    `盲注：小盲 ${hand.smallBlind} / 大盲 ${hand.bigBlind}${hand.ante > 0 ? `，前注每人 ${hand.ante}` : "，无前注"}`,
  );
  lines.push(`按钮位：座位 ${hand.buttonSeat}`);
  const heroPos = seatPosition(hand.heroSeat, hand.buttonSeat, n);
  lines.push(`你的座位：座位 ${hand.heroSeat}${heroPos ? `（${heroPos}）` : ""}`);
  lines.push("玩家列表：");
  for (const p of hand.players) {
    const pos = seatPositionCn(p.seat, hand.buttonSeat, n);
    const parts: string[] = [`座位 ${p.seat}`];
    if (pos) parts.push(pos);
    if (p.isHero) {
      parts.push("你（人类玩家）");
      parts.push(`底牌 ${cardsText(p.cards)}`);
    } else {
      parts.push(`AI${p.aiStyle ? `（风格：${STYLE_NAME[p.aiStyle]}）` : ""}`);
      parts.push(`底牌 ${p.cards ? cardsText(p.cards) : "未知（未摊牌）"}`);
    }
    parts.push(`净盈亏 ${p.profit >= 0 ? "+" : ""}${p.profit}`);
    if (p.finishPlace != null) parts.push(`锦标赛最终第 ${p.finishPlace} 名`);
    lines.push(`- ${parts.join("，")}`);
  }
  lines.push(`最终公共牌：${cardsText(hand.finalBoard)}`);
  const resultText =
    hand.result === "win" ? "你赢" : hand.result === "lose" ? "你输" : "平局";
  lines.push(
    `结果：${resultText}，你的净盈亏 ${hand.profit >= 0 ? "+" : ""}${hand.profit}，${hand.showdown ? "进入摊牌" : "未摊牌"}`,
  );
  lines.push("");
  lines.push("逐街动作序列（按发生顺序）：");
  for (const st of hand.streets) {
    if (st.street === "showdown") continue;
    lines.push(`【${STREET_LABEL[st.street]}】公共牌：${cardsText(st.board)}`);
    if (st.actions.length === 0) {
      // 空动作街 = 双方全下后引擎跑马发出的街（不可能有动作），如实标注
      lines.push("  （无动作——双方已全下，跑马发牌）");
    } else {
      for (const a of st.actions) {
        lines.push(`  - ${actionToText(a, hand)}`);
      }
    }
  }
  lines.push("");
  lines.push(
    "请复盘我（hero）的每个关键决策；若某条街是三人及以上的多人底池，请额外点评多人底池动态（胜率被稀释、继续范围应更紧、位置与尚未行动者的影响）。",
  );
  return lines.join("\n");
}

/**
 * 计算逐街客观胜率注入文本（coachlab 验证：data 变体 = slim 骨架 + 实算胜率，
 * 复盘质量显著优于说教版 full 与裸 slim）。口径：对随机对手（hero 底牌 + 该街公共牌，
 * 对手数 = 该街仍未弃牌的人数）。任何异常（数据不全等）静默跳过，不阻塞复盘。
 */
function handEquityLines(hand: HandRecord): string[] {
  const hero = hand.players.find((p) => p.isHero);
  if (!hero?.cards || hero.cards.length !== 2) return [];
  const lines: string[] = [];
  const folded = new Set<number>();
  const streetLabel: Record<string, string> = { flop: "翻牌圈", turn: "转牌圈", river: "河牌圈" };
  for (const st of hand.streets) {
    if (st.street === "preflop" || st.street === "showdown") {
      // 翻前无公共牌不算胜率；但仍要累计翻前的弃牌者
      for (const a of st.actions) if (a.action.type === "fold") folded.add(a.seat);
      continue;
    }
    const label = streetLabel[st.street];
    if (!label) continue;
    if (folded.has(hand.heroSeat)) break; // hero 已弃牌，后续街无决策可点评
    const activeOpps = hand.players.length - 1 - [...folded].filter((s) => s !== hand.heroSeat).length;
    if (activeOpps < 1) break;
    try {
      const eq = equityMulti(hero.cards, st.board, activeOpps, 2000);
      lines.push(
        `- ${label}（公共牌 ${cardsText(st.board)}）：你当时的实算胜率约 ${(eq.win * 100).toFixed(1)}%（对 ${activeOpps} 名对手）`,
      );
    } catch {
      break;
    }
    for (const a of st.actions) if (a.action.type === "fold") folded.add(a.seat);
  }
  return lines;
}

/**
 * 组装单手复盘的 user prompt（纯函数，便于 vitest 直测）：
 * renderHandForPrompt 文本 + 街级实算胜率 + 决策点级参考数据
 * （handReferenceLines：每个 hero 决策点一行的参考线，见 gto/reference.ts）。
 */
export function buildAnalysisUserPrompt(hand: HandRecord): string {
  const eqLines = handEquityLines(hand);
  const eqSection =
    eqLines.length > 0
      ? `\n\n客观胜率数据（实算，供分析参考）：\n${eqLines.join("\n")}`
      : "";
  const refLines = handReferenceLines(hand);
  const refSection =
    refLines.length > 0
      ? `\n\n决策点参考数据（你每个决策点的引擎参考线；启发式简化，非 solver 精确解）：\n${refLines.join("\n")}`
      : "";
  return `以下是这手牌的完整记录，请按系统要求的 JSON 格式输出复盘分析：\n\n${renderHandForPrompt(hand)}${eqSection}${refSection}`;
}

export const ANALYSIS_SYSTEM_PROMPT = `你是职业德州扑克教练。复盘学员（"你"）这手牌的关键决策：指出对错、给出正确打法与理由；若提供了胜率数据，请结合数据分析（这是实算的客观数据，可信）。若某条街是三人及以上多人底池，简要点评多人动态。

若提供了「决策点参考数据」：点评时优先逐条对照每个决策点的参考数据——与参考倾向一致的决策给予肯定并说明为什么对；偏离参考倾向的明确指出，并按「胜率差 × 当时底池」粗估该偏离长期重复的筹码代价（例如"胜率差约 10%，底池 200，每次约亏 20"）。参考数据由实算胜率驱动，是启发式参考线而非 solver 精确解，其胜率与赔率数值可直接引用。

严格要求：
1. 只输出一个严格的 JSON 对象，不要输出 markdown 代码块，不要输出任何其他文字。
2. JSON 格式如下：
{
  "streets": [
    { "street": "preflop", "rating": "good", "comments": ["……", "……"] }
  ],
  "overall": "总体评价（2-4 句话）",
  "score": 75
}
3. "street" 只能取 "preflop" | "flop" | "turn" | "river"，只点评实际进行到的街道，每条街道一条。
4. "rating" 只能取 "good"（打得好）| "ok"（可接受）| "mistake"（明显错误）。
5. "score" 为 0-100 的整数综合评分（越高代表学员这手牌打得越好）。
6. 简洁硬约束：每条 comment 不超过 120 字，overall 不超过 200 字——宁可少说也要保证 JSON 完整收尾，绝对不要让输出被截断。`;

/**
 * ANALYSIS_SYSTEM_PROMPT 的英文版（UI 语言为英文时使用）：结构与约束逐条对应，
 * 额外要求 JSON 内的点评文本用英文输出（手牌数据本身仍以中文事实呈现，模型可理解）。
 */
export const ANALYSIS_SYSTEM_PROMPT_EN = `You are a professional Texas Hold'em coach. Review the student's (referred to as "you") key decisions in this hand: point out what was right or wrong, give the correct line and why; if equity data is provided, incorporate it into your analysis (it is objectively computed and trustworthy). If any street is a multiway pot (three or more players), briefly comment on the multiway dynamics.

If "decision-point reference data" is provided: go through each decision point against its reference line first — affirm decisions that agree with the reference tendency and explain why they are right; clearly call out deviations, and roughly estimate the long-run chip cost of repeating each deviation as "equity gap × pot at the time" (e.g. "equity gap ≈10%, pot 200, ≈20 chips lost each time"). The reference data is driven by real computed equity — a heuristic reference line, not an exact solver solution — and its equity and odds figures may be quoted directly.

Strict requirements:
1. Output a single strict JSON object only — no markdown code blocks, no other text.
2. The JSON format is:
{
  "streets": [
    { "street": "preflop", "rating": "good", "comments": ["……", "……"] }
  ],
  "overall": "overall assessment (2-4 sentences)",
  "score": 75
}
3. "street" must be one of "preflop" | "flop" | "turn" | "river"; cover only the streets actually played, one entry per street.
4. "rating" must be one of "good" (well played) | "ok" (acceptable) | "mistake" (clear error).
5. "score" is an integer from 0 to 100 (higher means the student played this hand better).
6. Brevity hard constraints: each comment at most 120 characters, overall at most 200 characters — say less rather than risk an incomplete JSON; never let the output be truncated.
7. Output JSON with English text: every comment and the overall assessment must be written in English.`;

/** 按 UI 语言选择单手复盘 system prompt（zh 为默认，en 用英文版） */
export function analysisSystemPromptFor(lang: Lang): string {
  return lang === "en" ? ANALYSIS_SYSTEM_PROMPT_EN : ANALYSIS_SYSTEM_PROMPT;
}

const VALID_STREETS = new Set<Street>(["preflop", "flop", "turn", "river"]);
const VALID_RATINGS = new Set<StreetRating>(["good", "ok", "mistake"]);

/** 容错解析 LLM 输出为 AnalysisResult；失败时抛错（调用方可提示重试） */
export function parseAnalysisResult(text: string): AnalysisResult {
  let t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  if (start < 0) {
    throw new Error("分析结果解析失败：LLM 未返回 JSON");
  }
  // 从最后的 "}" 开始逐个向前尝试：容忍 JSON 之后跟了含 "}" 的前言后语
  let raw: unknown;
  let parsed = false;
  let end = t.lastIndexOf("}");
  while (!parsed && end > start) {
    try {
      raw = JSON.parse(t.slice(start, end + 1));
      parsed = true;
    } catch {
      end = t.lastIndexOf("}", end - 1);
    }
  }
  if (!parsed) {
    throw new Error("分析结果解析失败：JSON 格式错误，请重试");
  }
  const obj = raw as Partial<AnalysisResult>;
  const streets: AnalysisResult["streets"] = [];
  if (Array.isArray(obj.streets)) {
    for (const s of obj.streets) {
      if (!s || typeof s !== "object") continue;
      const st = s as { street?: unknown; rating?: unknown; comments?: unknown };
      const streetName =
        typeof st.street === "string" ? st.street.toLowerCase() : st.street;
      if (!VALID_STREETS.has(streetName as Street)) continue;
      const ratingRaw =
        typeof st.rating === "string" ? st.rating.toLowerCase() : st.rating;
      const rating = VALID_RATINGS.has(ratingRaw as StreetRating)
        ? (ratingRaw as StreetRating)
        : "ok";
      // comments 容忍单字符串（模型偶尔不包数组），并过滤空项
      const comments = Array.isArray(st.comments)
        ? st.comments.filter((c): c is string => typeof c === "string" && c.length > 0)
        : typeof st.comments === "string" && st.comments.length > 0
          ? [st.comments]
          : [];
      streets.push({ street: streetName as Street, rating, comments });
    }
  }
  const overall = typeof obj.overall === "string" && obj.overall.length > 0 ? obj.overall : "（无总体评价）";
  // score 容忍数字字符串（"85"），缺失/非法时默认 50
  const scoreField: unknown = (obj as { score?: unknown }).score;
  const scoreRaw =
    typeof scoreField === "string" && scoreField.trim() !== "" ? Number(scoreField) : scoreField;
  const scoreNum = typeof scoreRaw === "number" && Number.isFinite(scoreRaw) ? scoreRaw : 50;
  const score = Math.max(0, Math.min(100, Math.round(scoreNum)));
  return { streets, overall, score };
}

// ---------------------------------------------------------------------------
// 分析调用的自动重试
// ---------------------------------------------------------------------------

/** 重试时追加的 user 提示：要求模型严格只输出 JSON */
export const ANALYSIS_RETRY_HINT =
  "上次输出无法被解析或请求失败，请务必只输出一个严格合法的 JSON 对象，不要输出任何其他文字、不要用 markdown 代码块包裹";

/** 单次 LLM 调用的抽象：注入实现（生产为 chatCompletion，测试为 mock），便于 vitest 单测 */
export type LLMCaller = (messages: ChatMessage[]) => Promise<string>;

export interface AnalyzeOutcome {
  result: AnalysisResult;
  /** true = 第一次失败、第二次才成功（store 层语义，UI 可用可不用） */
  retried: boolean;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 带一次自动重试的复盘分析调用（纯函数，不依赖 store/IDB）。
 *
 * 第一次失败（网络错误、超时、输出无法解析均算）后，在 messages 尾部追加
 * ANALYSIS_RETRY_HINT 再试一次；第二次仍失败则抛出合并错误，
 * 包含两次失败各自的原因，方便用户定位是网络问题还是模型不按格式输出。
 */
export async function analyzeWithRetry(
  messages: ChatMessage[],
  callLLM: LLMCaller,
): Promise<AnalyzeOutcome> {
  try {
    const content = await callLLM(messages);
    return { result: parseAnalysisResult(content), retried: false };
  } catch (firstErr) {
    const retryMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content: ANALYSIS_RETRY_HINT },
    ];
    try {
      const content = await callLLM(retryMessages);
      return { result: parseAnalysisResult(content), retried: true };
    } catch (secondErr) {
      throw new Error(
        `AI 教练分析失败（已自动重试 1 次仍失败）。\n` +
          `第一次失败原因：${errMessage(firstErr)}\n` +
          `第二次失败原因：${errMessage(secondErr)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface HistoryStore {
  /** 已加载的历史记录（时间倒序） */
  hands: HandRecord[];
  /** 是否已从 IndexedDB 完成首次加载（含失败终态——失败时 loadError 非空） */
  loaded: boolean;
  /** 首次加载失败的错误文案（IndexedDB 不可用/隐私模式等）；正常为 null */
  loadError: string | null;
  /** 已缓存的分析结果（key = HandRecord.id） */
  analyses: Record<string, AnalysisResult>;

  /** 从 IndexedDB 加载全部记录与分析缓存到内存 */
  loadAll: () => Promise<void>;
  /** 保存一条记录（内存 + IndexedDB；同 id 覆盖） */
  saveHand: (record: HandRecord) => Promise<void>;
  /** addHand 为 saveHand 的别名（Phase 1 原始签名） */
  addHand: (hand: HandRecord) => Promise<void>;
  /** 返回全部记录（时间倒序）；会刷新内存缓存 */
  listHands: () => Promise<HandRecord[]>;
  /** 按 id 取单条记录（内存优先，未命中查 IndexedDB） */
  getHand: (id: string) => Promise<HandRecord | null>;
  /** 删除一条记录（连同其分析缓存） */
  deleteHand: (id: string) => Promise<void>;
  /** 清空全部历史与分析缓存（内存 + IndexedDB） */
  clearAll: () => Promise<void>;
  /** clear 为 clearAll 的别名（Phase 1 原始签名） */
  clear: () => Promise<void>;
  /** 读取已缓存的分析结果（无缓存返回 null，不调用 LLM） */
  getAnalysis: (id: string) => Promise<AnalysisResult | null>;
  /**
   * 调用 LLM 分析指定手牌，结果缓存到 IndexedDB。
   * 第一次调用失败（网络/超时/输出无法解析）会自动追加严格 JSON 提示重试一次；
   * 第二次仍失败才抛出合并错误（含两次失败各自原因）。
   * @throws Error config.apiKey 为空时抛出"请先在设置页配置"的友好错误。
   */
  analyzeHand: (id: string, config: LLMConfig) => Promise<AnalysisResult>;
  /** 基于内存中已加载的 hands 计算统计（需先 loadAll） */
  stats: () => HistoryStats;
}

export const useHistoryStore = create<HistoryStore>((set, get) => ({
  hands: [],
  loaded: false,
  loadError: null,
  analyses: {},

  loadAll: async () => {
    try {
      const db = await getDB();
      const [rawHands, analyses] = await Promise.all([
        db.getAll("hands") as Promise<unknown[]>,
        db.getAll("analyses") as Promise<AnalysisEntry[]>,
      ]);
      const analysisMap: Record<string, AnalysisResult> = {};
      for (const a of analyses) analysisMap[a.handId] = a.result;
      set({
        hands: sortDesc(filterValidHands(rawHands)),
        analyses: analysisMap,
        loaded: true,
        loadError: null,
      });
    } catch (err) {
      // IndexedDB 不可用（隐私模式/被禁用/配额满）：给页面一个可展示的错误
      // 终态（loaded: true + loadError），不再永久停在「加载中…」
      console.error("[historyStore] 加载手牌历史失败:", err);
      set({
        loaded: true,
        loadError: "浏览器存储不可用（可能处于隐私模式）",
      });
    }
  },

  saveHand: async (record) => {
    // 先更新内存（乐观），再异步落库：落库失败（隐私模式/配额满）时手牌仍
    // 保留在内存里，用户可继续查看/导出，而不是静默丢失
    set((s) => ({
      hands: sortDesc([record, ...s.hands.filter((h) => h.id !== record.id)]),
    }));
    try {
      const db = await getDB();
      await db.put("hands", record);
    } catch (err) {
      console.error("[historyStore] 手牌落库失败（仅保留在内存）:", err);
    }
  },

  addHand: async (hand) => {
    await get().saveHand(hand);
  },

  listHands: async () => {
    const db = await getDB();
    const raw = (await db.getAll("hands")) as unknown[];
    const hands = sortDesc(filterValidHands(raw)).map(
      // 旧记录回填：修复前存的 HandRecord 缺全下跑马后的空动作街，读出时补齐
      // （withRunoutStreets 对已齐全的记录是幂等 no-op）
      (h) => ({ ...h, streets: withRunoutStreets(h.streets, h.finalBoard) }),
    );
    set({ hands, loaded: true, loadError: null });
    return hands;
  },

  getHand: async (id) => {
    const cached = get().hands.find((h) => h.id === id);
    if (cached) return cached;
    const db = await getDB();
    const hand = (await db.get("hands", id)) as unknown;
    if (hand === undefined || hand === null) return null;
    if (!isValidHandRecord(hand)) {
      console.warn("[historyStore] 跳过损坏的手牌记录:", id);
      return null;
    }
    return { ...hand, streets: withRunoutStreets(hand.streets, hand.finalBoard) };
  },

  deleteHand: async (id) => {
    const db = await getDB();
    await db.delete("hands", id);
    await db.delete("analyses", id);
    set((s) => {
      const analyses = { ...s.analyses };
      delete analyses[id];
      return { hands: s.hands.filter((h) => h.id !== id), analyses };
    });
  },

  clearAll: async () => {
    const db = await getDB();
    await db.clear("hands");
    await db.clear("analyses");
    set({ hands: [], analyses: {}, loaded: true });
  },

  clear: async () => {
    await get().clearAll();
  },

  getAnalysis: async (id) => {
    const cached = get().analyses[id];
    if (cached) return cached;
    const db = await getDB();
    const entry = (await db.get("analyses", id)) as AnalysisEntry | undefined;
    if (entry) {
      set((s) => ({ analyses: { ...s.analyses, [id]: entry.result } }));
      return entry.result;
    }
    return null;
  },

  analyzeHand: async (id, config) => {
    if (!config.apiKey || config.apiKey.trim() === "") {
      throw new Error("尚未配置 LLM API Key，请先到「设置」页填写并保存");
    }
    const hand = await get().getHand(id);
    if (!hand) {
      throw new Error("未找到该手牌记录，可能已被删除");
    }
    const messages: ChatMessage[] = [
      { role: "system", content: analysisSystemPromptFor(getStoredLang()) },
      { role: "user", content: buildAnalysisUserPrompt(hand) },
    ];
    const { result } = await analyzeWithRetry(messages, (msgs) =>
      chatCompletion(config, msgs),
    );
    const db = await getDB();
    await db.put("analyses", { handId: id, result, createdAt: Date.now() } satisfies AnalysisEntry);
    set((s) => ({ analyses: { ...s.analyses, [id]: result } }));
    return result;
  },

  stats: () => computeStats(get().hands),
}));

// ---------------------------------------------------------------------------
// 整场复盘（Session 级 AI 教练）
// ---------------------------------------------------------------------------
//
// 与单手复盘 analyzeHand 的区别：分析对象是一场对局的聚合数据（最近 N 手的
// 统计 + 亏损最大的样本手），产出 strengths/leaks/priorities/score。
// 持久化走 localStorage（pokergto_session_reports，最多 5 份）而非 IndexedDB：
// 新增 object store 需要抬 idb 版本做迁移，报告体积小、数量少，localStorage 足够。

/** 整场复盘报告的 localStorage 键（JSON 数组，最新在前，最多 MAX_SESSION_REPORTS 份） */
export const SESSION_REPORTS_KEY = "pokergto_session_reports";
/** 最多保留的报告份数 */
export const MAX_SESSION_REPORTS = 5;
/** 默认分析最近 50 手 */
export const SESSION_ANALYSIS_DEFAULT_LIMIT = 50;
/** 分析手数上限 */
export const SESSION_ANALYSIS_MAX_LIMIT = 100;

export const SESSION_SYSTEM_PROMPT = `你是一位职业德州扑克教练，擅长无限注德州扑克教学（单挑与 2-9 人桌，现金局与锦标赛 SNG）。学员刚打完一场对局，你将看到这场对局的聚合统计数据（VPIP/PFR/AF/WTSD、位置拆分、对手风格拆分）以及亏损最大的几手牌摘要。请站在整场视角复盘学员（"你"）的表现：关注可重复的强项与系统性漏洞（leak），不要纠结单手牌的运气好坏。

严格要求：
1. 只输出一个严格的 JSON 对象，不要输出 markdown 代码块，不要输出任何其他文字。
2. JSON 格式如下：
{
  "strengths": ["……", "……"],
  "leaks": [
    { "title": "漏洞一句话概括", "detail": "具体说明、改进建议与证据引用" }
  ],
  "priorities": ["第一优先练习项", "第二优先练习项"],
  "score": 68
}
3. "strengths" 2-4 条：学员做得好的地方，每条都要有数据或样本支撑（例如"后位开局积极，按钮位附近盈亏 +45"）。
4. "leaks" 1-4 条，按严重程度排序："detail" 必须引用证据——亏损样本手用「样本1」~「样本5」编号引用，统计数据用指标名与数值（例如"VPIP 45% 明显偏松""枪口位盈亏 -120"）。
5. "priorities" 1-3 条，按练习优先级排序，具体可执行（例如"枪口位开局范围收紧到前 12%"，而不是"注意翻前"这种空话）。
6. "score" 为 0-100 的整数综合评分（越高代表学员这场整体打得越好）。
7. 简洁硬约束：strengths 每条不超过 60 字，leak 的 title 不超过 20 字、detail 不超过 120 字，priorities 每条不超过 40 字——宁可少说也要保证 JSON 完整收尾，绝对不要让输出被截断。`;

/**
 * SESSION_SYSTEM_PROMPT 的英文版（UI 语言为英文时使用）：结构与约束逐条对应；
 * 证据引用沿用 user prompt 中的「样本1」~「样本5」编号，并要求 JSON 文本用英文输出。
 */
export const SESSION_SYSTEM_PROMPT_EN = `You are a professional No-Limit Texas Hold'em coach (heads-up and 2-9 player tables, cash games and SNG tournaments). The student just finished a session. You will see aggregated session stats (VPIP/PFR/AF/WTSD, position splits, opponent-style splits) plus summaries of the biggest losing hands. Review the student's (referred to as "you") performance at the session level: focus on repeatable strengths and systemic leaks, not the luck of individual hands.

Strict requirements:
1. Output a single strict JSON object only — no markdown code blocks, no other text.
2. The JSON format is:
{
  "strengths": ["……", "……"],
  "leaks": [
    { "title": "one-line leak summary", "detail": "specifics, improvement advice and cited evidence" }
  ],
  "priorities": ["top practice priority", "second priority"],
  "score": 68
}
3. "strengths": 2-4 items — things the student did well, each backed by data or samples (e.g. "aggressive opens from late position, +45 profit around the button").
4. "leaks": 1-4 items sorted by severity; "detail" must cite evidence — reference losing sample hands by their labels 「样本1」-「样本5」, and stats by metric name and value (e.g. "VPIP 45% is clearly too loose", "UTG profit -120").
5. "priorities": 1-3 items sorted by practice priority, concrete and actionable (e.g. "tighten the UTG opening range to the top 12%", not vague advice like "pay attention preflop").
6. "score": an integer from 0 to 100 (higher means the student played the session better overall).
7. Brevity hard constraints: each strength at most 60 characters, leak title at most 20 characters, leak detail at most 120 characters, each priority at most 40 characters — say less rather than risk an incomplete JSON; never let the output be truncated.
8. Output JSON with English text: strengths, leak titles and details, and priorities must all be written in English.`;

/** 按 UI 语言选择整场复盘 system prompt（zh 为默认，en 用英文版） */
export function sessionSystemPromptFor(lang: Lang): string {
  return lang === "en" ? SESSION_SYSTEM_PROMPT_EN : SESSION_SYSTEM_PROMPT;
}

const styleName = (s: string): string => STYLE_NAME[s as ConcreteAIStyle] ?? s;

/** 把最近 N 手（时间倒序）聚合并渲染成整场复盘的 user prompt */
export function buildSessionUserPrompt(hands: HandRecord[]): string {
  const hud = computeHeroHud(hands);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const signed = (n: number) => `${n >= 0 ? "+" : ""}${n}`;
  const lines: string[] = [];
  lines.push(`以下是学员最近 ${hands.length} 手牌的整场数据（第 1 手为最新，按时间倒序）。`);
  lines.push("");
  lines.push("【整体统计】");
  lines.push(
    `- 手数 ${hud.totalHands}，总盈亏 ${signed(hud.totalProfit)}，每百手盈亏 ${
      hud.bbPer100 === null ? "—" : `${hud.bbPer100 >= 0 ? "+" : ""}${hud.bbPer100.toFixed(1)} bb/100`
    }`,
  );
  lines.push(`- 胜率 ${pct(hud.winRate)}，摊牌率 ${pct(hud.showdownRate)}`);
  lines.push(
    `- VPIP（自愿入池率）${pct(hud.vpip)}，PFR（翻前加注率）${pct(hud.pfr)}，翻后 AF ${hud.af.toFixed(2)}，WTSD（摊牌率）${pct(hud.wtsd)}`,
  );
  lines.push("");
  lines.push("【翻前位置桶】（手数 / VPIP / PFR；early=枪口侧，middle=中位，late=盲位侧）");
  const bucketLabel = { early: "前位 early", middle: "中位 middle", late: "后位 late" } as const;
  for (const b of ["early", "middle", "late"] as const) {
    const bk = hud.buckets[b];
    lines.push(
      `- ${bucketLabel[b]}：${bk.hands} 手，VPIP ${bk.vpip === null ? "—" : pct(bk.vpip)}，PFR ${bk.pfr === null ? "—" : pct(bk.pfr)}`,
    );
  }
  lines.push("");
  lines.push("【位置拆分】（位置：手数 / 盈亏 / 胜率）");
  for (const r of hud.byPosition) {
    lines.push(`- ${r.position}：${r.hands} 手，盈亏 ${signed(r.profit)}，胜率 ${pct(r.winRate)}`);
  }
  if (hud.byStyle.length > 0) {
    lines.push("");
    lines.push("【对手风格拆分】（对战该风格在场的手数 / 盈亏 / 胜率）");
    for (const r of hud.byStyle) {
      lines.push(`- ${STYLE_NAME[r.style]}：${r.hands} 手，盈亏 ${signed(r.profit)}，胜率 ${pct(r.winRate)}`);
    }
  }
  lines.push("");
  lines.push("【亏损最大的样本手】（leaks 的 detail 引用证据时使用「样本1」~「样本5」编号）");
  const losses = [...hands]
    .sort((a, b) => a.profit - b.profit)
    .filter((h) => h.profit < 0)
    .slice(0, 5);
  if (losses.length === 0) {
    lines.push("- 本时段没有亏损的手牌");
  } else {
    losses.forEach((h, i) => {
      lines.push(`样本${i + 1}：${summarizeHand(h, styleName)}`);
    });
  }
  lines.push("");
  lines.push("请按系统要求的 JSON 格式输出整场复盘报告。");
  return lines.join("\n");
}

/** 从 LLM 脏输出中提取第一个完整 JSON 对象（围栏剥离 + 末尾 "}" 逐个回退，与 parseAnalysisResult 同风格） */
function extractJsonObject(text: string): unknown {
  let t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  if (start < 0) {
    throw new Error("整场复盘解析失败：LLM 未返回 JSON");
  }
  let end = t.lastIndexOf("}");
  while (end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      end = t.lastIndexOf("}", end - 1);
    }
  }
  throw new Error("整场复盘解析失败：JSON 格式错误，请重试");
}

/** 容忍单字符串（模型偶尔不包数组），过滤空项与非字符串 */
function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((s): s is string => typeof s === "string" && s.length > 0);
  }
  if (typeof v === "string" && v.length > 0) return [v];
  return [];
}

function clampScore(v: unknown): number {
  const raw = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** 容错解析 LLM 输出为 SessionReport；失败时抛错（analyzeSessionCore 会自动重试一次） */
export function parseSessionReport(text: string, handsAnalyzed: number): SessionReport {
  const raw = extractJsonObject(text);
  const obj = (raw ?? {}) as {
    strengths?: unknown;
    leaks?: unknown;
    priorities?: unknown;
    score?: unknown;
  };
  const strengths = toStringArray(obj.strengths);
  const leaks: SessionReport["leaks"] = [];
  const leakItems: unknown[] = Array.isArray(obj.leaks)
    ? obj.leaks
    : toStringArray(obj.leaks);
  for (const item of leakItems) {
    if (typeof item === "string") {
      if (item) leaks.push({ title: item, detail: "" });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const it = item as { title?: unknown; detail?: unknown };
    const detail = typeof it.detail === "string" ? it.detail : "";
    let title = typeof it.title === "string" ? it.title : "";
    if (!title && detail) {
      title = detail.length > 20 ? `${detail.slice(0, 20)}…` : detail;
    }
    if (!title) continue;
    leaks.push({ title, detail });
  }
  const priorities = toStringArray(obj.priorities);
  return {
    createdAt: Date.now(),
    handsAnalyzed,
    strengths,
    leaks,
    priorities,
    score: clampScore(obj.score),
  };
}

export interface SessionAnalyzeOutcome {
  report: SessionReport;
  /** true = 第一次失败、第二次才成功 */
  retried: boolean;
}

/**
 * 整场复盘核心（纯注入，不碰 idb/localStorage，便于 vitest 单测）：
 * 聚合 hands → prompt → callLLM → 容错解析；首次失败追加严格 JSON 提示重试一次，
 * 第二次仍失败抛出含两次原因的合并错误。
 * lang 决定 system prompt 语言（默认 zh；en 时要求 JSON 文本用英文输出）。
 */
export async function analyzeSessionCore(
  hands: HandRecord[],
  callLLM: LLMCaller,
  lang: Lang = "zh",
): Promise<SessionAnalyzeOutcome> {
  if (hands.length === 0) {
    throw new Error("暂无可复盘的手牌记录，请先打几手牌再来整场复盘");
  }
  const messages: ChatMessage[] = [
    { role: "system", content: sessionSystemPromptFor(lang) },
    { role: "user", content: buildSessionUserPrompt(hands) },
  ];
  try {
    const content = await callLLM(messages);
    return { report: parseSessionReport(content, hands.length), retried: false };
  } catch (firstErr) {
    const retryMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content: ANALYSIS_RETRY_HINT },
    ];
    try {
      const content = await callLLM(retryMessages);
      return { report: parseSessionReport(content, hands.length), retried: true };
    } catch (secondErr) {
      throw new Error(
        `AI 教练整场复盘失败（已自动重试 1 次仍失败）。\n` +
          `第一次失败原因：${errMessage(firstErr)}\n` +
          `第二次失败原因：${errMessage(secondErr)}`,
      );
    }
  }
}

/** localStorage 存档的宽容校验（脏数据/旧格式条目直接丢弃） */
function normalizeSessionReport(x: unknown): SessionReport | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Partial<SessionReport>;
  if (typeof o.createdAt !== "number" || !Number.isFinite(o.createdAt)) return null;
  const leaks: SessionReport["leaks"] = [];
  if (Array.isArray(o.leaks)) {
    for (const l of o.leaks) {
      if (!l || typeof l !== "object") continue;
      const title = (l as { title?: unknown }).title;
      if (typeof title !== "string" || !title) continue;
      const detail = (l as { detail?: unknown }).detail;
      leaks.push({ title, detail: typeof detail === "string" ? detail : "" });
    }
  }
  return {
    createdAt: o.createdAt,
    handsAnalyzed: typeof o.handsAnalyzed === "number" ? o.handsAnalyzed : 0,
    strengths: toStringArray(o.strengths),
    leaks,
    priorities: toStringArray(o.priorities),
    score: clampScore(o.score),
  };
}

/** 读取已保存的整场复盘报告（最新在前）；无存档/脏数据返回 [] */
export function listSessionReports(): SessionReport[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SESSION_REPORTS_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map(normalizeSessionReport)
      .filter((r): r is SessionReport => r !== null)
      .slice(0, MAX_SESSION_REPORTS);
  } catch {
    return [];
  }
}

/** 保存一份报告（最新在前，超出 MAX_SESSION_REPORTS 截断）；返回保存后的完整列表 */
export function saveSessionReport(report: SessionReport): SessionReport[] {
  const next = [report, ...listSessionReports()].slice(0, MAX_SESSION_REPORTS);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(SESSION_REPORTS_KEY, JSON.stringify(next));
    } catch {
      /* 隐私模式/配额满：报告只保留在返回值里 */
    }
  }
  return next;
}

/**
 * 整场复盘入口：取最近 limit 手（默认 50，上限 100）→ 聚合统计 + 亏损样本手
 * → LLM 教练 → 容错解析 → 存 localStorage（最多 5 份）。
 * @throws Error config.apiKey 为空、无手牌、或两次调用均失败时抛出。
 */
export async function analyzeSession(
  config: LLMConfig,
  limit?: number,
): Promise<SessionReport> {
  if (!config.apiKey || config.apiKey.trim() === "") {
    throw new Error("尚未配置 LLM API Key，请先到「设置」页填写并保存");
  }
  const lim = Math.max(
    1,
    Math.min(SESSION_ANALYSIS_MAX_LIMIT, Math.floor(limit ?? SESSION_ANALYSIS_DEFAULT_LIMIT)),
  );
  const hands = (await useHistoryStore.getState().listHands()).slice(0, lim);
  const { report } = await analyzeSessionCore(
    hands,
    (msgs) => chatCompletion(config, msgs),
    getStoredLang(),
  );
  saveSessionReport(report);
  return report;
}
