/**
 * N 人无限注德州扑克游戏引擎（2-9 人桌）
 *
 * 引擎为纯函数：所有函数不修改入参，applyAction 返回全新 GameState。
 * GameState 字段语义见 src/lib/types.ts 的不变式注释。
 *
 * 规则要点（实现依据）：
 * - 座位与行动顺序：翻前从 UTG（大盲左邻第一个在局玩家）开始，翻后从按钮
 *   左邻第一个可行动玩家开始；定位统一用 nextActiveSeat / findNextActor。
 * - 单挑特例：2 人时按钮 = 小盲，UTG 即按钮（翻前按钮先行动，保持 v1 行为）。
 * - ante：全体模式每人先投 ante（计入 pot/handBet，是死钱，不计入
 *   streetBet/currentBet），再投盲注；BBA 模式（anteMode='bb'）仅大盲位
 *   替全桌投一份 ante（先投 ante 再投大盲）；筹码不足则全下。
 * - 下注轮结束条件：所有未弃牌且未全下的玩家都已行动且 streetBet 相等，
 *   或只剩一人未弃牌 / 全员 all-in。
 * - 最小加注：raise 的 amount（bet-to 语义）≥ currentBet + minRaise，
 *   且 ≤ 自身 streetBet + stack（超出即为 allin）。
 * - 短码 all-in（增量不足 minRaise）不重开下注轮：不更新 minRaise，且不重置
 *   其他玩家 hasActed；已行动过的玩家面对它只能跟注或弃牌（不能加注）。
 * - 结算：摊牌按 handBet 分层切边池（见 settleShowdown）；fold 获胜者收全池；
 *   结算后 pot 清零、底池计入胜者 stack。
 */
import type {
  Card,
  CreateGameConfig,
  GameState,
  PlayerAction,
  PlayerState,
  Seat,
} from "@/lib/types";
import { newDeck, shuffle } from "@/lib/poker/cards";
import { evaluate7 } from "@/lib/poker/evaluator";

export type { CreateGameConfig } from "@/lib/types";

/** 确定性发牌（测试用）：按“引擎实际 pop 顺序”给出牌堆前缀。 */
export interface RiggedDeckConfig extends CreateGameConfig {
  /**
   * 前 2*players+5 张即引擎依次 pop 的牌：
   * 从按钮位开始按座位顺序（button, button+1, …，环绕）每人底牌×2，
   * 然后翻牌×3、转牌、河牌。
   */
  deckPrefix: Card[];
}

/**
 * 从 from（不含）开始顺时针找下一个「在局」座位（未淘汰）。
 * 引擎与调局模块通用：按钮轮转、盲注/UTG 定位均以此为准。
 * 若 from 之后没有其他在局座位，但 from 自身在局，返回 from；全灭返回 null。
 */
export function nextActiveSeat(players: PlayerState[], from: Seat): Seat | null {
  const n = players.length;
  if (n === 0) return null;
  for (let i = 1; i <= n; i++) {
    const seat = (((from + i) % n) + n) % n;
    if (!players[seat].eliminated) return seat;
  }
  return null;
}

/**
 * 创建一手新牌局：洗牌、发底牌、投 ante 与盲注，
 * currentSeat 指向翻前先行动方（UTG；单挑时即按钮位）。
 * 内部使用 cards.newDeck() + shuffle()。
 * deckPrefix 仅供测试：注入确定性发牌顺序。
 */
