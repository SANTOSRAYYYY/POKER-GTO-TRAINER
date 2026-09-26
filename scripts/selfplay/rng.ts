/**
 * scripts/selfplay/rng.ts — 可复现随机源
 *
 * mulberry32：32 位整数种子的快速 PRNG（与 src 测试里的实现一致）。
 * 台架的每手牌用 masterSeed * 100000 + handIndex 派生独立种子，
 * 保证单手牌可独立复现，且与之前手数消耗的随机数数量无关（配对种子前提）。
 */

/** mulberry32 PRNG：传入任意 number（内部 |0 截断为 int32），返回 [0,1) 均匀序列 */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 每手牌的派生种子（任务约定：masterSeed * 100000 + handIndex） */
export function handSeed(masterSeed: number, handIndex: number): number {
  return masterSeed * 100000 + handIndex;
}

/**
 * 决策流种子：与发牌流分离（同一 handSeed 的不同映射），
 * 使「同一手的发牌」与「同一手的决策掷签」可独立复现。
 */
export function decisionSeed(handSeedValue: number): number {
  return (handSeedValue ^ 0x9e3779b9) >>> 0;
}
