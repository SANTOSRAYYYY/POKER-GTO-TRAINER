/**
 * LLM prompt 构造与输出解析模块
 *
 * buildPrompt：把 DecideInput 渲染为 system + user 两条消息。
 * parseDecision：对 LLM 输出做容错解析（提取 JSON、金额钳制、非法动作降级）。
 */
import type {
  Card,
  DecideInput,
  GameState,
  OpponentClass,
  OpponentModel,
  PlayerAction,
  PlayerState,
  Street,
  TournamentContext,
  TournamentPhase,
} from "@/lib/types";
import type { Lang } from "@/lib/i18n/lang";
import { AI_PROFILES } from "./profiles";
import { actOrderInfo, positionName, positionShortName } from "./positions";
import type { BrainStats } from "./brain";

// ---------------------------------------------------------------------------
// prompt 构造
// ---------------------------------------------------------------------------

const STREET_NAMES: Record<Street, string> = {
  preflop: "翻前",
  flop: "翻牌圈",
  turn: "转牌圈",
  river: "河牌圈",
  showdown: "摊牌",
};

function fmtCards(cards: Card[]): string {
  return cards.length ? cards.join(" ") : "（无）";
}

function fmtAction(a: PlayerAction): string {
  switch (a.type) {
    case "bet":
      return `bet（下注，amount 为本街下注总额，最小 ${a.amount}，最大为你的全下额）`;
    case "raise":
      return `raise（加注，amount 为加注到的本街累计总额，最小 ${a.amount}，最大为你的全下额）`;
    case "allin":
      return `allin（全下，amount=${a.amount}）`;
    case "call":
      return `call（跟注，需补 ${a.amount} 筹码）`;
    default:
      return `${a.type}（amount 固定为 0）`;
  }
}

function describeStreetActions(state: GameState): string {
  if (!state.streetActions.length) return "（本街尚无行动）";
  // streetActions 携带行动者座位（F4）：行动序列按座位标注，LLM 能定位加注者
  return state.streetActions
    .map((sa) =>
      `座位${sa.seat} ${sa.action.type}${sa.action.amount > 0 ? ` ${sa.action.amount}` : ""}`
    )
    .join(" → ");
}

function describeOpponent(p: PlayerState): string {
  const status = p.folded
    ? "已弃牌"
    : p.allIn
      ? "已全下"
      : p.hasActed
        ? "在局（本轮已行动）"
        : "在局（本轮未行动）";
  return `  - 座位 ${p.seat}：剩余筹码 ${p.stack}，本街已下注 ${p.streetBet}，${status}`;
}

const AMOUNT_SEMANTICS =
  "- amount 语义：bet/raise/allin 的 amount 是本街「下注到的累计总额」（bet-to），" +
  "不是增量；call 的 amount 是需要补的筹码数；fold/check 的 amount 为 0。";

const OUTPUT_REQUIREMENT =
  "【输出要求】只输出一行严格 JSON，不要输出任何其他文字、不要用 markdown 代码块：\n" +
  '{"action":"fold|check|call|bet|raise|allin","amount":数字,"reasoning":"一句话中文说明"}';

// ---------------------------------------------------------------------------
// 英文版片段（buildSlimPrompt lang="en" 用；局面事实结构与中文版一致，标签英文化）
// ---------------------------------------------------------------------------

const STREET_NAMES_EN: Record<Street, string> = {
  preflop: "Preflop",
  flop: "Flop",
  turn: "Turn",
  river: "River",
  showdown: "Showdown",
};

const AMOUNT_SEMANTICS_EN =
  "- amount semantics: for bet/raise/allin, amount is the cumulative total you put in " +
  "this street (bet-to), not an increment; for call it is the number of chips needed to " +
  "call; for fold/check amount is 0.";

const OUTPUT_REQUIREMENT_EN =
  "[Output requirement] Output exactly one line of strict JSON, nothing else, no markdown code block:\n" +
  '{"action":"fold|check|call|bet|raise|allin","amount":number,"reasoning":"one-sentence explanation in English"}';

