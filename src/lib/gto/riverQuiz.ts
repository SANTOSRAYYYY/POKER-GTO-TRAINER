/**
 * src/lib/gto/riverQuiz.ts — 河牌圈出题器（river 场景）
 *
 * 出题：按行动线的 hero 角色从对应范围抽底牌（sampleHeroCards，见
 * heroRange.ts 的「底牌与行动线一致性」设计）+ 从剩余牌发 5 张公共牌
 * （无重复），子题型三选一（随机），并随机抽一条覆盖三条街的完整行动线
 * （drawRiverLine，rng 注入）：
 * - value（薄价值 or 过牌）：你最后行动、无人下注——下注拿价值还是过牌比牌？
 *   行动线两种：open（你开局，c-bet 一枪后转牌双方过牌 → 对手跟注范围前 50%）
 *   / threeBet（你翻前 3bet 后连开两枪都被跟 → 前两街都跟了，范围收窄到前 40%）。
 * - bluffcatch（抓诈 or 弃牌）：对手下注一个满池——跟注抓诈还是弃牌？
 *   行动线两种（open / threeBet），极化范围不变（前 25% 强牌 + 35% 诈唬混入）。
 * - bluff（诈唬 or 放弃）：无人下注——诈唬偷池还是过牌放弃？
 *   行动线两种：open（你 c-bet 一枪后转牌双方过牌）/ flat（你跟注开局，翻牌
 *   双方过牌、转牌对手过牌放弃）。
 *
 * hero 角色映射（heroRoleForRiver）：open 线（你开局）→ open；threeBet 线
 * （你大盲 3bet）→ threeBet；flat 线（你大盲跟注对手开局）→ bbDefend。
 * 听牌没中的合理性由此成立：可玩牌才有听牌入池。
 *
 * 诈唬题文本与底牌一致性（2026-09-29 A1 修复）：行动线末句的「你的听牌全
 * 没中」只对真·空气使用——出题时用 heroRiverHand 做成牌检测（hero 底牌在
 * 5 张公共牌上是否参与成对/成顺/成花；evaluate7 口径，河牌 7 张已定无听牌
 * 可言，analyzeDraws 不适用）：hero 有成牌时末句改为如实描述（价值带「你
 * 击中了牌面」/ 中间带「这手牌有摊牌价值」）；成牌但精确胜率 <25% 的稀有
 * 弱成牌直接重发——成牌题选诈唬=错，真诈唬答案只颁给纯空气。
 *
 * 判定口径（全部实算）：
 * - 河牌公共牌已齐，单挑 vs 随机胜率可精确枚举：riverEquityExact 遍历剩余
 *   45 张牌的全部 C(45,2)=990 个对手组合，evaluate7 逐个比大小，无蒙特卡洛
 *   误差（确定性结果，答题判定与测试都稳定）。多人池改为 equityMulti 按
 *   对手数联合蒙特卡洛（组合数随对手数爆炸，无法精确枚举）。
 * - value：equityVsRange（对手 = 跟注范围 riverValueCallerSpecFor：open 线
 *   前 50% / threeBet 线前 40%，均 + 5% 诈唬混入）≥ 价值线（单挑 60%，每多
 *   一对手 +5pp）→ aggressive（价值下注）；45%-价值线 → passive（薄价值不够
 *   薄别贪：下注多半只被更强的牌跟）；< 45% → passive（过牌）。
 * - bluffcatch：equityVsRange（对手 = 极化范围 RIVER_BLUFFCATCH_POLAR_SPEC：
 *   前 25% 强牌 + 35% 诈唬混入）≥ 跟注线（单挑 33%，+3pp/人实现率税；满池注
 *   跟 1 池赢 3 池，保本胜率 33%）→ passive（跟注抓诈）；否则 → fold。
 * - bluff：精确胜率 < 25% → aggressive（诈唬：毫无摊牌价值，过牌=认输，
 *   唯有下注能赢）；25-45% → passive（弱牌有摊牌价值别诈唬：诈唬只会打走
 *   更弱的、被更强的跟）；≥ 45% → aggressive（牌力领先，价值下注）。
 *   **诈唬题只在单挑池出现**——多人池纯诈唬是负 EV 教学反面（需全部对手
 *   弃牌），多人池题型只抽 value / bluffcatch。
 *
 * 多路底池（multiway，见 multiway.ts）：opponents 按 55/30/15% 抽 1|2|3。
 * 多人行动线 kind 恒 open：value 多人线 = hero BTN/CO 开局被盲注（与按钮）
 * 跟注、连开一枪后转牌全过（hero role = open）；bluffcatch 多人线 = hero
 * 大盲跟注多人池，河牌面对开局者满池注且身后还有人（hero role = bbDefend，
 * heroRoleForRiver 需要 type+opponents 判定）。两套胜率口径（2026-09-29
 * 修正）：
 * - value（进攻侧）：薄价值下注要被更差的牌跟、压住全场，对 opponents 名
 *   跟注者联合采样，价值线步进不变（+0.05/人）；
 * - bluffcatch（防守侧）：面对满池注只评估 hero 对下注者极化范围的胜率
 *   （equityVsRange(..., opponents=1)）——身后尚未行动的跟注者视为死钱，
 *   死钱反而改善直接赔率，实现率税体现为跟注线 +0.03/人（由 +0.05 下调）。
 * 单挑（opponents=1）行为逐比特不变。
 *
 * 难度过滤（isTooObvious，见 trainerDifficulty.ts）：抓诈题 <20%/>85% 重发；
 * 薄价值题 >85%（无脑价值）或 <25%（纯空气过牌）重发；诈唬题只保留 >85%
 * （坚果级价值下注毫无决策含量）重发——**豁免 <25% 下限**（2026-09-29 A1
 * 修复）：纯空气必诈恰是诈唬题的教学本体（judgeRiver：<25% → 诈唬），
 * 过滤它这族题就永远不出真诈唬答案。10 次上限兜底。
 *
 * 判定精度（2026-09-29 A3）：value/bluffcatch 的判定胜率（equityVsRange，
 * 2000 次蒙特卡洛）落在判定阈值 ±3pp 边界带内时，自动用 20000 次迭代复核
 * 一次再定答案（见 borderline.ts）；bluff 题单挑精确枚举无 MC 噪声，不触发。
 *
 * 「摊牌价值」（showdown value）：弱成牌（如小对子）过牌有机会在摊牌赢下
 * 更弱的牌，但一旦下注，更弱的牌会弃、更强的牌会跟——下注反而把赢面打没。
 * 所以河牌极化：强牌与纯空气下注，中间牌过牌。
 */
