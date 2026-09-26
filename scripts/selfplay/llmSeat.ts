/**
 * scripts/selfplay/llmSeat.ts — 台架的 LLM 座位支持
 *
 * 与生产链路的差异：生产 src/lib/llm/client.ts 走浏览器 → /api/llm 代理；
 * 台架跑在 node 里，这里直连 `${baseUrl}/chat/completions`（OpenAI 兼容协议）。
 *
 * 安全红线：apiKey 只从环境变量读（DEEPSEEK_KEY / MOONSHOT_KEY，由
 * scripts/selfplay/llm-keys.env 注入 process.env），任何日志/异常/结果文件
 * 都只出现环境变量名，绝不出现 key 本体。
 *
 * 两种模式：
 * - agent：复用生产 prompt 链路 buildPrompt(input, brainStats(input))，
 *   含胜率数据 / 对手画像（opponentModels 由 match.ts F10 注入）/ 策略常识。
 * - raw（裸模型对照组）：极简 system + 只给底牌/公共牌/底池/筹码/合法动作/
 *   跟注额，不给任何统计数据与策略常识。
 * 两者输出都用生产 parseDecision 容错解析；解析失败视为本次 LLM 决策失败。
 *
 * 每次决策：30s 超时，失败重试 2 次（退避 2s/5s；400/401/403/404/422 属
 * 参数/权限错误，重试无意义，直接失败）。仍失败返回 null，调用方回退启发式
 * 并计 fallbacks++。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  Card,
  ChatMessage,
  DecideInput,
  PlayerAction,
  Street,
} from "@/lib/types";
import { brainStats } from "@/lib/ai/brain";
import { buildPrompt, parseDecision } from "@/lib/ai/prompt";

// ---------------------------------------------------------------------------
// 配置类型
// ---------------------------------------------------------------------------

export type LlmProvider = "deepseek" | "moonshot";

export interface LlmSeatSpec {
  provider: LlmProvider;
  /** 服务商侧 model id（如 deepseek-flash / kimi-k3-xxx） */
  model: string;
  /** true = 生产 prompt 链路（buildPrompt + brainStats）；false = 裸模型对照 */
  agent: boolean;
  /**
   * prompt 变体（full/raw/slim/stats/models，见下方 LlmPromptMode）。
   * 优先于 agent 字段；缺省时由 agent 推导（true→full / false→raw）。
   */
  promptMode?: LlmPromptMode;
  /** 显式设置才发送 reasoning_effort */
  reasoningEffort?: string;
  /** 显式设置才发送 thinking: {type: "enabled"|"disabled"} */
  thinkingEnabled?: boolean;
  /** 显式设置才发送 max_tokens */
  maxTokens?: number;
}

interface ProviderInfo {
  baseUrl: string;
  /** 存放 apiKey 的环境变量名（只引用名字，不引用值） */
  keyEnv: string;
}

const PROVIDERS: Record<LlmProvider, ProviderInfo> = {
  deepseek: { baseUrl: "https://api.deepseek.com", keyEnv: "DEEPSEEK_KEY" },
  moonshot: { baseUrl: "https://api.moonshot.cn/v1", keyEnv: "MOONSHOT_KEY" },
};

/** baseUrl 环境变量覆盖名（key 是 Kimi For Coding 订阅 key 时需指向 coding 端点） */
const BASE_URL_ENV: Record<LlmProvider, string> = {
  deepseek: "DEEPSEEK_BASE_URL",
  moonshot: "MOONSHOT_BASE_URL",
};

/**
 * 解析 provider 的 baseUrl：环境变量 <PROVIDER>_BASE_URL 优先，否则默认官方端点。
 * （实测本台架的 MOONSHOT_KEY 是 Kimi For Coding 订阅 key，官方 platform 端点
 * 401，需用 https://api.kimi.com/coding/v1 —— 在 llm-keys.env 里配置覆盖。）
 */
