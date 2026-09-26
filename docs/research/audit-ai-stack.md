# AI 决策全栈只读审计报告

日期：2026-09-23 ｜ 审计方式：纯静态只读（读源码 + grep + `npx tsc --noEmit` 基线通过，exit 0），未运行 vitest/build/dev/自对战，未修改任何源文件。

## 证据口径约定

- **实测**：来自 scripts/selfplay/results/ 已有配对实验报告（phase3/phase4/tourney-*，累计 ≈50 万手）。
- **推断**：由代码机理推导，无实验隔离数据。标注推断的结论都给出了建议的验证方式。

关键背景实测数据（供影响量级锚定）：
- 范围引擎（rangeMode）净效应：6max 100bb **+104.1 bb/100** [+95.6,+112.7]（phase4-range-6max-report.md，n=96000）；9max **+85.7** [+77.5,+93.9]；200bb **+156.8** [+139.3,+174.2]；HU **+85.0** [+76.2,+93.8]。
- blend 扫描：blend 0.0 > 0.3 > 0.5 单调（phase4-range-blend-report.md）——现行默认 `rangeBlendRandom: 0` 已是采纳后的最优值。
- warGuard：漏勺收敛 L3 ≈ -79%、L1 ≈ -43%（同报告任务 B）；护栏单项 200bb ≈ +19.9 bb/100（Phase 3，被 deep 报告引用）。
- **全部实验均未注入 opponentModels**（match.ts:311-317 构造的 DecideInput 无该字段）——剥削路径（adapt.ts）零实测覆盖。

---

## P0：显著影响牌力

### F1. DecideInput.callAmount 未按 hero 实际可跟注额封顶（新发现，不在线索清单）

- **位置**：`src/lib/store/gameStore.ts:455`（`callAmount = max(0, currentBet - me.streetBet)`，未封顶）；`scripts/selfplay/match.ts:307` 同样未封顶；对照引擎 `src/lib/poker/game.ts:243-245`：合法 call = `min(toCall, me.stack)`。
- **机理**：对手 bet-to 超过 hero 剩余筹码时（深打浅的 overbet/全下），`callAmount` 远大于 hero 实际需冒的筹码。所有以 callAmount 数值做阈值的判定全部失真：
  1. `brain.ts:1012` 翻后 `required = callAmount/(pot+callAmount)` 虚高 → 实际赔率极好（跟注即全下）的手被弃掉；
  2. `brain.ts:1019` `betFrac` 虚高 → `foldFloorEq` 绝对下限更易触发；
  3. `brain.ts:941,950` 翻前 `callVs3betMaxBB(25bb)` 上限误伤：hero 20bb 面对对手 100bb 全下，AKs（pct 0.958 ∈ call 带）按 100bb 计价被弃，实际只需跟 ~17bb；JJ 的 4bet+ 场景同理（pct 0.982 < exempt 0.985，`pfWarCapped` 下按虚高 callAmount 弃牌）；
  4. `gameStore.ts:460` potOdds、`brain.ts:740-742` brainStats.required、`gameStore.ts:551-557` heroDerived——**人类 hero 的 UI 赔率显示和 LLM prompt 注入的赔率同样虚高**。
- **触发条件**：面对下注的 bet-to > hero 剩余筹码。锦标赛中后期筹码分化后高频；现金局筹码拉开后同样出现。
- **影响**（推断）：方向 = 系统性过度弃牌（被动漏池，不产生大额亏损手，leak-hunt 的 topHands 方法论天然看不见它）。单次事件丢掉数 bb~数十 bb 的 +EV 跟注。bench 双侧同病（match.ts:307），配对差值恒为 0，故 50 万手实验完全没暴露它。
- **修复**：`buildDecideInput`（gameStore.ts:455）与 `heroDerived`（555）改为 `Math.min(state.currentBet - me.streetBet, me.stack)`；potOdds 用封顶后值；match.ts:307 同步。**注意**：改完后 bench 与生产口径才一致，需重跑一次 baseline 确认无回归。

### F2. SPR commit 判定用随机范围胜率，且在 warGuard 之前执行（线索 2，确认成立且比描述更重）