import type { Card } from "@/lib/types";
import { newDeck } from "@/lib/poker/cards";
import { evaluate7 } from "@/lib/poker/evaluator";
import { equityMulti, type EquityResult } from "@/lib/poker/equity";
import { equityVsRange, type RangeSpec } from "@/lib/ai/range";
import {
  drawBetSize,
  drawOpenPos,
  threeBetToText,
  type LocalizedText,
  type OpenPos,
} from "@/lib/gto/actionLine";
import {
  dealRemainingCards,
  sampleHeroCards,
  type HeroRole,
} from "@/lib/gto/heroRange";
import {
  FILTER_MAX_ATTEMPTS,
  isDefenseLikeObvious,
  isOffenseLikeObvious,
  OBVIOUS_NUTS_MIN,
} from "@/lib/gto/trainerDifficulty";
import { rejudgeIfBorderline } from "@/lib/gto/borderline";
import {
  drawMultiwayOpenerPos,
  drawOpponentCount,
  potPlayers,
  riverBluffcatchCallLine,
  riverValueBetLine,
  type OpponentCount,
} from "@/lib/gto/multiway";
import { QUIZ_ITERATIONS, type PostflopChoice } from "@/lib/gto/postflopQuiz";

/** 子题型：value = 薄价值 / bluffcatch = 抓诈 / bluff = 诈唬 */
export type RiverScenarioType = "value" | "bluffcatch" | "bluff";

/**
 * 行动线种类：
 * - open：hero 翻前开局加注（value/bluffcatch/bluff 通用）；
 * - threeBet：hero 翻前 3bet（value/bluffcatch）——前两街都打满，范围更紧；
 * - flat：hero 翻前跟注对手开局（仅 bluff：翻牌双方过牌的弱池）。
 */
export type RiverLineKind = "open" | "threeBet" | "flat";

export interface RiverScenario {
  hero: [Card, Card];
  board: [Card, Card, Card, Card, Card];
  type: RiverScenarioType;
  /** 本题的前文行动线（双语多行，页面渲染用） */
  actionLine: LocalizedText[];
  /** 行动线种类（驱动价值题跟注范围收窄与文案） */
  lineKind: RiverLineKind;
  /** 行动线中的开局位（hero 开局线 = hero 位置；底牌范围对齐用） */
  openPos: OpenPos;
  /** 对手数：1 = 单挑，2 = 三人池，3 = 四人池（诈唬题恒为 1——多人池不出纯诈唬题） */
  opponents: OpponentCount;
}

