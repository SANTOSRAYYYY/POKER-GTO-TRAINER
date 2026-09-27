/**
 * AI 对手决策模块
 *
 * 决策链路：config 含 apiKey 时优先走 LLM（llm/client.chatCompletion，
 * 超时窗口由 llmTimeoutFor 按思考程度给定为 8s/15s/25s），
 * LLM 调用失败、超时、输出无法解析或 config 为空时，一律兜底 heuristicDecide。
 * 返回值的 source 字段如实标记 'llm' | 'heuristic'。
 *
 * 大底池 self-consistency 投票（config.selfVote，undefined = 开）：
 * 底池 ≥ VOTE_POT_BB（默认 25bb）或处于河牌街时，并行采样 3 次
 * （Promise.all，各自 8/15/25s 超时窗口），对解析出的动作做多数投票
 * （action.type 归票；平票按 fold<check<call<bet<raise<allin 保守序取更保守者；
 * bet/raise 金额取中位数）；3 次全部失败（超时/网络错误/解析失败）才回退
 * 启发式。reasoning 合并各采样段。
 * 注：LLMConfig.selfVote 由调用方透传，生产 gameStore 的 readLLMConfig 透传
 * 待接线（本次只改 opponent.ts 读 config.selfVote）。
 */
import type {
  ChatMessage,
  DecideInput,
  DecideResult,
  LLMConfig,
  PlayerAction,
} from "@/lib/types";
import type { Lang } from "@/lib/i18n/lang";
import { chatCompletion } from "@/lib/llm/client";
import { heuristicDecide } from "./heuristic";
import { brainStats, type BrainStats } from "./brain";
import { buildPrompt, buildSlimPrompt, parseDecision, type ParsedDecision } from "./prompt";

/** 默认 LLM 决策超时：未设置思考程度或 low 档时使用 */
const LLM_TIMEOUT_DEFAULT_MS = 8_000;

/** 触发 self-consistency 投票的底池门槛（大盲倍数） */
export const VOTE_POT_BB = 25;

/** 投票的 3 次并行采样各自的超时窗口（毫秒） */
const VOTE_TIMEOUTS_MS = [8_000, 15_000, 25_000] as const;

/** 平票保守序：index 越小越保守（诈唬/加注平票时取保守） */
const CONSERVATIVE_ORDER: readonly PlayerAction["type"][] = [
  "fold", "check", "call", "bet", "raise", "allin",
];

/**
 * LLM 决策超时预算（毫秒）：思考程度越高推理耗时越长，给更宽的窗口，
 * 避免高 effort 的推理型模型被默认 8s 掐死后无谓回退启发式。
 * 默认/low → 8s，medium → 15s，high/max → 25s。
 */
