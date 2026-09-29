/**
 * multiway.ts（多路底池共享口径）与三族多人模式测试
 *
 * - 对手数抽取：1|2|3 ≈ 55%/30%/15%；场景级分布联动（发牌器透传）
 * - 判定阈值函数：全部随对手数单调递增，且单挑值等于各族既有常量
 * - 引擎层合理性回归：AA 在三人池/四人池胜率低于单挑（equityMulti 与
 *   equityVsRange 联合采样口径）
 * - 多人判定差分：同一判定胜率单挑判跟注/进攻、三人池判弃牌/过牌；
 *   半诈唬放宽在多人池不生效（翻牌进攻与转牌第二枪）
 * - 题型分布：河牌诈唬题只在单挑池出现（多人只出 value/bluffcatch）
 * - 多路场景生成：行动线人数与 opponents 一致（三人池/四人池标记）、
 *   hero 角色合理（attack=caller / defense=bbDefend / 单挑=open 等）、
 *   底牌落在角色范围内
 */
import { describe, expect, it } from "vitest";
import type { Card } from "@/lib/types";
import {
  drawMultiwayOpenerPos,
  drawOpponentCount,
  flopAttackLine,
  flopDefenseCallLine,
  flopDefenseRaiseLine,
  potPlayers,
  riverBluffcatchCallLine,
  riverValueBetLine,
  semibluffAllowed,
  turnBarrelLine,
  turnDefenseCallLine,
  turnDefenseRaiseLine,
  type OpponentCount,
} from "../multiway";
import {
  ATTACK_EQUITY_THRESHOLD,
  dealPostflopScenario,
  DEFENSE_CALL_THRESHOLD,
  DEFENSE_RAISE_THRESHOLD,
  drawPostflopLine,
  heroRoleForPostflop,
  judgePostflop,
} from "../postflopQuiz";
import {
  dealTurnScenario,
  heroRoleForTurn,
  judgeTurn,
  TURN_BARREL_EQUITY_THRESHOLD,
  TURN_DEFENSE_CALL_THRESHOLD,
  TURN_DEFENSE_RAISE_THRESHOLD,
} from "../turnQuiz";
import {
  dealRiverScenario,
  drawRiverLine,
  heroRoleForRiver,
  judgeRiver,
  RIVER_BLUFFCATCH_CALL_THRESHOLD,
  RIVER_VALUE_BET_THRESHOLD,
} from "../riverQuiz";
import { heroRangeLabels } from "../heroRange";
import { cardsToHandType } from "../pushfold";
import { equityMulti } from "@/lib/poker/equity";
import { equityVsRange } from "@/lib/ai/range";

/** 线性同余种子 rng（测试可复现） */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const c = (s: string) => s.split(" ") as Card[];
const STRONG_DRAW = { flushDraw: true, straightOuts: 0 };
const NO_DRAW = { flushDraw: false, straightOuts: 0 };

describe("drawOpponentCount 对手数分布", () => {
  it("20000 次抽样 ≈ 55% / 30% / 15%", () => {
    const rng = lcg(42);
    const count = { 1: 0, 2: 0, 3: 0 } as Record<OpponentCount, number>;
    const N = 20000;
    for (let i = 0; i < N; i++) count[drawOpponentCount(rng)]++;
    expect(count[1] / N).toBeGreaterThan(0.53);
    expect(count[1] / N).toBeLessThan(0.57);
    expect(count[2] / N).toBeGreaterThan(0.28);
    expect(count[2] / N).toBeLessThan(0.32);
    expect(count[3] / N).toBeGreaterThan(0.13);
    expect(count[3] / N).toBeLessThan(0.17);
  });

  it("potPlayers：1 对手 = 单挑（2 人），3 对手 = 四人池", () => {
    expect(potPlayers(1)).toBe(2);
    expect(potPlayers(2)).toBe(3);
    expect(potPlayers(3)).toBe(4);
  });
});