/** 锦标赛阶段英文名（slim prompt 事实段用） */
const PHASE_EN: Record<TournamentPhase, string> = {
  early: "early",
  middle: "middle",
  bubble: "bubble",
  final: "final table",
};

function fmtCardsEn(cards: Card[]): string {
  return cards.length ? cards.join(" ") : "(none)";
}

function fmtActionEn(a: PlayerAction): string {
  switch (a.type) {
    case "bet":
      return `bet (amount is your total bet this street, min ${a.amount}, max is your all-in)`;
    case "raise":
      return `raise (amount is the total you raise to this street, min ${a.amount}, max is your all-in)`;
    case "allin":
      return `allin (all-in, amount=${a.amount})`;
    case "call":
      return `call (match the bet, costs ${a.amount} chips)`;
    default:
      return `${a.type} (amount is fixed at 0)`;
  }
}

function describeStreetActionsEn(state: GameState): string {
  if (!state.streetActions.length) return "(no actions yet this street)";
  return state.streetActions
    .map((sa) =>
      `Seat${sa.seat} ${sa.action.type}${sa.action.amount > 0 ? ` ${sa.action.amount}` : ""}`
    )
    .join(" → ");
}

function describeOpponentEn(p: PlayerState): string {
  const status = p.folded
    ? "folded"
    : p.allIn
      ? "all-in"
      : p.hasActed
        ? "in hand (acted this round)"
        : "in hand (yet to act)";
  return `  - Seat ${p.seat}: stack ${p.stack}, bet this street ${p.streetBet}, ${status}`;
}

/** describeTournament 的英文版：同样只给事实 */
function describeTournamentEn(t: TournamentContext): string {
  return (
    `- Tournament: ${t.playersRemaining}/${t.totalPlayers} players left, ` +
    `your chip rank #${t.myRankByChips}` +
    ` (${t.myStackBB.toFixed(0)}bb, average ${t.avgStackBB.toFixed(0)}bb), ` +
    `phase: ${PHASE_EN[t.phase]}\n`
  );
}

const HEADS_UP_COMMON_SENSE =
  "【单挑德州基本策略常识】\n" +
  "- 单挑局范围宽，进攻性普遍比多人池高；按钮位（小盲）翻前有主动权。\n" +
  "- 底池赔率 = 需要跟注的筹码 /（底池 + 需要跟注的筹码）；胜率高于赔率时跟注才有利可图。\n" +
  "- 听牌（同花听/顺子听）有一定胜率，可跟注小注或半诈唬下注；纯空气面对大注应弃牌。\n" +
  AMOUNT_SEMANTICS;

function multiwayCommonSense(playerCount: number): string {
  return (
    "【多人底池策略常识】\n" +
    `- 当前底池有 ${playerCount} 名玩家在局（多人底池），与单挑思路不同。\n` +
    "- 底池赔率 = 需要跟注的筹码 /（底池 + 需要跟注的筹码）；多人底池中实际所需胜率高于赔率字面值。\n" +
    "- 多名对手在局时诈唬成功率显著下降：减少纯诈唬，半诈唬也要更克制；相应地价值下注可以打得更薄。\n" +
    "- 顶对级别的边缘牌力在多人底池明显贬值，继续游戏需要比单挑更强的牌力或更好的赔率。\n" +
    "- 你之后还有未行动的对手时，跟注/加注门槛应更高（可能被再加注，多人跟注也会摊薄你的胜率）。\n" +
    "- 听牌（同花听/顺子听）有一定胜率，可跟注小注或半诈唬下注；纯空气面对大注应弃牌。\n" +
    AMOUNT_SEMANTICS
  );
}

// ---------------------------------------------------------------------------
// 对手画像段（跨手统计建模，供剥削性调整）
// ---------------------------------------------------------------------------

const CLASS_CN: Record<OpponentClass, string> = {
  nit: "紧弱岩石（Nit）",
  tag: "紧凶（TAG）",
  lag: "松凶（LAG）",
  maniac: "疯狂玩家（Maniac）",
  calling_station: "跟注站",
  unknown: "未知",
};

