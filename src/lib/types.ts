/**
 * src/lib/types.ts — 全局共享类型契约（v2 Phase A：N 人桌 + 锦标赛）
 *
 * 本文件是整个「PokerGTO Trainer」项目的唯一共享契约。
 * 所有并行开发模块（poker 引擎 / AI / 存储 / UI）只允许依赖这里的类型。
 *
 * 约定总则：
 * - 所有筹码金额均为「整数个筹码单位」（不再细分），小盲/大盲/ante 可为任意非负整数。
 * - 座位（Seat）为 players 数组下标，0..8（2-9 人桌）。UI 层约定哪个座位是
 *   人类玩家（hero），引擎层不关心谁是人，HandRecord.heroSeat 记录本手人类坐在哪。
 * - 牌局引擎为纯函数（见 game.ts），GameState 可安全序列化（不含函数/类实例）。
 * - 淘汰只发生在两手之间（stack===0 && handOver 时由调局模块标记 eliminated），
 *   一手牌进行中没有淘汰；引擎内玩家只有 folded/allIn/hasActed 三种进行态。
 */

// ---------------------------------------------------------------------------
// 牌
// ---------------------------------------------------------------------------

/** 花色短码：s=♠黑桃 h=♥红桃 d=♦方块 c=♣梅花 */
export type Suit = "s" | "h" | "d" | "c";

/** 点数短码：'2'-'9'，'T'=10，'J'/'Q'/'K'/'A' */
export type Rank =
  | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
  | "T" | "J" | "Q" | "K" | "A";

/**
 * 牌的短码表示：两张字符，点数在前花色在后。
 * 例如 "As"（黑桃A）、"Td"（方块10）、"2c"（梅花2）。
 * 用模板字面量类型保证编译期合法；运行时由 parseCard() 校验。
 * 52 张牌 = 13 Rank × 4 Suit，全牌堆可用 newDeck() 生成。
 */
export type Card = `${Rank}${Suit}`;

/** 点数数值化（2=2 … T=10, J=11, Q=12, K=13, A=14），evaluator 内部使用 */
export type RankValue = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

// ---------------------------------------------------------------------------
// 动作与街道
// ---------------------------------------------------------------------------

/** 动作类型。allin 与 bet/raise 区分：allin 必定是把剩余全部投入 */
export type ActionType = "fold" | "check" | "call" | "bet" | "raise" | "allin";

/**
 * 一次玩家动作。
 *
 * amount 语义（关键约定）：
 * - bet / raise / allin：本街道行动完成后，该玩家在本街的「累计下注总额」
 *   （即“加注到 X”的 X，英文 bet-to / raise-to 语义，不是增量）。
 * - call：为跟上当前下注实际需要再投入的筹码数（增量）。
 * - fold / check：固定为 0。
 * 金额合法性由 game.legalActions() 计算并给出，AI/UI 不应自行构造越界金额。
 */
export interface PlayerAction {
  type: ActionType;
  amount: number;
}

/** 街道。showdown 仅作为摊牌结算阶段的标记，不产生下注动作 */
export type Street = "preflop" | "flop" | "turn" | "river" | "showdown";

// ---------------------------------------------------------------------------
// 游戏状态机
// ---------------------------------------------------------------------------

/** 座位号：players 数组下标，合法范围 0..players.length-1（2-9 人桌） */
export type Seat = number;

/** 单个玩家在一手牌中的状态 */
export interface PlayerState {
  seat: Seat;
  /**
   * 两张底牌。为 null 表示“尚未发牌”或“对观察者不可见”。
   * 引擎内部始终持有真实牌；给 AI/UI 的快照可对对手底牌置 null。
   */
  holeCards: [Card, Card] | null;
  /** 身后剩余可用筹码（不含已投入底池的部分） */
  stack: number;
  /**
   * 当前街道已累计下注额（每换一条街归零）。
   * 不含 ante —— ante 是死钱，不计入“需跟齐”的下注线。
   */
  streetBet: number;
  /**
   * 本手牌累计投入总额（跨街道累加，含 ante）。
   * 是摊牌边池分层与盈亏结算的依据。
   */
  handBet: number;
  /** 是否已弃牌 */
  folded: boolean;
  /** 是否已全下（allin 后 stack===0，不再参与后续行动） */
  allIn: boolean;
  /** 当前下注轮中是否已经行动过（配合 currentBet 判断本轮是否结束） */
  hasActed: boolean;
  /**
   * 是否已淘汰（锦标赛）。淘汰仅发生在两手之间：
   * 一手结束后 stack===0 的玩家由调局模块（store）置 eliminated 并保留座位。
   * 引擎 createGame 创建的一手牌内所有玩家 eliminated 恒为 false，
   * 引擎行动逻辑不读此字段（只依据 folded/allIn/hasActed）。
   */
  eliminated: boolean;
}