export function createGame(
  config: CreateGameConfig | RiggedDeckConfig,
): GameState {
  const { players: playerCount, smallBlind, bigBlind, stack, buttonSeat } = config;
  const ante = config.ante ?? 0;
  const anteMode = config.anteMode === "bb" ? "bb" : "all";
  if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > 9) {
    throw new Error("玩家数必须是 2-9 的整数");
  }
  if (
    !Number.isInteger(smallBlind) || !Number.isInteger(bigBlind) ||
    smallBlind <= 0 || bigBlind <= 0
  ) {
    throw new Error("盲注必须为正整数");
  }
  if (smallBlind > bigBlind) {
    throw new Error("小盲不能大于大盲");
  }
  if (!Number.isInteger(ante) || ante < 0) {
    throw new Error("ante 必须是非负整数");
  }
  if (!Number.isInteger(stack) || stack < bigBlind) {
    throw new Error("初始筹码必须是不小于大盲的正整数");
  }
  if (!Number.isInteger(buttonSeat) || buttonSeat < 0 || buttonSeat >= playerCount) {
    throw new Error("buttonSeat 必须是合法座位号");
  }

  let deck = shuffle(newDeck());
  if ("deckPrefix" in config) {
    const prefix = config.deckPrefix;
    const prefixSet = new Set<string>(prefix);
    if (prefixSet.size !== prefix.length || prefix.length > 52) {
      throw new Error("deckPrefix 含重复牌或长度非法");
    }
    // pop 从数组末尾取牌：反转前缀使引擎按 deckPrefix 声明顺序发牌
    deck = [...deck.filter((c) => !prefixSet.has(c)), ...prefix.slice().reverse()];
  }

  const pop = (): Card => {
    const c = deck.pop();
    if (!c) throw new Error("牌堆已空");
    return c;
  };

  const players: PlayerState[] = [];
  for (let seat = 0; seat < playerCount; seat++) {
    players.push({
      seat,
      holeCards: null,
      stack,
      streetBet: 0,
      handBet: 0,
      folded: false,
      allIn: false,
      hasActed: false,
      eliminated: false,
    });
  }

  // 发牌：从按钮位开始按座位顺序每人 2 张（从牌堆末尾 pop）。
  for (let i = 0; i < playerCount; i++) {
    const seat = ((buttonSeat + i) % playerCount) as Seat;
    players[seat].holeCards = [pop(), pop()];
  }

  // 盲注座位：单挑时按钮=小盲；3 人及以上小盲=按钮左邻、大盲=小盲左邻。
  // 先于 ante 定位：BBA 模式只有大盲位投 ante。
  const sbSeat =
    playerCount === 2 ? buttonSeat : nextActiveSeat(players, buttonSeat)!;
  const bbSeat = nextActiveSeat(players, sbSeat)!;

  // ante：全体模式每人先投；BBA 模式仅大盲位替全桌投一份
  // （死钱，只计入 handBet/pot，不计入 streetBet）。
  if (ante > 0) {
    const anteSeats = anteMode === "bb" ? [players[bbSeat]] : players;
    for (const p of anteSeats) {
      const paid = Math.min(ante, p.stack);
      p.stack -= paid;
      p.handBet += paid;
      if (p.stack === 0) p.allIn = true;
    }
  }

  const postBlind = (seat: Seat, amount: number): void => {
    const p = players[seat];
    const paid = Math.min(amount, p.stack);
    p.stack -= paid;
    p.streetBet += paid;
    p.handBet += paid;
    if (p.stack === 0) p.allIn = true;
  };
  postBlind(sbSeat, smallBlind);
  postBlind(bbSeat, bigBlind);

  const pot = players.reduce((sum, p) => sum + p.handBet, 0);

  const state: GameState = {
    deck,
    players,
    board: [],
    pot,
    street: "preflop",
    currentSeat: null, // 下方按 UTG 定位
    buttonSeat,
    smallBlind,
    bigBlind,
    ante,
    anteMode: config.anteMode ?? "all",
    minRaise: bigBlind,
    currentBet: Math.max(...players.map((p) => p.streetBet)),
    streetActions: [],
    handNumber: 1,
    handOver: false,
    winners: null,
    showdown: false,
  };

  // 翻前起点 = UTG（大盲左邻；单挑时即按钮位，保持 v1 行为）。
  const utg = nextActiveSeat(players, bbSeat)!;
  const actor = findNextActor(state, utg);
  // 极端情形：盲注/ante 已让所有人全下，无人可行动，直接摊牌跑完公共牌。
  if (actor === null) {
    return settleShowdown(state);
  }
  state.currentSeat = actor;
  return state;
}

/** 轮到 seat 行动的充要条件（types.ts 不变式）。 */
function canAct(p: PlayerState, currentBet: number): boolean {
  return !p.folded && !p.allIn && (!p.hasActed || p.streetBet < currentBet);
}

/**
 * 从 from（含）开始顺时针找第一个可行动的玩家；无人可行动返回 null。
 */
function findNextActor(state: GameState, from: Seat): Seat | null {
  if (state.handOver) return null;
  const n = state.players.length;
  for (let i = 0; i < n; i++) {
    const seat = ((from + i) % n) as Seat;
    if (canAct(state.players[seat], state.currentBet)) return seat;
  }
  return null;
}

/**
 * 计算当前行动方的合法动作集。
 * 返回的 bet/raise/allin 动作 amount 语义为 bet-to 总额（见 types.ts PlayerAction）。
 * 边界表达约定：对 bet/raise，返回该类型允许的代表值（最小额），
 * 调用方可在 [最小额, 全下额] 区间内自行选择金额后再 applyAction；
 * 无法行动（handOver / 全员 allIn）时返回空数组。
 */
