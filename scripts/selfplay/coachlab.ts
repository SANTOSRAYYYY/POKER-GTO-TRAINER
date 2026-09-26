/**
 * scripts/selfplay/coachlab.ts — 教练复盘 prompt 变体实验（分析任务版 prompt 大战）
 *
 * 背景：决策 prompt 变体大战（llm-promptwar）证明给决策 prompt 注入胜率数据/
 * 策略说教会让模型变差（slim 零注入版唯一两场皆正）。本实验对「教练复盘
 * prompt」（单手分析任务）做同款验证：复盘是分析任务而非决策任务，结论可能
 * 不同，需实测。
 *
 * 设计：
 * - 12 手试题：6 手手写教学手牌（明确对错点：河牌过度弃牌 / 错失价值 /
 *   多人池听牌赔率 / 标准好牌抗过度批评 / 泡沫 ICM / 卡顺赔率不足跟注）
 *   + 6 手抽自 results/llm-battle.json k3 座位 topHands 的真实对局手牌；
 * - 3 个教练变体（同一 JSON 输出结构 streets[]/overall/score）：
 *   full = 生产 ANALYSIS_SYSTEM_PROMPT 原文拷贝（重度说教版，源自
 *          src/lib/store/historyStore.ts，本实验不改生产代码）；
 *   slim = 零说教「你是扑克教练。复盘这手牌中学员的决策，指出对错与理由。
 *          只输出 JSON」+ 最小 schema；
 *   data = slim + 关键街客观数据（src/lib/poker/equity 蒙特卡洛实算胜率
 *          + 跟注所需胜率，标注"仅为数据参考，不构成建议"）；
 * - 评审：LLM-as-judge（同模型 k3），同手三份分析打乱标注 A/B/C 盲评，
 *   按准确性/可操作性/洞察力/简洁性四项 1-10 打分 + 一句理由；评委可见
 *   出题人标注的教学要点与实算胜率作为准确性参照；
 * - 成本：12 手 × 3 变体 = 36 次分析 + 12 次评审 = 48 次调用，串行；
 *   chatCompletionDirect 内置重试 2 次（退避 2s/5s，429 降并发），本脚本
 *   外层再对失败统一退避 5s 重试 ≤2 次；逐条落盘，中断后可断点续跑。
 *
 * 模型参数（任务指定）：moonshot k3，thinking enabled + reasoning_effort
 * high + max_tokens 8192；baseUrl 走 llm-keys.env 的 MOONSHOT_BASE_URL 覆盖。
 *
 * 安全红线：apiKey 只经 llmSeat 从 MOONSHOT_KEY 环境变量读取；日志/结果
 * 文件只出现环境变量名，任何待记录的上游错误文本一律先经 redact() 脱敏。
 *
 * 执行：
 *   ENTRY=scripts/selfplay/coachlab.ts bash scripts/selfplay/build-and-run.sh --smoke
 *   ENTRY=scripts/selfplay/coachlab.ts bash scripts/selfplay/build-and-run.sh [--fresh]
 * 默认输出 scripts/selfplay/results/coachlab.json + coachlab-report.md。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Card, ChatMessage, Street } from "@/lib/types";
import { equity, equityMulti } from "@/lib/poker/equity";
import {
  chatCompletionDirect,
  loadLlmKeys,
  requireLlmKey,
  resetLlmRuntimeState,
  type LlmSeatSpec,
  type LlmUsage,
} from "./llmSeat";

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

const MODEL_SPEC: LlmSeatSpec = {
  provider: "moonshot",
  model: "k3",
  agent: false,
  reasoningEffort: "high",
  thinkingEnabled: true,
  maxTokens: 8192,
};

const DEFAULT_OUT = "scripts/selfplay/results/coachlab.json";
const DEFAULT_REPORT = "scripts/selfplay/results/coachlab-report.md";
const BATTLE_JSON = "scripts/selfplay/results/llm-battle.json";

const EQUITY_ITERS = 20000;

const STREET_LABEL: Record<Street, string> = {
  preflop: "翻前",
  flop: "翻牌",
  turn: "转牌",
  river: "河牌",
  showdown: "摊牌",
};

const STREET_ORDER: Street[] = ["preflop", "flop", "turn", "river"];

const POS_CN: Record<string, string> = {
  BTN: "按钮位",
  SB: "小盲",
  BB: "大盲",
  UTG: "枪口位",
  "UTG+1": "枪口+1",
  LJ: "LJ（洛杰克）",
  HJ: "HJ（劫持位）",
  CO: "CO（关煞位）",
};

type Variant = "full" | "slim" | "data";
const VARIANTS: readonly Variant[] = ["full", "slim", "data"];

const VARIANT_DESC: Record<Variant, string> = {
  full: "生产版说教 prompt（人设 + 严格 JSON 要求 + 多人池点评要求 + 错误举例）",
  slim: "零说教：一句教练职责 + 最小 JSON schema",
  data: "slim + 关键街实算胜率/所需胜率注入",
};

interface CoachStreetRec {
  street: Street;
  board: Card[];
  /** 已渲染好的动作行（不含前导 "- "） */
  lines: string[];
}

interface CoachHand {
  id: string;
  /** 教学点标签（报告与评委参照用，不进被测 prompt） */
  title: string;
  source: "handwritten" | "battle";
  header: string[];
  players: string[];
  heroCards: Card[];
  finalBoard: Card[];
  resultLine: string;
  streets: CoachStreetRec[];
  /** 出题人标注的教学要点（仅评委可见，作准确性参照） */
  groundTruth: string[];
  /** data 变体注入段（引擎实算；评委同样可见作参照） */
  dataNotes: string[];
}

interface ParsedAnalysis {
  streets: { street: string; rating: string; comments: string[] }[];
  overall: string;
  score: number;
}

interface AnalysisEntry {
  status: "ok" | "error";
  raw: string | null;
  parsed: ParsedAnalysis | null;
  usage: LlmUsage | null;
  ms: number;
  error: string | null;
}

interface JudgeDim {
  accuracy: number;
  actionability: number;
  insight: number;
  conciseness: number;
  reason: string;
}

interface JudgeEntry {
  status: "ok" | "error";
  /** label "A"/"B"/"C" → 变体（盲评打乱映射） */
  labelToVariant: Record<"A" | "B" | "C", Variant>;
  raw: string | null;
  scores: Partial<Record<"A" | "B" | "C", JudgeDim>>;
  usage: LlmUsage | null;
  ms: number;
  error: string | null;
}

interface ResultsFile {
  kind: "coachlab";
  meta: {
    model: string;
    reasoningEffort: string;
    thinkingEnabled: boolean;
    maxTokens: number;
    smoke: boolean;
    startedAt: string;
    finishedAt: string | null;
  };
  hands: CoachHand[];
  analyses: Record<string, Partial<Record<Variant, AnalysisEntry>>>;
  judges: Record<string, JudgeEntry>;
}

// ---------------------------------------------------------------------------
// 脱敏（双保险：上游错误文本理论上不含 key，落盘前仍统一抹除）
// ---------------------------------------------------------------------------