/**
 * N 人牌局完整状态（状态机，2-9 人）。
 *
 * 生命周期：createGame() → 投 ante/盲注、发底牌 → 各街道行动循环（applyAction）
 * → 行动轮结束自动进入下一街 → river 行动结束或只剩一人未弃牌 → handOver=true。
 *
 * 字段不变式：
 * - pot === Σ players[*].handBet（结算前恒等；结算后 pot 清零）。
 * - currentBet === max(players[*].streetBet)（本街最高下注，不含 ante）。
 * - 轮到某人行动的充要条件：!handOver && !folded && !allIn &&
 *   (!hasActed || streetBet < currentBet)。
 * - 行动顺序：翻前从 UTG（大盲左邻第一个在局玩家）开始；翻后从按钮左邻
 *   第一个可行动玩家开始。单挑特例：按钮=小盲，UTG 即按钮（翻前按钮先动）。
 */
export interface GameState {
  /** 剩余牌堆。约定：从数组末尾 pop 发牌（末尾 = 牌堆顶） */
  deck: Card[];
  /** 玩家状态数组，长度 2-9，索引即座位号 */
  players: PlayerState[];
  /** 公共牌：preflop 为空，flop 3 张，turn 4 张，river/showdown 5 张 */
  board: Card[];
  /** 底池总额（含 ante 与本街尚未跟齐的下注） */
  pot: number;
  /** 当前街道 */
  street: Street;
  /** 当前行动方；handOver 后为 null */
  currentSeat: Seat | null;
  /**
   * 按钮位（庄家）座位。
   * 单挑（2 人）：按钮位 = 小盲，翻前按钮先行动，翻后按钮后行动。
   * 3 人及以上：小盲 = 按钮左邻，大盲 = 小盲左邻，翻前 UTG（大盲左邻）先行动。
   */
  buttonSeat: Seat;
  /** 小盲额度 */
  smallBlind: number;
  /** 大盲额度 */
  bigBlind: number;
  /** 本手前注额度（全体模式每人投入；BBA 模式仅大盲位投入；无 ante 局为 0） */
  ante: number;
  /** ante 模式：all=全体各投 / bb=仅大盲位投（BBA）；缺省视为 all */
  anteMode?: AnteMode;
  /**
   * 当前最小加注“增量”（即最小 raise 的 amount = currentBet + minRaise）。
   * 初始 = bigBlind，每次合法加注后更新为本次加注的增量。
   */
  minRaise: number;
  /** 当前街道最高下注额（call 需要补到该值；不含 ante） */
  currentBet: number;
  /**
   * 当前街道的行动历史（每换街清空；完整历史见 HandRecord）。
   * 每条动作携带行动者座位（SeatAction），供范围推断定位加注者/按座位展示。
   */
  streetActions: SeatAction[];
  /** 本手编号（从 1 开始，同一 session 内递增，按钮每手轮转） */
  handNumber: number;
  /** 本手是否已结束 */
  handOver: boolean;
  /**
   * 胜者座位列表；本手未结束为 null。
   * fold 获胜时为单元素；摊牌后所有赢到筹码（含任一边池/平分）的座位，升序。
   * 单挑平局即 [0, 1]。
   */
  winners: Seat[] | null;
  /** 是否进入摊牌（决定 HandRecord 是否应包含对手底牌） */
  showdown: boolean;
}

/** ante 投放方式：'all' 全体各投一份（默认）；'bb' 仅大盲位替全桌投（BBA 赛制） */
export type AnteMode = "all" | "bb";

/**
 * 开局配置（game.createGame）。
 * 只支持对称初始筹码；锦标赛中两手之间的筹码携带/淘汰/升盲由调局模块负责。
 */