describe("判定阈值函数（multiway.ts）", () => {
  const lines: [string, (o: OpponentCount) => number, number][] = [
    ["flopAttackLine", flopAttackLine, 0.55],
    ["flopDefenseRaiseLine", flopDefenseRaiseLine, 0.68],
    ["flopDefenseCallLine", flopDefenseCallLine, 0.28],
    ["turnBarrelLine", turnBarrelLine, 0.55],
    ["turnDefenseRaiseLine", turnDefenseRaiseLine, 0.68],
    ["turnDefenseCallLine", turnDefenseCallLine, 0.3],
    ["riverValueBetLine", riverValueBetLine, 0.6],
    ["riverBluffcatchCallLine", riverBluffcatchCallLine, 0.33],
  ];

  it("全部随对手数单调递增", () => {
    for (const [name, f] of lines) {
      expect(f(2), name).toBeGreaterThan(f(1));
      expect(f(3), name).toBeGreaterThan(f(2));
    }
  });

  it("单挑值 = 各族既有判定常量（单挑行为逐点一致）", () => {
    expect(flopAttackLine(1)).toBe(ATTACK_EQUITY_THRESHOLD);
    expect(flopDefenseRaiseLine(1)).toBe(DEFENSE_RAISE_THRESHOLD);
    expect(flopDefenseCallLine(1)).toBe(DEFENSE_CALL_THRESHOLD);
    expect(turnBarrelLine(1)).toBe(TURN_BARREL_EQUITY_THRESHOLD);
    expect(turnDefenseRaiseLine(1)).toBe(TURN_DEFENSE_RAISE_THRESHOLD);
    expect(turnDefenseCallLine(1)).toBe(TURN_DEFENSE_CALL_THRESHOLD);
    expect(riverValueBetLine(1)).toBe(RIVER_VALUE_BET_THRESHOLD);
    expect(riverBluffcatchCallLine(1)).toBe(RIVER_BLUFFCATCH_CALL_THRESHOLD);
    for (const [, f, base] of lines) expect(f(1)).toBe(base);
  });

  it("步进口径：进攻/加注 +0.06/人（不变）、防守跟注 +0.03/人（实现率税）、河牌价值 +0.05/人、抓诈 +0.03/人", () => {
    expect(flopAttackLine(3)).toBeCloseTo(0.67, 10);
    expect(flopDefenseRaiseLine(2)).toBeCloseTo(0.74, 10);
    expect(flopDefenseCallLine(3)).toBeCloseTo(0.34, 10);
    expect(turnDefenseCallLine(2)).toBeCloseTo(0.33, 10);
    expect(riverValueBetLine(3)).toBeCloseTo(0.7, 10);
    expect(riverBluffcatchCallLine(2)).toBeCloseTo(0.36, 10);
  });

  it("半诈唬放宽仅单挑生效", () => {
    expect(semibluffAllowed(1)).toBe(true);
    expect(semibluffAllowed(2)).toBe(false);
    expect(semibluffAllowed(3)).toBe(false);
  });

  it("多人池开局位永不是 BTN（hero 多人线常居 BTN，不能撞位）", () => {
    const rng = lcg(7);
    for (let i = 0; i < 200; i++) {
      expect(drawMultiwayOpenerPos(rng)).not.toBe("BTN");
    }
  });
});

describe("引擎层多人胜率回归（联合采样）", () => {
  it("AA 翻前对随机：四人池胜率显著低于单挑（equityMulti）", () => {
    const hero = c("As Ah");
    const hu = equityMulti(hero, [], 1, 6000);
    const fourWay = equityMulti(hero, [], 3, 6000);
    expect(hu.win).toBeGreaterThan(0.8);
    expect(fourWay.win).toBeLessThan(hu.win - 0.1);
    expect(fourWay.win).toBeGreaterThan(0.5); // 仍是强牌，但被明显摊薄
  });

  it("AA 翻牌圈对跟注者范围：三人池胜率低于单挑（equityVsRange 第 6 参）", () => {
    const hero = c("As Ah") as [Card, Card];
    const board = c("Ts 9d 2c");
    const spec = { topPct: 0.45, bluffPct: 0.1 };
    const hu = equityVsRange(hero, board, spec, 4000, lcg(7), 1);
    const threeWay = equityVsRange(hero, board, spec, 4000, lcg(7), 2);
    const fourWay = equityVsRange(hero, board, spec, 4000, lcg(7), 3);
    expect(threeWay).toBeLessThan(hu);
    expect(fourWay).toBeLessThan(threeWay);
  });
});

