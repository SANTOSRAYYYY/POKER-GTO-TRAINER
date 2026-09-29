/**
 * achievements.ts（金手链成就系统）测试
 *
 * - 8 个成就各自的判定口径（含边界与反例）
 * - 场次切分（30 分钟间隔）与现金局连赢（锦标赛手不断连）
 * - 复仇：必须先输后赢同一风格
 * - checkAchievements 聚合输出与 localStorage 读取的防御性
 */
import { describe, expect, it } from "vitest";
import type { ConcreteAIStyle, HandRecord, HandPlayerRecord } from "@/lib/types";
import { DICT } from "@/lib/i18n/dict";
import {
  ACHIEVEMENTS,
  checkAchievements,
  hasRevenge,
  loadUnlocked,
  maxCashWinStreak,
  SESSION_GAP_MS,
  sessionProfitsBb,
} from "../achievements";

let seq = 0;

interface MkOptions {
  timestamp?: number;
  result?: "win" | "lose" | "tie";
  profit?: number;
  bigBlind?: number;
  /** 对手风格（默认 1 名 tag 对手；null = 无风格信息） */
  opponents?: (ConcreteAIStyle | null)[];
  /** hero 锦标赛名次；设置后该手即锦标赛手 */
  heroFinishPlace?: number;
  /** 对局模式（新记录归档时写入；缺省 = 旧记录，回退启发式） */
  mode?: "cash" | "tournament";
  /** 锦标赛开赛总人数（仅锦标赛记录） */
  tournamentSeats?: number;
}

/** 构造最小合法 HandRecord */
function mkHand(o: MkOptions = {}): HandRecord {
  seq += 1;
  const opponents = o.opponents === undefined ? ["tag" as const] : o.opponents;
  const players: HandPlayerRecord[] = [
    {
      seat: 0,
      isHero: true,
      aiStyle: null,
      cards: ["As", "Kh"],
      profit: o.profit ?? 0,
      ...(o.heroFinishPlace !== undefined
        ? { finishPlace: o.heroFinishPlace }
        : {}),
    },
    ...opponents.map(
      (style, i): HandPlayerRecord => ({
        seat: i + 1,
        isHero: false,
        aiStyle: style,
        cards: null,
        profit: -(o.profit ?? 0),
      }),
    ),
  ];
  return {
    id: `h${seq}`,
    timestamp: o.timestamp ?? seq * 60_000,
    ...(o.mode !== undefined ? { mode: o.mode } : {}),
    ...(o.tournamentSeats !== undefined
      ? { tournamentSeats: o.tournamentSeats }
      : {}),
    players,
    heroSeat: 0,
    buttonSeat: 0,
    smallBlind: (o.bigBlind ?? 100) / 2,
    bigBlind: o.bigBlind ?? 100,
    ante: 0,
    streets: [],
    finalBoard: [],
    result: o.result ?? "win",
    profit: o.profit ?? 0,
    showdown: true,
  };
}

const ids = (hands: HandRecord[]) => checkAchievements(hands).map((a) => a.id);

describe("checkAchievements 单项判定", () => {
  it("空历史不解锁任何成就", () => {
    expect(checkAchievements([])).toEqual([]);
  });

  it("首胜：任意一手 result=win 即解锁", () => {
    expect(ids([mkHand({ result: "lose", profit: -100 })])).not.toContain("first_win");
    expect(ids([mkHand({ result: "win", profit: 100 })])).toContain("first_win");
  });

  it("锦标赛首次夺冠：hero finishPlace=1 的锦标赛手才解锁", () => {
    expect(ids([mkHand({ heroFinishPlace: 2 })])).not.toContain("first_title");
    expect(ids([mkHand({ heroFinishPlace: 1 })])).toContain("first_title");
  });

  it("9 人桌夺冠：新记录按开赛人数 tournamentSeats 判定（夺冠手恒为单挑）", () => {
    // 真实归档形态：9-max SNG 的夺冠手只剩单挑（players.length=2），
    // 但 mode='tournament' + tournamentSeats=9 可正确解锁
    const nineMaxFinal = mkHand({
      mode: "tournament",
      tournamentSeats: 9,
      heroFinishPlace: 1,
    });
    expect(nineMaxFinal.players).toHaveLength(2); // 单挑夺冠手
    expect(ids([nineMaxFinal])).toContain("first_title");
    expect(ids([nineMaxFinal])).toContain("nine_max_title");

    // 6-max 夺冠（新记录）：first_title 有，nine_max_title 没有
    const sixMaxFinal = mkHand({
      mode: "tournament",
      tournamentSeats: 6,
      heroFinishPlace: 1,
    });
    expect(ids([sixMaxFinal])).toContain("first_title");
    expect(ids([sixMaxFinal])).not.toContain("nine_max_title");

    // 锦标赛亚军不解锁
    expect(
      ids([mkHand({ mode: "tournament", tournamentSeats: 9, heroFinishPlace: 2 })]),
    ).not.toContain("nine_max_title");
  });

  it("9 人桌夺冠：缺 mode 的旧记录回退为「夺冠即算」（不更严于旧口径）", () => {
    // 旧启发式要求 players.length===9 才可解锁（真实夺冠手永远达不到）；
    // 回退口径放宽：旧记录无法区分 9-max 决赛手与 6-max 夺冠，finishPlace=1 即解锁
    const legacyNineMax = mkHand({
      heroFinishPlace: 1,
      opponents: ["tag", "lag", "nit", "gto", "maniac", "calling_station", "tag", "lag"],
    });
    expect(legacyNineMax.players).toHaveLength(9);
    expect(ids([legacyNineMax])).toContain("nine_max_title");

    const legacySixMax = mkHand({
      heroFinishPlace: 1,
      opponents: ["tag", "lag", "nit", "gto", "maniac"],
    });
    expect(ids([legacySixMax])).toContain("first_title");
    expect(ids([legacySixMax])).toContain("nine_max_title");
  });

  it("累计 1000 手：999 不解锁，1000 解锁", () => {
    const many = (n: number) => Array.from({ length: n }, () => mkHand());
    expect(ids(many(999))).not.toContain("hands_1000");
    expect(ids(many(1000))).toContain("hands_1000");
  });

  it("累计盈利 10000bb：按各手大盲归一化", () => {
    // bb=100，单手盈利 999900 = 9999bb → 不解锁；再加一手凑满 10000bb
    const h1 = mkHand({ profit: 999_900, bigBlind: 100 });
    expect(ids([h1])).not.toContain("profit_10000bb");
    const h2 = mkHand({ profit: 100, bigBlind: 100 });
    expect(ids([h1, h2])).toContain("profit_10000bb");
  });
});