export interface CreateGameConfig {
  /** 玩家数，2-9 */
  players: number;
  smallBlind: number;
  bigBlind: number;
  /** 每人前注，默认 0（锦标赛取自 BlindLevel.ante） */
  ante?: number;
  /**
   * ante 模式，默认 'all'。
   * 'bb'（BBA）：仅大盲位投一份 config.ante（先投 ante 再投大盲，不足则全下），
   * 其余座位不投；ante 仍是死钱（计入 pot/handBet，不计入 streetBet）。
   */
  anteMode?: AnteMode;
  /** 每人初始筹码（对称） */
  stack: number;
  /** 本手按钮位座位 */
  buttonSeat: Seat;
}

// ---------------------------------------------------------------------------
// 锦标赛（SNG 升盲）
// ---------------------------------------------------------------------------

/** 对局模式：现金桌（盲注固定）或锦标赛（按 handsPerLevel 升盲） */
export type GameMode = "cash" | "tournament";

/** 一级盲注结构 */
export interface BlindLevel {
  smallBlind: number;
  bigBlind: number;
  /** 每人前注；0 表示无前注 */
  ante: number;
}

/** 锦标赛配置 */
export interface TournamentConfig {
  /** 每人起始筹码 */
  startStack: number;
  /** 升盲表（从低到高） */
  levels: BlindLevel[];
  /** 每个盲注级别进行的手数，打满即升入下一级 */
  handsPerLevel: number;
  /**
   * 每人允许的重购（rebuy）次数，默认 0。
   * 重购期内（见 rebuyPeriodLevels）筹码归零可买回起始筹码继续；
   * 次数用完或重购期外归零即正常淘汰。
   */
  rebuysAllowed?: number;
  /**
   * 重购期级数：前 N 个盲注级别（索引 0..N-1）允许重购，默认 4。
   * 0 = 全程不可重购（等同直接淘汰制，rebuysAllowed 失效）。
   */
  rebuyPeriodLevels?: number;
  /**
   * ante 模式，默认 'all'（全体各投一份）。
   * 'bb'（BBA）：仅大盲位替全桌投一份该级 ante，其余座位不投。
   */
  anteMode?: AnteMode;
}

/**
 * 默认升盲表：10/20 → 15/30 → 25/50 → 50/100 → 75/150 → 100/200
 * → 150/300 → 200/400 → 300/600 → 400/800。
 * 每级 ante = 该级大盲（含第 1 级）。
 */
export const DEFAULT_BLIND_LEVELS: BlindLevel[] = [
  { smallBlind: 10, bigBlind: 20, ante: 20 },
  { smallBlind: 15, bigBlind: 30, ante: 30 },
  { smallBlind: 25, bigBlind: 50, ante: 50 },
  { smallBlind: 50, bigBlind: 100, ante: 100 },
  { smallBlind: 75, bigBlind: 150, ante: 150 },
  { smallBlind: 100, bigBlind: 200, ante: 200 },
  { smallBlind: 150, bigBlind: 300, ante: 300 },
  { smallBlind: 200, bigBlind: 400, ante: 400 },
  { smallBlind: 300, bigBlind: 600, ante: 600 },
  { smallBlind: 400, bigBlind: 800, ante: 800 },
];

// ---------------------------------------------------------------------------
// AI 风格档案
// ---------------------------------------------------------------------------

/** AI 风格 id。'random' 表示每手随机抽取一种具体风格（对 hero 保密） */
export type AIStyle =
  | "nit"
  | "tag"
  | "lag"
  | "maniac"
  | "calling_station"
  | "gto"
  | "random";

/** 具体风格（不含 random）。所有档案/决策内部均使用具体风格 */
export type ConcreteAIStyle = Exclude<AIStyle, "random">;

/** AI 风格档案 */
export interface AIProfile {
  /** 风格 id（与 ConcreteAIStyle 一致） */
  id: ConcreteAIStyle;
  /** 显示名（UI 展示，如 "紧弱 Nit"） */
  name: string;
  /** 风格描述（UI 展示用，一两句话说明打法特征） */
  description: string;
  /**
   * 性格提示词片段：注入 LLM system/user prompt，
   * 描述该风格的倾向（松紧度、攻击性、诈唬频率等），供 LLM 扮演。
   */
  personaPrompt: string;
}