describe("多人判定差分（同一胜率，单挑与多人结论不同）", () => {
  it("翻牌防守：0.31 单挑判跟注（≥0.28），四人池判弃牌（<0.34）", () => {
    expect(judgePostflop(0.9, "defense", 0.31, undefined, 1)).toBe("passive");
    expect(judgePostflop(0.9, "defense", 0.31, undefined, 3)).toBe("fold");
  });

  it("翻牌防守加注线：0.71 单挑判加注，三人池只够跟注（线 0.74）", () => {
    expect(judgePostflop(0.9, "defense", 0.71, undefined, 1)).toBe("aggressive");
    expect(judgePostflop(0.9, "defense", 0.71, undefined, 2)).toBe("passive");
  });

  it("翻牌进攻：0.58 单挑判进攻，三人池过牌（线 0.61）", () => {
    expect(judgePostflop(0.58, "attack", undefined, NO_DRAW, 1)).toBe("aggressive");
    expect(judgePostflop(0.58, "attack", undefined, NO_DRAW, 2)).toBe("passive");
  });

  it("翻牌半诈唬多人池不放宽：0.50 + 强听牌单挑进攻、三人池过牌", () => {
    expect(judgePostflop(0.5, "attack", undefined, STRONG_DRAW, 1)).toBe("aggressive");
    expect(judgePostflop(0.5, "attack", undefined, STRONG_DRAW, 2)).toBe("passive");
    expect(judgePostflop(0.5, "attack", undefined, STRONG_DRAW, 3)).toBe("passive");
  });

  it("转牌面对第二枪：0.33 单挑判跟注（≥0.30），四人池判弃牌（<0.36）", () => {
    expect(judgeTurn(0.33, "defense", undefined, 1)).toBe("passive");
    expect(judgeTurn(0.33, "defense", undefined, 3)).toBe("fold");
  });

  it("转牌第二枪：0.58 单挑进攻，三人池过牌（线 0.61）；半诈唬多人池不放宽", () => {
    expect(judgeTurn(0.58, "barrel", NO_DRAW, 1)).toBe("aggressive");
    expect(judgeTurn(0.58, "barrel", NO_DRAW, 2)).toBe("passive");
    expect(judgeTurn(0.45, "barrel", STRONG_DRAW, 1)).toBe("aggressive");
    expect(judgeTurn(0.45, "barrel", STRONG_DRAW, 2)).toBe("passive");
  });

  it("河牌薄价值：0.63 单挑判下注（≥0.60），四人池过牌（线 0.70）", () => {
    expect(judgeRiver(0.9, "value", 0.63, 1)).toBe("aggressive");
    expect(judgeRiver(0.9, "value", 0.63, 3)).toBe("passive");
  });

  it("河牌抓诈：0.35 单挑判跟注（≥0.33），四人池判弃牌（线 0.39）", () => {
    expect(judgeRiver(0.1, "bluffcatch", 0.35, 1)).toBe("passive");
    expect(judgeRiver(0.1, "bluffcatch", 0.35, 3)).toBe("fold");
  });

  it("河牌诈唬题判定不受对手数参数影响（题型本身只在单挑出现）", () => {
    expect(judgeRiver(0.24, "bluff", undefined, 1)).toBe("aggressive");
    expect(judgeRiver(0.3, "bluff", undefined, 1)).toBe("passive");
  });
});