/** 锦标赛阶段中文名（slim prompt 事实段用） */
const PHASE_CN: Record<TournamentPhase, string> = {
  early: "早期",
  middle: "中期",
  bubble: "泡沫期",
  final: "决赛期",
};

/**
 * 「锦标赛」事实行（slim 哲学：只给事实不给说教）：
 * 还剩 X/Y 人、筹码排名、自己/平均筹码（bb）、阶段。
 */
function describeTournament(t: TournamentContext): string {
  return (
    `- 锦标赛：还剩 ${t.playersRemaining}/${t.totalPlayers} 人，` +
    `你的筹码排第 ${t.myRankByChips}` +
    `（${t.myStackBB.toFixed(0)}bb，平均 ${t.avgStackBB.toFixed(0)}bb），` +
    `阶段：${PHASE_CN[t.phase]}\n`
  );
}

/** 各类型的剥削建议一句话 */
function exploitAdvice(cls: OpponentClass): string {
  switch (cls) {
    case "calling_station":
      return "少诈唬，价值下注可以更薄";
    case "nit":
      return "可以更频繁地偷盲和诈唬，他弃牌率高";
    case "maniac":
      return "放宽跟注抓他的诈唬，自己少诈唬，用强牌设陷阱";
    case "lag":
      return "跟注范围可略放宽，用强牌反击他的施压";
    default:
      return "打法均衡，按标准策略应对";
  }
}

/** 「对手画像」段：每座位一行统计 + 分类推测 + 剥削建议；样本不足单独标注 */
function describeOpponentModels(models: OpponentModel[]): string {
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const lines = models.map((m) => {
    if (m.cls === "unknown" || m.confidence <= 0) {
      return `- 座位 ${m.seat}：样本不足（仅 ${m.stats.hands} 手），按未知对手默认应对`;
    }
    // 位置拆分（置信度足够且有分桶数据时）：前位=身后≥5（UTG 侧），
    // 中位=身后 2-4（HJ/CO/BTN 侧），后位=身后 ≤1（SB/BB 盲位侧）
    const b = m.bucketVpip;
    const bucketText =
      b && (b.early !== null || b.middle !== null || b.late !== null)
        ? "；位置拆分 VPIP：" +
          [
            b.early !== null ? `前位 ${pct(b.early)}` : null,
            b.middle !== null ? `中位 ${pct(b.middle)}` : null,
            b.late !== null ? `后位 ${pct(b.late)}` : null,
          ]
            .filter(Boolean)
            .join(" / ")
        : "";
    return (
      `- 座位 ${m.seat}：${m.stats.hands} 手样本，` +
      `VPIP ${pct(m.vpip)}/PFR ${pct(m.pfr)}/AF ${m.af.toFixed(1)}/摊牌率 ${pct(m.wtsd)}` +
      bucketText +
      ` —— 推测：${CLASS_CN[m.cls]}。建议：${exploitAdvice(m.cls)}`
    );
  });
  return (
    "【对手画像】（基于与本桌过往手牌的统计推测，可用于剥削性调整；样本越少越不可靠）\n" +
    lines.join("\n") +
    "\n"
  );
}

/**
 * 渲染 DecideInput 为 OpenAI chat 消息（system + user）。
 * 支持 2-9 人桌：user 中列出所有未淘汰对手（不泄露其风格人设）、
 * 位置名与行动顺序、ante 死钱与多人底池赔率提示。
 * stats 为可选的数学引擎数据快照（brain.brainStats 的输出），
 * 提供时向 LLM 展示真实胜率与跟注所需胜率。
 * input.opponentModels 存在有效模型（confidence>0）时追加「对手画像」段。
 */