- **位置**：`brain.ts:1003-1009`。
- **机理**：`if (eq >= commitEq && me.stack <= 2×pot) return allin` 用的是 `eq`（vs 随机胜率，行 970），不是面对下注时算好的 `eqF`（混合胜率，行 981-1001）。文件头注释（行 28）与行 979 的辩护「对手没给信息」对 `facingBet` 场景不成立——此时对手已下注，范围信息存在。更严重的是该分支位于 facingBet 分支与 warGuard 门槛（行 1033-1040）**之前**：hero 下注被 raise 回来（warSeen=1，护栏要求 eqF ≥ 0.78）时，只要 vs 随机 eq ≥ 0.60 且 SPR ≤ 2，就直接全下，**整体绕过 warGuard 与范围推断两道防线**。
- **触发条件**：面对下注/加注且 stack ≤ 2×pot（pot 含对手当前注额，低 SPR 在加注后的底池里很常见）。
- **影响**（推断）：Phase 3/4 实测证明「vs 随机高估」是最大漏勺源（范围引擎 +104 bb/100 的来源），SPR 路径恰好保留了这个旧口径并绕开护栏。典型形态：顶对类 eq(random)≈0.62、eqF≈0.35，低 SPR 下全下进强范围。leak-hunt §2「单次全下未成独立大亏」是旧脑全栈随机口径下的结论，不能为当前混合架构背书。
- **修复**：`postflopDecide` 的 SPR 判定改为 `const eqCommit = facingBet ? eqF : eq`，或将 SPR 分支移到 facingBet 分支内部并叠加 warSeen 门槛。建议配 bench A/B（`sprUsesEqF` 旋钮）验证。

---

## P1：可感知缺陷

### F3. prompt 注入的 brainStats 与决策口径不一致（线索 3，确认成立）

- **位置**：`brain.ts:730-744`（brainStats 恒用 `preflopEquityVs`/`heroEquity` = 随机口径）；`prompt.ts:202-209` 原样展示；决策侧 facing bet 用 eqF（brain.ts:1000）。
- **机理**：LLM「pro 模式」在面对加注时被告知「胜率约 65%（对 N 名对手）」，而范围口径下可能只有 40%；prompt 还指示「请结合该数据与你的风格人设决策」→ 系统性诱导过度跟注/加注。叠加 F1，`required` 也虚高。另：启发式模式下 reasoning 文案（brain.ts:1161-1162）同样显示随机胜率，会出现「胜率约 65%，选择弃牌」这类自相矛盾的解释（实际按 eqF=40% 弃的）——可解释性损伤。
- **分类**：一致性/可解释性问题 + LLM 决策质量的实际损失。
- **修复**：`brainStats` 增加 `equityVsRange?: number` 字段（facingBet 时用与决策相同的 `inferFacingSpec`+`equityVsRange` 计算）；prompt 展示双口径（「vs 随机 X%，对手下注后 vs 推断范围 Y%」）；reasoning detail 同理。required 在 F1 修复后自动正确。

### F4. GameState.streetActions 不带行动者 seat，导致范围修正「张冠李戴」（线索 4，确认成立）

- **位置**：`types.ts:153`（`streetActions: PlayerAction[]`）；`brain.ts:358-368` `facingOpponentModel` 取「在局对手中置信度最高者」做代表；`prompt.ts:52-57` 行动序列渲染同样无座位（LLM 也不知道是谁加的注）。store 侧 `applyTracked`（gameStore.ts:566-590）其实用 `prev.currentSeat` 归出了带座位的 `pendingActions`，信息在 GameState 层面被丢弃。
- **机理**：多人池中，真正下注的 maniac 被忽略、范围推断用了隔壁高置信度 nit 的画像修正（`inferFacingSpec` 的 oppModel 修正，range.ts:111-128）→ 方向性错误（该放宽时收紧）。也阻塞 F5（翻前按加注者位置收紧）的实现。
- **影响**（推断）：剥削修正生效的场景里画像错配；修正幅度受 confidence 加权和钳制限制，单手幅度小，但方向错误是系统性的。
- **修复**：`GameState.streetActions` 升级为 `SeatAction[]`（引擎 `applyAction` 内记录行动者）；`facingOpponentModel` 改为取本街最后一个攻击性动作（bet/raise/allin）的 seat 的画像；prompt 渲染带座位号。改动面较大（引擎 + 全部消费方 + 回放），建议独立 PR。

### F5. 翻前面对加注/3bet 无范围推断、无加注者位置维度（线索 1，确认成立）

- **位置**：`brain.ts:870-959`。raiseLevel=1 用 `callVsRaisePct`/`value3betPct` 静态百分位阈值；raiseLevel≥2 用 `callVs3betPct`/`premiumPct`。全程不区分加注者位置；非 HU 没有任何位置化的防守表（`gto/ranges.ts` 面对加注的表只有 HU 专用 `bb_defend`，ranges.ts:265）。范围推断只在翻后启用（postflopDecide 才调 `inferFacingSpec`）。
- **机理**：对 UTG 开局（紧范围）按同一阈值跟注 = 偏松，对 BTN 开局 = 偏紧。PREFLOP_ORDER 本身是「对随机单对手」的胜率排序，用它衡量「对 UTG 开局范围」的相对强度会进一步高估同花连张/小对。
- **影响**（推断）：翻前底池小 + warGuard L2/L2' 已封死灾难性互加（实测收敛 43-79%），量级中等；但作为「范围引擎」的覆盖缺口，与翻后 +104 bb/100 的实测错价同源。
- **修复**：依赖 F4 先拿到加注者 seat → 用加注者位置的开局表（RANGE_TABLES 对应 id）把 hero 手牌百分位重估为「vs 该开局范围的相对强度」再套阈值；或新增按「加注者位置 × hero 位置」的防守表。短期低成本替代：按加注者可能位置对 callPct 加 ±0.05 修正。

