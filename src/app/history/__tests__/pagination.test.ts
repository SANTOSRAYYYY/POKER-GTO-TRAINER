/**
 * pagination.ts（/history 列表分页）测试
 *
 * 锁定口径：首页 HISTORY_PAGE_SIZE(50) 条；「加载更多」按页追加；
 * hasMore 在显示条数达到总量时变 false（按钮消失）。
 */
import { describe, expect, it } from "vitest";
import {
  HISTORY_PAGE_SIZE,
  nextVisibleCount,
  paginateHands,
} from "../pagination";

/** 造 n 条占位记录（分页只看数量与顺序） */
const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `h${i}` }));

describe("paginateHands", () => {
  it("120 条：首页 50 条且 hasMore；加载更多后 100 条；再追加到 150 全部显示", () => {
    const hands = many(120);

    const first = paginateHands(hands, HISTORY_PAGE_SIZE);
    expect(first.visible).toHaveLength(50);
    expect(first.shown).toBe(50);
    expect(first.total).toBe(120);
    expect(first.hasMore).toBe(true);

    const second = paginateHands(hands, nextVisibleCount(HISTORY_PAGE_SIZE));
    expect(second.visible).toHaveLength(100);
    expect(second.shown).toBe(100);
    expect(second.hasMore).toBe(true);

    const third = paginateHands(hands, nextVisibleCount(nextVisibleCount(HISTORY_PAGE_SIZE)));
    expect(third.visible).toHaveLength(120);
    expect(third.shown).toBe(120);
    expect(third.hasMore).toBe(false);
  });

  it("顺序保持输入顺序（时间倒序由 store 保证，分页不重排）", () => {
    const hands = many(60);
    const page = paginateHands(hands, 50);
    expect(page.visible[0].id).toBe("h0");
    expect(page.visible[49].id).toBe("h49");
  });

  it("边界：空列表、不足一页、恰好一页", () => {
    expect(paginateHands([], 50)).toMatchObject({
      visible: [],
      shown: 0,
      total: 0,
      hasMore: false,
    });
    const few = many(30);
    expect(paginateHands(few, 50).hasMore).toBe(false);
    expect(paginateHands(few, 50).visible).toHaveLength(30);
    const exact = many(50);
    expect(paginateHands(exact, 50).hasMore).toBe(false);
    expect(paginateHands(exact, 51).hasMore).toBe(false);
  });
});

describe("nextVisibleCount", () => {
  it("每次追加一页", () => {
    expect(nextVisibleCount(50)).toBe(100);
    expect(nextVisibleCount(100)).toBe(150);
  });
});
