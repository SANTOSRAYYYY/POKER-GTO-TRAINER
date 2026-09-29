/**
 * /api/llm — LLM 代理路由（已实现）
 *
 * POST body: { config: LLMConfig, messages: ChatMessage[] }
 * 转发到 `${config.baseUrl}/chat/completions`（OpenAI 兼容协议），
 * 55s 超时（配合 maxDuration=60），成功返回 { content: string }。
 *
 * 错误约定：显式分支返回 400/502/504 JSON { error }；
 * 顶层兜底 try/catch 把任何意外异常也转成 500 JSON { error }，
 * 避免框架默认的空 500 让客户端无从诊断。
 */
import { NextResponse } from "next/server";
import type { ChatMessage, LLMConfig } from "@/lib/types";

/**
 * Vercel 函数时长上限（秒）：复盘分析 prompt 与输出都很长，
 * 平台默认时长会把慢请求提前杀掉，这里拉到 60s。
 */
export const maxDuration = 60;

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
/** 略低于 maxDuration：保证超时时由函数返回可读 504，而不是被平台硬杀成空响应 */
const TIMEOUT_MS = 55_000;

/**
 * CORS：Capacitor App 的 WebView 以 https://localhost 为源跨域调用本代理所需。
 * 本路由是无鉴权公开代理（调用方自带 apiKey，无任何 Cookie/会话），
 * 放开 * 不引入新的暴露面；Web 同源调用不受影响。
 */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
} as const;

/** NextResponse.json 的包装：统一附带 CORS 头 */
function json(body: unknown, init?: { status?: number }) {
  return NextResponse.json(body, { ...init, headers: CORS_HEADERS });
}

/** 预检请求应答 */
export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/** 校验并规范化 baseUrl；非法值返回可读错误（400） */
function normalizeBaseUrl(raw: string | undefined): { baseUrl: string } | { error: string } {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return { baseUrl: DEFAULT_BASE_URL };
  if (!/^https?:\/\//i.test(trimmed)) {
    return {
      error: `config.baseUrl 必须以 http:// 或 https:// 开头（当前值：${trimmed.slice(0, 100)}）`,
    };
  }
  if (/\s/.test(trimmed)) {
    return { error: "config.baseUrl 不能包含空格或换行" };
  }
  try {
    new URL(trimmed);
  } catch {
    return { error: `config.baseUrl 不是合法 URL（当前值：${trimmed.slice(0, 100)}）` };
  }
  return { baseUrl: trimmed.replace(/\/+$/, "") };
}

/**
 * 提取 message.content：兼容字符串与 OpenAI 新格式的分片数组
 * （[{ type: "text", text: "..." }, ...]，部分国产模型兼容层也这么返回）。
 * 无法提取时返回 null。
 */
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

export async function POST(req: Request) {
  try {
    let body: { config?: LLMConfig; messages?: ChatMessage[] };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, { status: 400 });
    }

    const { config, messages } = body;
    if (!config?.apiKey || !config?.model || !Array.isArray(messages)) {
      return json(
        { error: "missing config.apiKey / config.model / messages" },
        { status: 400 },
      );
    }

    const normalized = normalizeBaseUrl(config.baseUrl);
    if ("error" in normalized) {
      return json({ error: normalized.error }, { status: 400 });
    }
    const baseUrl = normalized.baseUrl;

    let upstream: Response;
    try {
      upstream = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          ...(config.temperature !== undefined
            ? { temperature: config.temperature }
            : {}),
          // 高级参数仅在显式设置时透传：部分提供商不认识
          // reasoning_effort / max_tokens / thinking 会直接报错，undefined 一律不发
          ...(config.reasoningEffort !== undefined
            ? { reasoning_effort: config.reasoningEffort }
            : {}),
          ...(config.maxTokens !== undefined
            ? { max_tokens: config.maxTokens }
            : {}),
          // DeepSeek V4 思考模式开关（默认开、effort=high）；显式设置才发送
          ...(config.thinkingEnabled !== undefined
            ? { thinking: { type: config.thinkingEnabled ? "enabled" : "disabled" } }
            : {}),
          // 强制 JSON 输出（DeepSeek/OpenAI/Moonshot 均支持 response_format）
          ...(config.jsonOutput === true
            ? { response_format: { type: "json_object" } }
            : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const isTimeout =
        err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return json(
        { error: isTimeout ? "LLM upstream timeout (55s)" : `LLM fetch failed: ${String(err)}` },
        { status: isTimeout ? 504 : 502 },
      );
    }

    // 先读文本再解析：上游返回 200 但 body 不是合法 JSON（HTML 错误页/空 body）时，
    // 直接 .json() 会抛出未捕获异常变成空 500；这里转为 502 并附上前 500 字符帮助诊断。
    const rawText = await upstream.text().catch(() => "");

    if (!upstream.ok) {
      return json(
        { error: `LLM upstream ${upstream.status}: ${rawText.slice(0, 500)}` },
        { status: 502 },
      );
    }

    let data: { choices?: { message?: unknown }[] };
    try {
      data = JSON.parse(rawText) as typeof data;
    } catch {
      return json(
        { error: `LLM upstream returned non-JSON body: ${rawText.slice(0, 500)}` },
        { status: 502 },
      );
    }

    const content = extractContent(data.choices?.[0]?.message);
    if (typeof content !== "string") {
      return json(
        { error: "LLM upstream returned no content" },
        { status: 502 },
      );
    }
    // finish_reason === "length"：输出被 max_tokens 截断（推理模型的思考内容也计入额度），
    // JSON 必然不完整，直接报可读错误而不是把截断文本丢给客户端解析
    const finishReason = (
      data.choices?.[0] as { finish_reason?: string } | undefined
    )?.finish_reason;
    if (finishReason === "length") {
      return json(
        {
          error: `LLM 输出达到 max_tokens 上限被截断（当前上限：${config.maxTokens ?? "服务商默认值"}；思考模式下推理过程也占用该额度）。请到「设置 → 高级参数」把输出上限调大（如 8192/16384）`,
        },
        { status: 502 },
      );
    }
    return json({ content });
  } catch (err) {
    // 顶层兜底：任何意外异常都返回可读 JSON，而不是框架默认的空 500
    return json(
      { error: `LLM proxy internal error: ${String(err)}` },
      { status: 500 },
    );
  }
}
