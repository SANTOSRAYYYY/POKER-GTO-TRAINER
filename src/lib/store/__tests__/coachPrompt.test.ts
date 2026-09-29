/**
 * 教练复盘 prompt 组装测试（buildAnalysisUserPrompt / renderHandForPrompt /
 * ANALYSIS_SYSTEM_PROMPT 契约）。
 *
 * 锁定：
 * - renderHandForPrompt 对空动作跑马街输出「（无动作——双方已全下，跑马发牌）」，
 *   且补齐的街道（flop/turn/river 快照）全部出现在文本里；
 * - buildAnalysisUserPrompt 注入「决策点参考数据」段（每个 hero 决策点一行）
 *   与「客观胜率数据」段；hero 底牌缺失时不注入参考数据段；
 * - system prompt 仍声明同一 JSON 协议（streets/rating/score），
 *   字数约束为放宽后的 120/200，且要求对照决策点参考数据点评；
 * - 英文版 system prompt（ANALYSIS_/SESSION_SYSTEM_PROMPT_EN）与中文版
 *   同协议同约束，并要求 "Output JSON with English text"；
 * - getStoredLang：store 层读取 UI 语言的行为（无 window / 非法值回退 zh）。
 * - parseAnalysisResult 对新 prompt 下的合法输出照常解析（协议兼容）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Card, HandRecord, StreetRecord } from "@/lib/types";
import {
  ANALYSIS_SYSTEM_PROMPT,
  ANALYSIS_SYSTEM_PROMPT_EN,
  analysisSystemPromptFor,
  buildAnalysisUserPrompt,
  parseAnalysisResult,
  renderHandForPrompt,
  SESSION_SYSTEM_PROMPT,
  SESSION_SYSTEM_PROMPT_EN,
  sessionSystemPromptFor,
} from "@/lib/store/historyStore";
import { getStoredLang } from "@/lib/i18n/lang";

/** 线性同余种子 rng（胜率可复现） */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const c = (s: string) => s.split(" ") as Card[];

/**
 * 单挑全下跑马手：hero 翻前 all-in 被跟注，引擎直达摊牌，
 * flop/turn/river 为补录的空动作街（board 为各街发完后的快照）。
 */
function makeRunoutHand(overrides: Partial<HandRecord> = {}): HandRecord {
  const board = c("Qh 7d 2c 5s 9h");
  const streets: StreetRecord[] = [
    {
      street: "preflop",
      board: [],
      actions: [
        { seat: 0, action: { type: "allin", amount: 200 } },
        { seat: 1, action: { type: "call", amount: 198 } },
      ],
    },
    { street: "flop", board: board.slice(0, 3), actions: [] },
    { street: "turn", board: board.slice(0, 4), actions: [] },
    { street: "river", board: board.slice(0, 5), actions: [] },
  ];
  return {
    id: "h-runout",
    timestamp: 0,
    players: [
      { seat: 0, isHero: true, aiStyle: null, cards: c("As Kd"), profit: -200 },
      { seat: 1, isHero: false, aiStyle: "tag", cards: c("Qd Qs"), profit: 200 },
    ],
    heroSeat: 0,
    buttonSeat: 0,
    smallBlind: 1,
    bigBlind: 2,
    ante: 0,
    streets,
    finalBoard: board,
    result: "lose",
    profit: -200,
    showdown: true,
    ...overrides,
  };
}

describe("renderHandForPrompt 空动作跑马街渲染", () => {
  it("补齐的 flop/turn/river 街全部出现，空动作街标注「跑马发牌」", () => {
    const text = renderHandForPrompt(makeRunoutHand());
    expect(text).toContain("【翻牌】公共牌：Qh 7d 2c");
    expect(text).toContain("【转牌】公共牌：Qh 7d 2c 5s");
    expect(text).toContain("【河牌】公共牌：Qh 7d 2c 5s 9h");
    const runoutNotes = text.match(/（无动作——双方已全下，跑马发牌）/g);
    expect(runoutNotes).toHaveLength(3); // 三条空动作街各标注一次
    expect(text).toContain("你（座位0） 全下（本街累计 200）");
    expect(text).toContain("最终公共牌：Qh 7d 2c 5s 9h");
  });
});