export function providerBaseUrl(provider: LlmProvider): string {
  loadLlmKeys();
  const override = process.env[BASE_URL_ENV[provider]]?.trim();
  return (override || PROVIDERS[provider].baseUrl).replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// key 加载（手写 dotenv 两行解析，不加依赖；绝不打印值）
// ---------------------------------------------------------------------------

let keysLoaded = false;

/** 从 scripts/selfplay/llm-keys.env 注入 process.env（已存在的变量不覆盖） */
export function loadLlmKeys(): void {
  if (keysLoaded) return;
  keysLoaded = true;
  const candidates = [
    resolve(process.cwd(), "scripts/selfplay/llm-keys.env"),
    resolve(__dirname, "../llm-keys.env"), // esbuild 打包后 __dirname = .dist
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) return; // 允许只靠外部环境变量
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

/** 取 key；缺失时报错（错误信息只含环境变量名） */
export function requireLlmKey(provider: LlmProvider): string {
  loadLlmKeys();
  const { keyEnv } = PROVIDERS[provider];
  const key = process.env[keyEnv];
  if (!key) {
    throw new Error(
      `缺少 ${provider} 的 apiKey：请设置环境变量 ${keyEnv}（或写入 scripts/selfplay/llm-keys.env）`,
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// 直连 chat/completions（30s 超时 + 重试 2 次，退避 2s/5s）
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 180_000; // high 思考单决策可能 60s+，给足 180s
const RETRY_DELAYS_MS = [2_000, 5_000];
/** 参数/权限类错误重试无意义，直接失败（400 且指明 max_tokens 的走降档，例外） */
const NO_RETRY_STATUS = new Set([400, 401, 403, 404, 422]);

// ---------------------------------------------------------------------------
// 每模型运行时调节：并发限制器（429 降档）+ max_tokens 兼容降档
// ---------------------------------------------------------------------------

/** handConcurrency 上限 12：每模型的初始在途请求上限（座位共享同模型时合并限流） */
const MODEL_CONCURRENCY_INIT = 12;
/** max_tokens 兼容降档阶梯（DeepSeek V4 官方上限 384000 起逐级下探） */
const MAX_TOKENS_LADDER = [384000, 131072, 65536, 32768, 16384, 8192];

interface ModelGate {
  limit: number;
  active: number;
  queue: Array<() => void>;
}

export interface ModelRuntimeInfo {
  events429: number;
  /** 当前生效的并发上限（429 时减半，最小 1） */
  concurrencyLimit: number;
  /** max_tokens 因 400 被降档后的接受值；未发生降档为 null */
  maxTokensClampedTo: number | null;
}

const modelGates = new Map<string, ModelGate>();
const modelRuntime = new Map<string, ModelRuntimeInfo>();

function modelKeyOf(spec: LlmSeatSpec): string {
  return `${spec.provider}:${spec.model}`;
}

function gateFor(key: string): ModelGate {
  let g = modelGates.get(key);
  if (!g) {
    g = { limit: MODEL_CONCURRENCY_INIT, active: 0, queue: [] };
    modelGates.set(key, g);
  }
  return g;
}

function runtimeFor(key: string): ModelRuntimeInfo {
  let r = modelRuntime.get(key);
  if (!r) {
    r = { events429: 0, concurrencyLimit: MODEL_CONCURRENCY_INIT, maxTokensClampedTo: null };
    modelRuntime.set(key, r);
  }
  return r;
}

async function acquireModelSlot(key: string): Promise<() => void> {
  const g = gateFor(key);
  if (g.active < g.limit) {
    g.active++;
  } else {
    await new Promise<void>((resolve) => g.queue.push(resolve));
    g.active++;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    g.active--;
    const next = g.queue.shift();
    if (next) next();
  };
}

/** 429：该模型并发上限减半（最小 1），计数进运行时报告 */
function noteRateLimited(key: string): void {
  const g = gateFor(key);
  const r = runtimeFor(key);
  r.events429++;
  g.limit = Math.max(1, Math.floor(g.limit / 2));
  r.concurrencyLimit = g.limit;
}

/** 400 且指明 max_tokens：记录降档目标值（后续请求直接用接受值） */
function noteMaxTokensClamp(key: string, accepted: number): void {
  runtimeFor(key).maxTokensClampedTo = accepted;
}

/** 每场 match 开始复位运行时调节状态（消除进程内历史污染） */
export function resetLlmRuntimeState(): void {
  modelGates.clear();
  modelRuntime.clear();
}

/** 运行时报告：并入 MatchResult.meta.llmRuntime（无 LLM 座位时为 null） */
export function getLlmRuntimeReport(): Record<string, ModelRuntimeInfo> | null {
  if (modelRuntime.size === 0) return null;
  const out: Record<string, ModelRuntimeInfo> = {};
  for (const [k, v] of modelRuntime) out[k] = { ...v };
  return out;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface LlmChatResult {
  content: string;
  usage: LlmUsage;
}

/** 粗略估算：无 usage 字段时按字符数 / 4 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 与生产 route.ts 同口径：兼容字符串与分片数组 content */
function extractContent(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .filter((t) => t.length > 0);
    return texts.length > 0 ? texts.join("") : null;
  }
  return null;
}

/** 组装请求体：高级参数仅在 config 显式设置时携带 */
export function buildChatBody(
  spec: LlmSeatSpec,
  messages: ChatMessage[],
): Record<string, unknown> {
  return {
    model: spec.model,
    messages,
    ...(spec.reasoningEffort !== undefined
      ? { reasoning_effort: spec.reasoningEffort }
      : {}),
    ...(spec.maxTokens !== undefined ? { max_tokens: spec.maxTokens } : {}),
    ...(spec.thinkingEnabled !== undefined
      ? { thinking: { type: spec.thinkingEnabled ? "enabled" : "disabled" } }
      : {}),
  };
}

/** 参数/权限类错误（NO_RETRY_STATUS）：标记后直通抛出，不进入重试 */
class NoRetryError extends Error {}

/**
 * 直连服务商发一次 chat completion。抛错即「本次决策失败」（含重试耗尽）。
 * 错误信息只含 HTTP 状态与上游 body 截断（上游不会回显 key）。
 *
 * 运行时兼容调节（按 provider:model 记忆，进 meta.llmRuntime）：
 * - 400 且错误文本指明 max_tokens：按 MAX_TOKENS_LADDER 逐级降档重试
 *   （不消耗失败重试次数），记住接受值供后续请求直接使用；
 * - 429：该模型并发上限减半并计数，本次请求按普通失败进入退避重试；
 * - 并发上限由每模型信号量执行（初始 12 = handConcurrency 上限）。
 */
export async function chatCompletionDirect(
  spec: LlmSeatSpec,
  messages: ChatMessage[],
): Promise<LlmChatResult> {
  const baseUrl = providerBaseUrl(spec.provider);
  const apiKey = requireLlmKey(spec.provider);
  const key = modelKeyOf(spec);
  const clamped = runtimeFor(key).maxTokensClampedTo;
  const body = buildChatBody(
    clamped !== null && spec.maxTokens !== undefined
      ? { ...spec, maxTokens: clamped }
      : spec,
    messages,
  );

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    const release = await acquireModelSlot(key);
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const msg = `${spec.provider} upstream ${res.status}: ${text.slice(0, 300)}`;
        if (res.status === 429) {
          noteRateLimited(key);
          lastErr = new Error(msg);
          continue;
        }
        // max_tokens 超大 400：按阶梯降档后原地重试（不消耗失败重试次数）
        if (
          res.status === 400 &&
          typeof body.max_tokens === "number" &&
          /max_?tokens/i.test(text)
        ) {
          const cur = body.max_tokens as number;
          // 阶梯降序排列：filter 后首项即「下一档」
          const next = MAX_TOKENS_LADDER.filter((v) => v < cur)[0];
          if (next !== undefined) {
            body.max_tokens = next;
            noteMaxTokensClamp(key, next);
            attempt--; // 降档重试不计入失败次数
            continue;
          }
        }
        if (NO_RETRY_STATUS.has(res.status)) throw new NoRetryError(msg);
        lastErr = new Error(msg);
        continue;
      }
      const data = (await res.json()) as {
        choices?: { message?: unknown; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = extractContent(data.choices?.[0]?.message);
      if (typeof content !== "string" || !content.trim()) {
        const fr = data.choices?.[0]?.finish_reason;
        lastErr = new Error(
          `${spec.provider} 空响应${fr === "length" ? "（max_tokens 截断）" : ""}`,
        );
        continue;
      }
      const usage: LlmUsage = {
        promptTokens:
          typeof data.usage?.prompt_tokens === "number"
            ? data.usage.prompt_tokens
            : messages.reduce((s, m) => s + estimateTokens(m.content), 0),
        completionTokens:
          typeof data.usage?.completion_tokens === "number"
            ? data.usage.completion_tokens
            : estimateTokens(content),
      };
      return { content, usage };
    } catch (err) {
      if (err instanceof NoRetryError) throw err;
      lastErr = err instanceof Error ? err : new Error(String(err));
    } finally {
      release();
    }
  }
  throw lastErr ?? new Error(`${spec.provider} 请求失败`);
}

// ---------------------------------------------------------------------------
// prompt 变体（llmSeat 内自构，不污染生产 prompt.ts）
// ---------------------------------------------------------------------------

/**
 * prompt 变体：
 * - full：现状生产 prompt（策略说教 + brainStats 胜率 + 对手画像 + 回顾）
 * - raw：现状极简（"按常识打出强牌"）
 * - slim：局面 + 合法动作金额 + JSON 格式 + 一行「按职业牌手标准做出最优
 *   决策」；零策略说教、零胜率数据、零画像、零回顾
 * - stats：slim + 仅数字注入（当前胜率 X%、跟注所需胜率 Y%，brainStats
 *   口径，文案明示"数据参考，不构成建议"）
 * - models：stats + 对手画像统计（只给数字，不给剥削建议文案）
 */
export type LlmPromptMode = "full" | "raw" | "slim" | "stats" | "models";

const PROMPT_MODES: readonly LlmPromptMode[] = ["full", "raw", "slim", "stats", "models"];

/** 生效 prompt 变体：promptMode 优先；缺省由 agent 推导（true→full / false→raw） */
export function effectivePromptMode(spec: LlmSeatSpec): LlmPromptMode {
  return spec.promptMode ?? (spec.agent ? "full" : "raw");
}

export function isValidPromptMode(v: unknown): v is LlmPromptMode {
  return typeof v === "string" && (PROMPT_MODES as readonly string[]).includes(v);
}

const RAW_STREET_NAMES: Record<Street, string> = {
  preflop: "翻前",
  flop: "翻牌圈",
  turn: "转牌圈",
  river: "河牌圈",
  showdown: "摊牌",
};

function fmtCardsRaw(cards: Card[]): string {
  return cards.length ? cards.join(" ") : "（无）";
}

function fmtActionRaw(a: PlayerAction): string {
  switch (a.type) {
    case "bet":
      return `bet（下注，amount 最小 ${a.amount}，最大为你的全下额）`;
    case "raise":
      return `raise（加注，amount 最小 ${a.amount}，最大为你的全下额）`;
    case "allin":
      return `allin（全下，amount=${a.amount}）`;
    case "call":
      return `call（跟注，需补 ${a.amount} 筹码）`;
    default:
      return `${a.type}（amount 固定为 0）`;
  }
}

const JSON_OUTPUT_RULE =
  '{"action":"fold|check|call|bet|raise|allin","amount":数字,"reasoning":"一句话中文说明"}' +
  "。不要输出任何其他文字，不要用 markdown 代码块。";

function rawMessages(input: DecideInput): ChatMessage[] {
  const { state } = input;
  const seat = state.currentSeat ?? 0;
  const me = state.players[seat];
  const system =
    "你在打德州扑克，按常识打出强牌。只输出一行 JSON：" + JSON_OUTPUT_RULE;
  const user =
    `【当前局面】${RAW_STREET_NAMES[state.street]}，${state.players.length} 人桌\n` +
    `- 你的底牌：${me.holeCards ? fmtCardsRaw(me.holeCards) : "未知"}\n` +
    `- 公共牌：${fmtCardsRaw(state.board)}\n` +
    `- 底池：${state.pot}\n` +
    `- 你的剩余筹码：${me.stack}；本街你已下注：${me.streetBet}\n` +
    `- 跟注需要补：${input.callAmount}\n` +
    `【合法动作】（bet/raise 的 amount 是本街下注到的累计总额，call 的 amount 是要补的筹码，fold/check 为 0）\n` +
    input.legalActions.map((a) => `- ${fmtActionRaw(a)}`).join("\n") +
    "\n只输出一行 JSON。";
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** slim/stats/models 共用：局面字段与 raw 相同，system 换成职业标准、零说教 */
function slimMessages(input: DecideInput, extras: string[]): ChatMessage[] {
  const { state } = input;
  const seat = state.currentSeat ?? 0;
  const me = state.players[seat];
  const system =
    "你是一名无限注德州扑克职业选手。按职业牌手标准做出最优决策。" +
    "只输出一行 JSON：" + JSON_OUTPUT_RULE;
  const user =
    `【当前局面】${RAW_STREET_NAMES[state.street]}，${state.players.length} 人桌\n` +
    `- 你的底牌：${me.holeCards ? fmtCardsRaw(me.holeCards) : "未知"}\n` +
    `- 公共牌：${fmtCardsRaw(state.board)}\n` +
    `- 底池：${state.pot}\n` +
    `- 你的剩余筹码：${me.stack}；本街你已下注：${me.streetBet}\n` +
    `- 跟注需要补：${input.callAmount}\n` +
    extras.filter((s) => s.length > 0).join("") +
    `【合法动作】（bet/raise 的 amount 是本街下注到的累计总额，call 的 amount 是要补的筹码，fold/check 为 0）\n` +
    input.legalActions.map((a) => `- ${fmtActionRaw(a)}`).join("\n") +
    "\n只输出一行 JSON。";
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** stats 段：仅数字注入（胜率 / 跟注所需胜率），明示"数据参考，不构成建议" */
function statsSection(input: DecideInput): string {
  const st = brainStats(input);
  if (!st) return "";
  const required =
    st.required !== null ? `约 ${(st.required * 100).toFixed(0)}%` : "（当前无需跟注）";
  return (
    `- 【数据参考】数学引擎：当前对抗 ${st.opponents} 名对手的胜率约 ` +
    `${(st.equity * 100).toFixed(0)}%${st.preflop ? "（翻前对随机范围）" : ""}` +
    `；本次跟注所需胜率${required}。仅为数据参考，不构成建议。\n`
  );
}

/** models 段：对手画像只给数字（样本/VPIP/PFR/AF/摊牌率），不给剥削建议 */
function modelsSection(input: DecideInput): string {
  const models = input.opponentModels ?? [];
  if (models.length === 0) return "";
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const lines = models.map((m) =>
    m.stats.hands < 10
      ? `- 座位 ${m.seat}：样本不足（仅 ${m.stats.hands} 手）`
      : `- 座位 ${m.seat}：${m.stats.hands} 手样本，` +
        `VPIP ${pct(m.vpip)}/PFR ${pct(m.pfr)}/AF ${m.af.toFixed(1)}/摊牌率 ${pct(m.wtsd)}`,
  );
  return (
    "【对手统计】（与本桌过往手牌的历史样本数字，仅为数据参考，不构成建议）\n" +
    lines.join("\n") +
    "\n"
  );
}

/** 按变体构造消息（导出供离线校验/测试；决策走 decideWithLlm） */
export function messagesForMode(spec: LlmSeatSpec, input: DecideInput): ChatMessage[] {
  switch (effectivePromptMode(spec)) {
    case "full": {
      const { system, user } = buildPrompt(input, brainStats(input));
      return [
        { role: "system", content: system },
        { role: "user", content: user },
      ];
    }
    case "slim":
      return slimMessages(input, []);
    case "stats":
      return slimMessages(input, [statsSection(input)]);
    case "models":
      return slimMessages(input, [modelsSection(input), statsSection(input)]);
    default:
      return rawMessages(input);
  }
}

// ---------------------------------------------------------------------------
// 决策入口：LLM 决策，失败（含解析失败）decision=null 由调用方回退启发式
// ---------------------------------------------------------------------------

export interface LlmDecision {
  action: PlayerAction;
  reasoning: string;
  usage: LlmUsage;
  /** 模型原文（前 500 字符，供决策日志） */
  content: string;
}

export interface LlmDecisionResult {
  decision: LlmDecision | null;
  /** 拿到响应时的原文（前 500 字符；解析失败时 decision=null 也有）；请求失败为 null */
  content: string | null;
  /** 拿到响应即有（解析失败也记账）；请求失败为 null */
  usage: LlmUsage | null;
}

export async function decideWithLlm(
  spec: LlmSeatSpec,
  input: DecideInput,
): Promise<LlmDecisionResult> {
  const messages = messagesForMode(spec, input);

  let result: LlmChatResult;
  try {
    result = await chatCompletionDirect(spec, messages);
  } catch (err) {
    if (process.env.LLM_DEBUG) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[llm-debug] ${spec.model} 调用失败: ${msg.slice(0, 300)}`);
    }
    return { decision: null, content: null, usage: null };
  }
  const content = result.content.slice(0, 500);
  const parsed = parseDecision(result.content, input.legalActions);
  if (!parsed) {
    if (process.env.LLM_DEBUG) {
      console.error(
        `[llm-debug] ${spec.model} 解析失败: ${result.content.slice(0, 200).replace(/\n/g, " ")}`,
      );
    }
    return { decision: null, content, usage: result.usage };
  }
  return {
    decision: { ...parsed, usage: result.usage, content },
    content,
    usage: result.usage,
  };
}

// ---------------------------------------------------------------------------
// 每座位 LLM 记账（token / fallback / 延迟）
// ---------------------------------------------------------------------------

export interface LlmSeatStats {
  /** LLM 决策次数（含失败回退的） */
  calls: number;
  tokensIn: number;
  tokensOut: number;
  /** 重试耗尽或解析失败 → 回退启发式的次数 */
  fallbacks: number;
  /** 决策总耗时（含重试等待），ms */
  msTotal: number;
}

export function createLlmSeatStats(): LlmSeatStats {
  return { calls: 0, tokensIn: 0, tokensOut: 0, fallbacks: 0, msTotal: 0 };
}