describe("sessionProfitsBb 场次切分（30 分钟间隔）", () => {
  it("相邻间隔 > 30 分钟切成两场", () => {
    const hands = [
      mkHand({ timestamp: 0, profit: 200, bigBlind: 100 }), // 2bb
      mkHand({ timestamp: 10 * 60_000, profit: 300, bigBlind: 100 }), // 3bb，同场
      mkHand({ timestamp: 10 * 60_000 + SESSION_GAP_MS + 1, profit: 1000, bigBlind: 100 }), // 新场
    ];
    expect(sessionProfitsBb(hands)).toEqual([5, 10]);
  });

  it("输入顺序不限（内部按时间重排）", () => {
    const hands = [
      mkHand({ timestamp: 20 * 60_000, profit: 100, bigBlind: 100 }),
      mkHand({ timestamp: 0, profit: 200, bigBlind: 100 }),
    ];
    expect(sessionProfitsBb(hands)).toEqual([3]);
  });

  it("单场盈利 500bb：同场累计达标才解锁，跨场不累计", () => {
    const h1 = mkHand({ timestamp: 0, profit: 30_000, bigBlind: 100 }); // 300bb
    const h2 = mkHand({ timestamp: 5 * 60_000, profit: 20_000, bigBlind: 100 }); // 同场 +200bb
    expect(ids([h1, h2])).toContain("session_500bb");

    const g1 = mkHand({ timestamp: 0, profit: 30_000, bigBlind: 100 });
    const g2 = mkHand({ timestamp: SESSION_GAP_MS + 1, profit: 20_000, bigBlind: 100 });
    expect(ids([g1, g2])).not.toContain("session_500bb");
  });
});

describe("maxCashWinStreak 现金局连赢", () => {
  it("5 连盈解锁，平局（profit=0）断连", () => {
    const win = () => mkHand({ result: "win", profit: 50 });
    const tie = () => mkHand({ result: "tie", profit: 0 });
    expect(maxCashWinStreak([win(), win(), win(), win(), win()])).toBe(5);
    expect(ids([win(), win(), win(), win(), win()])).toContain("cash_streak_5");
    const broken = [win(), win(), tie(), win(), win(), win(), win()];
    expect(maxCashWinStreak(broken)).toBe(4);
    expect(ids(broken)).not.toContain("cash_streak_5");
  });

  it("锦标赛手穿插不断连也不计入", () => {
    const win = () => mkHand({ result: "win", profit: 50 });
    const tourney = mkHand({ heroFinishPlace: 3, result: "lose", profit: -500 });
    const hands = [win(), win(), tourney, win(), win(), win()];
    expect(maxCashWinStreak(hands)).toBe(5);
    expect(ids(hands)).toContain("cash_streak_5");
  });

  it("mode='tournament' 的前期手（无 finishPlace）明确排除，不再误判为现金局", () => {
    // 审计 A1：修复前 5 手 9-max 锦标赛前期手连盈会解锁 cash_streak_5
    const earlyTourneyWin = () =>
      mkHand({ mode: "tournament", tournamentSeats: 9, result: "win", profit: 50 });
    const hands = [
      earlyTourneyWin(),
      earlyTourneyWin(),
      earlyTourneyWin(),
      earlyTourneyWin(),
      earlyTourneyWin(),
    ];
    expect(maxCashWinStreak(hands)).toBe(0);
    expect(ids(hands)).not.toContain("cash_streak_5");
  });

  it("混合模式数据集：锦标赛手（mode 判定）不计入也不断连", () => {
    const cashWin = () => mkHand({ mode: "cash", result: "win", profit: 50 });
    const tourneyWin = () =>
      mkHand({ mode: "tournament", tournamentSeats: 9, result: "win", profit: 50 });
    // 现金 2 连 → 锦标赛 3 连（跳过）→ 现金 3 连 = 现金口径 5 连
    const hands = [
      cashWin(),
      cashWin(),
      tourneyWin(),
      tourneyWin(),
      tourneyWin(),
      cashWin(),
      cashWin(),
      cashWin(),
    ];
    expect(maxCashWinStreak(hands)).toBe(5);
    expect(ids(hands)).toContain("cash_streak_5");
  });
});

