/**
 * 测试夹具：构造 AI 视角的 DecideInput。
 * 默认 2 人桌（AI 固定 seat 1，hero seat 0 底牌置 null）；
 * 通过 playerCount / aiSeat / buttonSeat / ante / opponentOverrides 可构造多人场景。
 */
import type {
  Card,
  ConcreteAIStyle,
  DecideInput,
  GameState,
  PlayerAction,
  PlayerState,
  Seat,
  Street,
} from "@/lib/types";

export function makePlayer(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    seat: 1,
    holeCards: null,
    stack: 100,
    streetBet: 0,
    handBet: 0,
    folded: false,
    allIn: false,
    hasActed: false,
    eliminated: false,
    ...overrides,
  };
}

export interface ScenarioOptions {
  aiHole: [Card, Card] | null;
  /** 总玩家数（默认 2） */
  playerCount?: number;
  /** AI 所在座位（默认 1） */
  aiSeat?: Seat;
  /** 按钮位（默认 0） */
  buttonSeat?: Seat;
  /** 每人前注（默认 0） */
  ante?: number;
  /** 对非 AI 座位的状态覆盖（如 folded / stack / streetBet / eliminated） */
  opponentOverrides?: Record<number, Partial<PlayerState>>;
  board?: Card[];
  street?: Street;
  pot?: number;
  currentBet?: number;
  aiStreetBet?: number;
  aiStack?: number;
  callAmount?: number;
  legalActions: PlayerAction[];
  style?: ConcreteAIStyle;
}

export function makeDecideInput(opts: ScenarioOptions): DecideInput {
  const playerCount = opts.playerCount ?? 2;
  const aiSeat = opts.aiSeat ?? 1;
  const players: PlayerState[] = [];
  for (let seat = 0; seat < playerCount; seat++) {
    if (seat === aiSeat) {
      players.push(
        makePlayer({
          seat,
          holeCards: opts.aiHole,
          streetBet: opts.aiStreetBet ?? 0,
          stack: opts.aiStack ?? 100,
          handBet: opts.aiStreetBet ?? 0,
        }),
      );
    } else {
      players.push(
        makePlayer({ seat, ...(opts.opponentOverrides?.[seat] ?? {}) }),
      );
    }
  }
  const state: GameState = {
    deck: [],
    players,
    board: opts.board ?? [],
    pot: opts.pot ?? 0,
    street: opts.street ?? "preflop",
    currentSeat: aiSeat,
    buttonSeat: opts.buttonSeat ?? 0,
    smallBlind: 5,
    bigBlind: 10,
    ante: opts.ante ?? 0,
    minRaise: 10,
    currentBet: opts.currentBet ?? 0,
    streetActions: [],
    handNumber: 1,
    handOver: false,
    winners: null,
    showdown: false,
  };
  const callAmount = opts.callAmount ?? 0;
  const pot = opts.pot ?? 0;
  return {
    state,
    legalActions: opts.legalActions,
    callAmount,
    potOdds: callAmount > 0 ? callAmount / (pot + callAmount) : 0,
    style: opts.style ?? "gto",
  };
}

/** 断言决策结果动作合法（类型在合法集内、金额在合法区间） */
export function assertLegal(result: PlayerAction, input: DecideInput): void {
  const types = new Set(input.legalActions.map((a) => a.type));
  if (!types.has(result.type)) {
    throw new Error(`illegal action type: ${result.type}`);
  }
  const entry = input.legalActions.find((a) => a.type === result.type)!;
  const allin = input.legalActions.find((a) => a.type === "allin");
  const seat = input.state.currentSeat ?? 1;
  const me = input.state.players[seat];
  const maxTo = allin?.amount ?? me.streetBet + me.stack;
  switch (result.type) {
    case "fold":
    case "check":
      if (result.amount !== 0) throw new Error(`${result.type} amount must be 0`);
      break;
    case "call":
      if (result.amount !== entry.amount)
        throw new Error(`call amount ${result.amount} !== legal ${entry.amount}`);
      break;
    case "allin":
      if (result.amount !== entry.amount)
        throw new Error(`allin amount ${result.amount} !== legal ${entry.amount}`);
      break;
    case "bet":
    case "raise":
      if (result.amount < entry.amount || result.amount > Math.max(entry.amount, maxTo))
        throw new Error(
          `${result.type} amount ${result.amount} out of [${entry.amount}, ${Math.max(entry.amount, maxTo)}]`,
        );
      break;
  }
}
