/**
 * 页面域字典（lobby./history./stats./settings./trainer./ranges./equity./ref./nb./achieve. 前缀）——由页面组维护。
 * zh 文案与原硬编码逐字一致（e2e 依赖），en 用标准扑克/产品术语。
 */
export const PAGES_DICT = {
  // ================= 大厅（src/app/page.tsx） =================
  "lobby.title": { zh: "训练器", en: "Trainer" },
  "lobby.tagline": {
    zh: "2-9 人桌无限注德州扑克 · 现金局与锦标赛 SNG · 与不同风格的 AI 对战并复盘提升",
    en: "2-9 player No-Limit Texas Hold'em · Cash games & SNG tournaments · Play against AI opponents of different styles and review to improve",
  },
  "lobby.recentStats": { zh: "最近战绩", en: "Recent results" },
  "lobby.statsLoading": { zh: "战绩加载中…", en: "Loading stats…" },
  "lobby.noHands": {
    zh: "还没有对局记录，去打第一手牌吧。",
    en: "No hands recorded yet — go play your first hand.",
  },
  "lobby.totalHands": { zh: "总手数", en: "Hands" },
  "lobby.totalProfit": { zh: "总盈亏", en: "Profit" },
  "lobby.winRate": { zh: "胜率", en: "Win rate" },
  "lobby.showdownRate": { zh: "摊牌率", en: "Showdown rate" },
  "lobby.resume.title": { zh: "返回当前对战", en: "Resume current game" },
  "lobby.resume.modeTournament": { zh: "锦标赛 SNG", en: "SNG Tournament" },
  "lobby.resume.modeCash": { zh: "现金局", en: "Cash game" },
  "lobby.resume.info": {
    zh: "{mode} · {seats} 人桌 · 已进行 {hands} 手 · 你的盈亏",
    en: "{mode} · {seats}-max · {hands} hands played · Your profit",
  },
  "lobby.resume.overwrite": {
    zh: "开始新局会覆盖当前对战",
    en: "Starting a new game will overwrite the current one",
  },
  "lobby.resume.cta": { zh: "回到牌桌 →", en: "Back to table →" },
  "lobby.quickPlay": { zh: "快速对战", en: "Quick play" },
  "lobby.mode": { zh: "模式", en: "Mode" },
  "lobby.mode.cash": { zh: "现金局", en: "Cash game" },
  "lobby.mode.cashDesc": {
    zh: "盲注固定，随时重进",
    en: "Fixed blinds, rejoin anytime",
  },
  "lobby.mode.tournament": { zh: "锦标赛 SNG", en: "SNG Tournament" },
  "lobby.mode.tournamentDesc": {
    zh: "升盲淘汰，决出冠军",
    en: "Rising blinds, last player standing wins",
  },
  "lobby.seats": { zh: "人数", en: "Players" },
  "lobby.seatsTable": { zh: "{n} 人桌", en: "{n}-max" },
  "lobby.headsUp": { zh: "（单挑）", en: " (HU)" },
  "lobby.aiStyle": { zh: "AI 风格", en: "AI style" },
  "lobby.style.random": { zh: "随机", en: "Random" },
  "lobby.style.nit": { zh: "紧弱 Nit", en: "Nit" },
  "lobby.style.tag": { zh: "紧凶 TAG", en: "TAG" },
  "lobby.style.lag": { zh: "松凶 LAG", en: "LAG" },
  "lobby.style.maniac": { zh: "疯子 Maniac", en: "Maniac" },
  "lobby.style.calling_station": { zh: "跟注站", en: "Calling station" },
  "lobby.style.gto": { zh: "GTO 均衡", en: "GTO" },
  "lobby.styleDesc.random": {
    zh: "每手随机抽取一种风格，对你保密，最接近真实牌桌",
    en: "A random style each hand, hidden from you — closest to a real table",
  },
  "lobby.styleDesc.nit": {
    zh: "只玩强牌，极少诈唬，被加注就弃牌",
    en: "Plays only strong hands, rarely bluffs, folds to raises",
  },
  "lobby.styleDesc.tag": {
    zh: "选牌紧、打法凶，稳定难缠的常规玩家",
    en: "Tight hand selection, aggressive lines — a solid, tough regular",
  },
  "lobby.styleDesc.lag": {
    zh: "大范围进攻，频繁下注加注施压",
    en: "Attacks with a wide range, constantly betting and raising",
  },
  "lobby.styleDesc.maniac": {
    zh: "疯狂加注与全下，波动极大，专治胆小",
    en: "Manic raises and shoves, huge variance, punishes the timid",
  },
  "lobby.styleDesc.calling_station": {
    zh: "几乎不弃牌，爱跟注看到摊牌",
    en: "Almost never folds — calls down to showdown",
  },
  "lobby.styleDesc.gto": {
    zh: "接近博弈论最优策略，最难被剥削",
    en: "Near game-theory-optimal strategy, hardest to exploit",
  },
  "lobby.sb": { zh: "小盲", en: "Small blind" },
  "lobby.bb": { zh: "大盲", en: "Big blind" },
  "lobby.buyin": { zh: "买入（筹码）", en: "Buy-in (chips)" },
  "lobby.cashHint": {
    zh: "默认盲注 1/2、买入 200（= 100bb）。买入会自动换算成大盲数。",
    en: "Defaults: blinds 1/2, buy-in 200 (= 100bb). The buy-in is converted to big blinds automatically.",
  },
  "lobby.tourney.structure": {
    zh: "起始筹码 {stack}，每 {hands} 手升一级盲注，共 {levels} 级；筹码清零即淘汰，最后幸存者为冠军。",
    en: "Starting stack {stack}; blinds go up every {hands} hands across {levels} levels. Bust out and you're eliminated — the last survivor wins.",
  },
  "lobby.tourney.handsPerLevel": {
    zh: "每 N 手升一级",
    en: "Hands per level",
  },
  "lobby.tourney.blindMode": { zh: "升盲", en: "Blind escalation" },
  "lobby.tourney.blindMode.limited": { zh: "限制级别", en: "Limited levels" },
  "lobby.tourney.blindMode.limitedDesc": {
    zh: "10 级升盲表打完即停在顶级盲注",
    en: "Blinds stop at the top of the 10-level table",
  },
  "lobby.tourney.blindMode.infinite": { zh: "无限升盲", en: "Infinite escalation" },
  "lobby.tourney.blindMode.infiniteDesc": {
    zh: "顶级后大盲继续翻倍不封顶（预生成至 40 级）",
    en: "Big blind keeps doubling past the top level, uncapped (pre-generated to level 40)",
  },
  "lobby.tourney.rebuyPeriod": {
    zh: "重购期级数（前 N 级）",
    en: "Rebuy period (first N levels)",
  },
  "lobby.rebuys.label": { zh: "每人可重购次数", en: "Rebuys per player" },
  "lobby.rebuys.none": { zh: "不可重购", en: "No rebuys" },
  "lobby.rebuys.times": { zh: "{n} 次", en: "{n}" },
  "lobby.rebuys.hintOn": {
    zh: "重购期内（前 {levels} 级）筹码归零可买回起始筹码，每人最多 {n} 次。",
    en: "During the rebuy period (first {levels} levels), busting lets you buy back the starting stack, up to {n} times per player.",
  },
  "lobby.rebuys.hintOff": {
    zh: "筹码清零即淘汰，不可重购。",
    en: "Bust out and you're eliminated. No rebuys.",
  },
  "lobby.start": { zh: "入座开战 →", en: "Take a seat →" },
  "lobby.entry.historyTitle": { zh: "手牌历史", en: "Hand history" },
  "lobby.entry.historyDesc": {
    zh: "复盘每一手牌，AI 教练逐街点评",
    en: "Review every hand with street-by-street AI coach comments",
  },
  "lobby.entry.historyCount": {
    zh: "（已记录 {n} 手）",
    en: " ({n} recorded)",
  },
  "lobby.entry.rangesTitle": { zh: "翻前范围表", en: "Preflop ranges" },
  "lobby.entry.rangesDesc": {
    zh: "9 人桌各位置开局范围 + 单挑按钮位/大盲攻防的 13×13 矩阵",
    en: "Opening ranges for every 9-max position plus heads-up BTN/BB battles, on 13×13 grids",
  },
  "lobby.entry.equityTitle": { zh: "胜率计算器", en: "Equity calculator" },
  "lobby.entry.equityDesc": {
    zh: "任意底牌与公共牌组合，蒙特卡洛模拟对 1-8 名对手的胜率",
    en: "Monte Carlo equity for any hole cards and board against 1-8 opponents",
  },
  "lobby.entry.settingsTitle": { zh: "设置", en: "Settings" },
  "lobby.entry.settingsDesc": {
    zh: "配置 LLM API Key / 模型 / 默认 AI 风格 / AI 决策引擎",
    en: "Configure LLM API key / model / default AI style / AI decision engine",
  },

  // ================= 历史列表与回放（src/app/history/**） =================
  "history.title": { zh: "手牌历史", en: "Hand history" },
  "history.statsCenter": { zh: "数据中心", en: "Stats" },
  "history.clearAll": { zh: "清空全部", en: "Clear all" },
  "history.confirmDelete": {
    zh: "删除这手牌记录？",
    en: "Delete this hand record?",
  },
  "history.confirmClear": {
    zh: "确定清空全部手牌历史与分析缓存？此操作不可恢复。",
    en: "Clear all hand history and cached analysis? This cannot be undone.",
  },
  "history.totalHands": { zh: "总手数", en: "Hands" },
  "history.totalProfit": { zh: "总盈亏", en: "Profit" },
  "history.winRate": { zh: "胜率", en: "Win rate" },
  "history.showdownRate": { zh: "摊牌率", en: "Showdown rate" },
  "history.empty": { zh: "暂无手牌记录", en: "No hands yet" },
  "history.emptyCta": {
    zh: "去大厅开始第一手 →",
    en: "Go to the lobby and play your first hand →",
  },
  "history.seatsBadge": { zh: "{n}人桌", en: "{n}-max" },
  "history.modeTournament": { zh: "锦标赛", en: "SNG" },
  "history.modeCash": { zh: "现金局", en: "Cash" },
  "history.unrevealed": { zh: "未公开", en: "unrevealed" },
  "history.win": { zh: "赢", en: "Won" },
  "history.lose": { zh: "输", en: "Lost" },
  "history.tie": { zh: "平", en: "Tied" },
  "history.replayTitle": { zh: "手牌回放", en: "Hand replay" },
  "history.backToList": { zh: "← 历史列表", en: "← Hand list" },
  "history.notFound": {
    zh: "未找到该手牌记录，可能已被删除。",
    en: "Hand not found — it may have been deleted.",
  },
  "history.notFoundBack": {
    zh: "← 返回历史列表",
    en: "← Back to hand list",
  },
  "history.blinds": { zh: "盲注 {sb}/{bb}", en: "Blinds {sb}/{bb}" },
  "history.anteSuffix": { zh: " · ante {n}", en: " · ante {n}" },
  "history.noBoard": {
    zh: "（翻前，无公共牌）",
    en: "(Preflop, no board cards)",
  },
  "history.seat": { zh: "座位 {n}", en: "Seat {n}" },
  "history.folded": { zh: "已弃牌", en: "Folded" },
  "history.finishPlace": { zh: "第 {n} 名", en: "#{n}" },
  "history.prevStep": { zh: "← 上一步", en: "← Prev" },
  "history.nextStep": { zh: "下一步 →", en: "Next →" },
  "history.stepOf": { zh: "第 {cur} / {total} 步", en: "Step {cur} / {total}" },
  "history.enterStreet": { zh: "进入【{street}】", en: "Entering [{street}]" },
  "history.streetActions": { zh: "{street}动作序列", en: "{street} actions" },
  "history.noActions": {
    zh: "本街无动作记录",
    en: "No actions recorded on this street",
  },
  "history.street.preflop": { zh: "翻前", en: "Preflop" },
  "history.street.flop": { zh: "翻牌", en: "Flop" },
  "history.street.turn": { zh: "转牌", en: "Turn" },
  "history.street.river": { zh: "河牌", en: "River" },
  "history.street.showdown": { zh: "摊牌", en: "Showdown" },
  "history.aiActor": { zh: "AI·{style}", en: "AI·{style}" },
  "history.actorWithSeat": {
    zh: "{who}（座位{seat}）",
    en: "{who} (Seat {seat})",
  },
  "history.act.fold": { zh: "{who} 弃牌", en: "{who} folds" },
  "history.act.check": { zh: "{who} 过牌", en: "{who} checks" },
  "history.act.call": { zh: "{who} 跟注 {amount}", en: "{who} calls {amount}" },
  "history.act.bet": { zh: "{who} 下注到 {amount}", en: "{who} bets {amount}" },
  "history.act.raise": {
    zh: "{who} 加注到 {amount}",
    en: "{who} raises to {amount}",
  },
  "history.act.allin": {
    zh: "{who} 全下到 {amount}",
    en: "{who} is all-in for {amount}",
  },
  "history.rating.good": { zh: "打得好", en: "Well played" },
  "history.rating.ok": { zh: "可接受", en: "Acceptable" },
  "history.rating.mistake": { zh: "错误", en: "Mistake" },
  "history.ai.title": { zh: "AI 教练分析", en: "AI coach analysis" },
  "history.ai.score": { zh: "{n} 分", en: "{n}" },
  "history.ai.intro": {
    zh: "让 LLM 教练逐街点评这手牌，指出错误并给出正确打法。分析结果会缓存，不会重复计费。",
    en: "Let the LLM coach review this hand street by street, point out mistakes and show the right lines. Results are cached — you won't be charged twice.",
  },
  "history.ai.analyzing": { zh: "分析中…", en: "Analyzing…" },
  "history.ai.reanalyze": { zh: "重新分析", en: "Re-analyze" },
  "history.ai.start": { zh: "开始 AI 分析", en: "Start AI analysis" },
  "history.ai.noApiKey": {
    zh: "尚未配置 LLM API Key，请先到「设置」页填写并保存后再分析。",
    en: "No LLM API key configured yet — go to Settings, fill it in and save, then analyze.",
  },
  "history.ai.failed": {
    zh: "分析失败，请稍后重试",
    en: "Analysis failed, please try again later",
  },
  "history.ai.rawError": { zh: "{msg}", en: "{msg}" },
  "history.ai.troubleshoot": { zh: "常见排查方向", en: "Common things to check" },
  "history.ai.ts1": {
    zh: "API Key 无效、已过期或未保存",
    en: "The API key is invalid, expired, or wasn't saved",
  },
  "history.ai.ts2": {
    zh: "账户余额不足或额度用尽",
    en: "Insufficient balance or quota on the account",
  },
  "history.ai.ts3": {
    zh: "Base URL 填错（需以 https:// 开头，例如 https://api.openai.com/v1）",
    en: "Wrong Base URL (must start with https://, e.g. https://api.openai.com/v1)",
  },
  "history.ai.ts4": {
    zh: "模型名拼写错误或该账号无此模型权限",
    en: "Model name is misspelled or the account has no access to it",
  },
  "history.ai.ts5": {
    zh: "上游服务超时或返回了非 JSON 内容（错误详情中可见上游原文）",
    en: "The upstream timed out or returned non-JSON content (see the raw reply in the error details)",
  },
  "history.ai.goSettings": { zh: "去设置 →", en: "Go to Settings →" },
  "history.ai.overall": { zh: "总体评价", en: "Overall" },

  // ================= 参考线徽章（src/components/history/ReferenceBadge.tsx） =================
  "ref.disclaimer": {
    zh: "启发式参考线，非 solver 精确解",
    en: "Heuristic reference line, not an exact solver solution",
  },
  "ref.badge": {
    zh: "参考：胜率 {pct}% · 倾向 {tendency}",
    en: "Ref: {pct}% equity · leans {tendency}",
  },
  "ref.marginal": { zh: "（边际）", en: " (marginal)" },
  "ref.computing": { zh: "计算中…", en: "Computing…" },
  "ref.button": { zh: "参考线", en: "Ref line" },
  "ref.buttonTitle": {
    zh: "{disclaimer}（点击查看该决策点的引擎参考）",
    en: "{disclaimer} (click to compute the engine reference for this decision)",
  },

  // ================= 数据中心（src/app/stats/**, src/components/stats/**） =================
  "stats.title": { zh: "个人数据中心", en: "My stats" },
  "stats.subtitle": {
    zh: "汇总全部历史手牌，追踪你的打法指标、盈亏走势与位置/风格表现",
    en: "All your recorded hands in one place: playing metrics, profit trend, and performance by position and opponent style",
  },
  "stats.empty": {
    zh: "暂无手牌记录，打完几手牌后这里会出现你的数据面板",
    en: "No hands recorded yet — play a few hands and your dashboard will appear here",
  },
  "stats.emptyCta": {
    zh: "去对战页开始第一手 →",
    en: "Go play your first hand →",
  },
  "stats.gameFilter": { zh: "局型", en: "Game type" },
  "stats.rangeFilter": { zh: "范围", en: "Range" },
  "stats.filter.all": { zh: "全部", en: "All" },
  "stats.filter.cash": { zh: "仅现金局", en: "Cash only" },
  "stats.filter.tournament": { zh: "仅锦标赛", en: "SNG only" },
  "stats.range.all": { zh: "全部手", en: "All hands" },
  "stats.range.50": { zh: "近 50 手", en: "Last 50" },
  "stats.range.100": { zh: "近 100 手", en: "Last 100" },
  "stats.segment.50": { zh: "每段 50 手", en: "50-hand segments" },
  "stats.segment.100": { zh: "每段 100 手", en: "100-hand segments" },
  "stats.compareOn": { zh: "分段对比", en: "Compare segments" },
  "stats.compareOff": { zh: "关闭对比", en: "Close compare" },
  "stats.sampleInfo": { zh: "当前样本：{n} 手", en: "Current sample: {n} hands" },
  "stats.parenFilter": { zh: "（{name}）", en: " ({name})" },
  "stats.compareNeed": {
    zh: "样本不足：分段对比需要至少 {need} 手",
    en: "Not enough samples: segment compare needs at least {need} hands",
  },
  "stats.compareCurrent": {
    zh: "，当前共 {have} 手",
    en: ", you currently have {have}",
  },
  "stats.noMatch": {
    zh: "当前筛选条件下没有手牌记录",
    en: "No hands match the current filters",
  },
  "stats.totalHands": { zh: "总手数", en: "Hands" },
  "stats.totalProfit": { zh: "总盈亏", en: "Profit" },
  "stats.bbPer100": { zh: "每百手盈亏", en: "Profit per 100" },
  "stats.bbPer100Sub": { zh: "bb / 100 手", en: "bb / 100 hands" },
  "stats.winRate": { zh: "胜率", en: "Win rate" },
  "stats.winRateSub": { zh: "平局按 0.5 计", en: "Ties count as 0.5" },
  "stats.showdownRate": { zh: "摊牌率", en: "Showdown rate" },
  "stats.metric.vpip": { zh: "VPIP 自愿入池率", en: "VPIP" },
  "stats.metric.pfr": { zh: "PFR 翻前加注率", en: "PFR" },
  "stats.metric.af": { zh: "AF 翻后进攻系数", en: "AF" },
  "stats.metric.wtsd": { zh: "WTSD 摊牌率", en: "WTSD" },
  "stats.metric.bb100": { zh: "bb/100 每百手盈亏", en: "bb/100" },
  "stats.th.hands": { zh: "手数", en: "Hands" },
  "stats.th.profit": { zh: "盈亏", en: "Profit" },
  "stats.th.winRate": { zh: "胜率", en: "Win rate" },
  "stats.compare.title": { zh: "分段对比", en: "Segment compare" },
  "stats.compare.summary": {
    zh: "最近 {recent} 手 vs 之前 {previous} 手（绿升红降；WTSD 为中性指标，只显示变化值）",
    en: "Last {recent} hands vs the previous {previous} (green up / red down; WTSD is neutral — only the change is shown)",
  },
  "stats.compare.metric": { zh: "指标", en: "Metric" },
  "stats.compare.previous": { zh: "之前 {n} 手", en: "Previous {n}" },
  "stats.compare.recent": { zh: "最近 {n} 手", en: "Last {n}" },
  "stats.compare.delta": { zh: "变化", en: "Change" },
  "stats.hud.title": { zh: "打法指标", en: "Playing metrics" },
  "stats.hud.bucketTitle": { zh: "翻前位置分桶", en: "Preflop position buckets" },
  "stats.hud.bucketNote": {
    zh: "（对比基准判断松紧）",
    en: "(compare against baselines to judge tightness)",
  },
  "stats.hud.bucket.early": { zh: "前位 early", en: "Early" },
  "stats.hud.bucket.middle": { zh: "中位 middle", en: "Middle" },
  "stats.hud.bucket.late": { zh: "后位 late", en: "Late" },
  "stats.hud.bucketHint.early": {
    zh: "枪口侧（翻前身后 ≥5 人）",
    en: "UTG side (≥5 players left to act preflop)",
  },
  "stats.hud.bucketHint.middle": {
    zh: "HJ/CO/BTN 侧（身后 2-4 人）",
    en: "HJ/CO/BTN side (2-4 players left to act)",
  },
  "stats.hud.bucketHint.late": {
    zh: "盲位侧（身后 ≤1 人）",
    en: "Blinds side (≤1 player left to act)",
  },
  "stats.hud.th.bucket": { zh: "位置桶", en: "Bucket" },
  "stats.hud.th.vpipBaseline": { zh: "VPIP 基准", en: "VPIP baseline" },
  "stats.curve.title": { zh: "盈亏曲线", en: "Profit curve" },
  "stats.curve.range": {
    zh: "累计盈亏 · 第 1 手 → 第 {n} 手",
    en: "Cumulative profit · hand 1 → {n}",
  },
  "stats.curve.aria": { zh: "累计盈亏曲线", en: "Cumulative profit curve" },
  "stats.pos.title": { zh: "按位置表现", en: "By position" },
  "stats.pos.empty": { zh: "暂无位置数据", en: "No position data yet" },
  "stats.pos.th.position": { zh: "位置", en: "Position" },
  "stats.style.title": { zh: "按对手风格表现", en: "By opponent style" },
  "stats.style.empty": { zh: "暂无对手风格数据", en: "No opponent-style data yet" },
  "stats.style.th.style": { zh: "对手风格", en: "Opponent style" },
  "stats.style.note": {
    zh: "多人桌一手牌遇到多种风格时，该手盈亏会同时计入各在场风格。",
    en: "When a hand at a full table meets several styles, its profit counts toward every style present.",
  },
  "stats.report.title": { zh: "整场复盘 · AI 教练", en: "Session review · AI coach" },
  "stats.report.subtitle": {
    zh: "汇总最近 {n} 手的统计与亏损样本手，让教练找出你的强项与系统性漏洞。报告本地保存最近 5 份。",
    en: "Aggregates stats and losing sample hands from your last {n} hands so the coach can find your strengths and systemic leaks. The last 5 reports are kept locally.",
  },
  "stats.report.run": { zh: "生成整场复盘", en: "Generate session review" },
  "stats.report.running": {
    zh: "复盘中（可能需要数十秒）…",
    en: "Reviewing (may take tens of seconds)…",
  },
  "stats.report.noApiKey": {
    zh: "尚未配置 LLM API Key，请先到「设置」页填写并保存后再复盘。",
    en: "No LLM API key configured yet — go to Settings, fill it in and save, then review.",
  },
  "stats.report.failed": {
    zh: "复盘失败，请稍后重试",
    en: "Review failed, please try again later",
  },
  "stats.report.rawError": { zh: "{msg}", en: "{msg}" },
  "stats.report.empty": {
    zh: "还没有整场复盘报告。点击右上角按钮生成第一份。",
    en: "No session review yet. Click the button above to generate your first one.",
  },
  "stats.report.latest": { zh: "最新 · ", en: "Latest · " },
  "stats.report.handsAnalyzed": {
    zh: "分析手数：{n} 手",
    en: "Hands analyzed: {n}",
  },
  "stats.report.createdAt": { zh: "生成时间：{time}", en: "Generated: {time}" },
  "stats.report.strengths": { zh: "强项", en: "Strengths" },
  "stats.report.leaks": {
    zh: "漏洞（按严重程度排序）",
    en: "Leaks (sorted by severity)",
  },
  "stats.report.priorities": { zh: "练习优先级", en: "Practice priorities" },
  "stats.report.notListed": { zh: "（教练未列出）", en: "(not listed by the coach)" },
  "stats.report.scoreLabel": { zh: "整场评分", en: "Session score" },
  "stats.report.scoreAria": {
    zh: "整场评分 {score} 分",
    en: "Session score {score}",
  },
  "stats.report.goSettings": { zh: "去设置 →", en: "Go to Settings →" },

  // ================= 成就（AchievementsPanel / AchievementToast） =================
  "achieve.title": { zh: "金手链成就", en: "Bracelet achievements" },
  "achieve.unlockedCount": {
    zh: "{done}/{total} 已解锁",
    en: "{done}/{total} unlocked",
  },
  "achieve.unlockedAt": { zh: "{date} 解锁", en: "Unlocked {date}" },
  "achieve.toastTitle": { zh: "成就解锁", en: "Achievement unlocked" },

  // ================= 对手笔记本卡（stats 页 NotebookCard） =================
  "nb.title": { zh: "AI 眼中的你（长期）", en: "You in the AI's eyes (long-term)" },
  "nb.subtitle": {
    zh: "对手笔记本：AI 跨桌记住的你的打法画像，每开新桌自动注入（随间隔手数自然淡忘）",
    en: "The opponent notebook: a profile of your play the AI remembers across tables, injected automatically at every new table (decays naturally with hands in between)",
  },
  "nb.clear": { zh: "清空笔记本", en: "Clear notebook" },
  "nb.confirmClear": {
    zh: "确定清空「对手笔记本」？AI 将忘掉对你的全部长期了解，从下一桌起重新观察你。",
    en: "Clear the opponent notebook? The AI will forget everything it has learned about you and start observing you fresh from the next table.",
  },
  "nb.empty": {
    zh: "还没有长期画像——去打几手牌，AI 会开始记住你的打法。",
    en: "No long-term profile yet — play some hands and the AI will start remembering your style.",
  },
  "nb.vpipSub": { zh: "自愿入池率", en: "Voluntarily in pot" },
  "nb.pfrSub": { zh: "翻前加注率", en: "Preflop raise" },
  "nb.afSub": { zh: "翻后进攻系数", en: "Aggression factor" },
  "nb.wtsdSub": { zh: "摊牌率", en: "Went to showdown" },
  "nb.guess": { zh: "AI 推测：", en: "AI estimate: " },
  "nb.confidence": { zh: "（置信度 {pct}%）", en: " (confidence {pct}%)" },
  "nb.sample": {
    zh: "累计样本 {total} 手 · 有效 {eff} 手（近因加权）",
    en: "Total sample {total} hands · effective {eff} (recency-weighted)",
  },
  "nb.updatedAt": { zh: "更新于 {time}", en: "Updated {time}" },

  // ================= 设置（src/app/settings/page.tsx） =================
  "settings.title": { zh: "设置", en: "Settings" },
  "settings.llm.title": { zh: "LLM 服务", en: "LLM service" },
  "settings.llm.desc": {
    zh: "用于 AI 对手决策与赛后分析。兼容 OpenAI 协议的服务均可，例如 DeepSeek（https://api.deepseek.com，官方根地址；/v1 也兼容）、Kimi 订阅（https://api.kimi.com/coding/v1，走会员订阅额度，与 Moonshot 开放平台按量 Key 不通用）、Moonshot（https://api.moonshot.cn/v1）、OpenRouter（https://openrouter.ai/api/v1）。Key 只保存在你的浏览器 localStorage，经本站服务端代理转发。",
    en: "Used for AI opponent decisions and post-game analysis. Any OpenAI-compatible service works, e.g. DeepSeek (https://api.deepseek.com, official root; /v1 also accepted), Kimi subscription (https://api.kimi.com/coding/v1, billed via subscription quota — not interchangeable with Moonshot pay-as-you-go keys), Moonshot (https://api.moonshot.cn/v1), OpenRouter (https://openrouter.ai/api/v1). The key is stored only in your browser's localStorage and forwarded through this site's server-side proxy.",
  },
  "settings.apiKey": { zh: "API Key", en: "API Key" },
  "settings.baseUrl": { zh: "Base URL", en: "Base URL" },
  "settings.model": { zh: "模型", en: "Model" },
  "settings.advanced": {
    zh: "高级参数（可选，不设置则不发送给模型）",
    en: "Advanced parameters (optional — unset fields are not sent to the model)",
  },
  "settings.effort": { zh: "思考程度", en: "Reasoning effort" },
  "settings.effort.default": { zh: "默认（不发送）", en: "Default (not sent)" },
  "settings.effort.low": { zh: "低", en: "Low" },
  "settings.effort.medium": {
    zh: "中（DeepSeek 映射为高）",
    en: "Medium (maps to High on DeepSeek)",
  },
  "settings.effort.high": { zh: "高", en: "High" },
  "settings.effort.max": { zh: "最高（仅 DeepSeek V4）", en: "Max (DeepSeek V4 only)" },
  "settings.effortHint": {
    zh: "推理型模型（GPT-5、o 系列、DeepSeek V4 思考模式等）有效；越高越强但越慢越贵。对局内 AI 决策超时会随档位放宽（默认 8s / 中 15s / 高·最高 25s）。",
    en: "Works with reasoning models (GPT-5, o-series, DeepSeek V4 thinking mode, etc.); higher means stronger but slower and pricier. In-game AI decision timeouts scale with the tier (default 8s / medium 15s / high·max 25s).",
  },
  "settings.thinking": {
    zh: "思考模式开关（DeepSeek V4）",
    en: "Thinking mode toggle (DeepSeek V4)",
  },
  "settings.thinking.default": { zh: "默认（不发送）", en: "Default (not sent)" },
  "settings.thinking.on": { zh: "开启思考", en: "Thinking on" },
  "settings.thinking.off": {
    zh: "关闭思考（更快更便宜）",
    en: "Thinking off (faster and cheaper)",
  },
  "settings.thinkingHint": {
    zh: "DeepSeek V4 的 thinking 字段；不发送时 DeepSeek 默认开启思考且强度为高。思考模式下 temperature 等采样参数不生效。非 DeepSeek 提供商可能不认识该字段。",
    en: "The thinking field of DeepSeek V4; when not sent, DeepSeek enables thinking at high strength by default. In thinking mode, sampling parameters like temperature have no effect. Non-DeepSeek providers may not recognize this field.",
  },
  "settings.jsonOutput": {
    zh: "强制 JSON 输出（response_format）",
    en: "Force JSON output (response_format)",
  },
  "settings.jsonHint": {
    zh: "DeepSeek / OpenAI / Moonshot 均支持。本应用的决策与复盘都要求模型输出 JSON，开启后可显著降低解析失败率；若测试报错说明服务商不支持，关掉即可。",
    en: "Supported by DeepSeek / OpenAI / Moonshot. This app requires JSON for both decisions and reviews, so enabling it greatly reduces parse failures; if the test errors out, your provider doesn't support it — just turn it off.",
  },
  "settings.contextHands": {
    zh: "上下文携带量：最近 N 手牌回顾（0 或留空 = 不携带，最大 20）",
    en: "Context carry-over: recap of the last N hands (0 or empty = none, max 20)",
  },
  "settings.contextHintA": {
    zh: "每次 AI 决策时附带「最近 N 手牌的一句话回顾」（谁赢了、你做了什么动作、盈亏多少），让 AI 能利用近期动态（例如“你连续三手翻前弃牌”）。",
    en: "Each AI decision includes a one-line recap of the last N hands (who won, what you did, the profit), letting the AI exploit recent dynamics (e.g. \"you folded preflop three hands in a row\"). ",
  },
  "settings.contextHintEm": {
    zh: "仅在下方 prompt 风格选「完整」时生效",
    en: "Only takes effect when the prompt style below is set to \"Full\"",
  },
  "settings.contextHintB": {
    zh: "；模型的上下文窗口是固有属性（DeepSeek V4 为 1M），无需设置。",
    en: ". The model's context window is a fixed property (1M for DeepSeek V4) — no setting needed.",
  },
  "settings.promptStyle": { zh: "决策 prompt 风格", en: "Decision prompt style" },
  "settings.promptStyle.slim": {
    zh: "精简（推荐，默认）",
    en: "Slim (recommended, default)",
  },
  "settings.promptStyle.full": {
    zh: "完整（注入胜率/画像/回顾）",
    en: "Full (injects equity / profile / recaps)",
  },
  "settings.promptStyleHint": {
    zh: "经 240 手 × 2 场的 LLM 变体大战验证：给模型注入胜率/策略说教会让它做机械阈值决策（赢小输大），零注入的「精简」是唯一两场皆盈利的版本。「完整」保留作对照实验——选它时上方的上下文携带量才会被注入。",
    en: "Validated by a 240-hand × 2-match LLM variant battle: injecting equity/strategy lectures makes the model take mechanical threshold lines (win small, lose big); the zero-injection \"Slim\" style was the only one profitable in both matches. \"Full\" is kept as a control experiment — the context carry-over above is only injected when it's selected.",
  },
  "settings.maxTokens": {
    zh: "输出上限（max_tokens，留空 = 不限制）",
    en: "Output limit (max_tokens, empty = no limit)",
  },
  "settings.maxTokensHintA": {
    zh: "留空时我们不发送该字段，由服务商套用自己的默认值（DeepSeek 默认 4096）。",
    en: "When empty we don't send the field and the provider's own default applies (DeepSeek defaults to 4096). ",
  },
  "settings.maxTokensHintEm": {
    zh: "思考模式下推理过程也计入输出额度：思考程度非「默认」时建议显式填 8192 或更高",
    en: "In thinking mode, reasoning also consumes the output budget: when reasoning effort is not \"Default\", explicitly set 8192 or higher",
  },
  "settings.maxTokensHintB": {
    zh: "，否则复盘长输出可能被截断。部分模型/提供商不认识 reasoning_effort 或 max_tokens 字段，可能被忽略或直接报错；报错时请改回「默认（不发送）」，以你所用服务的文档为准。",
    en: " Otherwise long review outputs may be truncated. Some models/providers don't recognize reasoning_effort or max_tokens — they may ignore it or error out; if so, switch back to \"Default (not sent)\" and follow your provider's docs.",
  },
  "settings.testConnection": { zh: "测试连接", en: "Test connection" },
  "settings.testing": { zh: "测试中…", en: "Testing…" },
  "settings.testFormat": { zh: "测试复盘格式", en: "Test review format" },
  "settings.testFormatHint": {
    zh: "「测试复盘格式」会要求模型输出一小段 JSON 并计时，用于提前发现模型不遵循 JSON 指令、或响应过慢导致复盘分析超时的问题。",
    en: "\"Test review format\" asks the model for a small JSON snippet and times it, to catch models that ignore JSON instructions or respond so slowly that review analysis would time out.",
  },
  "settings.testOk": {
    zh: "连接成功，模型回复：{reply}",
    en: "Connected, model replied: {reply}",
  },
  "settings.testFail": {
    zh: "连接失败，请检查 API Key 与 Base URL",
    en: "Connection failed — check the API key and Base URL",
  },
  "settings.testRawError": { zh: "{msg}", en: "{msg}" },
  "settings.fmtNoJson": {
    zh: "模型未按要求输出合法 JSON（耗时 {s}），回复：{reply}",
    en: "The model did not output valid JSON as instructed (took {s}), reply: {reply}",
  },
  "settings.fmtNotOk": {
    zh: "模型输出了合法 JSON，但未严格按指令返回 {\"ok\":true}（耗时 {s}）",
    en: "The model output valid JSON but did not strictly return {\"ok\":true} as instructed (took {s})",
  },
  "settings.fmtNotOkSlow": {
    zh: "模型输出了合法 JSON，但未严格按指令返回 {\"ok\":true}（耗时 {s}）；该模型响应较慢，复盘分析可能超时",
    en: "The model output valid JSON but did not strictly return {\"ok\":true} as instructed (took {s}); the model is slow and review analysis may time out",
  },
  "settings.fmtOkSlow": {
    zh: "JSON 格式正确，耗时 {s} —— 该模型响应较慢，复盘分析可能超时",
    en: "JSON format is correct, took {s} — the model is slow and review analysis may time out",
  },
  "settings.fmtOk": {
    zh: "模型能按指令输出 JSON，耗时 {s}",
    en: "The model outputs JSON as instructed, took {s}",
  },
  "settings.fmtFail": { zh: "{msg}（耗时 {s}）", en: "{msg} (took {s})" },
  "settings.fmtFailNoMsg": {
    zh: "请求失败（耗时 {s}）",
    en: "Request failed (took {s})",
  },
  "settings.style.title": { zh: "默认 AI 风格", en: "Default AI style" },
  "settings.style.random": {
    zh: "随机（推荐，每手随机风格）",
    en: "Random (recommended, a random style each hand)",
  },
  "settings.styleHint": {
    zh: "大厅「快速对战」会默认选中该风格（对局时仍可更改）。",
    en: "The lobby's \"Quick play\" will preselect this style (you can still change it per game).",
  },
  "settings.engine.title": { zh: "AI 决策引擎", en: "AI decision engine" },
  "settings.engine.heuristic": {
    zh: "启发式（快，默认）",
    en: "Heuristic (fast, default)",
  },
  "settings.engine.heuristicDesc": {
    zh: "本地规则引擎即时决策，免费、无延迟，适合大量练习手数。",
    en: "Instant decisions from a local rule engine — free, zero latency, ideal for high-volume practice.",
  },
  "settings.engine.llm": { zh: "LLM 大模型", en: "LLM" },
  "settings.engine.llmDesc": {
    zh: "每个 AI 的每次决策都调用上方配置的 LLM，打法更拟人且会给出思考说明，但每个动作都有一次网络往返，明显更慢且消耗 token 费用；多人桌（如 9 人桌一手数十次 AI 决策）开销成倍放大。需先配置可用的 API Key。",
    en: "Every AI decision calls the LLM configured above. Play feels more human and comes with reasoning, but each action costs a network round trip — noticeably slower and billed in tokens; at full tables (dozens of AI decisions per hand at 9-max) the cost multiplies. A working API key is required first.",
  },
  "settings.engineHint": {
    zh: "对局内 AI 决策失败时会自动回退到启发式，不会中断牌局。",
    en: "If an in-game AI decision fails, it falls back to the heuristic engine automatically — the hand never breaks.",
  },
  "settings.save": { zh: "保存设置", en: "Save settings" },
  "settings.saved": { zh: "已保存到本地浏览器", en: "Saved to your browser" },

  // ================= 训练器（src/app/trainer/**） =================
  "trainer.title": { zh: "训练器", en: "Trainer" },
  "trainer.subtitle": {
    zh: "翻前短码全下/弃牌 · 翻后实算胜率决策，两种模式分开计分",
    en: "Preflop short-stack shove/fold · postflop decisions judged by real computed equity — scored separately",
  },
  "trainer.tab.pushfold": { zh: "翻前 Push/Fold", en: "Preflop Push/Fold" },
  "trainer.tab.postflop": { zh: "翻后特训", en: "Postflop drills" },
  "trainer.stats.streak": { zh: "连对（最佳 {best}）", en: "Streak (best {best})" },
  "trainer.stats.accuracy": {
    zh: "正确率（{correct}/{total}）",
    en: "Accuracy ({correct}/{total})",
  },
  "trainer.stats.wrong": { zh: "本局错题", en: "Mistakes this session" },
  "trainer.correct": { zh: "✓ 正确", en: "✓ Correct" },
  "trainer.wrong": { zh: "✗ 错误", en: "✗ Wrong" },
  "trainer.next": { zh: "下一手", en: "Next hand" },
  "trainer.wrongReview": { zh: "错题回顾（{n}）", en: "Mistake review ({n})" },
  "trainer.youChose": { zh: "你选了{choice}", en: "You chose {choice}" },
  "trainer.expected": { zh: "应{choice}", en: "Correct: {choice}" },
  "trainer.pf.rule": {
    zh: "单挑 SB（BTN）位 · 5–15bb 短码 · 全下或弃牌（Nash 近似表，相邻深度按最近档判定）",
    en: "Heads-up SB (BTN) · 5–15bb short stack · shove or fold (Nash approximation table; off-tier depths judged at the nearest tier)",
  },
  "trainer.pf.dealing": { zh: "发牌中…", en: "Dealing…" },
  "trainer.pf.scene1": { zh: "单挑，你在 ", en: "Heads-up, you're in the " },
  "trainer.pf.scenePos": { zh: "SB（按钮位）", en: "SB (button)" },
  "trainer.pf.scene2": { zh: "，有效筹码 ", en: " with an effective stack of " },
  "trainer.pf.scene3": {
    zh: "，翻前轮你先行动——全下还是弃牌？",
    en: " — first to act preflop. Shove or fold?",
  },
  "trainer.pf.verdictPush": { zh: "应该全下。", en: "shoving is correct." },
  "trainer.pf.verdictFold": { zh: "应该弃牌。", en: "folding is correct." },
  "trainer.pf.note.quant": {
    zh: "实际 {bb}bb 按最近档 {depth}bb 判定；",
    en: "Actual {bb}bb judged at the nearest tier {depth}bb; ",
  },
  "trainer.pf.note.pair": {
    zh: "{quant}{label} 是对子——单挑短码任何深度都是标准全下",
    en: "{quant}{label} is a pair — a standard shove at any heads-up short-stack depth",
  },
  "trainer.pf.note.push": {
    zh: "{quant}{label} 在 {depth}bb 档的全下范围内（该档约推 {pct}%）——标准全下",
    en: "{quant}{label} is inside the {depth}bb shove range (≈{pct}% at that tier) — a standard shove",
  },
  "trainer.pf.note.fold": {
    zh: "{quant}{label} 低于 {depth}bb 档的全下门槛（该档约推 {pct}%）——标准弃牌",
    en: "{quant}{label} is below the {depth}bb shove threshold (≈{pct}% at that tier) — a standard fold",
  },
  "trainer.pf.depthNote": {
    zh: "{bb}bb（{depth}bb 档）",
    en: "{bb}bb ({depth}bb tier)",
  },
  "trainer.post.rule": {
    zh: "翻牌圈场景 · 对 1 名随机对手实算胜率 · 胜率 ≥55% 进攻 / 面对半池注 ≤30% 弃牌 / 其余过牌·跟注",
    en: "Flop scenarios · real computed equity vs 1 random opponent · attack at ≥55% equity / fold to a half-pot bet at ≤30% / otherwise check·call",
  },
  "trainer.post.dealing": {
    zh: "发牌并实算胜率中…",
    en: "Dealing and computing equity…",
  },
  "trainer.post.attackQ": { zh: "进攻题", en: "Attack spot" },
  "trainer.post.defenseQ": {
    zh: "防守题（对手半池注）",
    en: "Defense spot (opponent bets half pot)",
  },
  "trainer.post.defenseShort": { zh: "防守题", en: "Defense spot" },
  "trainer.post.scenario.attack": {
    zh: "翻牌圈，前面无人下注，轮到你行动——主动进攻还是过牌？",
    en: "On the flop, no one has bet and the action is on you — attack or check?",
  },
  "trainer.post.scenario.defense": {
    zh: "翻牌圈，对手下注半个底池，轮到你——加注、跟注还是弃牌？",
    en: "On the flop, your opponent bets half pot — raise, call, or fold?",
  },
  "trainer.post.board": { zh: "公共牌", en: "Board" },
  "trainer.post.yourHand": { zh: "你的手牌", en: "Your hand" },
  "trainer.choice.aggressive": { zh: "下注/加注", en: "Bet/Raise" },
  "trainer.choice.passive": { zh: "过牌/跟注", en: "Check/Call" },
  "trainer.post.shouldBe": { zh: "应{choice}。", en: "the answer is {choice}." },
  "trainer.post.win": { zh: "胜率", en: "Win" },
  "trainer.post.tie": { zh: "平局", en: "Tie" },
  "trainer.post.lose": { zh: "败率", en: "Lose" },
  "trainer.post.method": {
    zh: "实算口径：对 1 名随机对手蒙特卡洛模拟 2000 次 · 进攻线 {attack}% · 防守弃牌线 {fold}%",
    en: "Method: 2000-iteration Monte Carlo vs 1 random opponent · attack line {attack}% · defense fold line {fold}%",
  },
  "trainer.post.wrongMeta": {
    zh: "{type} · 胜率 {pct}%",
    en: "{type} · equity {pct}%",
  },
  "trainer.post.tieNote": { zh: "（另平局 {pct}%）", en: " (plus {pct}% tie)" },
  "trainer.post.comment.attackAggressive": {
    zh: "实算胜率 {pct}%{tie}，越过 55% 进攻线——牌力明显领先随机手，主动下注拿价值、直接收池",
    en: "Computed equity {pct}%{tie}, above the 55% attack line — clearly ahead of a random hand: bet for value and take the pot down",
  },
  "trainer.post.comment.defenseAggressive": {
    zh: "实算胜率 {pct}%{tie}，面对半池注仍显著领先——加注进攻榨取价值，别给便宜看牌",
    en: "Computed equity {pct}%{tie}, still well ahead against a half-pot bet — raise for value and don't give a cheap look",
  },
  "trainer.post.comment.fold": {
    zh: "实算胜率 {pct}%{tie}，不足 30%——半池注虽只需 25% 赔率，但无主动权时实现率打折，弃牌",
    en: "Computed equity {pct}%{tie}, below 30% — a half-pot bet only needs 25%, but without the initiative your realization suffers: fold",
  },
  "trainer.post.comment.attackPassive": {
    zh: "实算胜率 {pct}%{tie}，不够进攻线——过牌控池、免费看转牌，别用弱牌造池",
    en: "Computed equity {pct}%{tie}, short of the attack line — check, keep the pot small and see a free turn; don't build a pot with a weak hand",
  },
  "trainer.post.comment.defensePassive": {
    zh: "实算胜率 {pct}%{tie}，够 25% 跟注赔率但不够加注——跟注看转牌，保持底池可控",
    en: "Computed equity {pct}%{tie}, enough for the 25% call price but not for a raise — call and see the turn, keeping the pot under control",
  },

  // ================= 范围表（src/app/ranges/page.tsx） =================
  "ranges.title": { zh: "翻前范围表", en: "Preflop ranges" },
  "ranges.subtitle": {
    zh: "9 人桌各位置开局 + 单挑攻防 · 对角线为对子，右上为同花（s），左下为杂色（o）",
    en: "Opening ranges for every 9-max position plus heads-up battles · diagonal = pairs, upper right = suited (s), lower left = offsuit (o)",
  },
  "ranges.group.nine_max": { zh: "9 人桌开局", en: "9-max opens" },
  "ranges.group.heads_up": { zh: "单挑", en: "Heads-up" },
  "ranges.table.utg": { zh: "UTG 开局", en: "UTG open" },
  "ranges.table.utg1": { zh: "UTG+1 开局", en: "UTG+1 open" },
  "ranges.table.lj": { zh: "LJ 开局", en: "LJ open" },
  "ranges.table.hj": { zh: "HJ 开局", en: "HJ open" },
  "ranges.table.co": { zh: "CO 开局", en: "CO open" },
  "ranges.table.btn": { zh: "BTN 开局", en: "BTN open" },
  "ranges.table.sb": { zh: "SB 开局（对 BB）", en: "SB open (vs BB)" },
  "ranges.table.btn_open": { zh: "按钮位开局", en: "Button open" },
  "ranges.table.bb_defend": {
    zh: "大盲位防守（对按钮加注）",
    en: "Big blind defense (vs button raise)",
  },
  "ranges.desc.utg": {
    zh: "枪口位（9 人桌最先行动），约 17% 最紧开局：中以上对子、全部同花 A、两张大牌。身后 8 人未行动，宁紧勿松。",
    en: "Under the gun (first to act at 9-max), the tightest ≈17% open: medium+ pairs, all suited aces, two big cards. With 8 players behind, err on the tight side.",
  },
  "ranges.desc.utg1": {
    zh: "约 20%：在 UTG 基础上放宽到小对子 66/55、K9s、J9s、98s 与 AJo/KQo 等杂色大牌。",
    en: "≈20%: widens UTG to small pairs 66/55, K9s, J9s, 98s and offsuit broadways like AJo/KQo.",
  },
  "ranges.desc.lj": {
    zh: "约 23%：继续加入 55、K8s、Q9s、T8s、87s 等同花连接张，仍以同花牌与大牌为主。",
    en: "≈23%: adds 55 plus suited connectors like K8s, Q9s, T8s, 87s — still dominated by suited hands and big cards.",
  },
  "ranges.desc.hj": {
    zh: "劫持位约 28%：对子到 44，K7s/Q8s/J8s 起，杂色 AJo/KQo/QJo/JTo 可开局。",
    en: "Hijack ≈28%: pairs down to 44, K7s/Q8s/J8s and up, and offsuit AJo/KQo/QJo/JTo can open.",
  },
  "ranges.desc.co": {
    zh: "关煞位约 31%：全部对子、K6s+、更多同花连张（65s），杂色放宽到 ATo/KJo/QJo/JTo/T9o。",
    en: "Cutoff ≈31%: all pairs, K6s+, more suited connectors (65s), offsuit widens to ATo/KJo/QJo/JTo/T9o.",
  },
  "ranges.desc.btn": {
    zh: "按钮位约 48%：位置最好，任意同花 K、Q4s+、半连张同花、任意杂色 A、K8o+ 均可开局偷盲。",
    en: "Button ≈48%: the best seat — any suited king, Q4s+, suited one-gappers, any offsuit ace, K8o+ can open to steal the blinds.",
  },
  "ranges.desc.sb": {
    zh: "小盲对大盲约 82% 可玩：约 55% 加注（绿色），中等牌力补全 1BB 跟注（蓝色，limp），仅最差约 18% 弃牌。",
    en: "Small blind vs big blind ≈82% playable: ≈55% raise (green), medium hands complete for 1BB (blue, limp), only the worst ≈18% fold.",
  },
  "ranges.desc.btn_open": {
    zh: "单挑规则下按钮位 = 小盲，翻前先行动。约 80% 起手牌可玩：强牌加注，中等牌跟注（limp），垃圾牌弃牌。",
    en: "Heads-up, the button is the small blind and acts first preflop. ≈80% of starting hands are playable: raise the strong ones, limp the medium ones, fold the trash.",
  },
  "ranges.desc.bb_defend": {
    zh: "大盲位面对按钮位加注时的应对：强牌 3-bet（再加注），中等牌利用好的底池赔率跟注，垃圾牌弃牌。",
    en: "How the big blind responds to a button raise: 3-bet the strong hands, call with medium hands getting good pot odds, fold the trash.",
  },
  "ranges.hint.raise": {
    zh: "主动进攻，加注开局 / 再加注",
    en: "Take the initiative: open-raise / re-raise",
  },
  "ranges.hint.call": {
    zh: "可玩但偏被动，跟注进入翻后",
    en: "Playable but passive: call and see a flop",
  },
  "ranges.hint.fold": {
    zh: "牌力太弱，直接弃牌",
    en: "Too weak — just fold",
  },
  "ranges.suggest": { zh: "建议：{action}", en: "Suggested: {action}" },
  "ranges.hoverTip": {
    zh: "悬停任意格子查看牌名与建议动作",
    en: "Hover any cell to see the hand and its suggested action",
  },
  "ranges.summary": {
    zh: "可玩 {pct}%（加注 {raise} / 跟注 {call} / 弃牌 {fold}，共 169 格）",
    en: "Playable {pct}% (raise {raise} / call {call} / fold {fold}, 169 cells)",
  },

  // ================= 胜率计算器（src/app/equity/page.tsx） =================
  "equity.title": { zh: "胜率计算器", en: "Equity calculator" },
  "equity.subtitle": {
    zh: "选择自己的手牌与公共牌，蒙特卡洛模拟对 1-8 名随机对手或指定对手手牌的胜率",
    en: "Pick your hand and the board, then Monte Carlo your equity against 1-8 random opponents or an exact opponent hand",
  },
  "equity.zone.hero": { zh: "我的手牌（2 张）", en: "My hand (2 cards)" },
  "equity.zone.board": {
    zh: "公共牌（0-5 张，0 张即翻前）",
    en: "Board (0-5 cards, 0 = preflop)",
  },
  "equity.zone.villain": { zh: "对手手牌（2 张）", en: "Opponent hand (2 cards)" },
  "equity.target.hero": { zh: "我的手牌", en: "my hand" },
  "equity.target.board": { zh: "公共牌", en: "the board" },
  "equity.target.villain": { zh: "对手手牌", en: "the opponent hand" },
  "equity.villainRange": { zh: "对手范围", en: "Opponent range" },
  "equity.random": { zh: "随机", en: "Random" },
  "equity.exact": { zh: "指定手牌", en: "Exact hand" },
  "equity.opponentCount": { zh: "对手数量", en: "Opponents" },
  "equity.opponentNote": {
    zh: "人（9 人桌最多 8 名对手）",
    en: "(up to 8 opponents at a 9-max table)",
  },
  "equity.pickHint": { zh: "点击加入「{zone}」", en: "Click to add to {zone}" },
  "equity.full": { zh: "（已满）", en: " (full)" },
  "equity.pickToZone": { zh: "选牌到此区 ↓", en: "Picking for this zone ↓" },
  "equity.empty": { zh: "（未选择）", en: "(none selected)" },
  "equity.removeTitle": { zh: "点击移除", en: "Click to remove" },
  "equity.compute": { zh: "计算胜率", en: "Compute equity" },
  "equity.computing": { zh: "计算中…", en: "Computing…" },
  "equity.reset": { zh: "重置", en: "Reset" },
  "equity.result": { zh: "结果", en: "Result" },
  "equity.resultHint": {
    zh: "选好牌后点击「计算胜率」。公共牌不足 5 张时会随机补齐模拟 10000 次。",
    en: "Pick cards, then hit \"Compute equity\". Boards shorter than 5 cards are completed randomly over 10,000 iterations.",
  },
  "equity.errHero": {
    zh: "请先选择自己的两张手牌",
    en: "Please pick your two hole cards first",
  },
  "equity.errVillain": {
    zh: "对手范围选择了「指定手牌」，请选择对手的两张牌",
    en: "Opponent range is set to \"Exact hand\" — pick the opponent's two cards",
  },
  "equity.errBoard": {
    zh: "公共牌数量应为 0（翻前）或 3-5 张",
    en: "The board should have 0 (preflop) or 3-5 cards",
  },
  "equity.errNoEngine": {
    zh: "胜率引擎尚未接入（poker 引擎组实现中），请稍后再试",
    en: "The equity engine isn't wired up yet (poker engine team is on it) — please try again later",
  },
  "equity.errFail": { zh: "计算失败", en: "Computation failed" },
  "equity.win": { zh: "胜率", en: "Win" },
  "equity.tie": { zh: "平局", en: "Tie" },
  "equity.lose": { zh: "负率", en: "Lose" },
  "equity.resultSummary": {
    zh: "我的手牌 {hero} ｜ 公共牌 {board} ｜ 对手 {villain}",
    en: "Hero {hero} ｜ Board {board} ｜ Villain {villain}",
  },
  "equity.preflop": { zh: "翻前", en: "preflop" },
  "equity.randomN": { zh: "随机 ×{n}", en: "random ×{n}" },
} as const;
