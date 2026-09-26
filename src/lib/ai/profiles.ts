/**
 * AI 风格档案模块
 *
 * 包含 6 种具体风格的完整档案：
 * - 供 UI 展示的 name / description
 * - 注入 LLM prompt 的 personaPrompt（人设扮演指令）
 * - 供启发式 bot 使用的数值参数 HEURISTIC_PARAMS（VPIP / 激进度 / 诈唬率）
 */
import type { AIProfile, AIStyle, ConcreteAIStyle } from "@/lib/types";

/** 启发式 bot 的风格参数（均为 0-1 的倾向值，越大越强） */
export interface HeuristicStyleParams {
  /** VPIP 倾向：自愿入池频率，越高越松（nit 极低，maniac 极高） */
  vpip: number;
  /** 激进度：倾向于下注/加注而非过牌/跟注 */
  aggression: number;
  /** 诈唬频率：在弱牌时假装强牌下注/加注的倾向 */
  bluffFreq: number;
}

export const AI_PROFILES: Record<ConcreteAIStyle, AIProfile> = {
  nit: {
    id: "nit",
    name: "紧弱岩石 Nit",
    description: "极度保守，只玩顶级起手牌，没有强牌绝不主动投入筹码。",
    personaPrompt:
      "你是一名极度保守的「紧弱」玩家（Nit）。你只玩前 10% 的顶级起手牌" +
      "（大对子、AK、AQ 这类牌），翻后没有拿到强成牌（顶对好踢脚以上）就绝不加注，" +
      "面对对手的加注倾向弃牌，几乎从不诈唬。宁可错过小底池，也绝不在边缘局面冒险。" +
      "你的弃牌是常态，出手必是强牌。",
  },
  tag: {
    id: "tag",
    name: "紧凶 TAG",
    description: "精挑细选起手牌，但入池后打得主动凶狠，是稳健赢家的打法。",
    personaPrompt:
      "你是一名「紧凶」玩家（TAG）。翻前选择性强，只玩前 20-25% 的优质起手牌，" +
      "但一旦入池就打得主动：倾向于自己下注/加注而不是过牌/跟注，" +
      "会用强牌做价值下注，偶尔在合适的牌面用听牌半诈唬。" +
      "你不恋战，牌力不够且对手表现强硬时会果断弃牌。",
  },
  lag: {
    id: "lag",
    name: "松凶 LAG",
    description: "入池范围宽，攻击性极强，频繁用位置和加注给对手制造难题。",
    personaPrompt:
      "你是一名「松凶」玩家（LAG）。你玩很多起手牌（前 35-40%），" +
      "入池后攻击性极强：频繁下注和加注，善用位置优势，" +
      "会在对手示弱时用各种牌（包括纯空气）抢底池，诈唬频率明显高于常人。" +
      "你喜欢给对手施压、制造困难决策，但不是无脑乱打——对手强力反击时你也能弃牌。",
  },
  maniac: {
    id: "maniac",
    name: "疯狂玩家 Maniac",
    description: "几乎每个底池都加注，不计后果地用下注压制对手，极度危险难缠。",
    personaPrompt:
      "你是一名「疯狂玩家」（Maniac）。你几乎每个底池都加注，" +
      "翻前翻后都疯狂下注，用持续的压力逼迫对手犯错。" +
      "你几乎不过牌、不跟注——要么加注要么全下，偶尔才弃牌。" +
      "你的下注 size 偏大，经常用弱牌甚至空气牌大举进攻。" +
      "你不在乎底池赔率，只在乎把对手逼到墙角。",
  },
  calling_station: {
    id: "calling_station",
    name: "跟注站 Calling Station",
    description: "什么牌都爱跟注看牌，几乎不主动加注，也几乎诈唬不走。",
    personaPrompt:
      "你是一名「跟注站」（Calling Station）。你好奇心重，" +
      "什么牌都想看到下一张公共牌、看到摊牌：面对下注你绝大多数时候选择跟注，" +
      "哪怕牌力很弱也舍不得弃牌。但你几乎从不主动下注或加注，" +
      "更不会诈唬——你的默认动作就是过牌和跟注。只有拿到坚果级强牌时你才会加注。",
  },
  gto: {
    id: "gto",
    name: "均衡机器 GTO",
    description: "按博弈论均衡打法的理论派，范围平衡、赔率精算，几乎无破绽。",
    personaPrompt:
      "你是一名按博弈论均衡（GTO）打法的理论玩家。你按范围而非单张底牌思考：" +
      "翻前按均衡范围入池，翻后根据底池赔率、胜率（equity）和范围优势做决策，" +
      "用混合策略保持平衡——同一手牌有时会下注、过牌或弃牌，让对手无法剥削。" +
      "你的诈唬和价值下注比例接近理论最优，下注 size 有明确逻辑。" +
      "你的决策冷静精确，不受情绪影响。",
  },
};

/** 各风格的启发式参数 */
export const HEURISTIC_PARAMS: Record<ConcreteAIStyle, HeuristicStyleParams> = {
  nit: { vpip: 0.12, aggression: 0.25, bluffFreq: 0.05 },
  tag: { vpip: 0.24, aggression: 0.7, bluffFreq: 0.2 },
  lag: { vpip: 0.4, aggression: 0.8, bluffFreq: 0.4 },
  maniac: { vpip: 0.65, aggression: 0.95, bluffFreq: 0.55 },
  calling_station: { vpip: 0.55, aggression: 0.12, bluffFreq: 0.03 },
  gto: { vpip: 0.3, aggression: 0.6, bluffFreq: 0.3 },
};

const CONCRETE_STYLES = Object.keys(AI_PROFILES) as ConcreteAIStyle[];

/**
 * 解析风格：传入具体风格原样返回；传入 'random' 时随机抽取一种具体风格返回。
 * 每手牌开始时调用一次，结果记入 HandRecord.aiStyle。
 * 注意：调用方负责保密，不要把抽取结果直接暴露给 hero。
 */
export function resolveStyle(style: AIStyle): ConcreteAIStyle {
  if (style !== "random") return style;
  const idx = Math.floor(Math.random() * CONCRETE_STYLES.length);
  return CONCRETE_STYLES[idx];
}

/**
 * 为一桌 AI 座位分配具体风格（N 人桌用）。
 * - mode 为具体风格：全员使用该风格；
 * - mode 为 'random'：洗牌式抽取——count ≤ 6 时从 6 种风格中无放回抽取（不重复）；
 *   count > 6 时先取一轮完整洗牌结果，剩余座位独立随机（允许重复）。
 * 结果按座位顺序返回；调用方负责保密，不要把分配结果暴露给 hero。
 */
export function assignStyles(
  count: number,
  mode: "random" | ConcreteAIStyle,
): ConcreteAIStyle[] {
  if (count <= 0) return [];
  if (mode !== "random") return Array.from({ length: count }, () => mode);

  // Fisher-Yates 洗牌，保证前 min(count, 6) 个互不重复
  const pool = [...CONCRETE_STYLES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const result: ConcreteAIStyle[] = [];
  for (let i = 0; i < count; i++) {
    result.push(
      i < pool.length
        ? pool[i]
        : CONCRETE_STYLES[Math.floor(Math.random() * CONCRETE_STYLES.length)],
    );
  }
  return result;
}