export function legalActions(state: GameState): PlayerAction[] {
  const seat = state.currentSeat;
  if (seat === null || state.handOver) return [];
  const me = state.players[seat];
  if (!canAct(me, state.currentBet)) return [];

  const toCall = state.currentBet - me.streetBet;
  const maxTotal = me.streetBet + me.stack; // 本街全下额（bet-to）
  const actions: PlayerAction[] = [];

  actions.push({ type: "fold", amount: 0 });

  if (state.currentBet === 0) {
    // 本街无人下注：可过牌或主动下注
    actions.push({ type: "check", amount: 0 });
    const minBet = Math.min(state.bigBlind, maxTotal);
    if (minBet < maxTotal) {
      actions.push({ type: "bet", amount: minBet });
      actions.push({ type: "allin", amount: maxTotal });
    } else {
      // 筹码不足以做最小 bet：只能全下
      actions.push({ type: "allin", amount: maxTotal });
    }
    return actions;
  }

  // 本街已有下注：先处理“跟齐”选项
  if (toCall === 0) {
    actions.push({ type: "check", amount: 0 });
  } else if (toCall >= me.stack) {
    // 跟注即全下（或筹码仍不够跟齐）
    actions.push({ type: "call", amount: me.stack });
    return actions; // 筹码封顶，不存在加注空间
  } else {
    actions.push({ type: "call", amount: toCall });
    // 已行动过却又面临未跟齐下注，说明之后只出现过 short all-in
    // （完整加注会重置 hasActed）：下注轮未重开，只能跟注或弃牌。
    if (me.hasActed) return actions;
  }

  // 加注空间（此时 maxTotal > currentBet）
  const minRaiseTotal = state.currentBet + state.minRaise;
  if (minRaiseTotal < maxTotal) {
    actions.push({ type: "raise", amount: minRaiseTotal });
  }
  // 全下总是可选（不足最小加注时为 short all-in，不重开下注轮）
  actions.push({ type: "allin", amount: maxTotal });

  return actions;
}

/** 深拷贝一个可安全修改的 GameState（全部为可序列化纯数据）。 */
function cloneState(state: GameState): GameState {
  return {
    ...state,
    deck: state.deck.slice(),
    board: state.board.slice(),
    streetActions: state.streetActions.map((a) => ({
      seat: a.seat,
      action: { ...a.action },
    })),
    players: state.players.map((p) => ({ ...p })),
  };
}

/** 发放公共牌到目标张数（flop 3 / turn 4 / river 5）。 */
function dealBoard(state: GameState, target: number): void {
  while (state.board.length < target) {
    const c = state.deck.pop();
    if (!c) throw new Error("牌堆不足以发出公共牌");
    state.board.push(c);
  }
}

/**
 * 距按钮左邻的位置距离：0 = 按钮左邻（翻后最先行动），越大越靠后。
 * 用于平分底池时余数筹码的确定性分配。
 */
function buttonDistance(seat: Seat, buttonSeat: Seat, n: number): number {
  return (((seat - buttonSeat - 1) % n) + n) % n;
}

/**
 * 摊牌结算：补满 5 张公共牌，按 handBet 分层切边池，逐层比牌分配。
 *
 * 边池算法：
 * 1. 把所有玩家的 handBet 去重升序得到投注层级 L1 < L2 < …；
 *    第 i 层由所有 handBet ≥ Li 的玩家（含已弃牌者的死钱）各出 (Li - L_{i-1})，
 *    该层只由「未弃牌且 handBet ≥ Li」的玩家（eligible）比牌分配。
 *    投入超出所有人的最高层只有一人 eligible，等价于把超额部分退还本人；
 *    这种单人退还层不影响 winners（不算“获胜”）。
 * 2. 每层奖金在胜者间平分；除不尽的余数筹码按「距按钮左邻最近者优先」
 *    的顺序每人多发 1（确定性规则）。
 *
 * 导出供调局层（gameStore）处理「开局即全员全下」的强制跑马：盲注/ante
 * 超过所有在局玩家筹码时按真实规则全员 all-in 直接摊牌，与 createGame 的
 * actor === null 分支同一路径（不另起平行结算实现）。
 */