// ---------------------------------------------------------------------------
// 手牌历史记录
// ---------------------------------------------------------------------------

/** 一条带行动者的动作记录 */
export interface SeatAction {
  seat: Seat;
  action: PlayerAction;
}

/** 一个街道的记录快照 */
export interface StreetRecord {
  street: Street;
  /** 该街道开始时的公共牌快照（preflop 为 []，flop 为 3 张……） */
  board: Card[];
  /** 该街道按顺序发生的动作序列（含盲注投放可选；建议从翻后街道开始记录下注动作） */
  actions: SeatAction[];
}

/** 一个玩家在一手牌中的记录快照 */
export interface HandPlayerRecord {
  seat: Seat;
  /** 是否人类玩家（hero）座位 */
  isHero: boolean;
  /** 该座位 AI 实际使用的具体风格（resolveStyle 之后）；人类座位为 null */
  aiStyle: ConcreteAIStyle | null;
  /** 底牌；未摊牌且未公开的对手为 null */
  cards: Card[] | null;
  /** 本手净盈亏（正为赢，含盲注/ante 与所有投入） */
  profit: number;
  /** 锦标赛最终名次（1 = 冠军）；仅锦标赛模式、且该玩家已出局或夺冠时填写 */
  finishPlace?: number;
}

/** 一手牌的完整记录（用于历史回放、统计、赛后分析） */
export interface HandRecord {
  /** 唯一 id（建议 crypto.randomUUID()） */
  id: string;
  /** 结束时的 Unix 毫秒时间戳 */
  timestamp: number;
  /**
   * 对局模式（现金/锦标赛）。归档时写入（v2 修复后）；
   * 旧记录缺省，isTournamentHand 回退到 finishPlace 启发式判定。
   */
  mode?: GameMode;
  /**
   * 锦标赛开赛总人数（config.seats）；仅锦标赛模式填写。
   * 淘汰者在两手之间即被移出引擎桌，players.length 是本手开局人数而非开赛
   * 人数（夺冠手恒为单挑），nine_max_title 等判定须用本字段。
   */
  tournamentSeats?: number;
  /** 本手所有在座玩家（含 hero，按座位升序）的快照 */
  players: HandPlayerRecord[];
  /** 人类玩家座位 */
  heroSeat: Seat;
  /** 本手按钮位（庄家）座位；用于回放与分析时标注位置 */
  buttonSeat: Seat;
  /** 盲注/前注配置 */
  smallBlind: number;
  bigBlind: number;
  /** 本手前注（无 ante 局为 0） */
  ante: number;
  /** ante 模式：all=全体各投 / bb=仅大盲位投（BBA）；缺省视为 all（旧记录口径） */
  anteMode?: AnteMode;
  /** 按街道顺序的记录（只包含实际进行到的街道） */
  streets: StreetRecord[];
  /** 最终公共牌（5 张或摊牌时的张数；提前 fold 时可能不足 5 张） */
  finalBoard: Card[];
  /** hero 视角结果（可由 players 中 hero 的 profit 符号推导，冗余便于 UI） */
  result: "win" | "lose" | "tie";
  /** hero 本手净盈亏（等于 players 中 hero 座位的 profit） */
  profit: number;
  /** 是否摊牌 */
  showdown: boolean;
}

// ---------------------------------------------------------------------------
// 对手建模（opponent modeling / 剥削性调整）
// ---------------------------------------------------------------------------

/**
 * 翻前位置分桶（按翻前行动时的「身后人数」）：
 * - early：身后 ≥ 5 人（9 人桌 UTG 侧）
 * - middle：身后 2-4 人（HJ/CO/BTN 侧）
 * - late：身后 ≤ 1 人（SB/BB 盲位侧）
 * 单挑（2 人桌）特殊处理：两个座位都归入 late。
 */
export interface PreflopBucketCounts {
  early: number;
  middle: number;
  late: number;
}

/**
 * 单个座位跨手累积的打法统计（桌面座位维度）。
 * 生命周期：startTable 清零；现金局补码/锦标赛 rebuy 不清零（打法惯性跨重购）。
 * 计数语义见 lib/ai/adapt.ts 的 updateStats。
 *
 * 近因加权（Phase 6）：启用后各计数均为指数衰减后的「有效计数」（浮点），
 * 不再一定是整数；λ=1.0 时退化为整数累加（旧口径）。
 */
