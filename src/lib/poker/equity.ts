/**
 * 胜率（equity）计算模块
 *
 * 实现方式：蒙特卡洛模拟 —— 随机补齐公共牌（board 不足 5 张时）与对手底牌
 * （villainCards 为 null 时），用 evaluator.compareHands 统计胜负。
 * equityMulti 泛化到多人底池：随机抽 N 个对手的底牌，hero 必须压过
 * 所有对手才算 win，与最强对手并列算 tie。
 */
import type { Card } from "@/lib/types";
import { newDeck } from "@/lib/poker/cards";
import { compareHands, evaluate7 } from "@/lib/poker/evaluator";

/** equity 结果：三个概率，0-1 区间，win + tie + lose ≈ 1（浮点误差允许） */
export interface EquityResult {
  win: number;
  tie: number;
  lose: number;
}

/**
 * 计算 hero 的胜率。
 * @param heroCards hero 底牌（2 张）
 * @param villainCards 对手底牌（已知时精确模拟；null 表示未知，随机抽对手底牌）
 * @param board 当前公共牌（0-5 张；不足 5 张随机补齐）
 * @param iterations 蒙特卡洛迭代次数，默认 10000；牌面确定度高的场景实现方可提前精确穷举
 */
export function equity(
  heroCards: Card[],
  villainCards: Card[] | null,
  board: Card[],
  iterations: number = 10000,
): EquityResult {
  if (heroCards.length !== 2) throw new Error("heroCards 必须为 2 张");
  if (villainCards !== null && villainCards.length !== 2) {
    throw new Error("villainCards 必须为 2 张或 null");
  }
  if (board.length > 5) throw new Error("board 最多 5 张");
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error("iterations 必须为正整数");
  }

  const dead = new Set<string>([...heroCards, ...board]);
  if (villainCards) for (const c of villainCards) dead.add(c);
  if (dead.size !== heroCards.length + board.length + (villainCards?.length ?? 0)) {
    throw new Error("存在重复牌");
  }

  const remaining = newDeck().filter((c) => !dead.has(c));
  const boardNeed = 5 - board.length;
  const villainNeed = villainCards === null ? 2 : 0;
  const drawCount = boardNeed + villainNeed;

  let win = 0;
  let tie = 0;
  let lose = 0;

  for (let i = 0; i < iterations; i++) {
    // 从剩余牌中无放回抽 drawCount 张：部分 Fisher-Yates
    const pool = remaining.slice();
    for (let k = 0; k < drawCount; k++) {
      const j = k + Math.floor(Math.random() * (pool.length - k));
      const tmp = pool[k];
      pool[k] = pool[j];
      pool[j] = tmp;
    }
    const drawn = pool.slice(0, drawCount);
    const villain: Card[] = villainCards
      ? [...villainCards]
      : [drawn[0], drawn[1]];
    const fullBoard = [...board, ...drawn.slice(villainNeed)];

    const cmp = compareHands(heroCards, villain, fullBoard);
    if (cmp > 0) win++;
    else if (cmp < 0) lose++;
    else tie++;
  }

  return {
    win: win / iterations,
    tie: tie / iterations,
    lose: lose / iterations,
  };
}

/**
 * 多人底池胜率：hero 对抗 opponents 个未知底牌的对手（随机抽牌）。
 * hero 严格强于所有对手计 win；与最强对手并列第一计 tie；其余计 lose。
 * @param heroCards hero 底牌（2 张）
 * @param board 当前公共牌（0-5 张；不足 5 张随机补齐）
 * @param opponents 对手数（≥1；剩余牌须够发 2*opponents 张底牌 + 补齐公共牌）
 * @param iterations 蒙特卡洛迭代次数，默认 10000
 */
export function equityMulti(
  heroCards: Card[],
  board: Card[],
  opponents: number,
  iterations: number = 10000,
): EquityResult {
  if (heroCards.length !== 2) throw new Error("heroCards 必须为 2 张");
  if (board.length > 5) throw new Error("board 最多 5 张");
  if (!Number.isInteger(opponents) || opponents < 1) {
    throw new Error("opponents 必须为不小于 1 的整数");
  }
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error("iterations 必须为正整数");
  }

  const dead = new Set<string>([...heroCards, ...board]);
  if (dead.size !== heroCards.length + board.length) {
    throw new Error("存在重复牌");
  }

  const remaining = newDeck().filter((c) => !dead.has(c));
  const villainNeed = 2 * opponents;
  const boardNeed = 5 - board.length;
  const drawCount = villainNeed + boardNeed;
  if (drawCount > remaining.length) {
    throw new Error("剩余牌不足以模拟该对手数");
  }

  let win = 0;
  let tie = 0;
  let lose = 0;

  for (let i = 0; i < iterations; i++) {
    // 从剩余牌中无放回抽 drawCount 张：部分 Fisher-Yates
    const pool = remaining.slice();
    for (let k = 0; k < drawCount; k++) {
      const j = k + Math.floor(Math.random() * (pool.length - k));
      const tmp = pool[k];
      pool[k] = pool[j];
      pool[j] = tmp;
    }
    const fullBoard = [...board, ...pool.slice(villainNeed, drawCount)];
    const heroScore = evaluate7([...heroCards, ...fullBoard]);

    let bestVillain = -1;
    for (let v = 0; v < opponents; v++) {
      const score = evaluate7([pool[2 * v], pool[2 * v + 1], ...fullBoard]);
      if (score > bestVillain) bestVillain = score;
    }

    if (heroScore > bestVillain) win++;
    else if (heroScore === bestVillain) tie++;
    else lose++;
  }

  return {
    win: win / iterations,
    tie: tie / iterations,
    lose: lose / iterations,
  };
}