export interface RiverQuiz extends RiverScenario {
  /** vs 随机对手的胜率（单挑 = 精确枚举；多人 = 按对手数联合蒙特卡洛。展示用；bluff 题的判定胜率） */
  equity: EquityResult;
  /** 判定胜率（value 题对跟注范围联合采样；bluffcatch 题对下注者极化范围，含多人池只对下注者；bluff 题为 null） */
  rangeEquity: number | null;
  /** 由胜率与子题型推导的标准答案 */
  answer: PostflopChoice;
}

/** 价值下注线（单挑基准）：对跟注范围胜率 ≥ 60%；多人用 riverValueBetLine */
export const RIVER_VALUE_BET_THRESHOLD = riverValueBetLine(1);
/** 薄价值带下沿：45%-价值线 过牌（点评区分「薄价值不够」与「太弱」的分界） */
export const RIVER_THIN_VALUE_MIN = 0.45;
/** 价值题判定用——河牌跟注者隐含范围（常规线）：前 50% 强度 + 5% 诈唬混入 */
export const RIVER_VALUE_CALLER_SPEC = { topPct: 0.5, bluffPct: 0.05 } as const;
/** 价值题判定用——前两街都开枪都被跟后的跟注范围：收紧到前 40% + 5% 诈唬混入 */
export const RIVER_VALUE_CALLER_2STREET_SPEC = { topPct: 0.4, bluffPct: 0.05 } as const;
/** 抓诈跟注线（单挑基准）：对极化范围胜率 ≥ 33%（满池注赔率：跟 1 池赢 3 池）；多人用 riverBluffcatchCallLine */
export const RIVER_BLUFFCATCH_CALL_THRESHOLD = riverBluffcatchCallLine(1);
/** 抓诈题判定用——满池下注者极化范围：前 25% 强牌 + 35% 诈唬混入（不随行动线变化） */
export const RIVER_BLUFFCATCH_POLAR_SPEC = { topPct: 0.25, bluffPct: 0.35 } as const;
/** 诈唬上限：精确胜率 < 25%（无摊牌价值）才诈唬 */
export const RIVER_BLUFF_MAX_EQUITY = 0.25;
/** 摊牌价值带上限：25-45% 过牌；≥ 45% 价值下注 */
export const RIVER_SHOWDOWN_VALUE_MAX = 0.45;

/**
 * 价值题跟注范围随行动线收窄（前文越多范围越紧）：
 * - open（c-bet 一枪后转牌双方过牌）→ RIVER_VALUE_CALLER_SPEC（前 50%）；
 * - threeBet（翻前 3bet + 连开两枪都被跟）→ RIVER_VALUE_CALLER_2STREET_SPEC（前 40%）。
 */
export function riverValueCallerSpecFor(lineKind: RiverLineKind): RangeSpec {
  return lineKind === "threeBet"
    ? RIVER_VALUE_CALLER_2STREET_SPEC
    : RIVER_VALUE_CALLER_SPEC;
}

