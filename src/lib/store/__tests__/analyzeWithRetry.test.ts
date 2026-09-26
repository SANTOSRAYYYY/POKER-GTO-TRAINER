/**
 * analyzeWithRetry 自动重试测试：注入 mock LLMCaller，不触网、不碰 IndexedDB。
 *
 * 覆盖：首次成功不重试 / 首次解析失败二次成功（且追加严格 JSON 提示、
 * 不改动原 messages）/ 首次网络错误二次成功 / 两次都失败抛出含双方原因的合并错误。
 */
import { describe, expect, it, vi } from "vitest";
import {
  ANALYSIS_RETRY_HINT,
  analyzeWithRetry,
  type LLMCaller,
} from "@/lib/store/historyStore";
import type { ChatMessage } from "@/lib/types";

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "系统提示" },
  { role: "user", content: "手牌记录" },
];

const GOOD_JSON = JSON.stringify({
  streets: [{ street: "preflop", rating: "good", comments: ["加注合理"] }],
  overall: "整体不错。",
  score: 80,
});

describe("analyzeWithRetry", () => {
  it("首次调用成功：不重试，返回解析结果", async () => {
    const callLLM: LLMCaller = vi.fn(async () => GOOD_JSON);
    const outcome = await analyzeWithRetry(MESSAGES, callLLM);
    expect(callLLM).toHaveBeenCalledTimes(1);
    expect(callLLM).toHaveBeenCalledWith(MESSAGES);
    expect(outcome.retried).toBe(false);
    expect(outcome.result.score).toBe(80);
    expect(outcome.result.overall).toBe("整体不错。");
  });

  it("首次输出无法解析：追加严格 JSON 提示后第二次成功", async () => {
    const callLLM = vi
      .fn<LLMCaller>()
      .mockResolvedValueOnce("对不起，我无法分析这手牌。")
      .mockResolvedValueOnce(GOOD_JSON);
    const outcome = await analyzeWithRetry(MESSAGES, callLLM);
    expect(callLLM).toHaveBeenCalledTimes(2);
    expect(outcome.retried).toBe(true);
    expect(outcome.result.score).toBe(80);
    // 第二次请求 = 原 messages + 末尾一条重试提示
    const secondMessages = callLLM.mock.calls[1][0];
    expect(secondMessages).toHaveLength(MESSAGES.length + 1);
    expect(secondMessages.slice(0, MESSAGES.length)).toEqual(MESSAGES);
    expect(secondMessages[secondMessages.length - 1]).toEqual({
      role: "user",
      content: ANALYSIS_RETRY_HINT,
    });
    // 不改动调用方传入的原数组
    expect(MESSAGES).toHaveLength(2);
  });

  it("首次网络/超时错误：第二次成功", async () => {
    const callLLM = vi
      .fn<LLMCaller>()
      .mockRejectedValueOnce(new Error("LLM proxy error 504: LLM upstream timeout (55s)"))
      .mockResolvedValueOnce(GOOD_JSON);
    const outcome = await analyzeWithRetry(MESSAGES, callLLM);
    expect(callLLM).toHaveBeenCalledTimes(2);
    expect(outcome.retried).toBe(true);
    expect(outcome.result.score).toBe(80);
  });

  it("两次都失败：抛出合并错误，包含两次失败各自的原因", async () => {
    const callLLM = vi
      .fn<LLMCaller>()
      .mockRejectedValueOnce(new Error("LLM proxy error 504: LLM upstream timeout (55s)"))
      .mockResolvedValueOnce("模型道歉但依然没有输出 JSON");
    const err: unknown = await analyzeWithRetry(MESSAGES, callLLM).catch((e: unknown) => e);
    expect(callLLM).toHaveBeenCalledTimes(2);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("重试");
    // 第一次原因：网络/超时错误原文
    expect(message).toContain("LLM proxy error 504");
    // 第二次原因：解析失败原文
    expect(message).toContain("未返回 JSON");
  });
});
