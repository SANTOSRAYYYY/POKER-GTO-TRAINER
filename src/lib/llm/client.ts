/**
 * LLM 客户端（已实现）
 *
 * 浏览器侧统一入口：不直连模型服务商，而是 POST 到本站 /api/llm 代理，
 * 由服务端转发到 OpenAI 兼容端点（避免 CORS，apiKey 不进入浏览器构建产物之外的网络层）。
 */
import type { ChatMessage, LLMConfig } from "@/lib/types";

export type { ChatMessage };

/**
 * 调用 /api/llm 完成一次 chat completion，返回助手消息文本。
 * @throws Error 代理返回非 2xx 或响应缺少 content 时抛出（供 opponent.decide 捕获后兜底）。
 */
export async function chatCompletion(
  config: LLMConfig,
  messages: ChatMessage[],
): Promise<string> {
  const res = await fetch("/api/llm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config, messages }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 代理错误体为 JSON { error } 时提取纯文本详情，否则保留原始 body 截断
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error) detail = parsed.error;
    } catch {
      /* body 非 JSON，保留原文 */
    }
    throw new Error(`LLM proxy error ${res.status}: ${detail}`);
  }
  const data = (await res.json()) as { content?: string; error?: string };
  if (typeof data.content !== "string") {
    throw new Error(`LLM proxy bad response: ${data.error ?? "missing content"}`);
  }
  return data.content;
}
