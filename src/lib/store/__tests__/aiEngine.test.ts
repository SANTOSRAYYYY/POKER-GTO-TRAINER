/**
 * AI 决策引擎开关（pokergto_ai_engine）接线测试（Phase C 集成验收）。
 *
 * 设置页把引擎选择写入 localStorage「pokergto_ai_engine」（heuristic | llm）：
 * - heuristic：gameStore 直连 heuristicDecide，绝不调用 LLM（即使已配置 API Key）；
 * - llm：走 opponent.decide（LLM 优先，失败兜底启发式）。
 * - llm 路径的决策 prompt 语言跟随 localStorage「pokergto_lang」（en 切英文
 *   slim 版，缺省/中文保持中文）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, HandRecord } from "@/lib/types";
import { chatCompletion } from "@/lib/llm/client";
import { useGameStore } from "@/lib/store/gameStore";
import { useHistoryStore } from "@/lib/store/historyStore";

vi.mock("@/lib/llm/client", () => ({
  chatCompletion: vi.fn(),
}));

const chatMock = vi.mocked(chatCompletion);
const st = () => useGameStore.getState();

const LLM_CONFIG_JSON = JSON.stringify({
  apiKey: "sk-test",
  baseUrl: "https://example.com/v1",
  model: "test-model",
});

let store: Record<string, string>;

function stubLocalStorage(initial: Record<string, string>): void {
  store = { ...initial };
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    },
  });
}

beforeEach(() => {
  chatMock.mockReset();
  vi.spyOn(useHistoryStore.getState(), "addHand").mockImplementation(
    async (_h: HandRecord) => {},
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 单挑开局（hero 按钮=小盲，翻前先动）；hero 跟注后轮到 AI 大盲行动 */
async function startHeadsUpAndCall(): Promise<void> {
  await st().startTable({
    mode: "cash",
    seats: 2,
    aiStyle: "tag",
    cashBlinds: { sb: 1, bb: 2 },
    buyin: 200,
  });
  expect(st().game!.currentSeat).toBe(0);
  await st().act({ type: "call", amount: 1 });
}

describe("AI 引擎开关", () => {
  it("heuristic：已配置 LLM 也绝不调用 chatCompletion，source 恒为 heuristic", async () => {
    stubLocalStorage({
      pokergto_ai_engine: "heuristic",
      pokergto_llm_config: LLM_CONFIG_JSON,
    });
    await startHeadsUpAndCall();
    const s = st();
    expect(s.aiEngine).toBe("heuristic");
    expect(s.llmConfig?.apiKey).toBe("sk-test"); // 配置照读，但引擎不调用
    expect(chatMock).not.toHaveBeenCalled();
    expect(s.lastAiAction).not.toBeNull();
    expect(s.lastAiAction!.source).toBe("heuristic");
  });

  it("llm：走 decide 调用 chatCompletion，合法输出标记 source=llm", async () => {
    stubLocalStorage({
      pokergto_ai_engine: "llm",
      pokergto_llm_config: LLM_CONFIG_JSON,
    });
    chatMock.mockResolvedValue(
      JSON.stringify({ action: "check", amount: 0, reasoning: "大盲免费看牌" }),
    );
    await startHeadsUpAndCall();
    const s = st();
    expect(s.aiEngine).toBe("llm");
    expect(chatMock).toHaveBeenCalled();
    expect(s.lastAiAction).not.toBeNull();
    expect(s.lastAiAction!.source).toBe("llm");
    expect(s.lastAiAction!.action.type).toBe("check");
  });

  it("llm 引擎但 LLM 失败：自动兜底启发式，牌局不中断", async () => {
    stubLocalStorage({
      pokergto_ai_engine: "llm",
      pokergto_llm_config: LLM_CONFIG_JSON,
    });
    chatMock.mockRejectedValue(new Error("network down"));
    await startHeadsUpAndCall();
    const s = st();
    expect(chatMock).toHaveBeenCalled();
    expect(s.lastAiAction).not.toBeNull();
    expect(s.lastAiAction!.source).toBe("heuristic");
  });

  it("未设置引擎键时默认 heuristic（兼容旧存档）", async () => {
    stubLocalStorage({});
    await startHeadsUpAndCall();
    expect(st().aiEngine).toBe("heuristic");
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("llm + UI 英文（pokergto_lang=en）：决策 prompt 切英文 slim 版", async () => {
    stubLocalStorage({
      pokergto_ai_engine: "llm",
      pokergto_llm_config: LLM_CONFIG_JSON,
      pokergto_lang: "en",
    });
    chatMock.mockResolvedValue(
      JSON.stringify({ action: "check", amount: 0, reasoning: "Free flop from the big blind" }),
    );
    await startHeadsUpAndCall();
    expect(chatMock).toHaveBeenCalled();
    const messages = chatMock.mock.calls[0][1] as ChatMessage[];
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("Output exactly one line of strict JSON");
    expect(messages[0].content).toContain("in English");
    expect(messages[1].content).toContain("Your hole cards");
    expect(messages[1].content).toContain("[Legal actions]");
    expect(messages[1].content).not.toContain("你的底牌");
  });

  it("llm + 无 pokergto_lang（默认中文）：决策 prompt 保持中文", async () => {
    stubLocalStorage({
      pokergto_ai_engine: "llm",
      pokergto_llm_config: LLM_CONFIG_JSON,
    });
    chatMock.mockResolvedValue(
      JSON.stringify({ action: "check", amount: 0, reasoning: "大盲免费看牌" }),
    );
    await startHeadsUpAndCall();
    expect(chatMock).toHaveBeenCalled();
    const messages = chatMock.mock.calls[0][1] as ChatMessage[];
    expect(messages[1].content).toContain("你的底牌");
    expect(messages[0].content).toContain("输出要求");
  });
});