/** 随机抽一条河牌圈行动线（rng 注入可复现）：单挑三个子题型各 2 种真实常见路线；多人池（opponents>1）走多人线（kind 恒 open，诈唬题多人池不出）；返回开局位供底牌范围对齐 */
export function drawRiverLine(
  type: RiverScenarioType,
  rng: () => number = Math.random,
  opponents: OpponentCount = 1,
): { kind: RiverLineKind; lines: LocalizedText[]; pos: OpenPos } {
  const size = drawBetSize(rng);
  if (opponents > 1) {
    if (type === "bluff") {
      // 多人池不出纯诈唬题（负 EV 教学反面）——dealRiverScenario 已排除，防御性兜底
      throw new Error("诈唬题只在单挑池出现");
    }
    const threeWay = opponents === 2;
    if (type === "value") {
      // 多人薄价值：hero 开局被多家跟注（三人池 = BTN 开局两盲注跟；
      // 四人池 = CO 开局按钮+两盲注跟），翻牌一枪被跟、转牌全过
      const pos: OpenPos = threeWay ? "BTN" : "CO";
      return {
        kind: "open",
        pos,
        lines: [
          threeWay
            ? {
                zh: "翻前：你（BTN）开局加注到 2.5bb，小盲与大盲都跟注（三人池）",
                en: "Preflop: you (BTN) open-raise to 2.5bb; both blinds call (three-way pot)",
              }
            : {
                zh: "翻前：你（CO）开局加注到 2.5bb，按钮、小盲与大盲都跟注（四人池）",
                en: "Preflop: you (CO) open-raise to 2.5bb; the button and both blinds call (four-way pot)",
              },
          threeWay
            ? {
                zh: `翻牌圈：你持续下注 ${size.zh}，两家都跟注`,
                en: `Flop: you continuation-bet ${size.en} and both call`,
              }
            : {
                zh: `翻牌圈：你持续下注 ${size.zh}，三家都跟注`,
                en: `Flop: you continuation-bet ${size.en} and all three call`,
              },
          { zh: "转牌圈：大家都过牌", en: "Turn: everyone checks" },
          threeWay
            ? {
                zh: "河牌圈：小盲与大盲都过牌，轮到你",
                en: "River: both blinds check — action on you",
              }
            : {
                zh: "河牌圈：小盲与大盲过牌，轮到你（按钮尚未行动）",
                en: "River: the blinds check — action on you (button still to act)",
              },
        ],
      };
    }
    // 多人抓诈：hero 大盲跟注，河牌面对开局者满池注且身后还有人
    const pos = drawMultiwayOpenerPos(rng);
    return {
      kind: "open",
      pos,
      lines: [
        threeWay
          ? {
              zh: `翻前：对手（${pos}）开局加注到 2.5bb，按钮跟注，你（大盲）也跟注（三人池）`,
              en: `Preflop: the ${pos} opens to 2.5bb, the button calls, and you call in the big blind (three-way pot)`,
            }
          : {
              zh: `翻前：对手（${pos}）开局加注到 2.5bb，中位与按钮都跟注，你（大盲）也跟注（四人池）`,
              en: `Preflop: the ${pos} opens to 2.5bb, middle position and the button both call, and you call in the big blind (four-way pot)`,
            },
        threeWay
          ? {
              zh: `翻牌圈：你过牌，对手持续下注 ${size.zh}，按钮跟注，你也跟注`,
              en: `Flop: you check, the opener c-bets ${size.en}, the button calls, and you call too`,
            }
          : {
              zh: `翻牌圈：你过牌，对手持续下注 ${size.zh}，两家跟注，你也跟注`,
              en: `Flop: you check, the opener c-bets ${size.en}, both call, and you call too`,
            },
        { zh: "转牌圈：大家都过牌", en: "Turn: everyone checks" },
        threeWay
          ? {
              zh: "河牌圈：你过牌，对手下注一个满池，按钮尚未行动——轮到你",
              en: "River: you check, the opener bets a full pot with the button still to act — action on you",
            }
          : {
              zh: "河牌圈：你过牌，对手下注一个满池，两家尚未行动——轮到你",
              en: "River: you check, the opener bets a full pot with two players still to act — action on you",
            },
      ],
    };
  }
  const pos = drawOpenPos(rng);
  const threeBet = threeBetToText();
  const kind: RiverLineKind =
    type === "bluff"
      ? rng() < 0.5
        ? "open"
        : "flat"
      : rng() < 0.5
        ? "open"
        : "threeBet";

  if (type === "value") {
    if (kind === "open") {
      return {
        kind,
        pos,
        lines: [
          {
            zh: `翻前：你（${pos}）开局加注到 2.5bb，大盲跟注`,
            en: `Preflop: you (${pos}) open-raise to 2.5bb and the big blind calls`,
          },
          {
            zh: `翻牌圈：你持续下注 ${size.zh}，对手跟注`,
            en: `Flop: you continuation-bet ${size.en} and the big blind calls`,
          },
          { zh: "转牌圈：双方都过牌", en: "Turn: both players check" },
          {
            zh: "河牌圈：对手过牌，轮到你",
            en: "River: the big blind checks — action on you",
          },
        ],
      };
    }
    return {
      kind,
      pos,
      lines: [
        {
          zh: `翻前：对手（${pos}）开局加注到 2.5bb，你（大盲）3bet 到 ${threeBet.zh}，对手跟注`,
          en: `Preflop: the ${pos} opens to 2.5bb; you (big blind) 3-bet to ${threeBet.en} and they call`,
        },
        {
          zh: `翻牌圈：你持续下注 ${size.zh}，对手跟注`,
          en: `Flop: you continuation-bet ${size.en} and the opener calls`,
        },
        {
          zh: `转牌圈：你再开第二枪 ${size.zh}，对手仍跟注`,
          en: `Turn: you fire a second barrel (${size.en}) and they call again`,
        },
        {
          zh: "河牌圈：对手过牌，轮到你",
          en: "River: the opener checks — action on you",
        },
      ],
    };
  }

  if (type === "bluffcatch") {
    if (kind === "open") {
      return {
        kind,
        pos,
        lines: [
          {
            zh: `翻前：你（${pos}）开局加注到 2.5bb，大盲跟注`,
            en: `Preflop: you (${pos}) open-raise to 2.5bb and the big blind calls`,
          },
          {
            zh: `翻牌圈：你持续下注 ${size.zh}，对手跟注`,
            en: `Flop: you continuation-bet ${size.en} and the big blind calls`,
          },
          {
            zh: `转牌圈：你过牌，对手下注 ${size.zh}，你跟注`,
            en: `Turn: you check, the big blind bets ${size.en}, and you call`,
          },
          {
            zh: "河牌圈：对手下注一个满池",
            en: "River: the big blind bets a full pot",
          },
        ],
      };
    }
    return {
      kind,
      pos,
      lines: [
        {
          zh: `翻前：对手（${pos}）开局加注到 2.5bb，你（大盲）3bet 到 ${threeBet.zh}，对手跟注`,
          en: `Preflop: the ${pos} opens to 2.5bb; you (big blind) 3-bet to ${threeBet.en} and they call`,
        },
        {
          zh: `翻牌圈：你过牌，对手下注 ${size.zh}，你跟注`,
          en: `Flop: you check, the opener bets ${size.en}, and you call`,
        },
        {
          zh: `转牌圈：你过牌，对手再下注 ${size.zh}，你跟注`,
          en: `Turn: you check, the opener bets ${size.en} again, and you call`,
        },
        {
          zh: "河牌圈：对手下注一个满池",
          en: "River: the opener bets a full pot",
        },
      ],
    };
  }

  // bluff
  if (kind === "open") {
    return {
      kind,
      pos,
      lines: [
        {
          zh: `翻前：你（${pos}）开局加注到 2.5bb，大盲跟注`,
          en: `Preflop: you (${pos}) open-raise to 2.5bb and the big blind calls`,
        },
        {
          zh: `翻牌圈：你持续下注 ${size.zh}，对手跟注`,
          en: `Flop: you continuation-bet ${size.en} and the big blind calls`,
        },
        { zh: "转牌圈：双方都过牌", en: "Turn: both players check" },
        {
          zh: "河牌圈：对手过牌，你的听牌全没中",
          en: "River: the big blind checks and all your draws have missed",
        },
      ],
    };
  }
  return {
    kind,
    pos,
    lines: [
      {
        zh: `翻前：对手（${pos}）开局加注到 2.5bb，你（大盲）跟注`,
        en: `Preflop: the ${pos} open-raises to 2.5bb and you (big blind) call`,
      },
      { zh: "翻牌圈：双方都过牌", en: "Flop: both players check" },
      {
        zh: "转牌圈：你过牌，对手也过牌",
        en: "Turn: you check and the opener checks back",
      },
      {
        zh: "河牌圈：轮到你行动——你的听牌全没中",
        en: "River: action on you — all your draws have missed",
      },
    ],
  };
}

