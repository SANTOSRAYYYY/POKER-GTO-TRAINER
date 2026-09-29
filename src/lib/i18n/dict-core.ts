/**
 * 全站文案字典：key（'domain.subKey'）→ { zh, en }。
 * 插值占位符：{name}。新增文案必须双语登记，t() 缺 key 时原样回显 key。
 */

export const DICT = {
  // ---- 导航 ----
  "nav.home": { zh: "大厅", en: "Lobby" },
  "nav.play": { zh: "对战", en: "Play" },
  "nav.history": { zh: "历史", en: "History" },
  "nav.ranges": { zh: "范围", en: "Ranges" },
  "nav.equity": { zh: "胜率", en: "Equity" },
  "nav.stats": { zh: "数据", en: "Stats" },
  "nav.trainer": { zh: "训练", en: "Trainer" },
  "nav.settings": { zh: "设置", en: "Settings" },
  "nav.langToggle": { zh: "EN", en: "中文" },

  // ---- 通用 ----
  "common.loading": { zh: "加载中…", en: "Loading…" },
  "common.delete": { zh: "删除", en: "Delete" },
  "common.retry": { zh: "重试", en: "Retry" },
  "common.confirm": { zh: "确认", en: "Confirm" },
  "common.cancel": { zh: "取消", en: "Cancel" },
  "common.save": { zh: "保存", en: "Save" },
  "common.back": { zh: "返回", en: "Back" },
  "common.you": { zh: "你", en: "You" },
  "common.pot": { zh: "底池", en: "Pot" },
  "common.stack": { zh: "筹码", en: "Stack" },
  "common.bb": { zh: "大盲", en: "BB" },
  "common.sb": { zh: "小盲", en: "SB" },
  "common.ante": { zh: "前注", en: "Ante" },
  "common.styleUnknown": { zh: "风格 ?", en: "Style ?" },

  // ---- 牌桌/动作 ----
  "action.fold": { zh: "弃牌", en: "Fold" },
  "action.check": { zh: "过牌", en: "Check" },
  "action.call": { zh: "跟注", en: "Call" },
  "action.bet": { zh: "下注", en: "Bet" },
  "action.raise": { zh: "加注", en: "Raise" },
  "action.allin": { zh: "全下", en: "All-in" },
  "action.callAmount": { zh: "跟注 {n}", en: "Call {n}" },
  "action.allInCallAmount": { zh: "全下跟注 {n}", en: "All-in Call {n}" },
  "action.preFold": { zh: "提前弃牌", en: "Pre-fold" },
  "action.preCheck": { zh: "提前过牌", en: "Pre-check" },
  "action.preCall": { zh: "提前跟注", en: "Pre-call" },
  "action.confirmBet": { zh: "确认", en: "OK" },
  "action.nextHand": { zh: "立即下一手 ▶", en: "Next hand ▶" },
  "action.thinking": { zh: "思考中", en: "Thinking" },

  // ---- 街道 ----
  "street.preflop": { zh: "翻前", en: "Preflop" },
  "street.flop": { zh: "翻牌圈", en: "Flop" },
  "street.turn": { zh: "转牌圈", en: "Turn" },
  "street.river": { zh: "河牌圈", en: "River" },
  "street.showdown": { zh: "摊牌", en: "Showdown" },
  "street.waitingBoard": { zh: "等待公共牌", en: "Waiting for board" },

  // ---- 手牌结果 ----
  "result.youWin": { zh: "你赢了这手牌", en: "You won the hand" },
  "result.youLose": { zh: "你输了这手牌", en: "You lost the hand" },
  "result.tie": { zh: "平分底池", en: "Split pot" },
  "result.winner": { zh: "赢家", en: "Winner" },
  "result.profit": { zh: "盈亏", en: "Profit" },
} as const;

export type DictKey = keyof typeof DICT;
