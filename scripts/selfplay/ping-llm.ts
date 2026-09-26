/**
 * scripts/selfplay/ping-llm.ts — 模型大战前的连通性 / 参数兼容性验证
 *
 * 对每个将用的模型发一条短 ping（"回复 ok"），验证 key / 模型名 / 参数组合：
 * - deepseek: deepseek-flash、deepseek-v4-pro
 *   （agent 参数：thinkingEnabled true + reasoningEffort "low" + maxTokens 300）
 * - moonshot: 先 GET /v1/models 列出可用模型，挑出 K3 与 K2.7 的 id 再 ping
 *   （K2.7 Code 强制思考、可能不认识 thinking 字段：遇 400 逐级放弃
 *   thinking → reasoning_effort → max_tokens 重试，并在结果里记录兼容性）
 *
 * 安全红线：apiKey 只从环境变量读，日志/结果文件只出现环境变量名；
 * 上游错误体做 key 值脱敏后再记录。
 *
 * 执行：ENTRY=scripts/selfplay/ping-llm.ts bash scripts/selfplay/build-and-run.sh [--out <json>]
 * 默认输出 scripts/selfplay/results/llm-ping.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ChatMessage } from "@/lib/types";
import {
  buildChatBody,
  loadLlmKeys,
  providerBaseUrl,
  requireLlmKey,
  type LlmSeatSpec,
} from "./llmSeat";

const TIMEOUT_MS = 30_000;
const DEFAULT_OUT = "scripts/selfplay/results/llm-ping.json";

/** ping 用参数（与烟测 agent 参数一致） */
const PING_PARAMS = {
  reasoningEffort: "low",
  thinkingEnabled: true,
  maxTokens: 300,
} as const;

/** 400 时逐级放弃的字段（buildChatBody 的 body key） */
const DROP_STAGES: string[][] = [
  [], // 全参数
  ["thinking"],
  ["thinking", "reasoning_effort"],
  ["thinking", "reasoning_effort", "max_tokens"],
];

export interface PingResult {
  provider: string;
  model: string;
  ok: boolean;
  latencyMs: number;
  reply: string | null;
  usage: { promptTokens: number; completionTokens: number } | null;
  paramCompat: {
    requested: string[];
    /** 因 400 被放弃的字段（顺序 = 放弃顺序） */
    dropped: string[];
    notes: string;
  };
  error: string | null;
}

/** 脱敏：把 key 本体从任意待记录文本中抹掉（双保险） */
function redact(text: string): string {
  let out = text;
  for (const env of ["DEEPSEEK_KEY", "MOONSHOT_KEY"]) {
    const v = process.env[env];
    if (v) out = out.split(v).join(`[${env}]`);
  }
  return out;
}

async function listMoonshotModels(): Promise<string[]> {
  const key = requireLlmKey("moonshot");
  const res = await fetch(`${providerBaseUrl("moonshot")}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET moonshot /models ${res.status}: ${redact(text.slice(0, 300))}`);
  }
  const data = (await res.json()) as { data?: { id?: unknown }[] };
  return (data.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string")
    .sort();
}

/** 单次尝试；返回结果或抛错（调用方按 400 决定是否进下一放弃阶段） */
async function attempt(
  spec: LlmSeatSpec,
  messages: ChatMessage[],
  drop: string[],
): Promise<{ latencyMs: number; reply: string; usage: PingResult["usage"] }> {
  const baseUrl = providerBaseUrl(spec.provider);
  const key = requireLlmKey(spec.provider);
  const body = buildChatBody(spec, messages) as Record<string, unknown>;
  for (const f of drop) delete body[f];

  const t0 = performance.now();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const latencyMs = performance.now() - t0;
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const err = new Error(`upstream ${res.status}: ${redact(text.slice(0, 300))}`);
    (err as { status?: number }).status = res.status;
    throw err;
  }
  const data = JSON.parse(text) as {
    choices?: { message?: { content?: unknown }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const raw = data.choices?.[0]?.message?.content;
  const reply = typeof raw === "string" ? raw.trim() : "";
  const fr = data.choices?.[0]?.finish_reason;
  if (!reply) {
    throw new Error(`空响应${fr === "length" ? "（max_tokens 截断）" : ""}`);
  }
  return {
    latencyMs,
    reply,
    usage:
      typeof data.usage?.prompt_tokens === "number"
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens ?? 0,
          }
        : null,
  };
}