export interface OpponentStats {
  /** 桌面座位号 */
  seat: Seat;
  /** 已观察手数（该座位实际参与的手；近因加权下为衰减后有效样本量） */
  hands: number;
  /** 翻前自愿投钱的手数（VPIP 分子；call/bet/raise/allin 计入，盲注/ante 强制投入与 fold/check 不计） */
  vpipHands: number;
  /** 翻前主动加注的手数（PFR 分子；bet/raise 与抬高下注线的 allin 计入） */
  pfrHands: number;
  /** 翻后进攻性动作次数（bet/raise/抬高下注线的 allin，按动作次数计） */
  postflopAggressive: number;
  /** 翻后被动动作次数（call/跟注性 allin，按动作次数计） */
  postflopPassive: number;
  /** 看到翻牌后打到摊牌的手数（WTSD 分子） */
  showdowns: number;
  /** 看到翻牌的手数（WTSD 分母；翻前未弃牌且本手进入翻牌圈） */
  showdownsSeenFlop: number;
  /** 各翻前位置桶的样本数（该座位在各桶位置出手的手数） */
  pfBucketHands: PreflopBucketCounts;
  /** 各翻前位置桶的 VPIP 分子 */
  pfBucketVpip: PreflopBucketCounts;
  /** 各翻前位置桶的 PFR 分子 */
  pfBucketPfr: PreflopBucketCounts;
}

/** 对手打法分类（unknown = 样本不足） */
export type OpponentClass =
  | "nit"
  | "tag"
  | "lag"
  | "maniac"
  | "calling_station"
  | "unknown";

/** 单个座位的对手画像：原始统计 + 衍生指标 + 分类与置信度 */
export interface OpponentModel {
  /** 座位号（与 DecideInput.state.players 的 seat 对齐） */
  seat: Seat;
  /** 原始计数（桌面座位维度） */
  stats: OpponentStats;
  /** 自愿入池率 0-1 */
  vpip: number;
  /** 翻前加注率 0-1 */
  pfr: number;
  /** 翻后 aggression factor = 进攻次数 / max(1, 被动次数) */
  af: number;
  /** 摊牌率 0-1（看到翻牌后打到摊牌的比例；未见过翻牌为 0） */
  wtsd: number;
  /** 打法分类（总体口径；brain 在 adaptPositionalEnabled 时按桶校正后重分类） */
  cls: OpponentClass;
  /** 分类置信度 0-1（有效样本 <10 手为 0；10 手 0.3 线性升到 40 手 1.0） */
  confidence: number;
  /** 分桶 VPIP（null = 该桶无样本）；供 prompt 位置拆分展示 */
  bucketVpip?: { early: number | null; middle: number | null; late: number | null };
}

// ---------------------------------------------------------------------------
// LLM 配置
// ---------------------------------------------------------------------------

/**
 * 思考程度档位，对应 OpenAI 兼容协议的 reasoning_effort 字段。
 * 仅推理型模型（GPT-5、o 系列、DeepSeek V4 思考模式等）识别；普通对话模型会忽略。
 * "max" 是 DeepSeek V4 特有的最高档（OpenAI 系不认识会报错/忽略）。
 * DeepSeek 映射：minimal/low→low、medium/high/xhigh→high、max→max。
 */
export type ReasoningEffort = "low" | "medium" | "high" | "max";

/**
 * OpenAI 兼容协议的 LLM 配置。
 * baseUrl 为空时服务端默认 https://api.openai.com/v1。
 *
 * 可选字段（temperature/reasoningEffort/maxTokens）为 undefined 时，
 * 代理路由不会把对应字段发给上游，避免不兼容的提供商因未知参数报错。
 */
export interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 采样温度，可选；不传则由服务端/模型默认 */
  temperature?: number;
  /**
   * 思考程度（reasoning_effort），可选。越高推理越充分，但延迟与费用越高。
   * 兼容性注意：只有推理型模型认识该字段；部分提供商会静默忽略未知字段，
   * 部分提供商会直接返回 400 错误——是否可用由用户依据所用服务自行判断。
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * 输出 token 上限（max_tokens），可选。不设置时由模型/服务端默认。
   * 兼容性注意同上：部分提供商不认识该字段会忽略或报错，由用户自行判断。
   * 思考模式下推理过程产生的 token 也计入该上限（DeepSeek/OpenAI 推理模型均如此）。
   */
  maxTokens?: number;
  /**
   * 思考模式开关（DeepSeek V4 的 `thinking: {type: "enabled"|"disabled"}`），可选。
   * undefined = 不发送该字段，由服务商决定（DeepSeek 默认开启且 effort=high）。
   * 注意：思考模式下 DeepSeek 不支持 temperature/presence_penalty/frequency_penalty
   * （传入不报错但不生效）。非 DeepSeek 提供商可能不认识该字段。
   */
  thinkingEnabled?: boolean;
  /**
   * 强制 JSON 输出（OpenAI 兼容协议的 `response_format: {type:"json_object"}`），可选。
   * DeepSeek / OpenAI / Moonshot 均支持；我们的决策与复盘 prompt 都要求 JSON，
   * 开启后可显著降低解析失败率。不支持的提供商可能报错，遇错关闭即可。
   */
  jsonOutput?: boolean;
  /**
   * 上下文携带量：对局中发给 LLM 的「最近 N 手牌回顾」条数（0-20），可选。
   * undefined/0 = 不携带（每次决策只看当前手牌）；越大 AI 越能利用近期动态
   * （如"你上两手都在翻前弃牌"），代价是 prompt 更长、更慢更贵。
   * 注意：这不是模型的上下文窗口（窗口是模型固有属性，如 DeepSeek V4 = 1M）。
   * 仅在 promptStyle = "full" 时注入（slim 模式零注入，经大样本验证更强）。
   */
  contextHands?: number;
  /**
   * LLM 决策 prompt 风格，可选（默认 slim）。
   * "slim"：零注入（局面事实 + 合法动作 + 人设 + JSON 协议）——经 LLM 变体
   *   大战验证为唯一稳定盈利版本（胜率注入会诱发机械阈值决策）；
   * "full"：完整版（策略常识 + 胜率数据 + 对手画像 + 近期回顾），保留作对照。
   */
  promptStyle?: "slim" | "full";
  /**
   * 大底池 self-consistency 投票开关，可选（undefined = 开）。
   * 开启后，LLM 模式下当底池 ≥ 25bb 或处于河牌街时，opponent.decide 并行采样
   * 3 次（8/15/25s 超时窗口），对解析出的动作做多数投票（平票按
   * fold<check<call<bet<raise<allin 保守序取更保守者，bet/raise 金额取中位数），
   * 3 次全部失败才回退启发式。false = 单次采样旧行为。
   */
  selfVote?: boolean;
}

/** chatCompletion 的消息格式（OpenAI 兼容） */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// 赛后分析结果
// ---------------------------------------------------------------------------

/** 单个街道的点评评级 */
export type StreetRating = "good" | "ok" | "mistake";

/** 单个街道的点评 */
export interface StreetAnalysis {
  street: Street;
  rating: StreetRating;
  /** 逐条点评文字（中文），可多条 */
  comments: string[];
}

/** 一手牌的完整分析结果（由分析模块产出，展示给用户） */
export interface AnalysisResult {
  /** 逐街点评（只包含实际进行到的街道） */
  streets: StreetAnalysis[];
  /** 总体评价文字 */
  overall: string;
  /** 综合评分 0-100（越高越好） */
  score: number;
}

// ---------------------------------------------------------------------------
// AI 决策输入/输出
// ---------------------------------------------------------------------------

/** 锦标赛阶段：early 早期 / middle 中期 / bubble 泡沫期 / final 终局（决赛） */
export type TournamentPhase = "early" | "middle" | "bubble" | "final";

/**
 * 锦标赛上下文快照（轻量 ICM 风格调整的输入；现金局决策不携带）。
 *
 * 由调局模块（gameStore）/ 自对战台架（match.ts）在构造 DecideInput 时组装；
 * brain.ts 仅在 tournament 存在且 icmEnabled 时做阈值修正，prompt.ts 渲染事实段。
 */
