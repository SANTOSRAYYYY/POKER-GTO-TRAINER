/**
 * readLLMConfig 字段透传回归测试。
 *
 * 曾有的 bug：gameStore.readLLMConfig 只挑 apiKey/baseUrl/model/temperature，
 * 丢弃了 reasoningEffort/maxTokens——导致设置页配的思考程度在对战中不生效
 * （复盘路径是整对象解析所以正常）。这里锁定完整透传。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLLMConfig } from "@/lib/store/gameStore";

function stubConfig(raw: string | null): void {
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => (k === "pokergto_llm_config" ? raw : null),
      setItem: () => {},
      removeItem: () => {},
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readLLMConfig", () => {
  it("思考程度与输出上限完整透传", () => {
    stubConfig(
      JSON.stringify({
        apiKey: "sk-test",
        baseUrl: "https://example.com/v1",
        model: "m",
        reasoningEffort: "high",
        maxTokens: 4096,
      }),
    );
    const c = readLLMConfig();
    expect(c?.reasoningEffort).toBe("high");
    expect(c?.maxTokens).toBe(4096);
  });

  it("max 档与思考模式开关透传（DeepSeek V4）", () => {
    stubConfig(
      JSON.stringify({
        apiKey: "sk-test",
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-flash",
        reasoningEffort: "max",
        thinkingEnabled: false,
      }),
    );
    const c = readLLMConfig();
    expect(c?.reasoningEffort).toBe("max");
    expect(c?.thinkingEnabled).toBe(false);
  });

  it("上下文携带量透传并钳制到 20；0/非法值视为不携带", () => {
    stubConfig(
      JSON.stringify({ apiKey: "sk", baseUrl: "", model: "m", contextHands: 99 }),
    );
    expect(readLLMConfig()?.contextHands).toBe(20);
    stubConfig(
      JSON.stringify({ apiKey: "sk", baseUrl: "", model: "m", contextHands: 5 }),
    );
    expect(readLLMConfig()?.contextHands).toBe(5);
    stubConfig(
      JSON.stringify({ apiKey: "sk", baseUrl: "", model: "m", contextHands: 0 }),
    );
    expect("contextHands" in readLLMConfig()!).toBe(false);
  });

  it("未设置高级参数时字段缺省（undefined 不发送给上游）", () => {
    stubConfig(JSON.stringify({ apiKey: "sk", baseUrl: "", model: "m" }));
    const c = readLLMConfig();
    expect(c).not.toBeNull();
    expect("reasoningEffort" in c!).toBe(false);
    expect("maxTokens" in c!).toBe(false);
  });

  it("非法值被清洗：reasoningEffort 白名单外丢弃、maxTokens 非正数丢弃", () => {
    stubConfig(
      JSON.stringify({
        apiKey: "sk",
        baseUrl: "",
        model: "m",
        reasoningEffort: "extreme",
        maxTokens: -5,
      }),
    );
    const c = readLLMConfig();
    expect("reasoningEffort" in c!).toBe(false);
    expect("maxTokens" in c!).toBe(false);
  });

  it("无 key / 无存档返回 null", () => {
    stubConfig(null);
    expect(readLLMConfig()).toBeNull();
    stubConfig(JSON.stringify({ apiKey: "", model: "m" }));
    expect(readLLMConfig()).toBeNull();
  });
});
