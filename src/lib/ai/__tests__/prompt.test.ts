import { describe, expect, it } from "vitest";
import type { PlayerAction } from "@/lib/types";
import { buildPrompt, buildSlimPrompt, parseDecision } from "../prompt";
import { makeDecideInput } from "./helpers";

const FACING_RAISE_LEGAL: PlayerAction[] = [
  { type: "fold", amount: 0 },
  { type: "call", amount: 20 },
  { type: "raise", amount: 60 },
  { type: "allin", amount: 200 },
];

const CAN_CHECK_LEGAL: PlayerAction[] = [
  { type: "check", amount: 0 },
  { type: "bet", amount: 10 },
  { type: "allin", amount: 200 },
];

const FOLD_CALL_ONLY: PlayerAction[] = [
  { type: "fold", amount: 0 },
  { type: "call", amount: 20 },
];

describe("buildPrompt", () => {
  const input = makeDecideInput({
    aiHole: ["As", "Kd"],
    board: ["Qh", "Jh", "2c"],
    street: "flop",
    pot: 60,
    currentBet: 30,
    callAmount: 30,
    legalActions: FACING_RAISE_LEGAL,
    style: "maniac",
  });
  const { system, user } = buildPrompt(input);

  it("system 包含风格人设与输出格式要求", () => {
    expect(system).toContain("Maniac");
    expect(system).toContain("几乎每个底池都加注");
    expect(system).toContain('"action"');
    expect(system).toContain("JSON");
  });

  it("user 包含局面要素：底牌/公共牌/底池赔率/合法动作及金额范围", () => {
    expect(user).toContain("As Kd");
    expect(user).toContain("Qh Jh 2c");
    expect(user).toContain("底池赔率：33.3%");
    expect(user).toContain("call（跟注，需补 20 筹码）");
    expect(user).toContain("raise");
    expect(user).toContain("最小 60");
    expect(user).toContain("allin");
  });

  it("recentHands 注入时出现「最近回顾」段；缺省时不出现", () => {
    const withHands = buildPrompt({
      ...input,
      recentHands: ["你 A♥K♦（BTN）：翻前加注｜结果 +120，赢家 你", "你 7♠2♦（BB）：翻前弃牌｜结果 -10，赢家 座位3（TAG）"],
    });
    expect(withHands.user).toContain("【最近 2 手回顾】");
    expect(withHands.user).toContain("你 A♥K♦（BTN）");
    expect(withHands.user).toContain("座位3（TAG）");
    const without = buildPrompt(input);
    expect(without.user).not.toContain("最近");
  });
});

describe("buildSlimPrompt（默认生产版）", () => {
  const input = makeDecideInput({
    aiHole: ["As", "Kd"],
    board: ["Qh", "Jh", "2c"],
    street: "flop",
    pot: 60,
    currentBet: 30,
    callAmount: 30,
    legalActions: FACING_RAISE_LEGAL,
    style: "maniac",
  });
  const { system, user } = buildSlimPrompt(input);

  it("保留人设、局面事实、合法动作与 JSON 协议", () => {
    expect(system).toContain("Maniac");
    expect(system).toContain('"action"');
    expect(user).toContain("As Kd");
    expect(user).toContain("Qh Jh 2c");
    expect(user).toContain("底池：60");
    expect(user).toContain("raise");
    expect(user).toContain("只输出一行 JSON");
  });

  it("零注入：无胜率数字、无策略说教、无画像、无回顾", () => {
    const all = system + user;
    expect(all).not.toContain("胜率");
    expect(all).not.toContain("底池赔率");
    expect(all).not.toContain("对手画像");
    expect(all).not.toContain("最近");
    expect(all).not.toContain("策略常识");
    // recentHands/opponentModels 即使传入也被忽略
    const injected = buildSlimPrompt({
      ...input,
      recentHands: ["你 A♥K♦（BTN）：翻前加注｜结果 +120，赢家 你"],
    });
    expect(injected.user).not.toContain("A♥K♦");
  });
});