describe("renderHandForPrompt 局型标注（mode 字段优先，审计 A1）", () => {
  it("mode='tournament' 的前期手（无 finishPlace）标注为锦标赛而非现金局", () => {
    const text = renderHandForPrompt(
      makeRunoutHand({ mode: "tournament", tournamentSeats: 9 }),
    );
    expect(text).toContain("锦标赛（SNG）");
    expect(text).not.toContain("现金局");
  });

  it("mode='cash' 标注现金局；缺 mode 的旧记录回退 finishPlace 启发式", () => {
    expect(renderHandForPrompt(makeRunoutHand({ mode: "cash" }))).toContain("现金局");
    // 旧记录：无 mode 且无 finishPlace → 现金局；带 finishPlace → 锦标赛
    expect(renderHandForPrompt(makeRunoutHand())).toContain("现金局");
    const legacy = makeRunoutHand();
    legacy.players = legacy.players.map((p) => ({ ...p, finishPlace: 2 }));
    expect(renderHandForPrompt(legacy)).toContain("锦标赛（SNG）");
  });
});

describe("buildAnalysisUserPrompt 注入组装", () => {
  it("含决策点参考数据段：hero 翻前 all-in 决策一行，跑马街不产生决策行", () => {
    vi.spyOn(Math, "random").mockImplementation(lcg(41));
    const prompt = buildAnalysisUserPrompt(makeRunoutHand());
    expect(prompt).toContain("决策点参考数据");
    expect(prompt).toContain("客观胜率数据");
    // hero 只有翻前一个决策点（all-in）；三条跑马街无动作 → 仅一行
    const refLines = prompt
      .split("\n")
      .filter((l) => l.startsWith("- ") && l.includes("参考倾向"));
    expect(refLines).toHaveLength(1);
    expect(refLines[0]).toContain("翻前");
    expect(refLines[0]).toContain("实算胜率");
    expect(refLines[0]).toMatch(/参考倾向：(加注\/下注|跟注|弃牌|过牌)（(明确|边际)）/);
    // 跑马街文本也进入 prompt（任务 1 修复后教练才能看到完整牌局）
    expect(prompt).toContain("跑马发牌");
    expect(prompt).toContain("【河牌】公共牌：Qh 7d 2c 5s 9h");
  });

  it("hero 底牌缺失：不注入决策点参考数据段与胜率段，但手牌文本仍在", () => {
    const hand = makeRunoutHand({
      players: makeRunoutHand().players.map((p) =>
        p.isHero ? { ...p, cards: null } : p,
      ),
    });
    const prompt = buildAnalysisUserPrompt(hand);
    expect(prompt).not.toContain("决策点参考数据");
    expect(prompt).not.toContain("客观胜率数据");
    expect(prompt).toContain("【河牌】公共牌：Qh 7d 2c 5s 9h");
  });
});

describe("ANALYSIS_SYSTEM_PROMPT 协议契约", () => {
  it("保持 JSON 协议字段不变，字数约束放宽为 120/200，并要求对照参考数据", () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toContain('"streets"');
    expect(ANALYSIS_SYSTEM_PROMPT).toContain('"rating"');
    expect(ANALYSIS_SYSTEM_PROMPT).toContain('"score"');
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("不超过 120 字"); // comment
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("不超过 200 字"); // overall
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("决策点参考数据");
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("偏离参考倾向");
  });

  it("新 prompt 下的合法 LLM 输出照常解析（parse 兼容）", () => {
    const json = JSON.stringify({
      streets: [
        { street: "preflop", rating: "mistake", comments: ["对照参考数据：倾向加注/下注，全下过度放大风险"] },
        { street: "river", rating: "ok", comments: ["跑马街无决策"] },
      ],
      overall: "翻前全下代价过高，长期约亏一个买入。",
      score: 45,
    });
    const r = parseAnalysisResult(json);
    expect(r.score).toBe(45);
    expect(r.streets).toHaveLength(2);
    expect(r.streets[0].rating).toBe("mistake");
  });
});

