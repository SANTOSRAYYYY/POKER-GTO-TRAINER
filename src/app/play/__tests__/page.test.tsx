/**
 * /play URL 参数解析测试：直接调用服务端组件 PlayPage（async 函数返回
 * React 元素，node 环境下不渲染），断言透传给 TableScreen 的 config/resume。
 *
 * 锁定语义：
 * - 锦标赛四参数（hpl / blindMode / rebuys / rebuyPeriod）合法值全部生效；
 * - 非法（非数值）回退默认、越界钳制进合法区间；
 * - blindMode=infinite 生成 40 级扩展表，其余值沿用默认 10 级表；
 * - resume 判定：裸地址/显式 resume=1 恢复存档，带开局参数开新局。
 */
import { describe, expect, it } from "vitest";
import PlayPage from "@/app/play/page";
import {
  DEFAULT_TOURNAMENT,
  INFINITE_TOTAL_LEVELS,
} from "@/lib/poker/tournament";
import type { TableConfig } from "@/lib/store/gameStore";

type SP = Record<string, string | string[] | undefined>;

async function props(sp: SP): Promise<{ config: TableConfig; resume: boolean }> {
  const el = await PlayPage({ searchParams: Promise.resolve(sp) });
  return el.props as { config: TableConfig; resume: boolean };
}

describe("/play 锦标赛参数解析", () => {
  it("合法参数全部生效：hpl / blindMode=infinite / rebuys / rebuyPeriod", async () => {
    const { config, resume } = await props({
      mode: "tournament",
      seats: "6",
      aiStyle: "tag",
      hpl: "5",
      blindMode: "infinite",
      rebuys: "7",
      rebuyPeriod: "2",
    });
    expect(resume).toBe(false);
    const tc = config.tournament!;
    expect(tc.startStack).toBe(DEFAULT_TOURNAMENT.startStack);
    expect(tc.handsPerLevel).toBe(5);
    expect(tc.rebuysAllowed).toBe(7);
    expect(tc.rebuyPeriodLevels).toBe(2);
    // 无限升盲：40 级扩展表，前 10 级与默认表一致，第 11 级起大盲翻倍
    expect(tc.levels).toHaveLength(INFINITE_TOTAL_LEVELS);
    expect(tc.levels.slice(0, 10)).toEqual(DEFAULT_TOURNAMENT.levels);
    expect(tc.levels[10]).toEqual({ smallBlind: 800, bigBlind: 1600, ante: 1600 });
    expect(tc.levels[39].bigBlind).toBe(800 * 2 ** 30);
  });

  it("不带新参数时全部回退默认：8 手/级、10 级限制表、rebuys=0、重购期 4 级", async () => {
    const { config } = await props({ mode: "tournament", seats: "9" });
    const tc = config.tournament!;
    expect(tc.handsPerLevel).toBe(8);
    expect(tc.levels).toBe(DEFAULT_TOURNAMENT.levels); // 限制级别：原表原引用
    expect(tc.rebuysAllowed).toBe(0);
    expect(tc.rebuyPeriodLevels).toBe(4);
  });

  it("非法（非数值）参数回退默认；blindMode 非 infinite 一律按限制级别", async () => {
    const { config } = await props({
      mode: "tournament",
      hpl: "abc",
      rebuys: "xyz",
      rebuyPeriod: "foo",
      blindMode: "whatever",
    });
    const tc = config.tournament!;
    expect(tc.handsPerLevel).toBe(8);
    expect(tc.rebuysAllowed).toBe(0);
    expect(tc.rebuyPeriodLevels).toBe(4);
    expect(tc.levels).toBe(DEFAULT_TOURNAMENT.levels);
  });

  it("越界数值钳制进合法区间", async () => {
    const high = await props({
      mode: "tournament",
      hpl: "100",
      rebuys: "1000",
      rebuyPeriod: "99",
    });
    expect(high.config.tournament!.handsPerLevel).toBe(50);
    expect(high.config.tournament!.rebuysAllowed).toBe(99);
    expect(high.config.tournament!.rebuyPeriodLevels).toBe(10);

    const low = await props({
      mode: "tournament",
      hpl: "0",
      rebuys: "-5",
      rebuyPeriod: "-1",
    });
    expect(low.config.tournament!.handsPerLevel).toBe(1);
    expect(low.config.tournament!.rebuysAllowed).toBe(0);
    expect(low.config.tournament!.rebuyPeriodLevels).toBe(0);
  });

  it("rebuys 任意非负整数（不再限 0-3）", async () => {
    const { config } = await props({ mode: "tournament", rebuys: "42" });
    expect(config.tournament!.rebuysAllowed).toBe(42);
  });

  it("现金局忽略锦标赛参数", async () => {
    const { config } = await props({
      mode: "cash",
      sb: "1",
      bb: "2",
      buyin: "200",
      hpl: "3",
      blindMode: "infinite",
      rebuys: "9",
      rebuyPeriod: "1",
    });
    expect(config.tournament).toBeUndefined();
    expect(config.cashBlinds).toEqual({ sb: 1, bb: 2 });
    expect(config.buyin).toBe(200);
  });
});

describe("/play resume 判定", () => {
  it("裸地址 → 恢复存档；带开局参数 → 开新局", async () => {
    expect((await props({})).resume).toBe(true);
    expect((await props({ resume: "1" })).resume).toBe(true);
    expect((await props({ mode: "cash" })).resume).toBe(false);
    // 新参数同样算作开局参数（单独出现即开新局）
    expect((await props({ hpl: "5" })).resume).toBe(false);
    expect((await props({ blindMode: "infinite" })).resume).toBe(false);
    expect((await props({ rebuyPeriod: "2" })).resume).toBe(false);
  });
});