describe("buildSlimPrompt 英文版（lang='en'，UI 英文时的 LLM 决策 prompt）", () => {
  const input = makeDecideInput({
    aiHole: ["As", "Kd"],
    board: ["Qh", "Jh", "2c"],
    street: "flop",
    pot: 60,
    currentBet: 30,
    callAmount: 30,
    legalActions: FACING_RAISE_LEGAL,
    style: "maniac",
  });
  const { system, user } = buildSlimPrompt(input, "en");

  it("system/user 使用英文标签，输出要求为英文 JSON 协议", () => {
    expect(system).toContain("Maniac");
    expect(system).toContain("professional No-Limit Texas Hold'em player");
    expect(system).toContain("Output exactly one line of strict JSON");
    expect(system).toContain('"reasoning":"one-sentence explanation in English"');
    expect(user).toContain("[Current situation] Flop, 2-max table");
    expect(user).toContain("- Your hole cards: As Kd");
    expect(user).toContain("- Board: Qh Jh 2c");
    expect(user).toContain("- Pot: 60");
    expect(user).toContain("- Your position: BB (Seat 1)");
    expect(user).toContain("[Legal actions]");
    expect(user).toContain("call (match the bet, costs 20 chips)");
    expect(user).toContain("output exactly one line of JSON");
  });

  it("英文版不含中文局面标签；缺省与显式 zh 仍为中文且完全一致", () => {
    expect(user).not.toContain("你的底牌");
    expect(user).not.toContain("底池：");
    expect(user).not.toContain("合法动作");
    expect(system).not.toContain("输出要求");
    const zh = buildSlimPrompt(input);
    expect(zh.user).toContain("你的底牌");
    expect(zh.user).toContain("底池：60");
    expect(zh.system).toContain("输出要求");
    expect(buildSlimPrompt(input, "zh")).toEqual(zh);
  });

  it("锦标赛事实段英文化；现金局无此行", () => {
    const tourney = buildSlimPrompt(
      {
        ...input,
        tournament: {
          playersRemaining: 4,
          totalPlayers: 9,
          myRankByChips: 2,
          myStackBB: 23.4,
          avgStackBB: 18.8,
          blindLevelBB: 20,
          phase: "bubble",
        },
      },
      "en",
    );
    expect(tourney.user).toContain("- Tournament: 4/9 players left");
    expect(tourney.user).toContain("phase: bubble");
    expect(user).not.toContain("Tournament");
  });
});

describe("buildPrompt 多人桌", () => {
  const input = makeDecideInput({
    aiHole: ["As", "Kd"],
    board: ["Qh", "Jh", "2c"],
    street: "flop",
    pot: 150,
    currentBet: 40,
    callAmount: 40,
    aiStack: 300,
    playerCount: 9,
    aiSeat: 5,
    buttonSeat: 0,
    ante: 10,
    opponentOverrides: {
      2: { streetBet: 40, hasActed: true },
      7: { folded: true },
      8: { allIn: true, stack: 0, streetBet: 40, hasActed: true },
    },
    legalActions: FACING_RAISE_LEGAL,
    style: "gto",
  });
  const { system, user } = buildPrompt(input);

  it("user 列出全部 8 名未淘汰对手及其状态", () => {
    const lines = user.match(/^ {2}- 座位 \d+：/gm) ?? [];
    expect(lines).toHaveLength(8);
    expect(user).toContain("  - 座位 0：");
    expect(user).toContain("  - 座位 8：");
    expect(user).not.toContain("  - 座位 5："); // 自己不列入对手
    expect(user).toContain("已弃牌");
    expect(user).toContain("已全下");
    expect(user).toContain("本轮已行动");
  });

  it("user 包含位置名、行动顺序与 ante 死钱", () => {
    expect(user).toContain("UTG+2"); // 9 人桌按钮 0，座位 5 = UTG+2
    expect(user).toContain("行动顺序");
    expect(user).toContain("座位 3"); // 翻前 UTG 最先行动
    expect(user).toContain("ante 死钱 90"); // ante 10 × 9 人
  });

  it("system 使用多人底池常识；多人赔率提示出现在 user", () => {
    expect(system).toContain("多人底池");
    expect(system).toContain("诈唬");
    expect(system).toContain("均衡机器"); // 自己的 gto 人设
    expect(user).toContain("多人底池：你之后可能还有对手行动");
  });

  it("不泄露对手风格人设", () => {
    for (const leak of ["紧弱", "疯狂玩家", "跟注站", "松凶", "紧凶"]) {
      expect(user).not.toContain(leak);
      expect(system).not.toContain(leak);
    }
  });

  it("单挑场景保持单挑常识与格式", () => {
    const hu = buildPrompt(
      makeDecideInput({
        aiHole: ["As", "Kd"],
        pot: 40,
        currentBet: 30,
        callAmount: 30,
        legalActions: FACING_RAISE_LEGAL,
        style: "tag",
      }),
    );
    expect(hu.system).toContain("单挑");
    expect(hu.system).toContain("紧凶");
    expect(hu.system).not.toContain("多人底池策略常识");
    expect(hu.user).toContain("BB（大盲）"); // 2 人桌按钮 0，AI 座位 1 = BB
    expect(hu.user.match(/^ {2}- 座位 \d+：/gm)).toHaveLength(1);
  });
});