describe("多人池防守框架（2026-09-29 修正：对下注者胜率 + 实现率税）", () => {
  // 旧框架「联合胜率 + 跟注线 +0.04/0.05pp/人」对多人摊薄重复计费（用户实报：
  // 四人池顶两对面对第二枪被误弃）。新框架：防守只评估对下注者的胜率
  // （身后跟注者视为死钱改善直接赔率），跟注线步进降为 +0.03/人实现率税；
  // 加注线 +0.06/人与进攻侧步进不变（加注/进攻是打全场）。
  it("防守跟注线 +0.03/人（翻牌 0.28 / 转牌 0.30 / 河牌抓诈 0.33 基准），单挑值不变", () => {
    expect(flopDefenseCallLine(1)).toBeCloseTo(0.28, 10);
    expect(flopDefenseCallLine(2)).toBeCloseTo(0.31, 10);
    expect(flopDefenseCallLine(3)).toBeCloseTo(0.34, 10);
    expect(turnDefenseCallLine(1)).toBeCloseTo(0.3, 10);
    expect(turnDefenseCallLine(2)).toBeCloseTo(0.33, 10);
    expect(turnDefenseCallLine(3)).toBeCloseTo(0.36, 10);
    expect(riverBluffcatchCallLine(1)).toBeCloseTo(0.33, 10);
    expect(riverBluffcatchCallLine(2)).toBeCloseTo(0.36, 10);
    expect(riverBluffcatchCallLine(3)).toBeCloseTo(0.39, 10);
  });

  it("加注线保持 +0.06/人（加注是打全场，仍需碾压级牌力），进攻侧步进不变", () => {
    expect(flopDefenseRaiseLine(3)).toBeCloseTo(0.8, 10);
    expect(turnDefenseRaiseLine(3)).toBeCloseTo(0.8, 10);
    expect(flopAttackLine(3)).toBeCloseTo(0.67, 10);
    expect(turnBarrelLine(3)).toBeCloseTo(0.67, 10);
    expect(riverValueBetLine(3)).toBeCloseTo(0.7, 10);
  });
});