export function llmTimeoutFor(
  config: Pick<LLMConfig, "reasoningEffort"> | null | undefined,
): number {
  switch (config?.reasoningEffort) {
    case "medium":
      return 15_000;
    case "high":
    case "max":
      return 25_000;
    default:
      return LLM_TIMEOUT_DEFAULT_MS;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`LLM timeout (${ms}ms)`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * 构造发给 LLM 的消息对。
 * prompt 风格：slim（默认，零注入——胜率注入经大样本验证会诱发机械决策）；
 * full 才计算 brainStats 注入（同时付出 40-80ms 计算成本）。
 * lang 只作用于 slim 路径（full 为对照实验，保持中文版）。
 */
function buildMessages(
  input: DecideInput,
  config: LLMConfig,
  lang: Lang = "zh",
): ChatMessage[] {
  if (config.promptStyle === "full") {
    let stats: BrainStats | null = null;
    try {
      stats = brainStats(input);
    } catch {
      stats = null; // 数据计算失败不阻塞 LLM 路径
    }
    const { system, user } = buildPrompt(input, stats);
    return [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
  }
  const { system, user } = buildSlimPrompt(input, lang);
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * self-consistency 投票：并行采样 3 次（各自 8/15/25s 窗口），多数投票归并动作。
 * 全部失败返回 null（调用方回退启发式）。
 */
async function voteDecide(
  input: DecideInput,
  config: LLMConfig,
  messages: ChatMessage[],
): Promise<DecideResult | null> {
  const settled = await Promise.all(
    VOTE_TIMEOUTS_MS.map((ms) =>
      withTimeout(chatCompletion(config, messages), ms)
        .then((text) => parseDecision(text, input.legalActions))
        .catch(() => null),
    ),
  );
  // 保留采样序号供 reasoning 合并定位
  const votes = settled
    .map((p, i) => ({ p, i }))
    .filter((v): v is { p: ParsedDecision; i: number } => v.p !== null);
  if (votes.length === 0) return null;

  // action.type 归票
  const tally = new Map<PlayerAction["type"], { count: number; amounts: number[] }>();
  for (const { p } of votes) {
    const t = p.action.type;
    const e = tally.get(t) ?? { count: 0, amounts: [] };
    e.count++;
    e.amounts.push(p.action.amount);
    tally.set(t, e);
  }
  let bestCount = 0;
  for (const v of tally.values()) bestCount = Math.max(bestCount, v.count);
  // 平票（含 1-1-1 与 2 票 1-1）按保守序取更保守者
  const winners = [...tally.keys()]
    .filter((t) => tally.get(t)!.count === bestCount)
    .sort(
      (a, b) => CONSERVATIVE_ORDER.indexOf(a) - CONSERVATIVE_ORDER.indexOf(b),
    );
  const winner = winners[0];

  let action: PlayerAction;
  if (winner === "bet" || winner === "raise") {
    // 金额取中位数；偶数票取下中位数（较小者，保守）。各票金额已被
    // parseDecision 钳制在合法区间内，中位数必在区间内。
    const amounts = tally.get(winner)!.amounts.slice().sort((x, y) => x - y);
    action = { type: winner, amount: amounts[Math.floor((amounts.length - 1) / 2)] };
  } else {
    // fold/check 金额恒 0；call/allin 金额以合法动作集为准（解析时已归一）
    const amt = winner === "fold" || winner === "check"
      ? 0
      : tally.get(winner)!.amounts[0];
    action = { type: winner, amount: amt };
  }

  const tallyText = [...tally.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([t, v]) => `${t}×${v.count}`)
    .join(" / ");
  const segments = votes.map(({ p, i }) => `采样${i + 1}：${p.reasoning}`);
  return {
    action,
    reasoning: `【大底池投票 ${tallyText}】${segments.join("；")}`,
    source: "llm",
  };
}

export async function decide(
  input: DecideInput,
  config: LLMConfig | null,
  lang: Lang = "zh",
): Promise<DecideResult> {
  if (config?.apiKey) {
    // 消息构造失败（异常快照等）不阻塞决策——与旧版整体 try/catch 语义一致
    let messages: ChatMessage[] | null = null;
    try {
      messages = buildMessages(input, config, lang);
    } catch {
      messages = null;
    }
    if (messages) {
      // 大底池/河牌街触发 self-consistency 投票（selfVote 缺省 = 开）
      const potBB = input.state.pot / Math.max(1, input.state.bigBlind);
      const vote = (config.selfVote ?? true) &&
        (potBB >= VOTE_POT_BB || input.state.street === "river");
      if (vote) {
        const r = await voteDecide(input, config, messages);
        if (r) return r;
        // 3 次采样全部失败：落到启发式兜底
      } else {
        try {
          const text = await withTimeout(chatCompletion(config, messages), llmTimeoutFor(config));
          const parsed = parseDecision(text, input.legalActions);
          if (parsed) {
            return { action: parsed.action, reasoning: parsed.reasoning, source: "llm" };
          }
        } catch {
          // 超时 / 网络错误 / 代理错误：静默降级到启发式
        }
      }
    }
  }
  return heuristicDecide(input, input.style);
}