### F6. 短筹码 all-in（short all-in call）被计入加注层级（新发现）

- **位置**：`brain.ts:345-351` `streetRaisesSeen` 与 `328-338` `preflopRaiseLevel`：所有 `allin` 一律计入攻击性动作数。
- **机理**：引擎规则里不足最小加注的 all-in 不重开下注轮（game.ts:249-251 注释），本质是跟注；但 brain 把它当再加注 → warGuard 门槛升档（0.78/0.85）、`inferFacingSpec` 范围收紧到 0.30/0.10、`preflopRaiseLevel` 虚高。面对「短码全下 3.5bb（大盲 3bb 跟注性质）」会被当成面对 3bet 处理 → 系统性过度收紧。
- **触发条件**：桌上有短码——锦标赛中后期高频。
- **影响**（推断）：方向过度收紧（偏保守），单次幅度小。
- **修复**：两函数只计「抬高下注线」的动作（维护 runningMax，`amount > runningMax` 才计数；可参照 `adapt.ts:118-138` 已有的 runningMax 口径）。

---

## P2：锦上添花 / 待测量

### F7. 多人池 spec 收紧 ×0.8^(n-1) 与联合采样的交互未标定（线索 5，「双重计数」严格意义上不成立，保留为待测量项）

- **位置**：`range.ts:78-79`（MULTIWAY_TIGHTEN=0.8）、`range.ts:106-108`（收紧）、`brain.ts:994-999`（joint 采样 opponents 个对手）。
- **核实结论**：两个机制建模的是**不同效应**——0.8 收紧是「下注进多人池 → 下注者范围信息更强」，联合采样是「hero 需压过全部对手」的摊薄；语义上不构成双重计数。但有两个真实问题：(a) 收紧后的「下注者范围」被施加到**全部** N 个对手——只跟注者/未行动者的范围应更弱（封顶范围/随机），统一按 aggressor spec 抽牌高估对抗强度 → 多人池过度弃牌；(b) 0.8 系数与联合摊薄叠加后的总收紧量从未被 bench 隔离测量（results/ 中无 rangeMultiwayJoint 或 tighten 系数的配对实验；9max +85.7 bb/100 是该组合默认开启下的净值，证明净方向强正，但不能证明系数最优）。
- **影响**：未测量，方向偏保守（过度收紧）。
- **修复**：bench 加 `rangeMultiwayJoint × multiwayTighten(1.0/0.8)` 双因子配对赛；长期：未行动对手用随机范围、仅 aggressor 用收紧 spec（依赖 F4 的 seat 信息）。

### F8. 对手建模无位置维度 / 无近因权重 / 无分街数据 / 阈值桌型盲（线索 6，确认成立）

- **位置**：`adapt.ts`：`updateStats`（103-178）VPIP/PFR 全位置混算、无衰减；`classify`（196-213）阈值注释自认「按 6 人桌常识标定」（行 32）却用于 2-9 人桌；AF 三街混合。
- **额外锐化（审计新发现）**：HU 下误分类有具体机理——brain 单挑用 `btn_open` 宽表开局，任何风格 VPIP 都偏高，nit 也极易被分成 lag/calling_station → 剥削方向可能反转（对真 nit 少诈唬、放宽跟注）。锦标赛 HU/3 人终局阶段恰好是剥削价值最高的时刻。
- **影响**（推断）：有 confidence 门控（<10 手零修正）和钳制（bluffMult ∈ [0.1,2] 等）兜底，幅度受限。
- **修复**：`OpponentStats` 加位置桶（至少 early/late 二分）与 EWMA 近因衰减（如 λ=0.95/手）；`classify` 阈值按在局人数缩放（HU 的 nit 上限 VPIP 应远高于 0.2）；AF 拆街（flop/turn/river 分开计）。改动集中在 adapt.ts 的 updateStats/classify/buildModel 三函数。

### F9. adapt 多对手算术平均可反转剥削方向（新发现）

- **位置**：`adapt.ts:300-341` `adjustments` 按 confidence 加权算术平均。
- **机理**：混合池一例：nit（bluffMult 1.5，conf 0.7）+ station（0.25，conf 0.3）→ 聚合 ≈ 1.13 > 1 → 对含 station 的底池反而提高诈唬率，方向错误。乘性量（bluffMult）算术平均本身不是安全聚合；openRangeShift 平均到 -0.3 经 `Math.round`（brain.ts:820）归零，修正丢失。
- **修复**：面对下注的决策用下注者画像（依赖 F4）；主动决策取「最可利用对手」（如 station 优先）而非平均；bluffMult 聚合改取 min（最保守）。