async function pingModel(spec: LlmSeatSpec): Promise<PingResult> {
  const requested = [
    ...(spec.reasoningEffort !== undefined ? ["reasoning_effort"] : []),
    ...(spec.thinkingEnabled !== undefined ? ["thinking"] : []),
    ...(spec.maxTokens !== undefined ? ["max_tokens"] : []),
  ];
  const messages: ChatMessage[] = [{ role: "user", content: "回复 ok" }];
  const dropped: string[] = [];
  let lastError: string | null = null;

  for (let i = 0; i < DROP_STAGES.length; i++) {
    const drop = DROP_STAGES[i];
    try {
      const r = await attempt(spec, messages, drop);
      return {
        provider: spec.provider,
        model: spec.model,
        ok: true,
        latencyMs: Math.round(r.latencyMs),
        reply: r.reply.slice(0, 50),
        usage: r.usage,
        paramCompat: {
          requested,
          dropped,
          notes:
            dropped.length === 0 ? "全参数一次通过" : `放弃 ${dropped.join("、")} 后通过`,
        },
        error: null,
      };
    } catch (err) {
      const status = (err as { status?: number }).status;
      lastError = redact(err instanceof Error ? err.message : String(err));
      if (status === 400 && i + 1 < DROP_STAGES.length) {
        // 参数兼容性降级：记录下一阶段将放弃的字段后继续
        dropped.push(...DROP_STAGES[i + 1].filter((f) => !dropped.includes(f)));
        continue;
      }
      break; // 非 400（超时/5xx/网络）或已到底：判失败
    }
  }
  return {
    provider: spec.provider,
    model: spec.model,
    ok: false,
    latencyMs: 0,
    reply: null,
    usage: null,
    paramCompat: {
      requested,
      dropped,
      notes: dropped.length ? `放弃 ${dropped.join("、")} 后仍失败` : "全参数失败",
    },
    error: lastError,
  };
}

function parseOut(argv: string[]): string {
  const i = argv.indexOf("--out");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : DEFAULT_OUT;
}

async function main(): Promise<void> {
  loadLlmKeys();
  // 提前校验两个 key 都在（只报变量名）
  requireLlmKey("deepseek");
  requireLlmKey("moonshot");

  // 1) moonshot 模型清单 → 挑 K3 / K2.7 的 id
  const moonshotBase = providerBaseUrl("moonshot");
  console.log(`moonshot baseUrl：${moonshotBase}`);
  const models = await listMoonshotModels();
  const k3Candidates = models.filter((id) => /k3/i.test(id));
  const k27Candidates = models.filter((id) => /k2[.\-_]?7/i.test(id));
  const k3 = k3Candidates[0] ?? null;
  // K2.7 缺位时回退 kimi-for-coding（订阅端点的默认编码模型，疑似 K2.x Code
  // 系），在结果里显式标注为替身
  const k27Fallback = models.includes("kimi-for-coding") ? "kimi-for-coding" : null;
  const k27 = k27Candidates[0] ?? k27Fallback;
  const k27IsFallback = k27Candidates.length === 0 && k27 !== null;
  console.log(`moonshot 可用模型 ${models.length} 个：`);
  for (const id of models) console.log(`  - ${id}`);
  console.log(`K3 候选：${k3Candidates.join(", ") || "（无）"} → 选用 ${k3 ?? "无"}`);
  console.log(
    `K2.7 候选：${k27Candidates.join(", ") || "（无）"} → 选用 ${k27 ?? "无"}` +
      (k27IsFallback ? "（替身：清单无 K2.7 字样，用 kimi-for-coding 顶替）" : ""),
  );

  // 2) 四个模型 ping
  const specs: LlmSeatSpec[] = [
    { provider: "deepseek", model: "deepseek-flash", agent: true, ...PING_PARAMS },
    { provider: "deepseek", model: "deepseek-v4-pro", agent: true, ...PING_PARAMS },
  ];
  if (k3) specs.push({ provider: "moonshot", model: k3, agent: true, ...PING_PARAMS });
  if (k27) specs.push({ provider: "moonshot", model: k27, agent: true, ...PING_PARAMS });

  const pings: PingResult[] = [];
  for (const spec of specs) {
    const r = await pingModel(spec);
    pings.push(r);
    console.log(
      `${r.ok ? "OK  " : "FAIL"} ${r.provider}:${r.model} ` +
        `${r.ok ? `${r.latencyMs}ms reply=${JSON.stringify(r.reply)} tokens=${r.usage ? `${r.usage.promptTokens}→${r.usage.completionTokens}` : "n/a"}` : `error=${r.error}`} ` +
        `| 参数：${r.paramCompat.notes}`,
    );
  }
  if (!k3 || !k27) {
    console.log(`警告：moonshot 侧 ${!k3 ? "K3 " : ""}${!k27 ? "K2.7 " : ""}未找到对应模型 id，未 ping`);
  }

  // 3) 写结果
  const report = {
    finishedAt: new Date().toISOString(),
    moonshotModels: {
      baseUrl: moonshotBase,
      count: models.length,
      all: models,
      k3Candidates,
      k27Candidates,
      k3,
      k27,
      k27IsFallback,
    },
    pings,
  };
  const outPath = resolve(parseOut(process.argv.slice(2)));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nping 结果已写入 ${outPath}`);
}

main().catch((err) => {
  console.error(redact(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