describe("revenge 复仇", () => {
  it("输给某风格后再赢回同一风格才解锁", () => {
    const hands = [
      mkHand({ timestamp: 0, result: "lose", profit: -100, opponents: ["lag"] }),
      mkHand({ timestamp: 1, result: "win", profit: 100, opponents: ["lag"] }),
    ];
    expect(hasRevenge(hands)).toBe(true);
    expect(ids(hands)).toContain("revenge");
  });

  it("先赢后输不算；输给 lag 赢 nit 也不算", () => {
    expect(
      hasRevenge([
        mkHand({ timestamp: 0, result: "win", profit: 100, opponents: ["lag"] }),
        mkHand({ timestamp: 1, result: "lose", profit: -100, opponents: ["lag"] }),
      ]),
    ).toBe(false);
    expect(
      hasRevenge([
        mkHand({ timestamp: 0, result: "lose", profit: -100, opponents: ["lag"] }),
        mkHand({ timestamp: 1, result: "win", profit: 100, opponents: ["nit"] }),
      ]),
    ).toBe(false);
  });
});

describe("checkAchievements 聚合", () => {
  it("返回 Achievement 定义对象（含名称/描述字典键），顺序与 ACHIEVEMENTS 一致", () => {
    const unlocked = checkAchievements([mkHand({ result: "win", profit: 100 })]);
    expect(unlocked.length).toBeGreaterThan(0);
    for (const a of unlocked) {
      expect(a.nameKey.startsWith("achieve.")).toBe(true);
      expect(a.descKey.startsWith("achieve.")).toBe(true);
    }
    const defOrder = ACHIEVEMENTS.map((a) => a.id);
    const idx = unlocked.map((a) => defOrder.indexOf(a.id));
    expect([...idx].sort((x, y) => x - y)).toEqual(idx);
  });
});

describe("成就双语登记齐全性（dict-pages.ts achieve.* 前缀）", () => {
  it("8 项成就的名称与描述在字典中双语非空，且 zh 与原硬编码逐字一致", () => {
    expect(ACHIEVEMENTS).toHaveLength(8);
    const ZH: Record<string, { name: string; desc: string }> = {
      first_win: { name: "首胜", desc: "赢下你的第一手牌" },
      first_title: { name: "初次夺冠", desc: "赢得任意一场锦标赛（SNG）冠军" },
      nine_max_title: { name: "九人桌之王", desc: "在 9 人桌锦标赛中夺冠" },
      session_500bb: { name: "单场暴击", desc: "单场（30 分钟间隔界定）累计盈利达到 500bb" },
      hands_1000: { name: "千手磨砺", desc: "累计打满 1000 手牌" },
      profit_10000bb: { name: "万 bb 俱乐部", desc: "累计盈利达到 10000bb（按各手大盲归一化）" },
      cash_streak_5: { name: "现金局五连盈", desc: "现金局连续 5 手盈利（平局不计入）" },
      revenge: { name: "复仇", desc: "输给某种风格的对手后，下次遇到该风格时赢回来" },
    };
    for (const a of ACHIEVEMENTS) {
      const name = DICT[a.nameKey];
      const desc = DICT[a.descKey];
      expect(name, a.nameKey).toBeDefined();
      expect(desc, a.descKey).toBeDefined();
      // 双语非空
      expect(name.zh.length, `${a.nameKey}.zh`).toBeGreaterThan(0);
      expect(name.en.length, `${a.nameKey}.en`).toBeGreaterThan(0);
      expect(desc.zh.length, `${a.descKey}.zh`).toBeGreaterThan(0);
      expect(desc.en.length, `${a.descKey}.en`).toBeGreaterThan(0);
      // zh 回归锁定（与原硬编码一致，ZH 模式零变化）
      expect(name.zh).toBe(ZH[a.id].name);
      expect(desc.zh).toBe(ZH[a.id].desc);
    }
  });
});

describe("loadUnlocked 持久化读取", () => {
  it("node 环境（无 window）返回空集合", () => {
    expect(loadUnlocked()).toEqual({});
  });
});