export function buildPrompt(
  input: DecideInput,
  stats?: BrainStats | null,
): {
  system: string;
  user: string;
} {
  const { state, style } = input;
  const profile = AI_PROFILES[style];
  const seat = state.currentSeat ?? 1;
  const me = state.players[seat];
  // 未淘汰的对手（含已弃牌/已全下，均如实标注状态）
  const opponents = state.players.filter((p) => p.seat !== seat && !p.eliminated);
  const inHand = opponents.filter((p) => !p.folded);
  const multiway = inHand.length > 1;

  const order = actOrderInfo(seat, state);
  const position = positionName(seat, state);
  const activeCount = order?.activeCount ?? state.players.length;

  const system =
    (multiway
      ? `你是一名无限注德州扑克职业选手，正在打一场 ${activeCount} 人桌对局。请完全代入下面的风格人设做决策。\n\n`
      : "你是一名单挑无限注德州扑克（Heads-Up No-Limit Texas Hold'em）职业选手，" +
        "正在打一场单挑对局。请完全代入下面的风格人设做决策。\n\n") +
    `【你的风格人设】${profile.name}：${profile.personaPrompt}\n\n` +
    (multiway ? multiwayCommonSense(inHand.length + 1) : HEADS_UP_COMMON_SENSE) +
    "\n\n" +
    OUTPUT_REQUIREMENT;

  const anteTotal =
    state.ante > 0
      ? state.anteMode === "bb"
        ? state.ante
        : state.ante * activeCount
      : 0;
  const potLine =
    anteTotal > 0
      ? `- 底池：${state.pot}（其中 ante 死钱 ${anteTotal}）`
      : `- 底池：${state.pot}`;

  const orderLine = order
    ? `- 行动顺序：翻前从${order.activeCount === 2 ? "按钮位（小盲）" : "UTG（枪口位）"}最先行动` +
      `（本局为座位 ${order.preflopFirst}），翻后从按钮左邻最先行动（本局为座位 ${order.postflopFirst}）；` +
      `你翻前第 ${order.preflopRank}/${order.activeCount} 个行动，翻后第 ${order.postflopRank}/${order.activeCount} 个行动。`
    : "";

  const oddsNote =
    multiway && input.callAmount > 0
      ? "（多人底池：你之后可能还有对手行动，实际所需胜率高于该赔率）"
      : "";

  const statsLine = stats
    ? `- 【数据参考】蒙特卡洛模拟：你当前对抗 ${stats.opponents} 名对手的随机范围胜率约 ` +
      `${(stats.equity * 100).toFixed(0)}%${stats.preflop ? "（翻前对随机范围）" : ""}` +
      // F3 双口径：面注时补「对手隐含范围胜率」（与决策引擎实际使用的口径一致）
      (stats.equityVsRange !== null && stats.equityVsRange !== undefined
        ? `；对手下注/加注后，你对其隐含范围的胜率约 ${(stats.equityVsRange * 100).toFixed(0)}%（范围推断口径）`
        : "") +
      (stats.required !== null
        ? `；本次跟注所需胜率约 ${(stats.required * 100).toFixed(0)}%（胜率高于所需跟注才有利可图）`
        : "；当前无需跟注") +
      "。请结合该数据与你的风格人设决策。\n"
    : "";

  const models = input.opponentModels ?? [];
  const modelsSection = models.some((m) => m.confidence > 0)
    ? describeOpponentModels(models)
    : "";

  // 近期手牌回顾段（用户配置的上下文携带量；最新在前）
  const recentSection = input.recentHands?.length
    ? `【最近 ${input.recentHands.length} 手回顾】（最新在前，可用于捕捉对手近期动态与牌桌气氛）\n` +
      input.recentHands.map((s) => `- ${s}`).join("\n") +
      "\n"
    : "";

  const user =
    `【当前局面】第 ${state.handNumber} 手，${STREET_NAMES[state.street]}，${activeCount} 人桌\n` +
    `- 你的底牌：${me.holeCards ? fmtCards(me.holeCards) : "未知"}\n` +
    `- 公共牌：${fmtCards(state.board)}\n` +
    `- 你的位置：${position}（座位 ${seat}）\n` +
    (orderLine ? orderLine + "\n" : "") +
    potLine + "\n" +
    `- 本街你已下注：${me.streetBet}；你的剩余筹码：${me.stack}\n` +
    `- 对手情况（共 ${opponents.length} 名对手，他们的风格人设对你保密）：\n` +
    opponents.map(describeOpponent).join("\n") + "\n" +
    `- 本街行动序列：${describeStreetActions(state)}\n` +
    `- 跟注需要补：${input.callAmount}；底池赔率：${(input.potOdds * 100).toFixed(1)}%${oddsNote}\n` +
    statsLine +
    modelsSection +
    recentSection +
    `【合法动作】\n` +
    input.legalActions.map((a) => `- ${fmtAction(a)}`).join("\n") +
    "\n\n请以你的风格人设做出决策，只输出一行 JSON。";

  return { system, user };
}

