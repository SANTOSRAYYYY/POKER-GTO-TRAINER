/**
 * parseAnalysisResult 容错测试：锁定对 LLM 脏输出的容忍度。
 *
 * 覆盖：markdown 围栏、前言后语、JSON 之后出现含 "}" 的尾巴、
 * rating/street 大小写、score 缺失/越界/字符串、comments 单字符串、
 * 非法 street 过滤、完全无 JSON 抛错。
 */
import { describe, expect, it } from "vitest";
import { parseAnalysisResult } from "@/lib/store/historyStore";

const GOOD_JSON = JSON.stringify({
  streets: [
    { street: "preflop", rating: "good", comments: ["加注尺度合理"] },
    { street: "river", rating: "mistake", comments: ["价值下注太薄", "应下 2/3 底池"] },
  ],
  overall: "整体不错，河牌需要改进。",
  score: 72,
});

describe("parseAnalysisResult", () => {
  it("纯 JSON 正常解析", () => {
    const r = parseAnalysisResult(GOOD_JSON);
    expect(r.score).toBe(72);
    expect(r.overall).toBe("整体不错，河牌需要改进。");
    expect(r.streets).toHaveLength(2);
    expect(r.streets[1].rating).toBe("mistake");
  });

  it("markdown ```json 围栏可剥离", () => {
    const r = parseAnalysisResult(`\`\`\`json\n${GOOD_JSON}\n\`\`\``);
    expect(r.score).toBe(72);
    expect(r.streets).toHaveLength(2);
  });

  it("带前言后语时仍能提取 JSON", () => {
    const r = parseAnalysisResult(`好的，以下是分析：\n${GOOD_JSON}\n希望对你有帮助！`);
    expect(r.score).toBe(72);
    expect(r.streets).toHaveLength(2);
  });

  it("JSON 之后的尾巴含 \"}\" 时回退到更早的结束位置", () => {
    const r = parseAnalysisResult(`${GOOD_JSON}\n备注：详见 {附录A}`);
    expect(r.score).toBe(72);
    expect(r.streets).toHaveLength(2);
  });

  it("score 缺失默认 50，越界钳制到 0-100，数字字符串可解析", () => {
    expect(parseAnalysisResult(`{"streets":[],"overall":"x"}`).score).toBe(50);
    expect(parseAnalysisResult(`{"streets":[],"overall":"x","score":250}`).score).toBe(100);
    expect(parseAnalysisResult(`{"streets":[],"overall":"x","score":-5}`).score).toBe(0);
    expect(parseAnalysisResult(`{"streets":[],"overall":"x","score":"85"}`).score).toBe(85);
  });

  it("rating 缺失/非法默认 ok，大小写不敏感；非法 street 被过滤", () => {
    const r = parseAnalysisResult(
      `{"streets":[
        {"street":"flop","rating":"GOOD","comments":["a"]},
        {"street":"turn","rating":"离谱","comments":["b"]},
        {"street":"showdown","rating":"good","comments":["c"]}
      ],"overall":"x","score":60}`,
    );
    expect(r.streets.map((s) => s.street)).toEqual(["flop", "turn"]);
    expect(r.streets[0].rating).toBe("good");
    expect(r.streets[1].rating).toBe("ok");
  });

  it("comments 为单字符串时包装成数组，空串被过滤", () => {
    const r = parseAnalysisResult(
      `{"streets":[{"street":"preflop","rating":"ok","comments":"单条点评"}],"overall":"x","score":60}`,
    );
    expect(r.streets[0].comments).toEqual(["单条点评"]);
    const r2 = parseAnalysisResult(
      `{"streets":[{"street":"preflop","rating":"ok","comments":["", "有效", 3]}],"overall":"x","score":60}`,
    );
    expect(r2.streets[0].comments).toEqual(["有效"]);
  });

  it("overall 缺失时给默认占位", () => {
    const r = parseAnalysisResult(`{"streets":[],"score":60}`);
    expect(r.overall).toBe("（无总体评价）");
    expect(r.streets).toEqual([]);
  });

  it("完全没有 JSON → 抛出可重试的解析错误", () => {
    expect(() => parseAnalysisResult("对不起，我无法分析这手牌。")).toThrow(/未返回 JSON/);
    expect(() => parseAnalysisResult("{ 这不是合法 JSON }")).toThrow(/JSON 格式错误/);
  });
});
