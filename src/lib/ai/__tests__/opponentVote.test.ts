/**
 * LLM 大底池 self-consistency 投票（opponent.decide，LLMConfig.selfVote）测试
 *
 * 覆盖：触发条件（底池 ≥ 25bb 或河牌街；小底池不触发；selfVote:false 关闭）、
 * 多数投票归票、平票保守序（fold<check<call<bet<raise<allin））、bet/raise 金额
 * 中位数（偶数票取下中位）、部分采样超时存活、3 次全失败回退启发式、
 * reasoning 三段合并。
 *
 * chatCompletion 直接 vi.mock 控制三次返回值（不经 fetch 层）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Card, DecideInput, LLMConfig } from "@/lib/types";

vi.mock("@/lib/llm/client", () => ({
  chatCompletion: vi.fn(),
}));

import { chatCompletion } from "@/lib/llm/client";
import { decide, VOTE_POT_BB } from "../opponent";
import { makeDecideInput } from "./helpers";

const chatMock = chatCompletion as unknown as ReturnType<typeof vi.fn>;

const CONFIG: LLMConfig = {
  apiKey: "sk-test",
  baseUrl: "https://example.com/v1",
  model: "test-model",
};

const json = (action: string, amount: number, reasoning: string) =>
  JSON.stringify({ action, amount, reasoning });

/** 大底池（30bb ≥ VOTE_POT_BB）翻前面注场景：触发投票 */
const BIG_POT = (): DecideInput =>
  makeDecideInput({
    aiHole: ["As", "Kd"],
    pot: 300,
    currentBet: 100,
    aiStreetBet: 50,
    aiStack: 900,
    callAmount: 50,
    legalActions: [
      { type: "fold", amount: 0 },
      { type: "call", amount: 50 },
      { type: "raise", amount: 200 },
      { type: "allin", amount: 950 },
    ],
    style: "tag",
  });

/** 小底池（4bb < VOTE_POT_BB）翻前场景：不触发投票 */
const SMALL_POT = (): DecideInput =>
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

