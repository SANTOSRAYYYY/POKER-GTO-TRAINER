/**
 * /api/llm 代理路由单元测试：直接调用 POST，vi.stubGlobal("fetch", ...) mock 上游。
 *
 * 锁定错误语义：
 * - 上游 200 但 body 非 JSON → 502 且 error 含上游原文诊断文本（修复前的空 500 根因）；
 * - message.content 为分片数组 → 拼接 text 部分；
 * - 上游非 2xx（如 401）→ 502 透传状态码与上游消息；
 * - baseUrl 无协议头 → 400；
 * - fetch 抛 AbortError → 504；
 * - 正常路径 → 200 { content }。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { maxDuration, POST } from "../route";

const VALID_BODY = {
  config: { apiKey: "sk-test", baseUrl: "https://api.example.com/v1", model: "test-model" },
  messages: [{ role: "user" as const, content: "hello" }],
};

function makeRequest(body: unknown = VALID_BODY): Request {
  return new Request("http://localhost/api/llm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function stubUpstream(impl: () => Promise<Response>): void {
  vi.stubGlobal("fetch", vi.fn(impl));
}

async function callRoute(body: unknown = VALID_BODY) {
  const res = await POST(makeRequest(body));
  const json = (await res.json()) as { content?: string; error?: string };
  return { status: res.status, json };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/llm", () => {
  it("导出 Vercel maxDuration = 60（复盘长请求不被平台默认时长杀掉）", () => {
    expect(maxDuration).toBe(60);
  });

  it("正常路径：上游 200 + 字符串 content → 200 { content }", async () => {
    stubUpstream(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "分析结果" } }] }),
        { status: 200 },
      ),
    );
    const { status, json } = await callRoute();
    expect(status).toBe(200);
    expect(json.content).toBe("分析结果");
  });

  it("上游 200 + 非法 JSON body → 502 且 error 含上游原文", async () => {
    stubUpstream(
      async () => new Response("<html><body>502 Bad Gateway</body></html>", { status: 200 }),
    );
    const { status, json } = await callRoute();
    expect(status).toBe(502);
    expect(json.error).toContain("502 Bad Gateway");
  });

  it("finish_reason=length（max_tokens 截断）→ 502 且提示调大输出上限", async () => {
    stubUpstream(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: "{\"streets\":[{\"street\":\"preflop\"" },
                finish_reason: "length",
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const { status, json } = await callRoute();
    expect(status).toBe(502);
    expect(json.error).toContain("max_tokens");
    expect(json.error).toContain("输出上限");
  });

  it("上游 200 + content 为分片数组 → 拼接 text 部分", async () => {
    stubUpstream(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: "翻前加注" },
                  { type: "text", text: "是正确打法" },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const { status, json } = await callRoute();
    expect(status).toBe(200);
    expect(json.content).toBe("翻前加注是正确打法");
  });

  it("上游 401 → 502 透传状态与上游消息", async () => {
    stubUpstream(
      async () =>
        new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 }),
    );
    const { status, json } = await callRoute();
    expect(status).toBe(502);
    expect(json.error).toContain("401");
    expect(json.error).toContain("invalid api key");
  });

  it("baseUrl 无协议头 → 400", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { status, json } = await callRoute({
      ...VALID_BODY,
      config: { ...VALID_BODY.config, baseUrl: "api.openai.com/v1" },
    });
    expect(status).toBe(400);
    expect(json.error).toContain("http://");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("上游 fetch 抛 AbortError → 504", async () => {
    stubUpstream(async () => {
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    });
    const { status, json } = await callRoute();
    expect(status).toBe(504);
    expect(json.error).toContain("timeout");
  });

  it("上游 200 + 缺少 choices → 502 no content", async () => {
    stubUpstream(async () => new Response(JSON.stringify({}), { status: 200 }));
    const { status, json } = await callRoute();
    expect(status).toBe(502);
    expect(json.error).toContain("no content");
  });

  it("带 reasoningEffort/maxTokens 时透传 reasoning_effort / max_tokens 到上游 body", async () => {
    const fetchSpy = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { status } = await callRoute({
      ...VALID_BODY,
      config: { ...VALID_BODY.config, reasoningEffort: "high", maxTokens: 4096 },
    });
    expect(status).toBe(200);
    const sentBody = JSON.parse(
      String(fetchSpy.mock.calls[0][1]?.body),
    ) as Record<string, unknown>;
    expect(sentBody.reasoning_effort).toBe("high");
    expect(sentBody.max_tokens).toBe(4096);
  });

  it("未设置时不向上游发送 reasoning_effort / max_tokens 字段", async () => {
    const fetchSpy = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { status } = await callRoute();
    expect(status).toBe(200);
    const sentBody = JSON.parse(
      String(fetchSpy.mock.calls[0][1]?.body),
    ) as Record<string, unknown>;
    expect("reasoning_effort" in sentBody).toBe(false);
    expect("max_tokens" in sentBody).toBe(false);
    expect("temperature" in sentBody).toBe(false);
    expect("thinking" in sentBody).toBe(false);
  });

  it("DeepSeek V4：thinkingEnabled / reasoningEffort=max 透传为 thinking 与 reasoning_effort", async () => {
    const fetchSpy = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { status } = await callRoute({
      ...VALID_BODY,
      config: {
        ...VALID_BODY.config,
        reasoningEffort: "max",
        thinkingEnabled: true,
      },
    });
    expect(status).toBe(200);
    const sentBody = JSON.parse(
      String(fetchSpy.mock.calls[0][1]?.body),
    ) as Record<string, unknown>;
    expect(sentBody.reasoning_effort).toBe("max");
    expect(sentBody.thinking).toEqual({ type: "enabled" });
  });

  it("thinkingEnabled=false 透传 thinking.type=disabled", async () => {
    const fetchSpy = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await callRoute({
      ...VALID_BODY,
      config: { ...VALID_BODY.config, thinkingEnabled: false },
    });
    const sentBody = JSON.parse(
      String(fetchSpy.mock.calls[0][1]?.body),
    ) as Record<string, unknown>;
    expect(sentBody.thinking).toEqual({ type: "disabled" });
  });

  it("jsonOutput=true 透传 response_format json_object；未设置不发送", async () => {
    const fetchSpy = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "{}" } }] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await callRoute({
      ...VALID_BODY,
      config: { ...VALID_BODY.config, jsonOutput: true },
    });
    const on = JSON.parse(
      String(fetchSpy.mock.calls[0][1]?.body),
    ) as Record<string, unknown>;
    expect(on.response_format).toEqual({ type: "json_object" });
  });
});
