/**
 * LLM 客户端（已实现）
 *
 * 浏览器侧统一入口：不直连模型服务商，而是 POST 到 LLM 代理，
 * 由服务端转发到 OpenAI 兼容端点（避免 CORS，apiKey 不进入浏览器构建产物之外的网络层）。
 *
 * 代理地址解析（resolveProxyEndpoint）：
 * - Web（Vercel）：同源 /api/llm；
 * - App（Capacitor 静态导出，无服务器）：线上 Vercel 部署的代理
 *   https://poker-nu-steel.vercel.app/api/llm（key 仍在用户设备 localStorage，
 *   架构与 Web 一致；该路由已放开 CORS 供 WebView 的 https://localhost 源调用）；
 * - 构建期可用 NEXT_PUBLIC_LLM_PROXY 显式覆盖（优先级最高）。
 */
import type { ChatMessage, LLMConfig } from "@/lib/types";

export type { ChatMessage };

/** App 模式默认代理：本项目的 Vercel 线上部署 */
const DEFAULT_APP_PROXY = "https://poker-nu-steel.vercel.app/api/llm";

/** 构建期内联（NEXT_PUBLIC_*）；未设置时为空串 */
const CONFIGURED_PROXY = process.env.NEXT_PUBLIC_LLM_PROXY?.trim() ?? "";

function resolveProxyEndpoint(): string {
  if (CONFIGURED_PROXY) return CONFIGURED_PROXY;
  if (typeof window !== "undefined") {
    const cap = (
      window as { Capacitor?: { isNativePlatform?: () => boolean } }
    ).Capacitor;
    if (cap?.isNativePlatform?.()) return DEFAULT_APP_PROXY;
  }
  return "/api/llm";
}

/**
 * 调用 LLM 代理完成一次 chat completion，返回助手消息文本。
 * @throws Error 代理返回非 2xx 或响应缺少 content 时抛出（供 opponent.decide 捕获后兜底）。
 */
export async function chatCompletion(
  config: LLMConfig,
  messages: ChatMessage[],
): Promise<string> {
  const res = await fetch(resolveProxyEndpoint(), {
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