### F10. bench 与生产的覆盖差距：adapt 路径零实测（新发现，流程性缺陷）

- **位置**：`scripts/selfplay/match.ts:311-319` 构造 DecideInput 不带 `opponentModels`/`recentHands`。
- **机理**：约 50 万手实验全部运行在 IDENTITY_ADJUSTMENT 下；`adjustments()`、`facingOpponentModel`、`inferFacingSpec` 的 oppModel 修正无任何配对赛证据与回归保护。F4/F8/F9 的任何修复都无法在现有台架验证收益。
- **修复**：match.ts 在手间累积各座位 OpponentStats（复用 adapt.updateStats），决策时 `buildModel` 注入；跑一组「adapt on/off」配对赛建立基线。

### F11. LLM 超时回退的可见性（线索 8，部分成立：「无法感知」不准确）

- **核实结论**：`opponent.ts:70-72` 静默 catch 回退启发式成立；但 UI 已有逐动作来源徽标（`HandInfoPanel.tsx:60-78` SourceBadge「启发式」，title「LLM 未启用或已回退」，230 行挂载），用户逐手可辨——**「无法感知」不成立**。真实缺口是：无聚合在线率（回退率）指标、无慢性失败告警；`decide` 的 catch 分支连 console 日志都没有（静默吞掉错误类型）。
- **修复**：store 累计 `{llmAttempts, llmFallbacks}` 计数并在设置页/桌角展示在线率；catch 内 `console.warn` 记录错误类别；连续 N 次回退时给用户一次性提示。

---

## 排除项 / 核实后不成立或影响可忽略

1. **线索 7（观战统计冻结）**：成立但影响可忽略。`gameStore.ts:1328` 观战手确实不更新 tableStats/recentHands，但触发前提是 hero 已出局（锦标赛淘汰/认输、现金局破产下桌），hero 自身决策已不存在；只影响观战阶段 AI-vs-AI 剥削模型的时效性与模拟观感。不值得单独修。
2. **线索 5 的「双重计数」严格命题**：不成立（见 F7，两机制建模不同效应）；降级为「系数未标定 + 施加对象过宽」的待测量项。
3. **线索 8 的「静默/无法感知」**：部分不成立（逐动作徽标已存在，见 F11）。
4. **equity tie 口径**（equity.ts / range.ts）：多人并列时 tie 按 1/2 计而非 1/k 计，轻微高估多人池胜率。触发频率低（多路平分底池），幅度可忽略，不建议改。
5. **缓存策略**（brain.ts:261 / range.ts:216 满即全清）：性能抖动非正确性问题；resetBrainCaches 已供台架复位，复现性有保障。
6. **blend 默认值**：线索中「决策用混合胜率」的 blend 问题已被实验解决——现行默认 `rangeBlendRandom: 0`（纯范围胜率）即实测最优（+120.8 vs +83.2，blend-report），无遗留问题。

## 修复优先级汇总

| 优先级 | 项 | 一句话 |
|---|---|---|
| P0 | F1 | buildDecideInput/heroDerived/match.ts 的 callAmount 按 me.stack 封顶 |
| P0 | F2 | postflopDecide 的 SPR 判定在 facingBet 时改用 eqF（并移入 warGuard 之后） |
| P1 | F3 | brainStats 增加 vs-range 口径，prompt/reasoning 双口径展示 |
| P1 | F4 | streetActions 升 SeatAction[]；facingOpponentModel 取真实加注者画像 |
| P1 | F5 | 翻前按加注者位置重估相对强度（依赖 F4；短期 ±0.05 修正近似） |
| P1 | F6 | streetRaisesSeen/preflopRaiseLevel 只计抬高下注线的动作 |
| P2 | F7 | 多人池 tighten × joint 双因子 bench A/B |
| P2 | F8 | OpponentStats 位置桶 + EWMA + 分街 AF；classify 按桌型缩放 |
| P2 | F9 | adjustments 聚合改最保守/关键对手优先 |
| P2 | F10 | bench 注入 opponentModels，跑 adapt on/off 基线 |
| P2 | F11 | LLM 回退率计数与展示 |

## 建议的验证顺序

F1/F2 改动小、方向明确，可直接改后跑既有回归（`__tests__/warGuard.test.ts`、`range.test.ts`、`brainTuning.test.ts`）+ 一次 6max 配对 smoke 确认无负效应。F4 是架构改动，建议独立进行并解锁 F5/F7/F9 的精确版。F10 是 F7/F8/F9 一切实测验证的前提，建议与 F4 之后第一批做。