/**
 * 河牌圈行动线里的 hero 翻前角色（驱动底牌范围，见 heroRange.ts）：
 * - open 线：你开局大盲跟注（value/bluffcatch/bluff 通用）→ open；
 * - threeBet 线：你（大盲）3bet 对手开局 → threeBet；
 * - flat 线（仅 bluff）：对手开局你（大盲）跟注 → bbDefend；
 * - 多人 bluffcatch（open 线 + opponents>1）：hero 是大盲跟注方 → bbDefend
 *   （多人 value 线 hero 仍是开局方 → open）。
 */
export function heroRoleForRiver(
  lineKind: RiverLineKind,
  type: RiverScenarioType,
  opponents: OpponentCount = 1,
): HeroRole {
  if (lineKind === "threeBet") return "threeBet";
  if (lineKind === "flat") return "bbDefend";
  if (type === "bluffcatch" && opponents > 1) return "bbDefend";
  return "open";
}

/**
 * 随机发一个河牌圈场景：先抽对手数（55/30/15%）与子题型（诈唬题只在单挑池
 * 出现——多人池纯诈唬是负 EV 教学反面，多人只抽 value/bluffcatch），再抽
 * 行动线并按其 hero 角色（heroRoleForRiver）从对应范围抽底牌，最后从剩余牌
 * 发 5 张公共牌（无重复）。价值题的行动线决定跟注范围松紧。
 * @param rng 随机源（默认 Math.random），注入以便测试可复现。
 */
export function dealRiverScenario(
  rng: () => number = Math.random,
): RiverScenario {
  const opponents = drawOpponentCount(rng);
  const t = rng();
  const type: RiverScenarioType =
    opponents === 1
      ? t < 1 / 3
        ? "value"
        : t < 2 / 3
          ? "bluffcatch"
          : "bluff"
      : t < 0.5
        ? "value"
        : "bluffcatch";
  const line = drawRiverLine(type, rng, opponents);
  const role = heroRoleForRiver(line.kind, type, opponents);
  const hero = sampleHeroCards(rng, role, {
    openPos: role === "open" ? line.pos : undefined,
  });
  const board = dealRemainingCards(rng, hero, 5) as [
    Card,
    Card,
    Card,
    Card,
    Card,
  ];
  return {
    hero,
    board,
    type,
    actionLine: line.lines,
    lineKind: line.kind,
    openPos: line.pos,
    opponents,
  };
}