describe("多路场景生成", () => {
  it("翻牌圈：opponents 分布透传（≈55/30/15），三种人数都出现", () => {
    const rng = lcg(2026);
    const count = { 1: 0, 2: 0, 3: 0 } as Record<OpponentCount, number>;
    const N = 600;
    for (let i = 0; i < N; i++) count[dealPostflopScenario(rng).opponents]++;
    expect(count[1]).toBeGreaterThan(0);
    expect(count[2]).toBeGreaterThan(0);
    expect(count[3]).toBeGreaterThan(0);
    expect(count[1] / N).toBeGreaterThan(0.45);
    expect(count[1] / N).toBeLessThan(0.65);
    expect(count[2] / N).toBeGreaterThan(0.22);
    expect(count[2] / N).toBeLessThan(0.38);
    expect(count[3] / N).toBeGreaterThan(0.08);
    expect(count[3] / N).toBeLessThan(0.22);
  });

  it("翻牌圈：行动线人数与 opponents 一致，hero 角色合理", () => {
    const rng = lcg(99);
    let multi = 0;
    for (let i = 0; i < 400; i++) {
      const s = dealPostflopScenario(rng);
      if (s.opponents === 1) continue;
      multi++;
      // 行动线标记底池人数
      expect(s.actionLine[0].zh).toContain(
        s.opponents === 2 ? "三人池" : "四人池",
      );
      // 多人线 kind 恒 open（无 3bet 多人线）
      expect(s.lineKind).toBe("open");
      const role = heroRoleForPostflop(s.type, s.lineKind, s.opponents);
      if (s.type === "attack") {
        // hero = BTN 跟注者，最后行动
        expect(role).toBe("caller");
        expect(s.actionLine[0].zh).toContain("（BTN）跟注");
        expect(s.actionLine[1].zh).toContain("最后行动");
      } else {
        // hero = 大盲跟注者，面对开局者持续下注且身后有人
        expect(role).toBe("bbDefend");
        expect(s.actionLine[0].zh).toContain("（大盲）也跟注");
        expect(s.actionLine[1].zh).toContain("尚未行动");
      }
      // 底牌落在角色范围内
      const label = cardsToHandType(s.hero[0], s.hero[1]).label;
      expect(heroRangeLabels(role).has(label)).toBe(true);
    }
    expect(multi).toBeGreaterThan(100);
  });

  it("转牌圈：行动线人数与 opponents 一致，hero 角色合理", () => {
    const rng = lcg(77);
    let multi = 0;
    for (let i = 0; i < 400; i++) {
      const s = dealTurnScenario(rng);
      if (s.opponents === 1) continue;
      multi++;
      expect(s.actionLine[0].zh).toContain(
        s.opponents === 2 ? "三人池" : "四人池",
      );
      expect(s.lineKind).toBe("open");
      const role = heroRoleForTurn(s.type, s.lineKind);
      if (s.type === "barrel") {
        // hero 开局被多家跟注，翻牌一枪被多家跟注
        expect(role).toBe("open");
        expect(s.actionLine[1].zh).toContain("都跟注");
      } else {
        // hero 大盲跟注，面对第二枪且身后有人
        expect(role).toBe("bbDefend");
        expect(s.actionLine[0].zh).toContain("（大盲）也跟注");
        expect(s.actionLine[2].zh).toContain("尚未行动");
      }
      const label = cardsToHandType(s.hero[0], s.hero[1]).label;
      expect(
        heroRangeLabels(role, role === "open" ? s.openPos : undefined).has(
          label,
        ),
      ).toBe(true);
    }
    expect(multi).toBeGreaterThan(100);
  });

  it("河牌圈：诈唬题只在单挑池出现；多人只出 value/bluffcatch", () => {
    const rng = lcg(55);
    const multiTypes = new Set<string>();
    let bluffCount = 0;
    let multi = 0;
    for (let i = 0; i < 400; i++) {
      const s = dealRiverScenario(rng);
      if (s.type === "bluff") {
        bluffCount++;
        expect(s.opponents).toBe(1);
      }
      if (s.opponents > 1) {
        multi++;
        multiTypes.add(s.type);
        expect(["value", "bluffcatch"]).toContain(s.type);
        expect(s.actionLine[0].zh).toContain(
          s.opponents === 2 ? "三人池" : "四人池",
        );
      }
    }
    expect(bluffCount).toBeGreaterThan(20); // 单挑时诈唬题照常出现
    expect(multi).toBeGreaterThan(100);
    expect(multiTypes.size).toBe(2); // 多人池两种题型都覆盖
  });

  it("河牌圈多人：hero 角色合理（value=open / bluffcatch=bbDefend），底牌在范围内", () => {
    const rng = lcg(31);
    let checked = 0;
    for (let i = 0; i < 400 && checked < 80; i++) {
      const s = dealRiverScenario(rng);
      if (s.opponents === 1) continue;
      checked++;
      const role = heroRoleForRiver(s.lineKind, s.type, s.opponents);
      if (s.type === "value") {
        expect(role).toBe("open");
        expect(["BTN", "CO"]).toContain(s.openPos); // hero 开局位固定 BTN/CO
      } else {
        expect(role).toBe("bbDefend");
        expect(s.actionLine[0].zh).toContain("（大盲）也跟注");
        expect(s.actionLine[3].zh).toContain("尚未行动");
      }
      const label = cardsToHandType(s.hero[0], s.hero[1]).label;
      expect(
        heroRangeLabels(role, role === "open" ? s.openPos : undefined).has(
          label,
        ),
      ).toBe(true);
    }
    expect(checked).toBe(80);
  });

  it("drawRiverLine 诈唬题多人池直接拒绝（防御性兜底）", () => {
    expect(() => drawRiverLine("bluff", lcg(1), 2)).toThrow();
    expect(() => drawRiverLine("bluff", lcg(1), 3)).toThrow();
  });

  it("drawPostflopLine 多人线可复现且 defense 恒 open 线", () => {
    expect(drawPostflopLine("defense", lcg(5), 2)).toEqual(
      drawPostflopLine("defense", lcg(5), 2),
    );
    expect(drawPostflopLine("defense", lcg(5), 3).kind).toBe("open");
    expect(drawPostflopLine("attack", lcg(5), 2).kind).toBe("open");
  });
});