export interface TournamentContext {
  /** 尚未淘汰的玩家数（含自己） */
  playersRemaining: number;
  /** 开赛总人数 */
  totalPlayers: number;
  /** 自己的筹码排名（1 = 筹码领先；按未淘汰者筹码降序，并列按严格大于计数） */
  myRankByChips: number;
  /** 未淘汰者平均筹码（大盲倍数） */
  avgStackBB: number;
  /** 自己的筹码（大盲倍数） */
  myStackBB: number;
  /** 当前级别大盲额度（与 state.bigBlind 一致） */
  blindLevelBB: number;
  /** 锦标赛阶段（见 computeTournamentPhase） */
  phase: TournamentPhase;
}

/**
 * 锦标赛阶段划分——简化模型，非真 ICM：
 * 只按「剩余人数 / 开赛人数」比例划分，不考虑奖金结构、 payout 跳跃与筹码分布。
 *   remaining/total > 0.6 → early；> 0.35 → middle；> 0.2 → bubble；否则 final。
 */
export function computeTournamentPhase(
  playersRemaining: number,
  totalPlayers: number,
): TournamentPhase {
  const ratio = totalPlayers > 0 ? playersRemaining / totalPlayers : 0;
  if (ratio > 0.6) return "early";
  if (ratio > 0.35) return "middle";
  if (ratio > 0.2) return "bubble";
  return "final";
}

/**
 * AI 决策输入快照。
 * 由引擎层在轮到 AI 行动时构造；state 中其他玩家的底牌必须置 null（信息隐藏）。
 */
export interface DecideInput {
  /** 游戏状态快照（AI 视角，对手底牌已隐藏） */
  state: GameState;
  /** 当前合法动作集（legalActions() 的输出，含金额边界） */
  legalActions: PlayerAction[];
  /** 跟注需要补的筹码数（check 时为 0） */
  callAmount: number;
  /**
   * 底池赔率 = callAmount / (pot + callAmount)，0-1；
   * 无需跟注时为 0。
   */
  potOdds: number;
  /** AI 本手使用的具体风格 */
  style: ConcreteAIStyle;
  /**
   * 在局其他座位（含 hero）的对手画像，由 store 用跨手累积统计建模。
   * 缺省/空数组时决策引擎按零修正处理（行为与无建模完全一致）。
   */
  opponentModels?: OpponentModel[];
  /**
   * 最近若干手牌的一句话回顾（最新在前），由 store 按 LLMConfig.contextHands 截断注入。
   * 供 LLM 路径利用近期动态；启发式引擎忽略该字段。
   */
  recentHands?: string[];
  /**
   * 锦标赛上下文（仅锦标赛模式注入；现金局缺省）。
   * brain.ts 的 icm* 旋钮据此做轻量 ICM 风格阈值修正；prompt.ts 渲染事实段。
   */
  tournament?: TournamentContext;
}

/** AI 决策输出 */
export interface DecideResult {
  /** 选择的动作（必须属于 legalActions 之一，金额须在合法范围内） */
  action: PlayerAction;
  /** 思考说明（简短中文，展示给用户用于教学） */
  reasoning: string;
  /** 决策来源：'llm' 表示大模型产出，'heuristic' 表示本地启发式兜底 */
  source: "llm" | "heuristic";
}

// ---------------------------------------------------------------------------
// 整场复盘（Session 级 AI 教练报告）
// ---------------------------------------------------------------------------

/**
 * 一场对局（最近 N 手牌）的 AI 教练整场复盘报告。
 * 由 historyStore.analyzeSession 产出，存 localStorage（pokergto_session_reports，
 * 最多保留 5 份），在 /stats 页展示。
 */
export interface SessionReport {
  /** 报告生成的 Unix 毫秒时间戳 */
  createdAt: number;
  /** 本场纳入分析的手数 */
  handsAnalyzed: number;
  /** 教练总结的强项（每条一句话，需有数据或样本支撑） */
  strengths: string[];
  /**
   * 系统性漏洞，按严重程度排序：
   * title 一句话概括；detail 含改进建议与证据引用（样本手编号或统计指标）。
   */
  leaks: { title: string; detail: string }[];
  /** 练习优先级排序（最优先在前） */
  priorities: string[];
  /** 整场综合评分 0-100（越高越好） */
  score: number;
}
