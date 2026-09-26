/**
 * scripts/selfplay/verify-paired.ts — 配对种子（paired deals）正确性校验
 *
 * 跑一个小型 paired match（座位 0：gto ↔ maniac，打法差异最大化），
 * 然后利用漏勺报告里记录的 holeCards/board，校验两遍中同一 handIndex
 * 同一座位拿到的底牌与公共牌完全一致（即发牌只由 masterSeed+handIndex 决定，
 * 不受座位 0 配置变化影响）。同时校验两遍都满足每手零和。
 *
 * 执行：bash scripts/selfplay/build-and-run.sh-verify-paired
 * （或 esbuild 打包后 node 执行，见 build-and-run.sh）
 */
import { runPaired, type MatchResult, type PairedMatchConfig } from "./match";

function checkZeroSum(r: MatchResult, label: string): void {
  const { hands, seats } = r.meta;
  for (let h = 0; h < hands; h++) {
    let sum = 0;
    for (let s = 0; s < seats; s++) sum += r.seats[s].profitSeries[h];
    if (sum !== 0) throw new Error(`${label} 第 ${h} 手非零和：${sum}`);
  }
}

async function main(): Promise<void> {
  const config: PairedMatchConfig = {
    seats: 6,
    hands: 200,
    smallBlind: 5,
    bigBlind: 10,
    startStack: 1000,
    masterSeed: 20260923,
    seatBrains: [
      { style: "gto" },
      { style: "gto" },
      { style: "gto" },
      { style: "gto" },
      { style: "gto" },
      { style: "gto" },
    ],
    // 与基准差异尽量大，最大化「决策不同 → 行动序列不同」的覆盖
    seat0Alt: { style: "maniac", tuning: { bluffFreqMult: 2 } },
  };

  const r = await runPaired(config);
  checkZeroSum(r.a, "run A");
  checkZeroSum(r.b, "run B");

  // 对每个座位，取两遍漏勺报告的 handIndex 交集，比对底牌与公共牌
  let compared = 0;
  for (let s = 0; s < config.seats; s++) {
    const mapA = new Map(r.a.seats[s].topHands.map((t) => [t.handIndex, t]));
    const mapB = new Map(r.b.seats[s].topHands.map((t) => [t.handIndex, t]));
    for (const [h, ta] of mapA) {
      const tb = mapB.get(h);
      if (!tb) continue;
      if (JSON.stringify(ta.holeCards) !== JSON.stringify(tb.holeCards)) {
        throw new Error(`座位 ${s} 第 ${h} 手底牌不一致：${ta.holeCards} vs ${tb.holeCards}`);
      }
      // 公共牌只比前缀：发牌序列由种子决定，但两臂行动不同会打到不同街道
      // （翻前结束=0 张 vs 摊牌=5 张），较长者必须以较短者为前缀
      const [shorter, longer] =
        ta.board.length <= tb.board.length ? [ta.board, tb.board] : [tb.board, ta.board];
      if (JSON.stringify(longer.slice(0, shorter.length)) !== JSON.stringify(shorter)) {
        throw new Error(`座位 ${s} 第 ${h} 手公共牌前缀不一致`);
      }
      compared++;
    }
  }
  if (compared < 10) {
    throw new Error(`重叠样本不足（${compared} 手），无法充分验证配对发牌`);
  }

  const d0 = r.delta[0];
  console.log(`配对发牌校验通过：${compared} 个重叠手牌底牌/公共牌逐比特一致`);
  console.log(`零和校验通过：A/B 各 ${config.hands} 手`);
  console.log(
    `座位 0（gto → maniac×2诈唬）配对差值：${d0.diffBB100.toFixed(1)} bb/100，` +
      `95% CI [${d0.ci95DiffBB100[0].toFixed(1)}, ${d0.ci95DiffBB100[1].toFixed(1)}]`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