/**
 * slim 版决策 prompt（默认）：经 LLM 变体大战（K3 × 240 手 × 2 场）验证——
 * 注入胜率/策略说教会让模型做机械阈值决策、放弃原生推理（「赢小输大」），
 * 只有零注入的 slim 两场皆正。只保留：风格人设一句话、局面事实、
 * 对手筹码事实、合法动作、JSON 协议；不含策略常识/胜率/画像/回顾。
 * lang="en" 时输出英文版（局面事实结构不变，标签英文化，reasoning 要求英文）。
 */
export function buildSlimPrompt(
  input: DecideInput,
  lang: Lang = "zh",
): {
  system: string;
  user: string;
} {
  if (lang === "en") return buildSlimPromptEn(input);
  const { state, style } = input;
  const profile = AI_PROFILES[style];
  const seat = state.currentSeat ?? 1;
  const me = state.players[seat];
  const opponents = state.players.filter((p) => p.seat !== seat && !p.eliminated);
  const position = positionName(seat, state);

  const system =
    `你是「${profile.name}」，一名无限注德州扑克职业选手。\n` +
    "按职业牌手标准做出最优决策，用你自己的判断而不是任何口诀。\n" +
    AMOUNT_SEMANTICS +
    "\n" +
    OUTPUT_REQUIREMENT;

  const user =
    `【当前局面】${STREET_NAMES[state.street]}，${state.players.length} 人桌\n` +
    `- 你的底牌：${me.holeCards ? fmtCards(me.holeCards) : "未知"}\n` +
    `- 公共牌：${fmtCards(state.board)}\n` +
    `- 你的位置：${position}（座位 ${seat}）\n` +
    `- 底池：${state.pot}\n` +
    `- 你的剩余筹码：${me.stack}；本街你已下注：${me.streetBet}\n` +
    // 锦标赛事实段（仅锦标赛模式注入；现金局无此行）
    (input.tournament ? describeTournament(input.tournament) : "") +
    `- 对手情况（${opponents.length} 名对手）：\n` +
    opponents.map(describeOpponent).join("\n") +
    "\n" +
    `- 本街行动序列：${describeStreetActions(state)}\n` +
    `- 跟注需要补：${input.callAmount}\n` +
    `【合法动作】\n` +
    input.legalActions.map((a) => `- ${fmtAction(a)}`).join("\n") +
    "\n\n请以你的风格人设做出决策，只输出一行 JSON。";

  return { system, user };
}

/** buildSlimPrompt 的英文版：与中文版逐行同构，仅文案英文化（位置用短名） */
function buildSlimPromptEn(input: DecideInput): {
  system: string;
  user: string;
} {
  const { state, style } = input;
  const profile = AI_PROFILES[style];
  const seat = state.currentSeat ?? 1;
  const me = state.players[seat];
  const opponents = state.players.filter((p) => p.seat !== seat && !p.eliminated);
  const position = positionShortName(seat, state);

  const system =
    `You are "${profile.name}", a professional No-Limit Texas Hold'em player.\n` +
    "Make the optimal decision to a professional standard, using your own judgment rather than any rules of thumb.\n" +
    AMOUNT_SEMANTICS_EN +
    "\n" +
    OUTPUT_REQUIREMENT_EN;

  const user =
    `[Current situation] ${STREET_NAMES_EN[state.street]}, ${state.players.length}-max table\n` +
    `- Your hole cards: ${me.holeCards ? fmtCardsEn(me.holeCards) : "unknown"}\n` +
    `- Board: ${fmtCardsEn(state.board)}\n` +
    `- Your position: ${position} (Seat ${seat})\n` +
    `- Pot: ${state.pot}\n` +
    `- Your stack: ${me.stack}; your bet this street: ${me.streetBet}\n` +
    // 锦标赛事实段（仅锦标赛模式注入；现金局无此行）
    (input.tournament ? describeTournamentEn(input.tournament) : "") +
    `- Opponents (${opponents.length}):\n` +
    opponents.map(describeOpponentEn).join("\n") +
    "\n" +
    `- Actions this street: ${describeStreetActionsEn(state)}\n` +
    `- To call: ${input.callAmount}\n` +
    `[Legal actions]\n` +
    input.legalActions.map((a) => `- ${fmtActionEn(a)}`).join("\n") +
    "\n\nDecide in character and output exactly one line of JSON.";

  return { system, user };
}

