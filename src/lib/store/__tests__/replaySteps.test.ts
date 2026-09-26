/**
 * 回放 buildSteps（components/history/replay）回归测试。
 *
 * 锁定回放步骤序列契约：
 * - 每条街（含空动作的跑马街）至少有一个「进入该街」步骤 → 街道 tab 可点；
 * - 摊牌手在末尾追加终局步骤（streetIdx = streets.length 哨兵）→ 「摊牌」tab 落点；
 * - 非摊牌手不追加终局步骤；
 * - 底池按 bet-to 增量正确累计；
 * - foldedSeatsAt 跟踪弃牌座位（摊牌亮牌名单依据）。
 */
import { describe, expect, it } from "vitest";
import type { Card, HandRecord, StreetRecord } from "@/lib/types";
import {
  buildSteps,
  foldedSeatsAt,
  isShowdownStep,
} from "@/components/history/replay";

/** 测试用 t 桩：直接回显 key（buildSteps 只在动作文案里用 t，结构断言不受影响） */
const t = (key: string): string => key;

const c = (s: string) => s.split(" ") as Card[];

/** 单挑全下跑马手（同 coachPrompt 的场景）：翻前 all-in 被跟注，后三街空动作补录 */
function makeRunoutHand(overrides: Partial<HandRecord> = {}): HandRecord {
  const board = c("Qh 7d 2c 5s 9h");
  const streets: StreetRecord[] = [
    {
      street: "preflop",
      board: [],
      actions: [
        { seat: 0, action: { type: "allin", amount: 200 } }, // SB 已投 1，增量 199
        { seat: 1, action: { type: "call", amount: 198 } }, // BB 补 198
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

describe("buildSteps 街道覆盖（含空动作跑马街）", () => {
  it("每条街都有步骤（tab 可点），空动作街也有「进入该街」步骤", () => {
    const hand = makeRunoutHand();
    const steps = buildSteps(hand, t);
    // 每条街恰好一个起始步骤（actionIdx=-1），翻前另有 2 个动作步骤
    for (let si = 0; si < hand.streets.length; si++) {
      expect(steps.some((s) => s.streetIdx === si)).toBe(true);
    }
    const streetStarts = steps.filter((s) => s.actionIdx === -1 && !isShowdownStep(hand, s));
    expect(streetStarts).toHaveLength(4); // preflop/flop/turn/river 各一
  });

  it("摊牌手追加终局步骤作为「摊牌」tab 落点；底池累计正确", () => {
    const hand = makeRunoutHand();
    const steps = buildSteps(hand, t);
    const last = steps[steps.length - 1];
    expect(isShowdownStep(hand, last)).toBe(true);
    expect(last.streetIdx).toBe(hand.streets.length);
    // 底池：盲注 3 + hero 全下增量 199 + BB 跟注 198 = 400
    expect(last.pot).toBe(400);
    // 翻前 all-in 步骤的底池：3 + 199 = 202
    const allinStep = steps.find((s) => s.actor === 0 && s.actionIdx === 0);
    expect(allinStep?.pot).toBe(202);
  });

  it("非摊牌手（提前 fold）不追加终局步骤", () => {
    const hand = makeRunoutHand({
      streets: [
        {
          street: "preflop",
          board: [],
          actions: [{ seat: 0, action: { type: "fold", amount: 0 } }],
        },
      ],
      finalBoard: [],
      showdown: false,
      result: "lose",
      profit: -1,
    });
    const steps = buildSteps(hand, t);
    expect(steps.some((s) => isShowdownStep(hand, s))).toBe(false);
    expect(steps).toHaveLength(2); // 进入翻前 + fold
  });

  it("foldedSeatsAt：弃牌者被跟踪（摊牌亮牌名单依据），未弃牌者不在集合中", () => {
    const hand = makeRunoutHand({
      streets: [
        {
          street: "preflop",
          board: [],
          actions: [
            { seat: 1, action: { type: "fold", amount: 0 } },
            { seat: 0, action: { type: "call", amount: 1 } },
          ],
        },
      ],
      showdown: false,
    });
    const steps = buildSteps(hand, t);
    const folded = foldedSeatsAt(hand, steps, steps.length - 1);
    expect(folded.has(1)).toBe(true);
    expect(folded.has(0)).toBe(false);
  });
});
