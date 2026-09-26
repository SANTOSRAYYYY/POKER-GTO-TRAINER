/**
 * 锦标赛（SNG）升盲调度：纯数据 + 纯函数，不依赖 GameState。
 *
 * 调局模块（store）在每手结束后使用：
 * - shouldLevelUp(handsPlayedAtLevel, handsPerLevel) 判断是否升盲；
 * - nextLevel(levelIndex) 得到新级别（到顶停住）；
 * - currentBlinds(levelIndex) 取该级别盲注/ante，作为下一手 createGame 的入参。
 */
import type { BlindLevel, TournamentConfig } from "@/lib/types";
import { DEFAULT_BLIND_LEVELS } from "@/lib/types";

/** 默认锦标赛配置：起始筹码 1500，每级 8 手，DEFAULT_BLIND_LEVELS 升盲表 */
export const DEFAULT_TOURNAMENT: TournamentConfig = {
  startStack: 1500,
  levels: DEFAULT_BLIND_LEVELS,
  handsPerLevel: 8,
};

/**
 * 取某一级别的盲注结构。levelIndex 越界时钳制到合法范围
 * （负数按 0，超过表顶按最后一级——与 nextLevel 的“到顶停住”一致）。
 */
export function currentBlinds(
  levelIndex: number,
  levels: BlindLevel[] = DEFAULT_BLIND_LEVELS,
): BlindLevel {
  if (levels.length === 0) throw new Error("levels 不能为空");
  const i = Math.max(0, Math.min(Math.floor(levelIndex), levels.length - 1));
  return levels[i];
}

/** 本级别已进行的手数达到 handsPerLevel 即应升盲 */
export function shouldLevelUp(
  handsPlayedAtLevel: number,
  handsPerLevel: number,
): boolean {
  return handsPlayedAtLevel >= handsPerLevel;
}

/**
 * 下一级别索引。已到顶（最后一级）时停住不再上升，
 * 返回的索引恒可安全传给 currentBlinds。
 */
export function nextLevel(
  levelIndex: number,
  levels: BlindLevel[] = DEFAULT_BLIND_LEVELS,
): number {
  if (levels.length === 0) throw new Error("levels 不能为空");
  return Math.min(Math.floor(levelIndex) + 1, levels.length - 1);
}