export function settleShowdown(state: GameState): GameState {
  const s = cloneState(state);
  dealBoard(s, 5);
  const n = s.players.length;

  const scores = s.players.map((p) =>
    evaluate7([...p.holeCards!, ...s.board]),
  );

  const levels = [...new Set(s.players.map((p) => p.handBet))]
    .filter((v) => v > 0)
    .sort((a, b) => a - b);

  const winnerSet = new Set<Seat>();
  let prev = 0;
  for (const level of levels) {
    const contributors = s.players.filter((p) => p.handBet >= level);
    const layerPot = (level - prev) * contributors.length;
    prev = level;
    if (layerPot === 0) continue;

    const eligible = contributors.filter((p) => !p.folded);
    // eligible 必然非空：至少投入最高层的那位玩家自己参与该层。
    let best = -1;
    for (const p of eligible) {
      if (scores[p.seat] > best) best = scores[p.seat];
    }
    const layerWinners = eligible
      .filter((p) => scores[p.seat] === best)
      .sort(
        (a, b) =>
          buttonDistance(a.seat, s.buttonSeat, n) -
          buttonDistance(b.seat, s.buttonSeat, n),
      );
    const share = Math.floor(layerPot / layerWinners.length);
    // 余数筹码：按 buttonDistance 升序，靠前的胜者每人 +1，直到发完。
    let remainder = layerPot - share * layerWinners.length;
    for (const p of layerWinners) {
      const odd = remainder > 0 ? 1 : 0;
      p.stack += share + odd;
      remainder -= odd;
    }
    // 单人退还层（只有一名 contributors）不算获胜，不标记 winners
    if (contributors.length > 1) {
      for (const p of layerWinners) winnerSet.add(p.seat);
    }
  }

  s.pot = 0;
  s.winners = [...winnerSet].sort((a, b) => a - b);
  s.street = "showdown";
  s.currentSeat = null;
  s.handOver = true;
  s.showdown = true;
  return s;
}

/** 只剩一人未弃牌后的结算：底池归该玩家，不公开底牌；street 保留在弃牌发生的街道。 */
function settleFold(state: GameState, winnerSeat: Seat): GameState {
  const s = cloneState(state);
  s.players[winnerSeat].stack += s.pot;
  s.pot = 0;
  s.winners = [winnerSeat];
  s.currentSeat = null;
  s.handOver = true;
  s.showdown = false;
  return s;
}

/** 推进到下一街道（发牌、重置本街下注状态、决定先行动方）。 */
function advanceStreet(state: GameState): GameState {
  const s = cloneState(state);
  const nextBoardCount =
    s.street === "preflop" ? 3 : s.street === "flop" ? 4 : 5;
  s.street =
    s.street === "preflop" ? "flop" : s.street === "flop" ? "turn" : "river";
  dealBoard(s, nextBoardCount);
  for (const p of s.players) {
    p.streetBet = 0;
    p.hasActed = false;
  }
  s.currentBet = 0;
  s.minRaise = s.bigBlind;
  s.streetActions = [];

  // 可继续下注的玩家（未弃牌且未全下）不足两人时不再产生下注轮：
  // 直接摊牌跑完剩余公共牌。
  const contenders = s.players.filter((p) => !p.folded && !p.allIn);
  if (contenders.length <= 1) {
    return settleShowdown(s);
  }

  // 翻后从按钮左邻第一个可行动玩家开始
  const firstFrom = nextActiveSeat(s.players, s.buttonSeat)!;
  const actor = findNextActor(s, firstFrom);
  if (actor === null) {
    return settleShowdown(s);
  }
  s.currentSeat = actor;
  return s;
}

/**
 * 应用一个动作，返回新的 GameState（纯函数，不改入参）。
 * 负责：筹码转移、currentBet/minRaise 更新、hasActed/folded/allIn 标记、
 * 下注轮结束自动推进街道（发公共牌、重置 streetBet/streetActions）、
 * 终局结算（fold 获胜或摊牌按边池分配）、winners/handOver/showdown 置位。
 * @throws Error 动作不合法（类型不允许或金额越界）。
 */
