import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMConfig } from "@/lib/types";
import { decide, llmTimeoutFor } from "../opponent";
import { makeDecideInput } from "./helpers";

const CONFIG: LLMConfig = {
  apiKey: "sk-test",
  baseUrl: "https://example.com/v1",
  model: "test-model",
};

const INPUT = () =>
  makeDecideInput({
    aiHole: ["As", "Kd"],
    pot: 40,
    currentBet: 30,
    aiStreetBet: 10,
    aiStack: 190,
    callAmount: 20,
    legalActions: [
      { type: "fold", amount: 0 },
      { type: "call", amount: 20 },
      { type: "raise", amount: 60 },
      { type: "allin", amount: 200 },
    ],
    style: "tag",
  });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("opponent.decide", () => {
  it("config 为 null 时直接走启发式", async () => {
    const r = await decide(INPUT(), null);
    expect(r.source).toBe("heuristic");
    expect(["fold", "call", "raise", "allin"]).toContain(r.action.type);
  });

  it("config 无 apiKey 时走启发式", async () => {
    const r = await decide(INPUT(), { ...CONFIG, apiKey: "" });
    expect(r.source).toBe("heuristic");
  });

  it("LLM 正常返回时 source 为 'llm' 且采用其动作", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          content: '{"action":"call","amount":20,"reasoning":"赔率合适，跟注"}',
        }),
      })),
    );
    const r = await decide(INPUT(), CONFIG);
    expect(r.source).toBe("llm");
    expect(r.action).toEqual({ type: "call", amount: 20 });
    expect(r.reasoning).toBe("赔率合适，跟注");
  });

  it("LLM 返回垃圾文本时降级启发式", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ content: "我完全不知道怎么打这手牌" }),
      })),
    );
    const r = await decide(INPUT(), CONFIG);
    expect(r.source).toBe("heuristic");
  });

  it("LLM 请求失败（网络错误/非 2xx）时降级启发式", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 502, text: async () => "bad gateway" })),
    );
    const r1 = await decide(INPUT(), CONFIG);
    expect(r1.source).toBe("heuristic");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const r2 = await decide(INPUT(), CONFIG);
    expect(r2.source).toBe("heuristic");
  });
});

describe("llmTimeoutFor 超时档位映射", () => {
  it("默认 / low → 8s，medium → 15s，high → 25s", () => {
    expect(llmTimeoutFor(null)).toBe(8_000);
    expect(llmTimeoutFor(undefined)).toBe(8_000);
    expect(llmTimeoutFor(CONFIG)).toBe(8_000);
    expect(llmTimeoutFor({ ...CONFIG, reasoningEffort: "low" })).toBe(8_000);
    expect(llmTimeoutFor({ ...CONFIG, reasoningEffort: "medium" })).toBe(15_000);
    expect(llmTimeoutFor({ ...CONFIG, reasoningEffort: "high" })).toBe(25_000);
  });
});

describe("decide 超时窗口随思考程度放宽", () => {
  /** mock fetch：hangMs 后才返回一个合法 LLM 决策（配合 fake timers 使用） */
  function stubSlowFetch(hangMs: number) {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  ok: true,
                  json: async () => ({
                    content: '{"action":"call","amount":20,"reasoning":"思考完毕，跟注"}',
                  }),
                }),
              hangMs,
            );
          }),
      ),
    );
  }

  it("默认档：LLM 挂起 12s 超过 8s 窗口 → 回退启发式", async () => {
    vi.useFakeTimers();
    stubSlowFetch(12_000);
    const p = decide(INPUT(), CONFIG);
    await vi.advanceTimersByTimeAsync(12_000);
    const r = await p;
    expect(r.source).toBe("heuristic");
  });

  it("medium 档：LLM 12s 返回仍在 15s 窗口内 → 采用 LLM 结果", async () => {
    vi.useFakeTimers();
    stubSlowFetch(12_000);
    const p = decide(INPUT(), { ...CONFIG, reasoningEffort: "medium" });
    await vi.advanceTimersByTimeAsync(12_000);
    const r = await p;
    expect(r.source).toBe("llm");
    expect(r.action).toEqual({ type: "call", amount: 20 });
  });

  it("high 档：LLM 12s 返回仍在 25s 窗口内 → 采用 LLM 结果", async () => {
    vi.useFakeTimers();
    stubSlowFetch(12_000);
    const p = decide(INPUT(), { ...CONFIG, reasoningEffort: "high" });
    await vi.advanceTimersByTimeAsync(12_000);
    const r = await p;
    expect(r.source).toBe("llm");
    expect(r.action).toEqual({ type: "call", amount: 20 });
  });

  it("high 档：LLM 挂起 30s 超过 25s 窗口 → 回退启发式", async () => {
    vi.useFakeTimers();
    stubSlowFetch(30_000);
    const p = decide(INPUT(), { ...CONFIG, reasoningEffort: "high" });
    await vi.advanceTimersByTimeAsync(30_000);
    const r = await p;
    expect(r.source).toBe("heuristic");
  });
});
