# Phase 7 报告：锦标赛上下文感知（轻量 ICM 风格调整）

赛制：8 人 heuristic 锦标赛（100bb 起步 startStack=2000 / level0 bb=20、rebuy 0、
handsPerLevel 10、DEFAULT_BLIND_LEVELS 原始 10 级表、maxHands 200）。同 masterSeed
两场 match（发牌逐手一致；锦标赛不支持 runPaired），唯一变量 = 座位 0 的
`icmEnabled`（A=false → B=true），其余 7 座位默认 gto。种子 42–71 共 30 场。

判定规则（任务定案）：座位 0 名次差（A−B）95% CI 全正且中值 > +0.15 → 保留
`icmEnabled` 默认开启，否则默认 false。

## 规则表（brain.ts 新旋钮）

| 旋钮 | 默认 | 规则 |
|---|---|---|
| `icmEnabled` | **false**（验收未过） | 总开关；false 或 `input.tournament` 缺省（现金局）时全部零修正，行为逐比特回到旧版 |
| `icmBubbleCallTighten` | 0.04 | bubble/final 且 myStackBB < 15：面对加注/下注的跟注门槛 +4pp（翻前 `callVsRaisePct`/`callVs3betPct` 与翻后跟注胜率边际同量）；push/fold 与全下范围照旧 |
| `icmBigStackPressure` | 1.3 | bubble/final 且 `myRankByChips×3 ≤ playersRemaining`（严格前 1/3）且 `myStackBB > 2×avgStackBB`：偷盲/垃圾开局/诈唬 3bet/半诈唬/纯诈唬/诈唬加注概率 ×1.3 |
| （阶段划分） | — | `computeTournamentPhase`：remaining/total > 0.6 early，> 0.35 middle，> 0.2 bubble，否则 final（简化模型，非真 ICM——不看奖金结构/payout 跳跃） |

early/middle 阶段零修正；「不犯蠢」底线（foldFloorEq / warGuard / callVs3betMaxBB）
不受调整影响。注入链：gameStore（生产，排名按 tableStacks 经 seatMap 换算）与
match.ts（台架，排名按开手结转筹码 carried）同一口径；LLM slim prompt 渲染一行
事实段（`锦标赛：还剩 X/Y 人，你的筹码排第 Z（NNbb，平均 MMbb），阶段：泡沫期`），
只给事实不给说教，不受 `icmEnabled` 开关影响。

## 30 场验证数据（种子 42–71）

| 指标（座位 0） | A（icm off） | B（icm on） | 差值 |
|---|---|---|---|
| 平均名次 | 4.13 | 4.13 | **mean 0.000，median 0.000，95% CI [0, 0]** |
| 累计盈亏（筹码） | +4000 | +4000 | **mean 0.0，median 0.0，95% CI [0, 0]** |
| 夺冠次数 | 4 | 4 | 0 |
| 场均手数 | 93.7 | 93.6 | seed 56：92 → 89 |

- 30 个种子里座位 0 有 11 次打进单挑（place ≤ 2：seed 43,44,50,51,52,56,57,58,59,67,69），
  但名次/盈亏差值全部为 0。
- 唯一可观测分叉：seed 56 单挑阶段少打 3 手（89 vs 92），说明默认旋钮确实触发过
  至少一次决策翻转，但座位 0 最终名次与盈亏不变（同样第 2 名出局、-2000）。

**判定：未过采纳线（CI 非全正）→ `icmEnabled` 默认改回 false**，机制保留供 A/B。

## 根因分析（为什么测不出效应）

1. **触发面结构性地窄**：8 人桌 phase 口径下 bubble/final = 剩余 ≤ 2 人
   （2/8=0.25 bubble；3/8=0.375 仍属 middle）。ICM 调整只在单挑阶段生效，
   而座位 0 只有约 1/3 的比赛能活到单挑（11/30）。
2. **大筹码施压在本赛制不可达**：单挑时 `myStackBB > 2×avgStackBB` 数学上不可能
   （avg = 两人筹码和的一半，领先者恒 < 2×avg）。该规则只对更大场
   （总人数更多、bubble 覆盖剩余 3-7 人）有意义。
3. **单挑翻前大盲防守走专属分支**：HU 大盲面对加注用 `bb_defend` 表直接决策，
   不经过收紧的 `callPct` 路径；收紧实际只覆盖「按钮位（小盲）limp 后被加注」
   与翻后短码跟注边际两个窗口。
4. 探针验证注入链路本身无误：seed 67 极端旋钮（tighten 0.5 / pressure ×3）下
   两臂明显分叉（座位 0 VPIP 31.8% → 33.3%，手数 88 → 87），
   排除「注入没生效」的可能——默认 +0.04 的效应量就是翻不动几个决策。

## 产物

- 类型/契约：`src/lib/types.ts`（`TournamentPhase` / `TournamentContext` /
  `computeTournamentPhase`；`DecideInput.tournament?`）
- 决策：`src/lib/ai/brain.ts`（`icmEnabled` / `icmBubbleCallTighten` /
  `icmBigStackPressure` 旋钮 + `icmAdjust`，默认全零修正）
- prompt：`src/lib/ai/prompt.ts`（buildSlimPrompt 锦标赛事实段，不受 icmEnabled 影响）
- 注入：`src/lib/store/gameStore.ts`（buildDecideInput 第 6 参 +
  tournamentContextFor）、`scripts/selfplay/match.ts`（playHand 注入）
- 台架：`scripts/selfplay/icm-ab.ts`（30 种子 A/B 驱动）、
  `configs/phase7-icm-probe-{a,b}.json`（注入探针）
- 数据：`results/phase7-icm-seeds.json`（逐种子明细）、
  `results/phase7-icm-{smoke,probe-a,probe-b}.json`
- 测试：`src/lib/ai/__tests__/icm.test.ts`（13 例：phase 边界、短码收紧
  生效/默认关不生效/early-middle 不生效/final 生效/旋钮化、大筹码施压
  ×1.3/不满足条件不上调、prompt 事实段渲染与缺省不渲染）

## 遗留问题

- 全量 vitest 在并行负载下有两个**计时型**测试偶发超墙（brain 性能 <120ms
  基准、range 多人池蒙特卡洛 5s 超时），隔离单跑均通过（116ms / 3.6s）；
  与本改动无因果关系（bitwise 回归测试 brainTuning/adapt 恒等组每次都过）。
- 若未来要真让 ICM 生效，需要更大的场（总人数 20+，让 bubble 覆盖 3-7 人）
  或更粗的 phase 口径（如剩余 ≤ 30% 直接算 bubble），并按本报告的 A/B
  框架重新验收；当前 8 人 SNG 下该机制是「有等于没有」。
- prompt 事实段（LLM 可见的锦标赛信息）未单独做 LLM A/B 验收——它是事实
  注入不是阈值调整，建议后续用 llm-tourney 系列配置单独评。