export function applyAction(state: GameState, action: PlayerAction): GameState {
  if (state.handOver || state.currentSeat === null) {
    throw new Error("本手牌已结束，无法再行动");
  }
  const seat = state.currentSeat;
  const s = cloneState(state);
  const me = s.players[seat];
  if (!canAct(me, s.currentBet)) {
    throw new Error("当前玩家无行动权");
  }

  const toCall = s.currentBet - me.streetBet;
  const maxTotal = me.streetBet + me.stack;

  const invalid = (msg: string): never => {
    throw new Error(`非法动作(${action.type}): ${msg}`);
  };

  switch (action.type) {
    case "fold": {
      if (action.amount !== 0) invalid("fold 的 amount 必须为 0");
      me.folded = true;
      me.hasActed = true;
      break;
    }
    case "check": {
      if (action.amount !== 0) invalid("check 的 amount 必须为 0");
      if (toCall > 0) invalid("有未跟齐的下注，不能 check");
      me.hasActed = true;
      break;
    }
    case "call": {
      if (toCall === 0) invalid("无需跟注，应使用 check");
      const pay = Math.min(toCall, me.stack);
      if (action.amount !== pay) {
        invalid(`call 的 amount 应为需补增量 ${pay}，收到 ${action.amount}`);
      }
      me.stack -= pay;
      me.streetBet += pay;
      me.handBet += pay;
      if (me.stack === 0) me.allIn = true;
      me.hasActed = true;
      break;
    }
    case "bet":
    case "raise":
    case "allin": {
      const total = action.amount;
      if (!Number.isInteger(total) || total <= 0) {
        invalid("金额必须为正整数（bet-to 总额）");
      }
      if (total > maxTotal) {
        invalid(`金额超出自身筹码上限（最大可至 ${maxTotal}）`);
      }
      const isAllIn = total === maxTotal;

      if (action.type === "bet") {
        if (s.currentBet !== 0) invalid("本街已有下注，应使用 raise");
        const minBet = Math.min(s.bigBlind, maxTotal);
        if (total < minBet) invalid(`bet 至少为 ${minBet}`);
      } else if (action.type === "raise") {
        if (s.currentBet === 0) invalid("本街尚无下注，应使用 bet");
        if (toCall >= me.stack) invalid("筹码不足以加注");
        const minTotal = s.currentBet + s.minRaise;
        // raise 到自身上限等价于 all-in，予以接受（调用方无需换算类型）
        if (!isAllIn && total < minTotal) invalid(`raise 至少为 ${minTotal}`);
      } else {
        // allin：必须恰好是全部剩余（bet-to = streetBet + stack）
        if (!isAllIn) {
          invalid(`allin 必须全下（本街总额 ${maxTotal}），收到 ${total}`);
        }
      }
      // 已行动过的玩家面对未跟齐下注时，下注轮必然未被重开
      // （完整加注会重置其 hasActed）：此时只允许跟注/弃牌，
      // 任何超过 currentBet 的投入都视为加注，予以拒绝。
      if (me.hasActed && total > s.currentBet) {
        invalid("下注轮未被重开（short all-in），已行动过的玩家不能再加注");
      }

      // 增量是否构成一次“完整加注”（足以重开下注轮、更新 minRaise）
      const raiseIncrement = total - s.currentBet;
      const fullRaise =
        s.currentBet === 0
          ? total >= Math.min(s.bigBlind, maxTotal)
          : raiseIncrement >= s.minRaise;

      const pay = total - me.streetBet;
      me.stack -= pay;
      me.streetBet = total;
      me.handBet += pay;
      if (me.stack === 0) me.allIn = true;

      if (fullRaise) {
        // 完整加注/下注：其他未弃牌且未全下的玩家需要重新行动
        if (s.currentBet === 0) {
          s.minRaise = s.bigBlind;
        } else {
          s.minRaise = raiseIncrement;
        }
        for (const p of s.players) {
          if (p.seat !== seat && !p.folded && !p.allIn) p.hasActed = false;
        }
      }
      // 非完整加注的 allin（short all-in）：不改变 minRaise，也不重开下注轮
      if (me.streetBet > s.currentBet) s.currentBet = me.streetBet;
      me.hasActed = true;
      break;
    }
    default:
      invalid(`未知动作类型 ${(action as PlayerAction).type}`);
  }

  s.streetActions.push({ seat, action: { ...action } });
  s.pot = s.players.reduce((sum, p) => sum + p.handBet, 0);

  // ---- 终局/推进判定 ----
  const inHand = s.players.filter((p) => !p.folded);
  if (inHand.length === 1) {
    return settleFold(s, inHand[0].seat);
  }

  const contenders = inHand.filter((p) => !p.allIn);
  // 全员 all-in：直接摊牌跑完剩余公共牌
  if (contenders.length === 0) {
    return settleShowdown(s);
  }

  const roundClosed = contenders.every(
    (p) => p.hasActed && p.streetBet === s.currentBet,
  );
  if (roundClosed) {
    if (s.street === "river") {
      return settleShowdown(s);
    }
    return advanceStreet(s);
  }

  // 轮到当前行动方之后最近的可行动者
  const next = findNextActor(s, (seat + 1) % s.players.length);
  if (next === null) {
    // 理论上不可达（roundClosed 为假时必存在可行动者）；兜底直接摊牌。
    return settleShowdown(s);
  }
  s.currentSeat = next;
  return s;
}
