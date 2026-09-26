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

  it("9 人桌夺冠：需要 9 名玩家 + 夺冠；6 人桌夺冠只算 first_title", () => {
    const sixMax = mkHand({
      heroFinishPlace: 1,
      opponents: ["tag", "lag", "nit", "gto", "maniac"],
    });
    expect(ids([sixMax])).toContain("first_title");
    expect(ids([sixMax])).not.toContain("nine_max_title");

    const nineMax = mkHand({
      heroFinishPlace: 1,
      opponents: ["tag", "lag", "nit", "gto", "maniac", "calling_station", "tag", "lag"],
    });
    expect(nineMax.players).toHaveLength(9);
    expect(ids([nineMax])).toContain("nine_max_title");
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
  it("返回 Achievement 定义对象（含名称与描述），顺序与 ACHIEVEMENTS 一致", () => {
    const unlocked = checkAchievements([mkHand({ result: "win", profit: 100 })]);
    expect(unlocked.length).toBeGreaterThan(0);
    for (const a of unlocked) {
      expect(a.name.length).toBeGreaterThan(0);
      expect(a.description.length).toBeGreaterThan(0);
    }
    const defOrder = ACHIEVEMENTS.map((a) => a.id);
    const idx = unlocked.map((a) => defOrder.indexOf(a.id));
    expect([...idx].sort((x, y) => x - y)).toEqual(idx);
  });
});

describe("loadUnlocked 持久化读取", () => {
  it("node 环境（无 window）返回空集合", () => {
    expect(loadUnlocked()).toEqual({});
  });
});