beforeEach(() => {
  chatMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("投票触发条件", () => {
  it(`底池 ≥ ${VOTE_POT_BB}bb → 并行采样 3 次`, async () => {
    chatMock.mockResolvedValue(json("call", 50, "跟注"));
    await decide(BIG_POT(), CONFIG);
    expect(chatMock).toHaveBeenCalledTimes(3);
  });

  it("小底池翻前 → 单次采样旧路径（1 次调用）", async () => {
    chatMock.mockResolvedValue(json("call", 20, "跟注"));
    const r = await decide(SMALL_POT(), CONFIG);
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(r.source).toBe("llm");
    expect(r.action).toEqual({ type: "call", amount: 20 });
    expect(r.reasoning).toBe("跟注"); // 旧路径不加投票前缀
  });

  it("河牌街即使小底池也触发投票", async () => {
    chatMock.mockResolvedValue(json("check", 0, "过牌"));
    const input = makeDecideInput({
      aiHole: ["As", "Kd"] as [Card, Card],
      board: ["Qs", "8d", "4c", "2h", "7s"] as Card[],
      street: "river",
      pot: 20,
      aiStack: 200,
      callAmount: 0,
      legalActions: [
        { type: "check", amount: 0 },
        { type: "bet", amount: 10 },
        { type: "allin", amount: 200 },
      ],
      style: "tag",
    });
    await decide(input, CONFIG);
    expect(chatMock).toHaveBeenCalledTimes(3);
  });

  it("selfVote:false → 大底池也走单次采样", async () => {
    chatMock.mockResolvedValue(json("call", 50, "跟注"));
    const r = await decide(BIG_POT(), { ...CONFIG, selfVote: false });
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(r.action).toEqual({ type: "call", amount: 50 });
  });
});

describe("多数投票与平票保守序", () => {
  it("多数投票：call×2 / raise×1 → call；reasoning 合并三段", async () => {
    chatMock
      .mockResolvedValueOnce(json("call", 50, "赔率合适"))
      .mockResolvedValueOnce(json("raise", 300, "施压"))
      .mockResolvedValueOnce(json("call", 50, "牌力够"));
    const r = await decide(BIG_POT(), CONFIG);
    expect(r.source).toBe("llm");
    expect(r.action).toEqual({ type: "call", amount: 50 });
    expect(r.reasoning).toContain("call×2");
    expect(r.reasoning).toContain("raise×1");
    expect(r.reasoning).toContain("采样1：赔率合适");
    expect(r.reasoning).toContain("采样2：施压");
    expect(r.reasoning).toContain("采样3：牌力够");
  });

  it("三方平票（raise/call/fold 各一票）→ 最保守的 fold", async () => {
    chatMock
      .mockResolvedValueOnce(json("raise", 300, "诈唬施压"))
      .mockResolvedValueOnce(json("call", 50, "跟注"))
      .mockResolvedValueOnce(json("fold", 0, "牌力不足"));
    const r = await decide(BIG_POT(), CONFIG);
    expect(r.action.type).toBe("fold");
  });

  it("两票平票（一次超时，call vs raise 各一票）→ 更保守的 call", async () => {
    vi.useFakeTimers();
    chatMock
      .mockImplementationOnce(() => new Promise<string>(() => {})) // 采样1 挂起，8s 超时
      .mockResolvedValueOnce(json("raise", 300, "加注"))
      .mockResolvedValueOnce(json("call", 50, "跟注"));
    const p = decide(BIG_POT(), CONFIG);
    await vi.advanceTimersByTimeAsync(8_000);
    const r = await p;
    expect(r.action.type).toBe("call");
    expect(r.reasoning).toContain("call×1");
  });

  it("check/call/bet 平票 → 最保守的 check", async () => {
    const input = BIG_POT();
    input.state.currentBet = 0;
    input.callAmount = 0;
    input.legalActions = [
      { type: "check", amount: 0 },
      { type: "bet", amount: 100 },
      { type: "allin", amount: 900 },
    ];
    chatMock
      .mockResolvedValueOnce(json("bet", 200, "下注"))
      .mockResolvedValueOnce(json("check", 0, "过牌"))
      .mockResolvedValueOnce(json("bet", 150, "价值"));
    const r = await decide(input, CONFIG);
    // bet×2 / check×1：bet 多数胜，金额取中位数
    expect(r.action.type).toBe("bet");
    expect(r.action.amount).toBe(150);
  });
});

describe("bet/raise 金额中位数", () => {
  it("raise×3 金额 200/350/500 → 中位数 350", async () => {
    chatMock
      .mockResolvedValueOnce(json("raise", 500, "大加注"))
      .mockResolvedValueOnce(json("raise", 200, "小加注"))
      .mockResolvedValueOnce(json("raise", 350, "中等加注"));
    const r = await decide(BIG_POT(), CONFIG);
    expect(r.action).toEqual({ type: "raise", amount: 350 });
  });

  it("raise×2（一次失败）金额 400/200 → 下中位数 200（保守）", async () => {
    chatMock
      .mockResolvedValueOnce(json("raise", 400, "大加注"))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(json("raise", 200, "小加注"));
    const r = await decide(BIG_POT(), CONFIG);
    expect(r.action).toEqual({ type: "raise", amount: 200 });
  });

  it("金额超界的票先被解析钳制再参与中位数（合法区间内）", async () => {
    chatMock
      .mockResolvedValueOnce(json("raise", 99999, "超限"))
      .mockResolvedValueOnce(json("raise", 200, "最小"))
      .mockResolvedValueOnce(json("raise", 320, "中间"));
    const r = await decide(BIG_POT(), CONFIG);
    // 99999 钳到 allin 950 → [200, 320, 950] 中位数 320
    expect(r.action).toEqual({ type: "raise", amount: 320 });
  });
});

describe("失败回退", () => {
  it("3 次全部抛错 → 回退启发式", async () => {
    chatMock.mockRejectedValue(new Error("network down"));
    const r = await decide(BIG_POT(), CONFIG);
    expect(chatMock).toHaveBeenCalledTimes(3);
    expect(r.source).toBe("heuristic");
  });

  it("3 次全部返回无法解析的文本 → 回退启发式", async () => {
    chatMock.mockResolvedValue("我完全不知道怎么打这手牌");
    const r = await decide(BIG_POT(), CONFIG);
    expect(r.source).toBe("heuristic");
  });

  it("3 次全部挂起超时（8/15/25s 窗口）→ 回退启发式", async () => {
    vi.useFakeTimers();
    chatMock.mockImplementation(() => new Promise<string>(() => {}));
    const p = decide(BIG_POT(), CONFIG);
    await vi.advanceTimersByTimeAsync(25_000);
    const r = await p;
    expect(r.source).toBe("heuristic");
  });
});