// ---------------------------------------------------------------------------
// 英文复盘 system prompt（UI 语言 en 时切换，analyzeHand/analyzeSession 使用）
// ---------------------------------------------------------------------------

describe("英文复盘 system prompt（UI 语言 en 时切换）", () => {
  it("ANALYSIS_SYSTEM_PROMPT_EN 与中文版同协议同约束，要求英文输出", () => {
    expect(ANALYSIS_SYSTEM_PROMPT_EN).toContain('"streets"');
    expect(ANALYSIS_SYSTEM_PROMPT_EN).toContain('"rating"');
    expect(ANALYSIS_SYSTEM_PROMPT_EN).toContain('"score"');
    expect(ANALYSIS_SYSTEM_PROMPT_EN).toContain('"preflop" | "flop" | "turn" | "river"');
    expect(ANALYSIS_SYSTEM_PROMPT_EN).toContain('"good"');
    expect(ANALYSIS_SYSTEM_PROMPT_EN).toContain('"mistake"');
    expect(ANALYSIS_SYSTEM_PROMPT_EN).toContain("120"); // comment 长度约束
    expect(ANALYSIS_SYSTEM_PROMPT_EN).toContain("200"); // overall 长度约束
    expect(ANALYSIS_SYSTEM_PROMPT_EN).toContain("reference data"); // 对照决策点参考数据
    expect(ANALYSIS_SYSTEM_PROMPT_EN).toContain("Output JSON with English text");
    expect(ANALYSIS_SYSTEM_PROMPT_EN).not.toContain("不超过");
  });

  it("SESSION_SYSTEM_PROMPT_EN 与中文版同协议同约束，要求英文输出", () => {
    expect(SESSION_SYSTEM_PROMPT_EN).toContain('"strengths"');
    expect(SESSION_SYSTEM_PROMPT_EN).toContain('"leaks"');
    expect(SESSION_SYSTEM_PROMPT_EN).toContain('"priorities"');
    expect(SESSION_SYSTEM_PROMPT_EN).toContain('"score"');
    expect(SESSION_SYSTEM_PROMPT_EN).toContain("样本1"); // 证据编号与中文 user prompt 一致
    expect(SESSION_SYSTEM_PROMPT_EN).toContain("Output JSON with English text");
  });

  it("*SystemPromptFor 按 lang 选择，zh 为默认路径", () => {
    expect(analysisSystemPromptFor("zh")).toBe(ANALYSIS_SYSTEM_PROMPT);
    expect(analysisSystemPromptFor("en")).toBe(ANALYSIS_SYSTEM_PROMPT_EN);
    expect(sessionSystemPromptFor("zh")).toBe(SESSION_SYSTEM_PROMPT);
    expect(sessionSystemPromptFor("en")).toBe(SESSION_SYSTEM_PROMPT_EN);
  });
});

describe("getStoredLang（store 层 UI 语言读取）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("无 window（SSR/node 环境）回退默认 zh", () => {
    expect(getStoredLang()).toBe("zh");
  });

  it("localStorage pokergto_lang=en 返回 en；非法值与缺失回退 zh", () => {
    const store: Record<string, string> = { pokergto_lang: "en" };
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
    expect(getStoredLang()).toBe("en");
    store.pokergto_lang = "fr";
    expect(getStoredLang()).toBe("zh");
    delete store.pokergto_lang;
    expect(getStoredLang()).toBe("zh");
  });
});
