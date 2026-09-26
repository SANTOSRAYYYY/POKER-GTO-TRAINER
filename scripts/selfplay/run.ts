/**
 * scripts/selfplay/run.ts — self-play 台架 CLI
 *
 * 用法：
 *   npx tsx scripts/selfplay/run.ts --config <json> --out <结果json>
 * 或（无 tsx 时，走 esbuild 打包）：
 *   bash scripts/selfplay/build-and-run.sh --config <json> --out <结果json>
 *
 * 配置 JSON 即 MatchConfig；若含 seat0Alt 字段则自动进入配对模式
 * （runPaired：同一 masterSeed 两遍，发牌逐手一致，第二遍座位 0 换对照组）。
 *
 * stdout 打印摘要表；完整 MatchResult/PairedMatchResult 写入 --out。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  runMatch,
  runPaired,
  type MatchResult,
  type PairedMatchConfig,
  type PairedMatchResult,
} from "./match";

function parseArgs(argv: string[]): { config: string; out: string } {
  let config = "";
  let out = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") config = argv[++i] ?? "";
    else if (argv[i] === "--out") out = argv[++i] ?? "";
  }
  if (!config || !out) {
    console.error("用法: run.ts --config <json文件> --out <结果json文件>");
    process.exit(1);
  }
  return { config, out };
}

function fmt(x: number, digits = 1): string {
  return x.toFixed(digits);
}

function signed(x: number, digits = 1): string {
  return (x >= 0 ? "+" : "") + x.toFixed(digits);
}

function tuningBrief(t: Record<string, number | boolean> | null): string {
  if (!t) return "-";
  const keys = Object.keys(t);
  if (keys.length === 0) return "{}";
  return keys.map((k) => `${k}=${t[k]}`).join(",");
}

function printMatchTable(title: string, r: MatchResult): void {
  console.log(`\n== ${title} ==`);
  console.log(
    `mode=${r.mode} hands=${r.meta.hands}${r.tournament ? `（实际 ${r.tournament.handsPlayed}，${r.tournament.endedBy === "champion" ? "已出冠军" : "打满上限"}）` : ""} ` +
      `seats=${r.meta.seats} blinds=${r.meta.smallBlind}/${r.meta.bigBlind} ` +
      `stack=${r.meta.startStack} seed=${r.meta.masterSeed} conc=${r.meta.handConcurrency} ` +
      `耗时 ${(r.meta.durationMs / 1000).toFixed(1)}s（${fmt(r.meta.handsPerSec)} hands/s）`,
  );
  if (r.seatShuffle) {
    console.log(
      `座位映射（物理座位 → 配置下标）：${r.seatShuffle.map((c, i) => `${i}→#${c}`).join("  ")}`,
    );
  }
  const header = [
    "seat".padEnd(4),
    "style".padEnd(15),
    "profit".padStart(8),
    "bb/100".padStart(8),
    "95% CI".padStart(20),
    "VPIP".padStart(6),
    "PFR".padStart(6),
    "rebuy".padStart(5),
    "tuning",
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length + 20));
  for (const s of r.seats) {
    console.log(
      [
        String(s.seat).padEnd(4),
        s.style.padEnd(15),
        String(s.totalProfit).padStart(8),
        signed(s.bb100).padStart(8),
        `[${signed(s.ci95BB100[0])}, ${signed(s.ci95BB100[1])}]`.padStart(20),
        (s.vpip * 100).toFixed(1).padStart(5) + "%",
        (s.pfr * 100).toFixed(1).padStart(5) + "%",
        String(s.rebuys).padStart(5),
        tuningBrief(s.tuning),
      ].join("  "),
    );
  }
  // 锦标赛：名次表（名次升序），含冠军标注
  if (r.tournament) {
    const t = r.tournament;
    console.log(
      `锦标赛：hands=${t.handsPlayed} finalLevel=${t.finalLevel} ` +
        `冠军=${t.championSeat !== null ? `座位 ${t.championSeat}` : "无"}`,
    );
    const ranked = r.seats
      .map((s) => ({ seat: s.seat, place: t.finishPlaces[s.seat], rebuys: t.rebuysUsed[s.seat], stack: s.finalStack }))
      .sort((a, b) => (a.place ?? 99) - (b.place ?? 99));
    for (const row of ranked) {
      const brain = r.seatBrains[row.seat];
      const llmTag = brain.llm
        ? ` ${brain.llm.provider}:${brain.llm.model}/${brain.llm.promptMode ?? (brain.llm.agent ? "full" : "raw")}`
        : "";
      console.log(
        `  #${row.place ?? "?"} 座位${row.seat}${row.seat === t.championSeat ? " 🏆" : ""} ` +
          `rebuy=${row.rebuys} 终局筹码=${row.stack}（${brain.style}${llmTag}）`,
      );
    }
  }
  // LLM 座位记账：token / fallback / 延迟（纯启发式 match 不打印该段）
  if (r.seats.some((s) => s.llm)) {
    console.log("LLM 座位：");
    for (const s of r.seats) {
      if (!s.llm) continue;
      const fbRate = s.llm.calls > 0 ? (s.llm.fallbacks / s.llm.calls) * 100 : 0;
      console.log(
        `  seat ${s.seat} ${s.llm.model} ${s.llm.promptMode}: ` +
          `calls=${s.llm.calls} tokens=${s.llm.tokensIn}→${s.llm.tokensOut} ` +
          `fallback=${s.llm.fallbacks}(${fbRate.toFixed(1)}%) avg=${s.llm.avgDecisionMs.toFixed(0)}ms`,
      );
    }
  }
}

function printPaired(r: PairedMatchResult): void {
  printMatchTable("配对 A（座位 0 = 基准）", r.a);
  printMatchTable("配对 B（座位 0 = 对照）", r.b);
  console.log("\n== 配对差值（B - A，发牌逐手一致） ==");
  for (const d of r.delta) {
    const mark = d.seat === 0 ? " ← 唯一变量" : "";
    console.log(
      `seat ${d.seat}: ${signed(d.bb100A)} → ${signed(d.bb100B)} bb/100，` +
        `diff ${signed(d.diffBB100)} bb/100，95% CI [${signed(d.ci95DiffBB100[0])}, ${signed(d.ci95DiffBB100[1])}]${mark}`,
    );
  }
}

async function main(): Promise<void> {
  const { config, out } = parseArgs(process.argv.slice(2));
  const cfg = JSON.parse(readFileSync(resolve(config), "utf8")) as PairedMatchConfig;
  const paired = cfg.seat0Alt !== undefined;
  const outPath = resolve(out);
  // 决策日志：`<out>.decisions.jsonl`，整场开始前截断（配对两臂共享同一文件追加）
  if (cfg.logDecisions) {
    cfg.decisionsLogPath = `${outPath}.decisions.jsonl`;
    writeFileSync(cfg.decisionsLogPath, "");
  }
  const result = paired ? await runPaired(cfg) : await runMatch(cfg);

  if (result.kind === "paired") printPaired(result);
  else printMatchTable("Match", result);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\n结果已写入 ${outPath}`);
  if (cfg.logDecisions) console.log(`决策日志已写入 ${cfg.decisionsLogPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