/**
 * 河牌 vs 随机对手的精确胜率：公共牌已齐，枚举剩余牌的全部对手底牌组合
 * （C(45,2)=990），evaluate7 逐个比大小。返回 win/tie/lose（0-1，和为 1）。
 */
export function riverEquityExact(
  hero: [Card, Card],
  board: Card[],
): EquityResult {
  if (board.length !== 5) throw new Error("riverEquityExact 需要 5 张公共牌");
  const dead = new Set<string>([...hero, ...board]);
  if (dead.size !== 7) throw new Error("存在重复牌");
  const cards = newDeck().filter((c) => !dead.has(c));
  const heroScore = evaluate7([...hero, ...board]);
  let win = 0;
  let tie = 0;
  let lose = 0;
  for (let i = 0; i < cards.length - 1; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const s = evaluate7([cards[i], cards[j], ...board]);
      if (heroScore > s) win++;
      else if (heroScore === s) tie++;
      else lose++;
    }
  }
  const n = (cards.length * (cards.length - 1)) / 2;
  return { win: win / n, tie: tie / n, lose: lose / n };
}

/** 牌型 category 的分数权重（与 evaluator.ts 编码约定一致：score = category × 13^5 + …） */
const CATEGORY_WEIGHT = 13 ** 5;

/** 河牌圈 hero 的成牌状态（诈唬题文本校准与「成牌不判诈唬」语义校验用，A1） */
export interface RiverHandInfo {
  /** hero+board 7 张最优牌型 category（0 高牌 / 1 一对 / 2 两对 / … / 8 同花顺） */
  category: number;
  /** hero 底牌是否参与成牌：最优牌型 ≥ 一对 且 严格强于 board 单独 5 张（底牌真实改进牌面；A 高踢脚改进不算成牌） */
  made: boolean;
}

/**
 * hero 在 5 张公共牌上的成牌检测（纯函数）：
 * - category = evaluate7(hero+board) 的牌型档；
 * - made = category ≥ 一对 且 heroScore > evaluate7(board)——底牌必须真实
 *   改进牌面：board 天成顺/天花时 hero 无贡献（board plays）、A 高仅改进
 *   踢脚，都不算「成牌」，仍属纯空气。
 * 河牌 7 张牌已定、听牌全部清算，成牌检测用 evaluate7 参与性口径（不用
 * postflopQuiz 的 analyzeDraws——那是翻牌/转牌的听牌分析，河牌无听牌可言）。
 */
export function heroRiverHand(
  hero: [Card, Card],
  board: Card[],
): RiverHandInfo {
  if (board.length !== 5) throw new Error("heroRiverHand 需要 5 张公共牌");
  const heroScore = evaluate7([...hero, ...board]);
  const boardScore = evaluate7(board);
  const category = Math.floor(heroScore / CATEGORY_WEIGHT);
  return { category, made: category >= 1 && heroScore > boardScore };
}

/**
 * 诈唬题行动线末句校准（A1：「你的听牌全没中」只对真·空气使用）：
 * - 纯空气（made=false）：原样返回（drawRiverLine 写死的「听牌全没中」为真）；
 * - 成牌：末句按胜率带改为如实描述——≥45% 价值带「你击中了牌面」，
 *   否则摊牌价值带「这手牌有摊牌价值」。open / flat 两种线各自套用原句式。
 */
export function calibrateBluffActionLine(
  lines: LocalizedText[],
  lineKind: RiverLineKind,
  made: boolean,
  win: number,
): LocalizedText[] {
  if (!made) return lines;
  const head =
    lineKind === "flat"
      ? { zh: "河牌圈：轮到你行动", en: "River: action on you" }
      : { zh: "河牌圈：对手过牌，轮到你", en: "River: the big blind checks — action on you" };
  const last: LocalizedText =
    win >= RIVER_SHOWDOWN_VALUE_MAX
      ? {
          zh: `${head.zh}——你击中了牌面`,
          en: `${head.en} — you've connected with the board`,
        }
      : {
          zh: `${head.zh}——这手牌有摊牌价值`,
          en: `${head.en} — this hand has showdown value`,
        };
  return [...lines.slice(0, -1), last];
}

/**
 * 胜率 + 子题型 → 标准答案（纯函数）。
 * value/bluffcatch 请传对相应范围的胜率 rangeWin；bluff 用 vs 随机精确胜率 win。
 * opponents 驱动多人池门槛（multiway.ts；bluff 题恒为单挑，不受影响）。
 * 注：bluff 的 <25% → 诈唬分支只对纯空气成立——generateRiverQuiz 会把
 * 「成牌但 <25%」的稀有弱成牌题重发（成牌题选诈唬=错，A1）。
 */
