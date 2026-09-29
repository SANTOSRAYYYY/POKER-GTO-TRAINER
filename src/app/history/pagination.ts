/**
 * src/app/history/pagination.ts — /history 列表分页（纯函数）
 *
 * 背景：1000 手一次渲染 ~13k DOM 节点（桌面生产 ~0.7s），数据量继续增长
 * 会线性恶化。分页策略：首页 PAGE_SIZE 条 + 「加载更多」按页追加；
 * 只影响列表渲染，统计口径（computeStats 等）始终基于全量 hands。
 */

/** 每页条数（首页与每次「加载更多」的追加量） */
export const HISTORY_PAGE_SIZE = 50;

export interface HandPage<T> {
  /** 当前应渲染的记录（前 count 条） */
  visible: T[];
  /** 已显示条数（= visible.length） */
  shown: number;
  /** 总条数 */
  total: number;
  /** 是否还有未显示的记录 */
  hasMore: boolean;
}

/** 按显示条数切片；count 超过总量时全部显示（hasMore=false） */
export function paginateHands<T>(hands: readonly T[], count: number): HandPage<T> {
  const total = hands.length;
  const visible = hands.slice(0, Math.max(0, count));
  return { visible, shown: visible.length, total, hasMore: visible.length < total };
}

/** 「加载更多」后的显示条数 */
export function nextVisibleCount(current: number): number {
  return current + HISTORY_PAGE_SIZE;
}