describe("parseDecision", () => {
  it("解析干净的 JSON", () => {
    const r = parseDecision(
      '{"action":"raise","amount":80,"reasoning":"顶对加注打价值"}',
      FACING_RAISE_LEGAL,
    );
    expect(r).not.toBeNull();
    expect(r!.action).toEqual({ type: "raise", amount: 80 });
    expect(r!.reasoning).toBe("顶对加注打价值");
  });

  it("容忍 JSON 前后的多余文本", () => {
    const r = parseDecision(
      '好的，我来分析一下局面。\n{"action":"call","amount":20,"reasoning":"赔率合适"}\n以上是我的决策。',
      FACING_RAISE_LEGAL,
    );
    expect(r!.action).toEqual({ type: "call", amount: 20 });
  });

  it("容忍 markdown 代码块包裹", () => {
    const r = parseDecision(
      '```json\n{"action":"fold","amount":0,"reasoning":"牌太弱"}\n```',
      FACING_RAISE_LEGAL,
    );
    expect(r!.action).toEqual({ type: "fold", amount: 0 });
  });

  it("完全无法提取 JSON 时返回 null", () => {
    expect(parseDecision("我选择跟注，因为赔率不错", FACING_RAISE_LEGAL)).toBeNull();
    expect(parseDecision("{broken json", FACING_RAISE_LEGAL)).toBeNull();
    expect(parseDecision("", FACING_RAISE_LEGAL)).toBeNull();
  });

  it("越界金额钳制到合法区间", () => {
    const tooBig = parseDecision(
      '{"action":"raise","amount":99999,"reasoning":"x"}',
      FACING_RAISE_LEGAL,
    );
    expect(tooBig!.action).toEqual({ type: "raise", amount: 200 }); // 钳到全下额

    const tooSmall = parseDecision(
      '{"action":"raise","amount":1,"reasoning":"x"}',
      FACING_RAISE_LEGAL,
    );
    expect(tooSmall!.action).toEqual({ type: "raise", amount: 60 }); // 钳到最小加注
  });

  it("bet 金额同样钳制", () => {
    const r = parseDecision(
      '{"action":"bet","amount":9999,"reasoning":"x"}',
      CAN_CHECK_LEGAL,
    );
    expect(r!.action).toEqual({ type: "bet", amount: 200 });
  });

  it("call 金额以合法动作集为准，忽略 LLM 给的金额", () => {
    const r = parseDecision(
      '{"action":"call","amount":999,"reasoning":"跟注"}',
      FACING_RAISE_LEGAL,
    );
    expect(r!.action).toEqual({ type: "call", amount: 20 });
  });

  it("非法动作类型降级：check 不合法时降级为 call", () => {
    const r = parseDecision(
      '{"action":"check","amount":0,"reasoning":"想过牌"}',
      FACING_RAISE_LEGAL,
    );
    expect(r!.action).toEqual({ type: "call", amount: 20 });
  });

  it("未知动作降级：优先 check，其次 call/fold", () => {
    const r1 = parseDecision('{"action":"fly","amount":0}', CAN_CHECK_LEGAL);
    expect(r1!.action).toEqual({ type: "check", amount: 0 });

    const r2 = parseDecision('{"action":"fly","amount":0}', FOLD_CALL_ONLY);
    expect(r2!.action).toEqual({ type: "call", amount: 20 });

    const r3 = parseDecision('{"not":"json shape"}', [
      { type: "fold", amount: 0 },
    ]);
    expect(r3!.action).toEqual({ type: "fold", amount: 0 });
  });

  it("缺失 reasoning 时给默认说明", () => {
    const r = parseDecision('{"action":"fold"}', FACING_RAISE_LEGAL);
    expect(r!.action).toEqual({ type: "fold", amount: 0 });
    expect(r!.reasoning.length).toBeGreaterThan(0);
  });

  it("allin 金额以合法动作集为准", () => {
    const r = parseDecision(
      '{"action":"allin","amount":1,"reasoning":"全下"}',
      FACING_RAISE_LEGAL,
    );
    expect(r!.action).toEqual({ type: "allin", amount: 200 });
  });
});