export function judgeRiver(
  win: number,
  type: RiverScenarioType,
  rangeWin?: number,
  opponents: OpponentCount = 1,
): PostflopChoice {
  if (type === "value") {
    return (rangeWin ?? win) >= riverValueBetLine(opponents)
      ? "aggressive"
      : "passive";
  }
  if (type === "bluffcatch") {
    return (rangeWin ?? win) >= riverBluffcatchCallLine(opponents)
      ? "passive"
      : "fold";
  }
  // bluff：极化策略——纯空气诈唬、中间（有摊牌价值）过牌、强牌价值下注
  if (win < RIVER_BLUFF_MAX_EQUITY) return "aggressive";
  if (win < RIVER_SHOWDOWN_VALUE_MAX) return "passive";
  return "aggressive";
}

/**
 * 难度过滤（反脑残，纯函数）：
 * - value：对跟注范围胜率 >85%（无脑价值）或 <25%（纯空气过牌毫无决策
 *   含量；河牌已无听牌可言，hasStrongDraw 恒 false）→ 重发；
 * - bluffcatch：对极化范围胜率 <20%（纯垃圾弃牌）或 >85%（坚果级无脑跟注）→ 重发；
 * - bluff：只过滤 >85%（坚果级无脑价值下注）——**豁免 <25% 下限**（A1）：
 *   纯空气必诈恰是本题型的教学核心（judgeRiver：<25% → 诈唬），把它当
 *   脑残题过滤掉，这族题就永远不出真诈唬答案（实测 34 题 0 道真诈唬）。
 */
export function isTooObvious(
  win: number,
  type: RiverScenarioType,
  rangeWin?: number,
): boolean {
  if (type === "value") return isOffenseLikeObvious(rangeWin ?? win, false);
  if (type === "bluffcatch") return isDefenseLikeObvious(rangeWin ?? win);
  return win > OBVIOUS_NUTS_MIN;
}

/**
 * 出一道完整的河牌圈题（单挑精确枚举 + 范围蒙特卡洛；多人池全蒙特卡洛，
 * 约几十 ms，调用方负责异步化）。
 * 显而易见的情形（isTooObvious）重发，FILTER_MAX_ATTEMPTS 次上限兜底。
 * 判定胜率落在阈值 ±3pp 边界带内时用 20000 次迭代复核（borderline.ts，A3）；
 * 诈唬题额外做成牌校验：成牌弱牌（<25%）重发、行动线末句按真实牌力校准（A1）。
 */
export function generateRiverQuiz(
  rng: () => number = Math.random,
  iterations: number = QUIZ_ITERATIONS,
): RiverQuiz {
  for (let attempt = 0; ; attempt++) {
    const scenario = dealRiverScenario(rng);
    // 单挑精确枚举（确定性）；多人池组合数爆炸，改按对手数联合蒙特卡洛
    const equity =
      scenario.opponents === 1
        ? riverEquityExact(scenario.hero, scenario.board)
        : equityMulti(
            [...scenario.hero],
            [...scenario.board],
            scenario.opponents,
            iterations,
          );
    const rangeEquity =
      scenario.type === "value"
        ? // value（进攻侧）：对 opponents 名跟注者联合采样（主动进攻要赢全场）
          rejudgeIfBorderline(
            equityVsRange(
              scenario.hero,
              scenario.board,
              riverValueCallerSpecFor(scenario.lineKind),
              iterations,
              rng,
              scenario.opponents,
            ),
            [riverValueBetLine(scenario.opponents)],
            (iters) =>
              equityVsRange(
                scenario.hero,
                scenario.board,
                riverValueCallerSpecFor(scenario.lineKind),
                iters,
                rng,
                scenario.opponents,
              ),
          )
        : scenario.type === "bluffcatch"
          ? // bluffcatch（含多人池）：只评估对下注者极化范围的胜率（opponents=1）——
            // 身后尚未行动的跟注者视为死钱，死钱改善直接赔率
            rejudgeIfBorderline(
              equityVsRange(
                scenario.hero,
                scenario.board,
                RIVER_BLUFFCATCH_POLAR_SPEC,
                iterations,
                rng,
                1,
              ),
              [riverBluffcatchCallLine(scenario.opponents)],
              (iters) =>
                equityVsRange(
                  scenario.hero,
                  scenario.board,
                  RIVER_BLUFFCATCH_POLAR_SPEC,
                  iters,
                  rng,
                  1,
                ),
            )
          : null;
    // A1b 诈唬题成牌校验：「听牌全没中」的叙事只对真·空气使用
    const handInfo =
      scenario.type === "bluff"
        ? heroRiverHand(scenario.hero, scenario.board)
        : null;
    if (
      handInfo?.made &&
      equity.win < RIVER_BLUFF_MAX_EQUITY &&
      attempt + 1 < FILTER_MAX_ATTEMPTS
    ) {
      continue; // 成牌弱牌（<25%）重发——成牌题选诈唬=错，真诈唬只颁给纯空气
    }
    const answer = judgeRiver(
      equity.win,
      scenario.type,
      rangeEquity ?? undefined,
      scenario.opponents,
    );
    if (
      attempt + 1 < FILTER_MAX_ATTEMPTS &&
      isTooObvious(equity.win, scenario.type, rangeEquity ?? undefined)
    ) {
      continue; // 显而易见的题重发
    }
    const actionLine = handInfo
      ? calibrateBluffActionLine(
          scenario.actionLine,
          scenario.lineKind,
          handInfo.made,
          equity.win,
        )
      : scenario.actionLine;
    return { ...scenario, actionLine, equity, rangeEquity, answer };
  }
}

