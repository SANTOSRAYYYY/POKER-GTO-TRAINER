/**
 * 整场复盘（Session 级 AI 教练）测试：
 * - parseSessionReport 容错：markdown 围栏、前言后语、JSON 后含 "}" 的尾巴、
 *   score 缺失/越界/字符串、strengths 单字符串、leaks 字符串项/缺字段项、
 *   完全无 JSON 抛错
 * - analyzeSessionCore：mock LLMCaller（不触网/不碰 idb），首次成功不重试、
 *   首次失败追加严格 JSON 提示重试、两次都失败抛合并错误、空手牌直接抛错、
 *   lang='en' 时 system prompt 切英文版（缺省/显式 zh 保持中文）
 * - buildSessionUserPrompt：聚合统计与亏损样本手进入 prompt
 * - listSessionReports/saveSessionReport：localStorage 最多 5 份、最新在前、
 *   脏数据/无 window 容错
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANALYSIS_RETRY_HINT,
  analyzeSessionCore,
  buildSessionUserPrompt,
  listSessionReports,
  parseSessionReport,
  saveSessionReport,
  SESSION_REPORTS_KEY,
  SESSION_SYSTEM_PROMPT,
  SESSION_SYSTEM_PROMPT_EN,
  type LLMCaller,
} from "@/lib/store/historyStore";
import { DEFAULT_RECENCY_LAMBDA, setAdaptRecencyLambda } from "@/lib/ai/adapt";
import type { ChatMessage, HandRecord, SessionReport } from "@/lib/types";

afterEach(() => {
  vi.unstubAllGlobals();
  setAdaptRecencyLambda(DEFAULT_RECENCY_LAMBDA);
});

const GOOD_JSON = JSON.stringify({
  strengths: ["后位进攻性合理", "摊牌价值索取到位"],
  leaks: [
    { title: "枪口位偏松", detail: "UTG VPIP 偏高且盈亏 -120（证据：样本1），应收紧到前 12%" },
    { title: "大河牌跟注过宽", detail: "样本2 河牌面对重注跟注赔率不够" },
  ],
  priorities: ["收紧枪口位开局范围", "复盘河牌大注跟注决策"],
  score: 62,
});

// ---------------------------------------------------------------------------
// parseSessionReport
// ---------------------------------------------------------------------------

describe("parseSessionReport", () => {
  it("纯 JSON 正常解析，createdAt/handsAnalyzed 由调用方落库", () => {
    const before = Date.now();
    const r = parseSessionReport(GOOD_JSON, 42);
    expect(r.handsAnalyzed).toBe(42);
    expect(r.createdAt).toBeGreaterThanOrEqual(before);
    expect(r.score).toBe(62);
    expect(r.strengths).toHaveLength(2);
    expect(r.leaks).toHaveLength(2);
    expect(r.leaks[0].title).toBe("枪口位偏松");
    expect(r.leaks[0].detail).toContain("样本1");
    expect(r.priorities).toEqual(["收紧枪口位开局范围", "复盘河牌大注跟注决策"]);
  });

  it("markdown ```json 围栏与前言后语可剥离", () => {
    const fenced = parseSessionReport(`\`\`\`json\n${GOOD_JSON}\n\`\`\``, 10);
    expect(fenced.score).toBe(62);
    const noisy = parseSessionReport(`好的，以下是整场复盘：\n${GOOD_JSON}\n加油！`, 10);
    expect(noisy.score).toBe(62);
    expect(noisy.leaks).toHaveLength(2);
  });

  it("JSON 之后的尾巴含 \"}\" 时回退到更早的结束位置", () => {
    const r = parseSessionReport(`${GOOD_JSON}\n备注：详见 {附录A}`, 10);
    expect(r.score).toBe(62);
    expect(r.strengths).toHaveLength(2);
  });

  it("score 缺失默认 50，越界钳制 0-100，数字字符串可解析", () => {
    expect(parseSessionReport(`{"strengths":[]}`, 1).score).toBe(50);
    expect(parseSessionReport(`{"score":250}`, 1).score).toBe(100);
    expect(parseSessionReport(`{"score":-5}`, 1).score).toBe(0);
    expect(parseSessionReport(`{"score":"85"}`, 1).score).toBe(85);
  });

  it("strengths/priorities 容忍单字符串并过滤空项与非字符串", () => {
    const r = parseSessionReport(
      `{"strengths":"单条强项","priorities":["", "有效", 3, null],"score":60}`,
      1,
    );
    expect(r.strengths).toEqual(["单条强项"]);
    expect(r.priorities).toEqual(["有效"]);
  });

  it("leaks 容错：字符串项包装、缺 detail 补空串、缺 title 从 detail 截取、空项丢弃", () => {
    const r = parseSessionReport(
      `{"leaks":[
        "盲位防守过宽",
        {"title":"只有标题"},
        {"detail":"没有标题时从 detail 截取的概括，这句话超过二十个字会被截断"},
        {"title":""},
        42
      ],"score":60}`,
      1,
    );
    expect(r.leaks).toHaveLength(3);
    expect(r.leaks[0]).toEqual({ title: "盲位防守过宽", detail: "" });
    expect(r.leaks[1]).toEqual({ title: "只有标题", detail: "" });
    expect(r.leaks[2].title).toBe("没有标题时从 detail 截取的概括，…");
    expect(r.leaks[2].title.endsWith("…")).toBe(true);
    expect(r.leaks[2].detail).toContain("没有标题");
  });

  it("leaks 为单字符串时包装成一条", () => {
    const r = parseSessionReport(`{"leaks":"翻前整体偏松","score":60}`, 1);
    expect(r.leaks).toEqual([{ title: "翻前整体偏松", detail: "" }]);
  });

  it("完全没有 JSON / JSON 损坏 → 抛出可重试的解析错误", () => {
    expect(() => parseSessionReport("对不起，我无法复盘。", 1)).toThrow(/未返回 JSON/);
    expect(() => parseSessionReport("{ 这不是合法 JSON }", 1)).toThrow(/JSON 格式错误/);
  });
});

// ---------------------------------------------------------------------------
// analyzeSessionCore（mock LLMCaller）
// ---------------------------------------------------------------------------

function makeHand(id: string, profit: number, heroFold = false): HandRecord {
  return {
    id,
    timestamp: 1000,
    players: [
      { seat: 0, isHero: true, aiStyle: null, cards: ["As", "Kd"], profit },
      { seat: 1, isHero: false, aiStyle: "tag", cards: null, profit: -profit },
    ],
    heroSeat: 0,
    buttonSeat: 0,
    smallBlind: 5,
    bigBlind: 10,
    ante: 0,
    streets: [
      {
        street: "preflop",
        board: [],
        actions: heroFold
          ? [{ seat: 0, action: { type: "fold", amount: 0 } }]
          : [{ seat: 0, action: { type: "raise", amount: 30 } }],
      },
    ],
    finalBoard: [],
    result: profit > 0 ? "win" : profit < 0 ? "lose" : "tie",
    profit,
    showdown: false,
  };
}

const HANDS = [makeHand("a", -100), makeHand("b", 50), makeHand("c", 0, true)];

describe("analyzeSessionCore", () => {
  it("首次成功：不重试，prompt 含聚合统计与亏损样本手", async () => {
    const callLLM: LLMCaller = vi.fn(async () => GOOD_JSON);
    const { report, retried } = await analyzeSessionCore(HANDS, callLLM);
    expect(retried).toBe(false);
    expect(callLLM).toHaveBeenCalledTimes(1);
    expect(report.score).toBe(62);
    expect(report.handsAnalyzed).toBe(3);

    const messages = (callLLM as ReturnType<typeof vi.fn>).mock.calls[0][0] as ChatMessage[];
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("整场");
    const user = messages[1].content;
    expect(user).toContain("VPIP");
    expect(user).toContain("【位置拆分】");
    expect(user).toContain("【对手风格拆分】");
    expect(user).toContain("样本1"); // -100 的那手进入亏损样本
    expect(user).toContain("-100");
  });

  it("首次输出无法解析：追加严格 JSON 提示后第二次成功", async () => {
    const callLLM = vi
      .fn<LLMCaller>()
      .mockResolvedValueOnce("对不起，我无法复盘。")
      .mockResolvedValueOnce(GOOD_JSON);
    const { report, retried } = await analyzeSessionCore(HANDS, callLLM);
    expect(retried).toBe(true);
    expect(report.score).toBe(62);
    const second = callLLM.mock.calls[1][0];
    expect(second[second.length - 1]).toEqual({ role: "user", content: ANALYSIS_RETRY_HINT });
  });

  it("两次都失败：抛出含双方原因的合并错误", async () => {
    const callLLM = vi
      .fn<LLMCaller>()
      .mockRejectedValueOnce(new Error("LLM proxy error 504: timeout"))
      .mockResolvedValueOnce("仍然没有 JSON");
    const err: unknown = await analyzeSessionCore(HANDS, callLLM).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("LLM proxy error 504");
    expect(msg).toContain("未返回 JSON");
  });

  it("空手牌：直接抛错且不调用 LLM", async () => {
    const callLLM: LLMCaller = vi.fn(async () => GOOD_JSON);
    await expect(analyzeSessionCore([], callLLM)).rejects.toThrow(/暂无可复盘/);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it("lang='en'：system prompt 切英文版（要求英文输出）；缺省仍为中文", async () => {
    const callLLMEn: LLMCaller = vi.fn(async () => GOOD_JSON);
    await analyzeSessionCore(HANDS, callLLMEn, "en");
    const enMessages = (callLLMEn as ReturnType<typeof vi.fn>).mock.calls[0][0] as ChatMessage[];
    expect(enMessages[0].content).toBe(SESSION_SYSTEM_PROMPT_EN);
    expect(enMessages[0].content).toContain("Output JSON with English text");
    // user prompt（聚合数据）不受语言开关影响，仍按原结构渲染
    expect(enMessages[1].content).toContain("样本1");

    const callLLMZh: LLMCaller = vi.fn(async () => GOOD_JSON);
    await analyzeSessionCore(HANDS, callLLMZh);
    const zhMessages = (callLLMZh as ReturnType<typeof vi.fn>).mock.calls[0][0] as ChatMessage[];
    expect(zhMessages[0].content).toBe(SESSION_SYSTEM_PROMPT);
    const callLLMZhExplicit: LLMCaller = vi.fn(async () => GOOD_JSON);
    await analyzeSessionCore(HANDS, callLLMZhExplicit, "zh");
    const zhExplicitMessages = (callLLMZhExplicit as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as ChatMessage[];
    expect(zhExplicitMessages[0].content).toBe(SESSION_SYSTEM_PROMPT);
  });
});

// ---------------------------------------------------------------------------
// buildSessionUserPrompt
// ---------------------------------------------------------------------------

describe("buildSessionUserPrompt", () => {
  it("包含整体统计、位置/风格拆分与样本引用说明", () => {
    const text = buildSessionUserPrompt(HANDS);
    expect(text).toContain("最近 3 手牌");
    expect(text).toContain("VPIP");
    expect(text).toContain("【翻前位置桶】");
    expect(text).toContain("【亏损最大的样本手】");
    expect(text).toContain("「样本1」");
    // 全部盈利时不列样本
    const noLoss = buildSessionUserPrompt([makeHand("x", 10), makeHand("y", 20)]);
    expect(noLoss).toContain("没有亏损的手牌");
  });
});

// ---------------------------------------------------------------------------
// localStorage 报告存档
// ---------------------------------------------------------------------------

function makeReport(createdAt: number): SessionReport {
  return {
    createdAt,
    handsAnalyzed: 50,
    strengths: ["后位进攻性合理"],
    leaks: [{ title: "前位偏松", detail: "UTG 盈亏 -120（证据：样本1）" }],
    priorities: ["收紧枪口开局"],
    score: 70,
  };
}

function stubStorage() {
  const m = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => void m.set(k, String(v)),
      removeItem: (k: string) => void m.delete(k),
    },
  });
  return m;
}

describe("sessionReports localStorage 存档", () => {
  it("最多保留 5 份、最新在前，并写入 localStorage", () => {
    const m = stubStorage();
    let list: SessionReport[] = [];
    for (let i = 1; i <= 6; i++) list = saveSessionReport(makeReport(i));
    expect(list).toHaveLength(5);
    expect(list[0].createdAt).toBe(6);
    expect(list[4].createdAt).toBe(2); // 最旧的一份（createdAt=1）被截掉
    expect(listSessionReports().map((r) => r.createdAt)).toEqual([6, 5, 4, 3, 2]);
    // 确实持久化到了约定键
    expect(m.get(SESSION_REPORTS_KEY)).toBeTruthy();
    expect(JSON.parse(m.get(SESSION_REPORTS_KEY)!)).toHaveLength(5);
  });

  it("脏数据容错：非 JSON / 非数组 / 缺字段条目被丢弃", () => {
    const m = stubStorage();
    m.set(SESSION_REPORTS_KEY, "{not json");
    expect(listSessionReports()).toEqual([]);
    m.set(SESSION_REPORTS_KEY, JSON.stringify({ foo: 1 }));
    expect(listSessionReports()).toEqual([]);
    m.set(
      SESSION_REPORTS_KEY,
      JSON.stringify([makeReport(1), { foo: 1 }, "junk", null, { createdAt: "bad" }]),
    );
    const list = listSessionReports();
    expect(list).toHaveLength(1);
    expect(list[0].createdAt).toBe(1);
  });

  it("无 window（SSR/纯 node）返回 []，不抛错", () => {
    expect(typeof window).toBe("undefined");
    expect(listSessionReports()).toEqual([]);
  });
});