// ---------------------------------------------------------------------------
// 输出解析
// ---------------------------------------------------------------------------

export interface ParsedDecision {
  action: PlayerAction;
  reasoning: string;
}

const ACTION_TYPES: PlayerAction["type"][] = [
  "fold", "check", "call", "bet", "raise", "allin",
];

/**
 * 容错解析 LLM 输出：
 * - 从文本中提取第一个 {...} JSON 块（容忍前后多余文字、markdown 代码块）
 * - action 不合法时降级：优先 check → call → fold
 * - bet/raise 的 amount 钳制到 [合法最小额, 全下额]；allin/call 金额以合法动作集为准
 * - 完全无法提取 JSON 时返回 null（调用方应降级到 heuristic）
 */
export function parseDecision(
  text: string,
  legalActions: PlayerAction[],
): ParsedDecision | null {
  const map = new Map(legalActions.map((a) => [a.type, a.amount]));

  // 提取 JSON：先整体 parse，失败后退化到 { ... } 子串
  let raw: unknown = null;
  const trimmed = text.trim();
  try {
    raw = JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        raw = JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }
  if (typeof raw !== "object" || raw === null) return null;

  const obj = raw as Record<string, unknown>;
  const reasoning =
    typeof obj.reasoning === "string" && obj.reasoning.trim()
      ? obj.reasoning.trim()
      : "（AI 未给出说明）";

  // 解析动作类型
  let type = typeof obj.action === "string" ? obj.action.toLowerCase().trim() : "";
  if (!ACTION_TYPES.includes(type as PlayerAction["type"])) type = "";
  if (type && !map.has(type as PlayerAction["type"])) type = ""; // 不合法动作走降级

  const rawAmount =
    typeof obj.amount === "number" && Number.isFinite(obj.amount) ? obj.amount : 0;

  const allinTo = map.get("allin");
  const clampTo = (t: "bet" | "raise", amt: number): number => {
    const min = map.get(t)!;
    const max = allinTo !== undefined ? Math.max(min, allinTo) : min;
    return Math.round(Math.min(max, Math.max(min, amt)));
  };

  let action: PlayerAction | null = null;
  switch (type) {
    case "fold":
      action = { type: "fold", amount: 0 };
      break;
    case "check":
      action = { type: "check", amount: 0 };
      break;
    case "call":
      action = { type: "call", amount: map.get("call") ?? 0 };
      break;
    case "allin":
      action = { type: "allin", amount: map.get("allin") ?? 0 };
      break;
    case "bet":
      action = { type: "bet", amount: clampTo("bet", rawAmount) };
      break;
    case "raise":
      action = { type: "raise", amount: clampTo("raise", rawAmount) };
      break;
    default:
      break;
  }

  // 降级链：check → call → fold → allin → 第一个合法动作
  if (!action) {
    if (map.has("check")) action = { type: "check", amount: 0 };
    else if (map.has("call")) action = { type: "call", amount: map.get("call")! };
    else if (map.has("fold")) action = { type: "fold", amount: 0 };
    else if (map.has("allin")) action = { type: "allin", amount: map.get("allin")! };
    else if (legalActions.length) action = legalActions[0];
    else return null;
  }

  return { action, reasoning };
}