/** 判定后的一句话简评（中文库内版；页面组件走字典双语同逻辑；价值题范围宽度随行动线；多人池带底池人数提示与动态门槛） */
export function riverQuizComment(quiz: RiverQuiz): string {
  const pct = (quiz.equity.win * 100).toFixed(1);
  const rPct =
    quiz.rangeEquity !== null ? (quiz.rangeEquity * 100).toFixed(1) : null;
  const tie =
    quiz.equity.tie >= 0.005
      ? `（另平局 ${(quiz.equity.tie * 100).toFixed(1)}%）`
      : "";
  const callerPct = Math.round(
    riverValueCallerSpecFor(quiz.lineKind).topPct * 100,
  );
  const value = Math.round(riverValueBetLine(quiz.opponents) * 100);
  const catchLine = Math.round(riverBluffcatchCallLine(quiz.opponents) * 100);
  const note =
    quiz.opponents > 1
      ? `${potPlayers(quiz.opponents)} 人底池：胜率被稀释，继续需要更强牌力——`
      : "";
  const noteDefense =
    quiz.opponents > 1
      ? `${potPlayers(quiz.opponents)} 人底池：只评估对下注者的胜率，身后跟注者视为死钱改善直接赔率——`
      : "";
  switch (quiz.answer) {
    case "aggressive":
      if (quiz.type === "value") {
        return `${note}对跟注范围（前 ${callerPct}%，随行动线收窄）实算胜率 ${rPct}%${tie}，越过 ${value}% 价值线——下注拿价值：更差的牌会跟注，别浪费最后一条街`;
      }
      if (quiz.type === "bluff" && quiz.equity.win < RIVER_BLUFF_MAX_EQUITY) {
        return `精确胜率 ${pct}%${tie}，不足 25%——听牌全没中、毫无摊牌价值，过牌等于认输；唯有诈唬下注能赢这个池（河牌极化策略：强牌与纯空气下注，中间牌过牌）`;
      }
      return `${note}精确胜率 ${pct}%${tie}，超过 45%——牌力明显领先随机手，主动下注拿价值（这是价值不是诈唬）`;
    case "fold":
      return `${noteDefense}对极化范围（前 25% 强牌 + 35% 诈唬）实算胜率 ${rPct}%${tie}，不足 ${catchLine}%——满池注需 33% 胜率保本，你连对方的诈唬组合都压不过，弃牌`;
    case "passive":
      if (quiz.type === "value") {
        return (quiz.rangeEquity ?? 0) >= RIVER_THIN_VALUE_MIN
          ? `${note}对跟注范围（前 ${callerPct}%，随行动线收窄）实算胜率 ${rPct}%${tie}，在 45%-${value}% 之间——薄价值不够薄别贪：下注多半只被更强的牌跟；过牌利用摊牌价值免费比牌`
          : `${note}对跟注范围（前 ${callerPct}%，随行动线收窄）实算胜率 ${rPct}%${tie}，不足 45%——下注等于诈唬而非价值；有摊牌价值的牌过牌比牌`;
      }
      if (quiz.type === "bluffcatch") {
        return `${noteDefense}对极化范围（前 25% 强牌 + 35% 诈唬）实算胜率 ${rPct}%${tie}，越过 ${catchLine}% 满池赔率线——跟注抓诈：对方的诈唬组合足够多，满池注只需三分之一胜率`;
      }
      return `精确胜率 ${pct}%${tie}，在 25-45% 之间——弱牌有摊牌价值：过牌有机会赢下更弱的牌；诈唬只会打走更弱的、被更强的跟注，把赢面打没`;
  }
}