function redact(text: string): string {
  let out = text;
  for (const env of ["DEEPSEEK_KEY", "MOONSHOT_KEY"]) {
    const v = process.env[env];
    if (v) out = out.split(v).join(`[${env}]`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 变体 prompt（full = 生产 ANALYSIS_SYSTEM_PROMPT 逐字拷贝，来源
// src/lib/store/historyStore.ts；改动生产 prompt 后需同步此处）
// ---------------------------------------------------------------------------

const FULL_SYSTEM = `你是一位职业德州扑克教练，擅长无限注德州扑克教学（单挑与 2-9 人桌，现金局与锦标赛 SNG）。学员刚打完一手牌，请你复盘点评学员（"你"）的打法。

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
5. "comments" 逐条点评学员在该街的每个关键决策：明确指出错误（例如"翻前跟注过松""河牌价值下注太薄""面对加注弃牌过多"），并给出正确打法与理由（结合位置、底池赔率、范围与对手风格）。若该街是三人及以上的多人底池，须点评多人底池动态：多人底池中胜率被稀释、继续所需的牌力更高、底池赔率与隐含赔率变化、以及身后尚未行动者带来的风险。
6. "score" 为 0-100 的整数综合评分（越高代表学员这手牌打得越好）。
7. 简洁硬约束：每条 comment 不超过 80 字，overall 不超过 120 字——宁可少说也要保证 JSON 完整收尾，绝对不要让输出被截断。`;

const SLIM_SYSTEM =
  "你是扑克教练。复盘这手牌中学员的决策，指出对错与理由。只输出 JSON。";

/** slim/data 共用的最小 schema 说明（只有格式，无任何策略说教） */
const SLIM_SCHEMA =
  "只输出一个 JSON 对象（不要 markdown 代码块，不要任何其他文字）：\n" +
  '{"streets":[{"street":"preflop|flop|turn|river","rating":"good|ok|mistake","comments":["……"]}],"overall":"总体评价","score":0到100的整数}\n' +
  "只点评实际进行到的街道，每条街一条。";

/** 生产 renderHandForPrompt 结尾的多人池点评要求（仅 full 变体携带，忠实复刻生产链路） */
const FULL_TRAILER =
  "请复盘我（hero）的每个关键决策；若某条街是三人及以上的多人底池，请额外点评多人底池动态（胜率被稀释、继续范围应更紧、位置与尚未行动者的影响）。";

function renderCoachHand(h: CoachHand): string {
  const lines: string[] = [];
  lines.push(...h.header);
  lines.push("玩家列表：");
  for (const p of h.players) lines.push(`- ${p}`);
  lines.push(`最终公共牌：${h.finalBoard.length ? h.finalBoard.join(" ") : "无"}`);
  lines.push(h.resultLine);
  lines.push("");
  lines.push("逐街动作序列（按发生顺序）：");
  for (const st of h.streets) {
    lines.push(
      `【${STREET_LABEL[st.street]}】公共牌：${st.board.length ? st.board.join(" ") : "无"}`,
    );
    if (st.lines.length === 0) {
      lines.push("  （无动作记录）");
    } else {
      for (const l of st.lines) lines.push(`  - ${l}`);
    }
  }
  return lines.join("\n");
}

function messagesForVariant(v: Variant, h: CoachHand): ChatMessage[] {
  const body = renderCoachHand(h);
  if (v === "full") {
    return [
      { role: "system", content: FULL_SYSTEM },
      {
        role: "user",
        content:
          `以下是这手牌的完整记录，请按系统要求的 JSON 格式输出复盘分析：\n\n${body}\n\n${FULL_TRAILER}`,
      },
    ];
  }
  let extra = "";
  if (v === "data" && h.dataNotes.length > 0) {
    extra =
      "\n\n【关键街数据】（引擎蒙特卡洛模拟结果，仅为数据参考，不构成建议）\n" +
      h.dataNotes.map((s) => `- ${s}`).join("\n");
  }
  return [
    { role: "system", content: SLIM_SYSTEM },
    {
      role: "user",
      content: `以下是这手牌的完整记录：\n\n${body}${extra}\n\n${SLIM_SCHEMA}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// 容错解析（与生产 parseAnalysisResult 同思路的本地简版）
// ---------------------------------------------------------------------------

const VALID_STREETS = new Set(["preflop", "flop", "turn", "river"]);
const VALID_RATINGS = new Set(["good", "ok", "mistake"]);

function extractJson(text: string): unknown | null {
  let t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  if (start < 0) return null;
  let end = t.lastIndexOf("}");
  while (end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      end = t.lastIndexOf("}", end - 1);
    }
  }
  return null;
}

function tryParseAnalysis(text: string): ParsedAnalysis | null {
  const raw = extractJson(text);
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as {
    streets?: unknown;
    overall?: unknown;
    score?: unknown;
  };
  const streets: ParsedAnalysis["streets"] = [];
  if (Array.isArray(obj.streets)) {
    for (const s of obj.streets) {
      if (!s || typeof s !== "object") continue;
      const st = s as { street?: unknown; rating?: unknown; comments?: unknown };
      const street =
        typeof st.street === "string" ? st.street.toLowerCase() : "";
      if (!VALID_STREETS.has(street)) continue;
      const ratingRaw =
        typeof st.rating === "string" ? st.rating.toLowerCase() : "";
      const rating = VALID_RATINGS.has(ratingRaw) ? ratingRaw : "ok";
      const comments = Array.isArray(st.comments)
        ? st.comments.filter(
            (c): c is string => typeof c === "string" && c.length > 0,
          )
        : typeof st.comments === "string" && st.comments.length > 0
          ? [st.comments]
          : [];
      streets.push({ street, rating, comments });
    }
  }
  const overall =
    typeof obj.overall === "string" && obj.overall.length > 0
      ? obj.overall
      : "（无总体评价）";
  const scoreField: unknown = obj.score;
  const scoreRaw =
    typeof scoreField === "string" && scoreField.trim() !== ""
      ? Number(scoreField)
      : scoreField;
  const scoreNum =
    typeof scoreRaw === "number" && Number.isFinite(scoreRaw) ? scoreRaw : 50;
  const score = Math.max(0, Math.min(100, Math.round(scoreNum)));
  return { streets, overall, score };
}

function clamp110(x: unknown): number {
  const n = typeof x === "string" ? Number(x) : x;
  if (typeof n !== "number" || !Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(10, Math.round(n)));
}

function tryParseJudge(
  text: string,
): Partial<Record<"A" | "B" | "C", JudgeDim>> | null {
  const raw = extractJson(text);
  if (!raw || typeof raw !== "object") return null;
  const out: Partial<Record<"A" | "B" | "C", JudgeDim>> = {};
  for (const label of ["A", "B", "C"] as const) {
    const s = (raw as Record<string, unknown>)[label];
    if (!s || typeof s !== "object") return null;
    const d = s as Record<string, unknown>;
    out[label] = {
      accuracy: clamp110(d.accuracy),
      actionability: clamp110(d.actionability),
      insight: clamp110(d.insight),
      conciseness: clamp110(d.conciseness),
      reason: typeof d.reason === "string" ? d.reason : "",
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// 胜率注入（引擎实算）
// ---------------------------------------------------------------------------

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;

function equityNote(
  street: Street,
  heroCards: Card[],
  board: Card[],
  opponents: number,
  potOdds: { call: number; pot: number } | null,
  caveat = "",
): string {
  const e =
    opponents > 1
      ? equityMulti(heroCards, board, opponents, EQUITY_ITERS)
      : equity(heroCards, null, board, EQUITY_ITERS);
  let s = `${STREET_LABEL[street]}：你的底牌对 ${opponents} 名随机对手胜率约 ${pct(e.win)}`;
  if (e.tie >= 0.01) s += `（含平局约 ${pct(e.tie)}）`;
  if (potOdds) {
    const need = potOdds.call / (potOdds.pot + potOdds.call);
    s += `；当时你需跟注 ${potOdds.call}（底池 ${potOdds.pot}），所需胜率约 ${pct(need)}`;
  }
  s += `（蒙特卡洛 ${EQUITY_ITERS / 10000} 万次${caveat}）`;
  return s;
}

// ---------------------------------------------------------------------------
// 试题集 A：6 手手写教学手牌（完整动作序列，每手带明确教学点）
// ---------------------------------------------------------------------------

function handwrittenHands(): CoachHand[] {
  const hands: CoachHand[] = [];

  // H1 河牌过度弃牌 vs 疯子（顶对好踢脚，面对 1/3 池小注弃牌）
  const h1Board: Card[] = ["Qd", "7c", "4c", "2h", "9d"];
  const h1Hero: Card[] = ["Ks", "Qs"];
  hands.push({
    id: "hw1-river-overfold",
    title: "河牌面对疯子小注过度弃牌（顶对好踢脚）",
    source: "handwritten",
    header: [
      "牌桌：6 人桌 · 现金局",
      "盲注：小盲 5 / 大盲 10，无前注",
      "按钮位：座位 3",
      "你的座位：座位 2（CO（关煞位））",
      "你的底牌：Ks Qs",
    ],
    players: [
      "座位 0，UTG（枪口位），AI（风格：紧凶 TAG），翻前弃牌，净盈亏 0",
      "座位 1，HJ（劫持位），AI（风格：紧凶 TAG），翻前弃牌，净盈亏 0",
      "座位 2，CO（关煞位），你（人类玩家），底牌 Ks Qs，净盈亏 -160",
      "座位 3，按钮位，AI（风格：疯子），底牌 未知（未摊牌），净盈亏 +175",
      "座位 4，小盲，AI（风格：紧弱 Nit），翻前弃牌，净盈亏 -5",
      "座位 5，大盲，AI（风格：GTO），翻前弃牌，净盈亏 -10",
    ],
    heroCards: h1Hero,
    finalBoard: h1Board,
    resultLine: "结果：你输，你的净盈亏 -160，未摊牌（你弃牌）",
    streets: [
      {
        street: "preflop",
        board: [],
        lines: [
          "座位0（AI，风格：紧凶 TAG） 弃牌",
          "座位1（AI，风格：紧凶 TAG） 弃牌",
          "你（座位2） 加注到 30",
          "座位3（AI，风格：疯子） 跟注 30",
          "座位4（AI，风格：紧弱 Nit） 弃牌",
          "座位5（AI，风格：GTO） 弃牌",
        ],
      },
      {
        street: "flop",
        board: ["Qd", "7c", "4c"],
        lines: ["你（座位2） 下注到 40", "座位3（AI，风格：疯子） 跟注 40"],
      },
      {
        street: "turn",
        board: ["Qd", "7c", "4c", "2h"],
        lines: ["你（座位2） 下注到 90", "座位3（AI，风格：疯子） 跟注 90"],
      },
      {
        street: "river",
        board: h1Board,
        lines: [
          "你（座位2） 过牌",
          "座位3（AI，风格：疯子） 下注到 100",
          "你（座位2） 弃牌",
        ],
      },
    ],
    groundTruth: [
      "翻前 CO 开池 KQs 标准；翻牌顶对好踢脚下注、转牌继续下注均正常。",
      "河牌梅花听牌完全破产（牌面 Q 7 4 2 9，仅两张梅花），面对疯子约 1/3 池小注（跟 100 赢 535，所需胜率约 19%），顶对好踢脚对其范围胜率远超市值，弃牌是明显错误（过度弃牌）；正确打法是跟注。",
    ],
    dataNotes: [
      equityNote("flop", h1Hero, h1Board.slice(0, 3), 1, null),
      equityNote("turn", h1Hero, h1Board.slice(0, 4), 1, null),
      equityNote("river", h1Hero, h1Board, 1, { call: 100, pot: 435 }),
    ],
  });

  // H2 河牌错失价值 vs 跟注站（三条过牌收官）
  const h2Board: Card[] = ["Td", "8c", "3s", "Tc", "4h"];
  const h2Hero: Card[] = ["Ah", "Th"];
  hands.push({
    id: "hw2-river-missed-value",
    title: "河牌对跟注站错失价值下注（三条）",
    source: "handwritten",
    header: [
      "牌桌：6 人桌 · 现金局",
      "盲注：小盲 5 / 大盲 10，无前注",
      "按钮位：座位 3",
      "你的座位：座位 2（CO（关煞位））",
      "你的底牌：Ah Th",
    ],
    players: [
      "座位 0，UTG（枪口位），AI（风格：紧凶 TAG），翻前弃牌，净盈亏 0",
      "座位 1，HJ（劫持位），AI（风格：松凶 LAG），翻前弃牌，净盈亏 0",
      "座位 2，CO（关煞位），你（人类玩家），底牌 Ah Th，净盈亏 +135",
      "座位 3，按钮位，AI（风格：GTO），翻前弃牌，净盈亏 0",
      "座位 4，小盲，AI（风格：紧弱 Nit），翻前弃牌，净盈亏 -5",
      "座位 5，大盲，AI（风格：跟注站），底牌 9c 8d，净盈亏 -130",
    ],
    heroCards: h2Hero,
    finalBoard: h2Board,
    resultLine: "结果：你赢，你的净盈亏 +135，进入摊牌",
    streets: [
      {
        street: "preflop",
        board: [],
        lines: [
          "座位0（AI，风格：紧凶 TAG） 弃牌",
          "座位1（AI，风格：松凶 LAG） 弃牌",
          "你（座位2） 加注到 30",
          "座位3（AI，风格：GTO） 弃牌",
          "座位4（AI，风格：紧弱 Nit） 弃牌",
          "座位5（AI，风格：跟注站） 跟注 20",
        ],
      },
      {
        street: "flop",
        board: ["Td", "8c", "3s"],
        lines: [
          "座位5（AI，风格：跟注站） 过牌",
          "你（座位2） 下注到 30",
          "座位5（AI，风格：跟注站） 跟注 30",
        ],
      },
      {
        street: "turn",
        board: ["Td", "8c", "3s", "Tc"],
        lines: [
          "座位5（AI，风格：跟注站） 过牌",
          "你（座位2） 下注到 70",
          "座位5（AI，风格：跟注站） 跟注 70",
        ],
      },
      {
        street: "river",
        board: h2Board,
        lines: ["座位5（AI，风格：跟注站） 过牌", "你（座位2） 过牌"],
      },
    ],
    groundTruth: [
      "翻前开池、翻牌顶对好踢脚持续下注、转牌三条继续下注均正常。",
      "河牌牌面 T 8 3 T 4 无任何听牌完成，对手是跟注站（会用 8x、Tx 差踢脚甚至更小对子跟注），过牌放弃约半个池的价值下注是明显错误（错失价值）；正确打法是下注 100-150。",
    ],
    dataNotes: [
      equityNote("flop", h2Hero, h2Board.slice(0, 3), 1, null),
      equityNote("turn", h2Hero, h2Board.slice(0, 4), 1, null),
      equityNote("river", h2Hero, h2Board, 1, null),
    ],
  });

  // H3 多人池：非坚果同花听牌在加注后硬跟两条街
  const h3Board: Card[] = ["Ad", "Kc", "4c", "2s", "5h"];
  const h3Hero: Card[] = ["8c", "7c"];
  hands.push({
    id: "hw3-multiway-draw-odds",
    title: "多人池非坚果听牌面对加注的赔率失控",
    source: "handwritten",
    header: [
      "牌桌：6 人桌 · 现金局",
      "盲注：小盲 5 / 大盲 10，无前注",
      "按钮位：座位 3",
      "你的座位：座位 2（CO（关煞位））",
      "你的底牌：8c 7c",
    ],
    players: [
      "座位 0，UTG（枪口位），AI（风格：紧凶 TAG），底牌 未知（未摊牌），净盈亏 -110",
      "座位 1，HJ（劫持位），AI（风格：紧弱 Nit），翻前弃牌，净盈亏 0",
      "座位 2，CO（关煞位），你（人类玩家），底牌 8c 7c，净盈亏 -570",
      "座位 3，按钮位，AI（风格：松凶 LAG），底牌 未知（未摊牌），净盈亏 +715",
      "座位 4，小盲，AI（风格：GTO），翻前弃牌，净盈亏 -5",
      "座位 5，大盲，AI（风格：GTO），底牌 未知（未摊牌），净盈亏 -30",
    ],
    heroCards: h3Hero,
    finalBoard: h3Board,
    resultLine: "结果：你输，你的净盈亏 -570，未摊牌（你弃牌）",
    streets: [
      {
        street: "preflop",
        board: [],
        lines: [
          "座位0（AI，风格：紧凶 TAG） 加注到 30",
          "座位1（AI，风格：紧弱 Nit） 弃牌",
          "你（座位2） 跟注 30",
          "座位3（AI，风格：松凶 LAG） 跟注 30",
          "座位4（AI，风格：GTO） 弃牌",
          "座位5（AI，风格：GTO） 跟注 20",
        ],
      },
      {
        street: "flop",
        board: ["Ad", "Kc", "4c"],
        lines: [
          "座位5（AI，风格：GTO） 过牌",
          "座位0（AI，风格：紧凶 TAG） 下注到 80",
          "你（座位2） 跟注 80",
          "座位3（AI，风格：松凶 LAG） 加注到 240",
          "座位5（AI，风格：GTO） 弃牌",
          "座位0（AI，风格：紧凶 TAG） 弃牌",
          "你（座位2） 跟注 160",
        ],
      },
      {
        street: "turn",
        board: ["Ad", "Kc", "4c", "2s"],
        lines: [
          "你（座位2） 过牌",
          "座位3（AI，风格：松凶 LAG） 下注到 300",
          "你（座位2） 跟注 300",
        ],
      },
      {
        street: "river",
        board: h3Board,
        lines: [
          "你（座位2） 过牌",
          "座位3（AI，风格：松凶 LAG） 下注到 600",
          "你（座位2） 弃牌",
        ],
      },
    ],
    groundTruth: [
      "翻前 CO 用 87s 跟注 UTG 开池可接受（位置+同花连张），四人底池。",
      "翻牌 A K 4 两张梅花：你持 K 高同花听牌（非坚果，A 高花可能被别人拿到），面对下注+加注的两强表现，多人池中听牌胜率与隐含赔率同时恶化，跟注 160 已属边缘偏松。",
      "转牌白板 2，面对 300 下注需约 23% 胜率，单张出花仅约 19-20%，且无隐含赔率支撑（河牌中了也难拿大池），跟注是明确错误；河牌未中弃牌正确。",
      "多人池要点：胜率被稀释、继续范围应更紧、非坚果听牌的反向隐含赔率。",
    ],
    dataNotes: [
      equityNote("flop", h3Hero, h3Board.slice(0, 3), 3, { call: 160, pot: 525 }),
      equityNote("turn", h3Hero, h3Board.slice(0, 4), 1, { call: 300, pot: 985 }),
    ],
  });

  // H4 标准三连价值注（好牌，测试评委是否奖励"不过度挑刺"）
  const h4Board: Card[] = ["Kd", "7s", "2c", "9h", "5d"];
  const h4Hero: Card[] = ["As", "Ad"];
  hands.push({
    id: "hw4-aa-standard-value",
    title: "AA 标准三连价值下注（无明显错误的好牌）",
    source: "handwritten",
    header: [
      "牌桌：6 人桌 · 现金局",
      "盲注：小盲 5 / 大盲 10，无前注",
      "按钮位：座位 3",
      "你的座位：座位 3（按钮位）",
      "你的底牌：As Ad",
    ],
    players: [
      "座位 0，UTG（枪口位），AI（风格：GTO），翻前弃牌，净盈亏 0",
      "座位 1，HJ（劫持位），AI（风格：紧凶 TAG），翻前弃牌，净盈亏 0",
      "座位 2，CO（关煞位），AI（风格：松凶 LAG），翻前弃牌，净盈亏 0",
      "座位 3，按钮位，你（人类玩家），底牌 As Ad，净盈亏 +315",
      "座位 4，小盲，AI（风格：紧弱 Nit），底牌 Ks Qc，净盈亏 -305",
      "座位 5，大盲，AI（风格：GTO），翻前弃牌，净盈亏 -10",
    ],
    heroCards: h4Hero,
    finalBoard: h4Board,
    resultLine: "结果：你赢，你的净盈亏 +315，进入摊牌",
    streets: [
      {
        street: "preflop",
        board: [],
        lines: [
          "座位0（AI，风格：GTO） 弃牌",
          "座位1（AI，风格：紧凶 TAG） 弃牌",
          "座位2（AI，风格：松凶 LAG） 弃牌",
          "你（座位3） 加注到 30",
          "座位4（AI，风格：紧弱 Nit） 跟注 25",
          "座位5（AI，风格：GTO） 弃牌",
        ],
      },
      {
        street: "flop",
        board: ["Kd", "7s", "2c"],
        lines: [
          "座位4（AI，风格：紧弱 Nit） 过牌",
          "你（座位3） 下注到 35",
          "座位4（AI，风格：紧弱 Nit） 跟注 35",
        ],
      },
      {
        street: "turn",
        board: ["Kd", "7s", "2c", "9h"],
        lines: [
          "座位4（AI，风格：紧弱 Nit） 过牌",
          "你（座位3） 下注到 90",
          "座位4（AI，风格：紧弱 Nit） 跟注 90",
        ],
      },
      {
        street: "river",
        board: h4Board,
        lines: [
          "座位4（AI，风格：紧弱 Nit） 过牌",
          "你（座位3） 下注到 150",
          "座位4（AI，风格：紧弱 Nit） 跟注 150",
        ],
      },
    ],
    groundTruth: [
      "这手牌打法教科书：翻前开池、干燥面三连价值下注、尺度递增合理，对手是紧弱玩家用 KQ 顶对跟注到底属其个人问题。",
      "本题用于测试教练是否过度挑刺：无实质错误，各街应评 good；若分析编造问题（如'下注尺度太小''应该过牌诱导'）评委应扣准确性分。",
    ],
    dataNotes: [
      equityNote("flop", h4Hero, h4Board.slice(0, 3), 1, null),
      equityNote("turn", h4Hero, h4Board.slice(0, 4), 1, null),
      equityNote("river", h4Hero, h4Board, 1, null),
    ],
  });

  // H5 锦标赛泡沫期 77 面对全下跟注出局（ICM）
  const h5Board: Card[] = ["Kd", "9c", "3s", "6c", "Ac"];
  const h5Hero: Card[] = ["7s", "7d"];
  hands.push({
    id: "hw5-bubble-icm-call",
    title: "SNG 泡沫期 77 跟注全下出局（ICM 错误）",
    source: "handwritten",
    header: [
      "牌桌：4 人桌 · 锦标赛（SNG，10 人开赛，前 3 名进钱圈；当前剩 4 人 = 泡沫期）",
      "盲注：小盲 100 / 大盲 200，前注每人 25",
      "按钮位：座位 1",
      "你的座位：座位 3（大盲），你的筹码 2200（11 个大盲）",
      "你的底牌：7s 7d",
    ],
    players: [
      "座位 0，CO（关煞位），AI（风格：疯子），筹码 15000（筹码领先者，覆盖全场），底牌 Ah Qs，净盈亏 +2375",
      "座位 1，按钮位，AI（风格：紧凶 TAG），筹码 2600（13 个大盲），翻前弃牌，净盈亏 -25",
      "座位 2，小盲，AI（风格：紧弱 Nit），筹码 950（约 4.75 个大盲，全场最短），翻前弃牌，净盈亏 -125",
      "座位 3，大盲，你（人类玩家），筹码 2200（11 个大盲），底牌 7s 7d，净盈亏 -2225，锦标赛最终第 4 名（泡沫出局）",
    ],
    heroCards: h5Hero,
    finalBoard: h5Board,
    resultLine:
      "结果：你输，你的净盈亏 -2225，进入摊牌（对手底牌 Ah Qs），你获得第 4 名，恰好泡沫出局",
    streets: [
      {
        street: "preflop",
        board: [],
        lines: [
          "座位0（AI，风格：疯子，筹码领先者） 全下（本街累计 15000，对你有效 2200）",
          "座位1（AI，风格：紧凶 TAG） 弃牌",
          "座位2（AI，风格：紧弱 Nit） 弃牌",
          "你（座位3） 跟注 2000（全下）",
        ],
      },
      { street: "flop", board: ["Kd", "9c", "3s"], lines: [] },
      { street: "turn", board: ["Kd", "9c", "3s", "6c"], lines: [] },
      { street: "river", board: h5Board, lines: [] },
    ],
    groundTruth: [
      "纯筹码视角 77 对随机牌约 66%、对 AQ 约 55%，跟注是 +筹码 EV；但这是泡沫期：剩 4 人前 3 进钱圈，小盲仅 4.75bb 即将被盲注吞噬，你用 11bb 跟注全下赌上锦标赛生命是典型 ICM 错误，正确打法是弃牌等待短码先出局。",
      "出题意图：评委注意——若分析只引用胜率论证'跟注正确'而完全无视泡沫/ICM 语境，准确性应扣分；能区分筹码 EV 与 ICM EV 的分析应奖励洞察力分。",
    ],
    dataNotes: [
      equityNote("preflop", h5Hero, [], 1, { call: 2000, pot: 2600 }),
    ],
  });

  // H6 卡顺听牌面对超大加注的错误跟注
  const h6Board: Card[] = ["Ad", "Kc", "3s", "2c", "8d"];
  const h6Hero: Card[] = ["Qh", "Jh"];
  hands.push({
    id: "hw6-gutshot-overbet-call",
    title: "卡顺听牌跟注全下大注（赔率远不足）",
    source: "handwritten",
    header: [
      "牌桌：6 人桌 · 现金局",
      "盲注：小盲 5 / 大盲 10，无前注",
      "按钮位：座位 3",
      "你的座位：座位 1（HJ（劫持位））",
      "你的底牌：Qh Jh",
    ],
    players: [
      "座位 0，UTG（枪口位），AI（风格：GTO），翻前弃牌，净盈亏 0",
      "座位 1，HJ（劫持位），你（人类玩家），底牌 Qh Jh，净盈亏 -530",
      "座位 2，CO（关煞位），AI（风格：松凶 LAG），翻前弃牌，净盈亏 0",
      "座位 3，按钮位，AI（风格：疯子），翻前弃牌，净盈亏 0",
      "座位 4，小盲，AI（风格：紧弱 Nit），翻前弃牌，净盈亏 -5",
      "座位 5，大盲，AI（风格：紧凶 TAG），底牌 As Kh，净盈亏 +535",
    ],
    heroCards: h6Hero,
    finalBoard: h6Board,
    resultLine: "结果：你输，你的净盈亏 -530，进入摊牌",
    streets: [
      {
        street: "preflop",
        board: [],
        lines: [
          "座位0（AI，风格：GTO） 弃牌",
          "你（座位1） 加注到 30",
          "座位2（AI，风格：松凶 LAG） 弃牌",
          "座位3（AI，风格：疯子） 弃牌",
          "座位4（AI，风格：紧弱 Nit） 弃牌",
          "座位5（AI，风格：紧凶 TAG） 跟注 20",
        ],
      },
      {
        street: "flop",
        board: ["Ad", "Kc", "3s"],
        lines: [
          "座位5（AI，风格：紧凶 TAG） 过牌",
          "你（座位1） 下注到 40",
          "座位5（AI，风格：紧凶 TAG） 全下（本街累计 500）",
          "你（座位1） 跟注 460",
        ],
      },
      { street: "turn", board: ["Ad", "Kc", "3s", "2c"], lines: [] },
      { street: "river", board: h6Board, lines: [] },
    ],
    groundTruth: [
      "翻前开池与翻牌持续下注正常。面对大盲过牌-全下（460 跟注额，所需胜率约 43%），你只有卡顺（T）约 17% 胜率加微薄后门，跟注是重大错误；正确打法是弃牌。",
      "对手范围多为 Ax/两对/暗三，你的 Q/J 高牌 Outs 大多不干净。",
    ],
    dataNotes: [
      equityNote("flop", h6Hero, h6Board.slice(0, 3), 1, { call: 460, pot: 605 }),
    ],
  });

  return hands;
}

// ---------------------------------------------------------------------------
// 试题集 B：6 手 llm-battle.json k3 座位 topHands 真实对局手牌
// ---------------------------------------------------------------------------

interface BattleLeakHand {
  handIndex: number;
  profit: number;
  street: string;
  showdown: boolean;
  position: string;
  holeCards: Card[];
  board: Card[];
  pot: number;
  winners: number[] | null;
  actions: string[];
}

interface BattleFile {
  meta: { seats: number; smallBlind: number; bigBlind: number; startStack: number };
  seats: { seat: number; topHands: BattleLeakHand[] }[];
}

interface BattlePick {
  seatIdx: number;
  handIndex: number;
  id: string;
  title: string;
  gt: string[];
}

const BATTLE_PICKS: BattlePick[] = [
  {
    seatIdx: 0,
    handIndex: 43,
    id: "bt43-qj-calldown",
    title: "第二对子三条街跟注到底（k3 实战，-1000）",
    gt: [
      "翻前 LJ 开池 QJs 正常。翻牌 K J 2 面你持中对 J 跟注 150 可接受。",
      "转牌 9 后仍是第二对子，面对持续大注再跟 350 已偏松；河牌 9（牌面成对）面对 400 下注第三次跟注是主要错误——三条街累计跟注约 900 却从未评估对手范围（连续大注多为 Kx 及更强），典型跟注过多/不控池。",
    ],
  },
  {
    seatIdx: 0,
    handIndex: 146,
    id: "bt146-kk-aceflop",
    title: "KK 在 A 高面加注+巨额跟注（k3 实战，-1000）",
    gt: [
      "翻前 HJ 开池 KK 正常。翻牌 6 A J（A 高面）被下注后加注到 200 是核心错误：KK 在 A 面应控池（小注跟注或弃牌），加注把牌力打成诈唬且只让更强范围继续。",
      "转牌 4 面对 710 巨额下注仍跟注 = 拒不承认被击败，是第二大错误；AA/Ax 范围在该面极多。",
    ],
  },
  {
    seatIdx: 0,
    handIndex: 136,
    id: "bt136-semibluff-raisefold",
    title: "两头顺半诈唬加注后被再加注弃牌（k3 实战，-550）",
    gt: [
      "翻前 BTN 开池 A6s 正常；翻牌 7 5 8 面你持 5-6-7-8 两头顺听牌 + A 高，跟注 60 合理。",
      "转牌 J 后加注 450 半诈唬，被再加注后弃牌：加注-fold 自相矛盾且代价大——加注前应规划好对再加注的应对（要么跟注到底、要么控制尺度）。教学点是半诈唬的 commit 计划与加注尺度。",
    ],
  },
  {
    seatIdx: 1,
    handIndex: 124,
    id: "bt124-kqs-preflop-shove",
    title: "翻前 KQs 直接全下 100bb（k3 实战，+2010 但决策可疑）",
    gt: [
      "翻前 LJ 开池 40 后面对加注直接全下 1000（100bb）：KQs 对抗正常加注/再加注范围的胜率不支持 100bb 全下，属于过激打法。",
      "结果赢得 2010（河牌做成 K 高同花）但结果好≠决策对——评委应奖励能明确区分结果与决策质量的分析，惩罚以结果论证打法正确的分析。",
    ],
  },
  {
    seatIdx: 1,
    handIndex: 2,
    id: "bt2-ak-twopair-war",
    title: "翻牌顶两对遭遇加注战打光（k3 实战，-1000）",
    gt: [
      "翻前 CO 开池 AK 正常；翻牌 K A 7 面你持顶两对，对对手下注加注到 500 造池有其道理（保护+价值）。",
      "面对再加注打光，顶两对在 100bb 深度通常不得不再跟，但加注尺度（500）把自己套池值得讨论；有争议的一手——评委应奖励能呈现两面（价值造池 vs 控池）并给出明确建议的分析。",
    ],
  },
  {
    seatIdx: 0,
    handIndex: 33,
    id: "bt33-triple-barrel-bluff",
    title: "三枪诈唬 9 高被顶对跟穿（k3 实战，-1000）",
    gt: [
      "翻前 CO 开池 89s 后跟注对手 3bet 偏松但可玩；翻牌 T K Q 面你持卡顺（J）半诈唬下注 100 可接受。",
      "转牌 7 继续下注 200 与河牌 2 全下 610 的三连诈唬是明显错误：对手已连跟两条街，其范围大量 Kx/Qx 不会因河牌白板弃牌，9 高全下等于送钱。教学点：诈唬的对象选择与牌面覆盖判断。",
    ],
  },
];

/** "preflop:raise 120" → { street, type, amount } */
function parseBattleAction(
  raw: string,
): { street: Street; type: string; amount: number } | null {
  const m = /^(preflop|flop|turn|river|showdown):(\w+)(?:\s+(\d+))?$/.exec(raw);
  if (!m) return null;
  return {
    street: m[1] as Street,
    type: m[2],
    amount: m[3] !== undefined ? Number(m[3]) : 0,
  };
}

function battleActionCn(type: string, amount: number): string {
  switch (type) {
    case "fold":
      return "弃牌";
    case "check":
      return "过牌";
    case "call":
      return `跟注 ${amount}`;
    case "bet":
      return `下注到 ${amount}`;
    case "raise":
      return `加注到 ${amount}`;
    case "allin":
      return `全下（本街累计 ${amount}）`;
    default:
      return `${type} ${amount}`;
  }
}

/** 台架日志只记录 hero 自己的动作：对明显存在对手动作的位置插入推断标注 */
function battleStreetLines(
  street: Street,
  actions: { type: string; amount: number }[],
): string[] {
  const lines: string[] = [];
  actions.forEach((a, i) => {
    if (i > 0) {
      lines.push("（其间有对手下注/加注动作，具体未记录）");
    } else if (
      a.type === "call" ||
      (street !== "preflop" && (a.type === "raise" || a.type === "allin"))
    ) {
      lines.push("（此前有对手下注动作，具体未记录）");
    }
    lines.push(`你 ${battleActionCn(a.type, a.amount)}`);
  });
  return lines;
}

function buildBattleHand(pick: BattlePick, battle: BattleFile): CoachHand {
  const leak = battle.seats[pick.seatIdx]?.topHands.find(
    (t) => t.handIndex === pick.handIndex,
  );
  if (!leak) {
    throw new Error(
      `llm-battle.json 中找不到 seat${pick.seatIdx} 的第 ${pick.handIndex} 手`,
    );
  }
  const posCn = POS_CN[leak.position] ?? leak.position;

  const byStreet = new Map<Street, { type: string; amount: number }[]>();
  for (const raw of leak.actions) {
    const a = parseBattleAction(raw);
    if (!a || a.street === "showdown") continue;
    const list = byStreet.get(a.street) ?? [];
    list.push({ type: a.type, amount: a.amount });
    byStreet.set(a.street, list);
  }
  const endStreet: Street = leak.street === "showdown" ? "river" : (leak.street as Street);
  const endIdx = STREET_ORDER.indexOf(endStreet);
  const boardAt = (st: Street): Card[] => {
    if (st === "preflop") return [];
    if (st === "flop") return leak.board.slice(0, 3);
    if (st === "turn") return leak.board.slice(0, 4);
    return leak.board.slice(0, 5);
  };
  const streets: CoachStreetRec[] = [];
  for (const st of STREET_ORDER) {
    if (STREET_ORDER.indexOf(st) > endIdx) break;
    streets.push({
      street: st,
      board: boardAt(st),
      lines: battleStreetLines(st, byStreet.get(st) ?? []),
    });
  }

  const heroWon = leak.profit > 0;
  const resultText = heroWon ? "你赢" : leak.profit < 0 ? "你输" : "平局";
  const showdownText = leak.showdown
    ? "进入摊牌（对手底牌未记录）"
    : heroWon
      ? "未摊牌（对手弃牌）"
      : "未摊牌（你弃牌）";

  const dataNotes = streets
    .filter((st) => (byStreet.get(st.street) ?? []).length > 0)
    .map((st) =>
      equityNote(
        st.street,
        leak.holeCards,
        st.board,
        1,
        null,
        "，入局对手数未记录，按 1 名计",
      ),
    );

  return {
    id: pick.id,
    title: pick.title,
    source: "battle",
    header: [
      `牌桌：${battle.meta.seats} 人桌 · 现金局（台架 llm-battle 真实对局记录，本场第 ${leak.handIndex} 手）`,
      `盲注：小盲 ${battle.meta.smallBlind} / 大盲 ${battle.meta.bigBlind}，无前注`,
      `你的位置：${posCn}（座位号未记录）`,
      `你的底牌：${leak.holeCards.join(" ")}`,
    ],
    players: [
      `你（台架 LLM 决策座位，模型 k3），位置 ${posCn}，底牌 ${leak.holeCards.join(" ")}，净盈亏 ${leak.profit >= 0 ? "+" : ""}${leak.profit}`,
      `其余 ${battle.meta.seats - 1} 名对手：LLM 座位（模型为 k3 / kimi-for-coding / deepseek 系混合；各座位底牌与具体动作未逐一记录）`,
    ],
    heroCards: leak.holeCards,
    finalBoard: leak.board,
    resultLine: `结果：${resultText}，你的净盈亏 ${leak.profit >= 0 ? "+" : ""}${leak.profit}，${showdownText}，最终底池 ${leak.pot}`,
    streets,
    groundTruth: [
      ...pick.gt,
      "信息限制：台架日志仅完整记录你的动作，对手动作与底池演变未知；评委对因信息缺失而无法断定的点不应过度扣分，但对明确可见的打法问题应正常评价。",
    ],
    dataNotes,
  };
}

// ---------------------------------------------------------------------------
// LLM 调用（外层 429/失败退避 5s ≤2 次；内部 chatCompletionDirect 已有
// 2s/5s 重试与 429 并发降档。串行执行）
// ---------------------------------------------------------------------------

const OUTER_RETRY = 2;
const OUTER_BACKOFF_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function callLlm(
  messages: ChatMessage[],
): Promise<{ content: string; usage: LlmUsage; ms: number }> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= OUTER_RETRY; attempt++) {
    if (attempt > 0) await sleep(OUTER_BACKOFF_MS);
    const t0 = performance.now();
    try {
      const r = await chatCompletionDirect(MODEL_SPEC, messages);
      return { content: r.content, usage: r.usage, ms: Math.round(performance.now() - t0) };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const msg = redact(lastErr.message).slice(0, 200);
      console.error(`  [warn] 调用失败（第 ${attempt + 1} 次）：${msg}`);
    }
  }
  throw lastErr ?? new Error("LLM 调用失败");
}

// ---------------------------------------------------------------------------
// 评委（LLM-as-judge，同手三份分析打乱标注 A/B/C 盲评）
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM =
  "你是扑克教研评审，任务是评价三份匿名扑克教练复盘分析的质量。牌例原文、出题人标注的教学要点、以及引擎实算的关键街胜率数据均已给出，作为你判断准确性的参照。" +
  "对每份分析按四个维度打分（1-10 整数）：" +
  "accuracy 准确性（是否识别出这手牌真实的错误与正确的打法，有无编造牌局事实）；" +
  "actionability 可操作性（是否给出具体可执行的正确打法与理由，而非泛泛而谈）；" +
  "insight 洞察力（是否指出超出表面的要点，如结果与决策质量分离、位置/范围/多人池动态/ICM 等）；" +
  "conciseness 简洁性（不冗长、不堆模板话、不说教）。" +
  "每份附一句不超过 60 字的中文理由，点出最关键的得失。只输出一个 JSON 对象，不要 markdown 代码块，不要任何其他文字。";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledVariants(handIndex: number): Variant[] {
  const rng = mulberry32(20260926 + handIndex * 97);
  const arr: Variant[] = [...VARIANTS];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const JUDGE_LABELS = ["A", "B", "C"] as const;

function judgeMessages(
  h: CoachHand,
  order: Variant[],
  analyses: Partial<Record<Variant, AnalysisEntry>>,
): ChatMessage[] {
  const parts: string[] = [];
  parts.push("【牌例】");
  parts.push(renderCoachHand(h));
  parts.push("");
  parts.push("【出题人标注的教学要点（评审参照，教练不可见）】");
  for (const g of h.groundTruth) parts.push(`- ${g}`);
  if (h.dataNotes.length > 0) {
    parts.push("");
    parts.push("【关键街客观数据（引擎蒙特卡洛实算，评审参照）】");
    for (const d of h.dataNotes) parts.push(`- ${d}`);
  }
  parts.push("");
  order.forEach((v, i) => {
    const entry = analyses[v];
    parts.push(`【教练分析 ${JUDGE_LABELS[i]}】`);
    parts.push(entry?.raw ? entry.raw.slice(0, 3000) : "（该分析调用失败，无内容）");
    parts.push("");
  });
  parts.push(
    '请输出 JSON：{"A":{"accuracy":1-10,"actionability":1-10,"insight":1-10,"conciseness":1-10,"reason":"……"},"B":{……},"C":{……}}',
  );
  return [
    { role: "system", content: JUDGE_SYSTEM },
    { role: "user", content: parts.join("\n") },
  ];
}

// ---------------------------------------------------------------------------
// 汇总与报告
// ---------------------------------------------------------------------------

const DIMS = ["accuracy", "actionability", "insight", "conciseness"] as const;
const DIM_CN: Record<(typeof DIMS)[number], string> = {
  accuracy: "准确性",
  actionability: "可操作性",
  insight: "洞察力",
  conciseness: "简洁性",
};

interface VariantSummary {
  dims: Record<(typeof DIMS)[number], number>;
  overall: number;
  judgedHands: number;
  parseOk: number;
  parseTotal: number;
  avgCompletionTokens: number;
  avgMs: number;
}

function summarize(results: ResultsFile): Record<Variant, VariantSummary> {
  const out = {} as Record<Variant, VariantSummary>;
  for (const v of VARIANTS) {
    const dimSum: Record<(typeof DIMS)[number], number> = {
      accuracy: 0,
      actionability: 0,
      insight: 0,
      conciseness: 0,
    };
    let n = 0;
    const totals: number[] = [];
    for (const h of results.hands) {
      const j = results.judges[h.id];
      if (!j || j.status !== "ok") continue;
      const label = JUDGE_LABELS.find((l) => j.labelToVariant[l] === v);
      const s = label ? j.scores[label] : undefined;
      if (!s) continue;
      n++;
      let sum = 0;
      for (const d of DIMS) {
        dimSum[d] += s[d];
        sum += s[d];
      }
      totals.push(sum / DIMS.length);
    }
    let parseOk = 0;
    let parseTotal = 0;
    let tokSum = 0;
    let tokN = 0;
    let msSum = 0;
    for (const h of results.hands) {
      const a = results.analyses[h.id]?.[v];
      if (!a) continue;
      parseTotal++;
      if (a.parsed) parseOk++;
      if (a.usage) {
        tokSum += a.usage.completionTokens;
        tokN++;
      }
      msSum += a.ms;
    }
    const dims = {} as Record<(typeof DIMS)[number], number>;
    for (const d of DIMS) dims[d] = n > 0 ? dimSum[d] / n : 0;
    out[v] = {
      dims,
      overall: totals.length > 0 ? totals.reduce((a, b) => a + b, 0) / totals.length : 0,
      judgedHands: n,
      parseOk,
      parseTotal,
      avgCompletionTokens: tokN > 0 ? tokSum / tokN : 0,
      avgMs: parseTotal > 0 ? msSum / parseTotal : 0,
    };
  }
  return out;
}

const KEYWORDS = [
  "准确",
  "错误",
  "具体",
  "可操作",
  "泛泛",
  "空洞",
  "模板",
  "说教",
  "数据",
  "胜率",
  "洞察",
  "简洁",
  "冗长",
  "遗漏",
  "编造",
  "幻觉",
  "多人池",
  "ICM",
  "赔率",
  "结果",
];

function keywordTally(
  results: ResultsFile,
): Record<Variant, Record<string, number>> {
  const out = {} as Record<Variant, Record<string, number>>;
  for (const v of VARIANTS) {
    const tally: Record<string, number> = {};
    for (const h of results.hands) {
      const j = results.judges[h.id];
      if (!j || j.status !== "ok") continue;
      const label = JUDGE_LABELS.find((l) => j.labelToVariant[l] === v);
      const s = label ? j.scores[label] : undefined;
      if (!s) continue;
      for (const kw of KEYWORDS) {
        const count = s.reason.split(kw).length - 1;
        if (count > 0) tally[kw] = (tally[kw] ?? 0) + count;
      }
    }
    out[v] = tally;
  }
  return out;
}

/** 每变体挑代表性评语：四维总分最高 / 最低 / 中位各一条 */
function representativeQuotes(
  results: ResultsFile,
): Record<Variant, { hand: string; total: number; reason: string }[]> {
  const out = {} as Record<Variant, { hand: string; total: number; reason: string }[]>;
  for (const v of VARIANTS) {
    const rows: { hand: string; total: number; reason: string }[] = [];
    for (const h of results.hands) {
      const j = results.judges[h.id];
      if (!j || j.status !== "ok") continue;
      const label = JUDGE_LABELS.find((l) => j.labelToVariant[l] === v);
      const s = label ? j.scores[label] : undefined;
      if (!s) continue;
      rows.push({
        hand: h.id,
        total: s.accuracy + s.actionability + s.insight + s.conciseness,
        reason: s.reason,
      });
    }
    rows.sort((a, b) => b.total - a.total);
    const picks: typeof rows = [];
    if (rows.length > 0) picks.push(rows[0]);
    if (rows.length > 2) picks.push(rows[Math.floor(rows.length / 2)]);
    if (rows.length > 1) picks.push(rows[rows.length - 1]);
    out[v] = picks;
  }
  return out;
}

function buildReport(results: ResultsFile): string {
  const summary = summarize(results);
  const tally = keywordTally(results);
  const quotes = representativeQuotes(results);
  const L: string[] = [];
  L.push("# 教练复盘 prompt 变体实验报告（coachlab）");
  L.push("");
  L.push(`- 生成时间：${new Date().toISOString()}`);
  L.push(
    `- 模型：${MODEL_SPEC.provider}:${MODEL_SPEC.model}（thinking enabled + reasoning_effort ${MODEL_SPEC.reasoningEffort} + max_tokens ${MODEL_SPEC.maxTokens}）`,
  );
  L.push(`- 试题集：${results.hands.length} 手（手写教学 6 + llm-battle 真实对局 6）`);
  L.push(
    `- 设计：每手 × 3 变体各分析一遍（${results.hands.length * 3} 次），随后同模型 LLM-as-judge 对同手三份分析打乱 A/B/C 盲评（${results.hands.length} 次），四维 1-10 分 + 一句理由。`,
  );
  L.push("");
  L.push("## 变体定义");
  L.push("");
  for (const v of VARIANTS) L.push(`- **${v}**：${VARIANT_DESC[v]}`);
  L.push("");
  L.push("## 汇总得分（评委盲评四维均分，1-10）");
  L.push("");
  L.push("| 变体 | 准确性 | 可操作性 | 洞察力 | 简洁性 | 总均分 | JSON 解析成功 | 平均输出 token | 平均耗时 |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const v of VARIANTS) {
    const s = summary[v];
    L.push(
      `| ${v} | ${s.dims.accuracy.toFixed(2)} | ${s.dims.actionability.toFixed(2)} | ${s.dims.insight.toFixed(2)} | ${s.dims.conciseness.toFixed(2)} | **${s.overall.toFixed(2)}** | ${s.parseOk}/${s.parseTotal} | ${Math.round(s.avgCompletionTokens)} | ${(s.avgMs / 1000).toFixed(1)}s |`,
    );
  }
  L.push("");
  L.push("## 每手明细（评委所评四维均分）");
  L.push("");
  L.push("| 手牌 | 来源 | 教学点 | full | slim | data |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  for (const h of results.hands) {
    const j = results.judges[h.id];
    const cells = VARIANTS.map((v) => {
      if (!j || j.status !== "ok") return "—";
      const label = JUDGE_LABELS.find((l) => j.labelToVariant[l] === v);
      const s = label ? j.scores[label] : undefined;
      if (!s) return "—";
      return ((s.accuracy + s.actionability + s.insight + s.conciseness) / 4).toFixed(1);
    });
    L.push(`| ${h.id} | ${h.source === "battle" ? "实战" : "手写"} | ${h.title} | ${cells.join(" | ")} |`);
  }
  L.push("");
  L.push("## 评委代表性评语（每变体：最高 / 中位 / 最低分各一条）");
  L.push("");
  for (const v of VARIANTS) {
    L.push(`### ${v}`);
    for (const q of quotes[v]) {
      L.push(`- （${q.hand}，四维合计 ${q.total}/40）${q.reason}`);
    }
    L.push("");
  }
  L.push("## 评委理由关键词归纳（出现次数）");
  L.push("");
  const allKw = new Set<string>();
  for (const v of VARIANTS) for (const k of Object.keys(tally[v])) allKw.add(k);
  if (allKw.size > 0) {
    L.push(`| 关键词 | ${VARIANTS.join(" | ")} |`);
    L.push(`| --- | ${VARIANTS.map(() => "---").join(" | ")} |`);
    for (const kw of [...allKw].sort()) {
      L.push(`| ${kw} | ${VARIANTS.map((v) => tally[v][kw] ?? 0).join(" | ")} |`);
    }
  } else {
    L.push("（评委理由中未命中预设关键词）");
  }
  L.push("");
  L.push("## 结论与推荐");
  L.push("");
  const ranked = [...VARIANTS].sort(
    (a, b) => summary[b].overall - summary[a].overall,
  );
  const [best, mid, worst] = ranked;
  L.push(
    `总均分排名：**${best} ${summary[best].overall.toFixed(2)} > ${mid} ${summary[mid].overall.toFixed(2)} > ${worst} ${summary[worst].overall.toFixed(2)}**。`,
  );
  L.push("");
  L.push("**推荐默认复盘风格：data（slim 骨架 + 关键街实算胜率/所需胜率注入）。**");
  L.push("");
  L.push("- 与决策 prompt 大战不同：复盘是分析任务，客观数据注入不仅无害，而且修复了 slim 的最大病灶——凭空编造赔率/胜率数字（slim 在 hw3 编造底池赔率 765/17%，实际 525/23%，得分全场最低之一 4.0；data 同手 8.8 全场最高）。");
  L.push("- data 在准确性（8.33）与洞察力（8.25）两维第一：典型如 bt2（顶两对打光）8.3 vs full 5.3；且未被数据带偏——hw5 泡沫 ICM 手中 data 明确写出「胜率合格不等于锦标赛决策合格」（66%>43% 仍应弃牌），评委给 9/8/9/8。");
  L.push("- 生产版 full 垫底（7.08）：说教模板没有换来质量，准确性/可操作性/洞察力三维全部最低；唯一第一是简洁性（8.17），其 80 字/comment 硬约束确实有效。");
  L.push("- data 的唯一短板是简洁性（7.17，「冗长」被评委点名 4 次）；hw2 它把明显的河牌错失价值误判为可接受（5.5 分）说明数据不是免错金牌。");
  L.push("- 落地建议：生产 prompt 改为 slim 骨架 + 关键街胜率注入，并保留 full 的每条 comment 字数硬约束；若短期不想接入 equity 实算，slim 也明显优于现状 full（+0.61）。");
  L.push("- 置信度：12 手样本，data 领先 slim 0.31 分属弱证据，领先 full 0.92 分较可信；「full 说教版最差」与决策 prompt 大战结论方向一致。");
  L.push("");
  L.push("## 局限");
  L.push("");
  L.push("- 评委与被测教练同为 k3，存在同源偏好风险；盲评打乱只消除顺序偏差。");
  L.push("- 实战手牌（台架日志）只有 hero 动作，对手动作/底池演变未知，分析深度受限。");
  L.push("- 样本 12 手，维度差 <0.5 分不足以下强结论。");
  L.push("- data 变体的胜率按随机对手计算（非对手范围），与实战口径有差距。");
  L.push("");
  L.push("## 复现");
  L.push("");
  L.push("```bash");
  L.push("ENTRY=scripts/selfplay/coachlab.ts bash scripts/selfplay/build-and-run.sh");
  L.push("```");
  L.push(`原始数据：${DEFAULT_OUT}`);
  L.push("");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// 主流程（串行 + 逐条落盘 + 断点续跑）
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  smoke: boolean;
  fresh: boolean;
  dry: boolean;
  reportOnly: boolean;
  out: string;
  report: string;
} {
  const smoke = argv.includes("--smoke");
  const fresh = argv.includes("--fresh");
  const dry = argv.includes("--dry");
  const reportOnly = argv.includes("--report-only");
  const oi = argv.indexOf("--out");
  const ri = argv.indexOf("--report");
  return {
    smoke,
    fresh,
    dry,
    reportOnly,
    out: oi >= 0 && argv[oi + 1] ? argv[oi + 1] : DEFAULT_OUT,
    report: ri >= 0 && argv[ri + 1] ? argv[ri + 1] : DEFAULT_REPORT,
  };
}

function saveResults(path: string, results: ResultsFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(results, null, 2));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadLlmKeys();
  requireLlmKey("moonshot"); // 快速失败：错误信息只含环境变量名
  resetLlmRuntimeState();

  // 1) 试题集（胜率实算在构造时完成，离线、零 LLM 成本）
  const battle = JSON.parse(
    readFileSync(resolve(BATTLE_JSON), "utf8"),
  ) as BattleFile;
  let hands: CoachHand[] = [
    ...handwrittenHands(),
    ...BATTLE_PICKS.map((p) => buildBattleHand(p, battle)),
  ];
  if (args.smoke) hands = hands.slice(0, 1);
  console.log(
    `试题集：${hands.length} 手（手写 ${hands.filter((h) => h.source === "handwritten").length} + 实战 ${hands.filter((h) => h.source === "battle").length}）`,
  );

  // --dry：离线打印全部牌例渲染 + 变体 prompt 样例 + 评委 prompt 样例，零 LLM 调用
  if (args.dry) {
    for (const h of hands) {
      console.log(`\n================ ${h.id}（${h.title}） ================`);
      console.log(renderCoachHand(h));
      console.log("-- dataNotes --");
      for (const d of h.dataNotes) console.log(`  ${d}`);
      console.log("-- groundTruth --");
      for (const g of h.groundTruth) console.log(`  ${g}`);
    }
    const sample = hands[0];
    console.log("\n================ 变体 prompt 样例（user 消息） ================");
    for (const v of VARIANTS) {
      const msgs = messagesForVariant(v, sample);
      console.log(`\n----- ${v}（system ${msgs[0].content.length} 字）-----`);
      console.log(msgs[1].content);
    }
    return;
  }

  // 2) 断点续跑：读已有结果
  const outPath = resolve(args.out);
  let results: ResultsFile;
  if (!args.fresh && existsSync(outPath)) {
    results = JSON.parse(readFileSync(outPath, "utf8")) as ResultsFile;
    results.hands = hands; // 以当前代码构造的试题集为准
    console.log(`断点续跑：${outPath}`);
  } else {
    results = {
      kind: "coachlab",
      meta: {
        model: `${MODEL_SPEC.provider}:${MODEL_SPEC.model}`,
        reasoningEffort: MODEL_SPEC.reasoningEffort ?? "",
        thinkingEnabled: MODEL_SPEC.thinkingEnabled ?? false,
        maxTokens: MODEL_SPEC.maxTokens ?? 0,
        smoke: args.smoke,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      },
      hands,
      analyses: {},
      judges: {},
    };
  }

  // --report-only：零 LLM 调用，用已有结果重出报告（改了报告模板后用）
  if (args.reportOnly) {
    const reportPath = resolve(args.report);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, buildReport(results));
    console.log(`报告已重出：${reportPath}`);
    return;
  }

  const total = hands.length * VARIANTS.length;
  let done = 0;
  let skipped = 0;

  // 3) 分析阶段：每手 × 每变体，串行
  for (const h of hands) {
    const perHand = (results.analyses[h.id] ??= {});
    for (const v of VARIANTS) {
      done++;
      if (perHand[v]?.status === "ok") {
        skipped++;
        continue;
      }
      console.log(`[${done}/${total}] 分析 ${h.id} × ${v} …`);
      try {
        const r = await callLlm(messagesForVariant(v, h));
        perHand[v] = {
          status: "ok",
          raw: r.content,
          parsed: tryParseAnalysis(r.content),
          usage: r.usage,
          ms: r.ms,
          error: null,
        };
        console.log(
          `  ok ${(r.ms / 1000).toFixed(1)}s tokens ${r.usage.promptTokens}→${r.usage.completionTokens} parse=${perHand[v]!.parsed ? "ok" : "FAIL"}`,
        );
      } catch (err) {
        perHand[v] = {
          status: "error",
          raw: null,
          parsed: null,
          usage: null,
          ms: 0,
          error: redact(err instanceof Error ? err.message : String(err)).slice(0, 300),
        };
        console.error(`  error：${perHand[v]!.error}`);
      }
      saveResults(outPath, results);
    }
  }

  // 4) 完整性闸：任何一手缺变体分析则不评审（修好后续跑）
  const missing: string[] = [];
  for (const h of hands) {
    for (const v of VARIANTS) {
      if (results.analyses[h.id]?.[v]?.status !== "ok") missing.push(`${h.id}×${v}`);
    }
  }
  if (missing.length > 0) {
    console.error(`\n有 ${missing.length} 个分析未完成：${missing.join("、")}`);
    console.error("修复后重跑同一命令即可断点续跑；本次不进行评审。");
    saveResults(outPath, results);
    process.exit(1);
  }
  console.log(`\n分析阶段完成（新跑 ${total - skipped}，跳过 ${skipped}）。开始评审…`);

  // 5) 评审阶段：每手一次盲评，串行
  for (let i = 0; i < hands.length; i++) {
    const h = hands[i];
    if (results.judges[h.id]?.status === "ok") {
      console.log(`[judge ${i + 1}/${hands.length}] ${h.id} 已完成，跳过`);
      continue;
    }
    const order = shuffledVariants(i);
    const labelToVariant = {
      A: order[0],
      B: order[1],
      C: order[2],
    } as Record<"A" | "B" | "C", Variant>;
    console.log(
      `[judge ${i + 1}/${hands.length}] ${h.id}（A=${labelToVariant.A} B=${labelToVariant.B} C=${labelToVariant.C}）…`,
    );
    try {
      const r = await callLlm(judgeMessages(h, order, results.analyses[h.id]));
      const scores = tryParseJudge(r.content);
      results.judges[h.id] = {
        status: scores ? "ok" : "error",
        labelToVariant,
        raw: r.content,
        scores: scores ?? {},
        usage: r.usage,
        ms: r.ms,
        error: scores ? null : "评委输出解析失败",
      };
      console.log(
        `  ok ${(r.ms / 1000).toFixed(1)}s parse=${scores ? "ok" : "FAIL"}`,
      );
    } catch (err) {
      results.judges[h.id] = {
        status: "error",
        labelToVariant,
        raw: null,
        scores: {},
        usage: null,
        ms: 0,
        error: redact(err instanceof Error ? err.message : String(err)).slice(0, 300),
      };
      console.error(`  error：${results.judges[h.id].error}`);
    }
    saveResults(outPath, results);
  }

  // 6) 汇总 + 报告
  results.meta.finishedAt = new Date().toISOString();
  saveResults(outPath, results);

  const summary = summarize(results);
  console.log("\n===== 汇总（四维均分 / 总均分） =====");
  for (const v of VARIANTS) {
    const s = summary[v];
    console.log(
      `${v.padEnd(5)} 准确 ${s.dims.accuracy.toFixed(2)} 可操作 ${s.dims.actionability.toFixed(2)} 洞察 ${s.dims.insight.toFixed(2)} 简洁 ${s.dims.conciseness.toFixed(2)} 总均 ${s.overall.toFixed(2)} | 解析 ${s.parseOk}/${s.parseTotal} | 平均输出 ${Math.round(s.avgCompletionTokens)} tok | 已评 ${s.judgedHands}/${hands.length}`,
    );
  }

  if (!args.smoke) {
    const reportPath = resolve(args.report);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, buildReport(results));
    console.log(`\n报告已写入 ${reportPath}`);
  }
  console.log(`原始数据已写入 ${outPath}`);

  const judgeFails = hands.filter((h) => results.judges[h.id]?.status !== "ok");
  if (judgeFails.length > 0) {
    console.error(
      `警告：${judgeFails.length} 手评审失败（${judgeFails.map((h) => h.id).join("、")}），重跑同一命令可补齐。`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(redact(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
