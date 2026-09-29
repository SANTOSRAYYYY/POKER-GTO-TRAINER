# scripts/selfplay — 大规模 self-play 参数调优台架

无头模拟器：不经 React/zustand/gameStore，直接驱动 `src/lib/poker/game.ts`
引擎 + `src/lib/ai/brain.ts` 决策（`brainDecide` 无 setTimeout，全同步）。

## 用法

```bash
# 推荐（tsx 不在依赖里，用 node_modules 的 esbuild 打成 cjs 再跑）
bash scripts/selfplay/build-and-run.sh --config scripts/selfplay/configs/baseline6.json --out scripts/selfplay/results/baseline6.json

# 配对模式：config 里加 seat0Alt 字段即自动启用
bash scripts/selfplay/build-and-run.sh --config scripts/selfplay/configs/paired-demo.json --out scripts/selfplay/results/paired-demo.json

# 配对发牌正确性校验
ENTRY=scripts/selfplay/verify-paired.ts bash scripts/selfplay/build-and-run.sh

# Phase 7 锦标赛 ICM A/B（8 人 SNG，座位 0 icmEnabled false→true，30 种子）
ENTRY=scripts/selfplay/icm-ab.ts bash scripts/selfplay/build-and-run.sh \
  --out scripts/selfplay/results/phase7-icm-seeds.json [--seeds 42:72]
```

stdout 打印摘要表（profit / bb/100 / 95% CI / VPIP / PFR / rebuys），
完整结果写 JSON 到 --out。`results/` 与 `.dist/` 已 gitignore。

## MatchConfig

```jsonc
{
  "seats": 6,                 // 2-9
  "hands": 3000,
  "smallBlind": 5, "bigBlind": 10,   // 要求 smallBlind < bigBlind
  "startStack": 1000,
  "masterSeed": 42,
  "progressEvery": 500,       // 可选，stderr 进度
  "resetStacksEachHand": true, // 可选：每手全员重置回 startStack（不结转、不记 rebuy），消滚雪球方差
  "seatBrains": [             // 长度 = seats
    { "style": "gto", "tuning": { "equityIterationsScale": 0.25 } }
    // ...tuning 可选，键见 src/lib/ai/brain.ts 的 BrainTuning
  ],
  "seat0Alt": { "style": "gto", "tuning": { "callMarginDelta": -0.05 } }
  // 存在 seat0Alt → runPaired：同一 masterSeed 两遍，发牌逐手一致
}
```

多种子配对结果合并（座位 0 差值序列拼接 + 合并 CI）：

```bash
ENTRY=scripts/selfplay/merge-paired.ts bash scripts/selfplay/build-and-run.sh <paired1.json> <paired2.json>
```

## 可复现性

- 每手发牌：`mulberry32(masterSeed * 100000 + handIndex)` 洗牌生成完整
  52 张 `deckPrefix` 注入 `createGame`；按钮 = `handIndex % seats` 轮转。
- 每手决策：`mulberry32(handSeed ^ 0x9e3779b9)` 同时作为 `brainDecide` 的
  rng 和本手期间的 `Math.random` 补丁（brain 蒙特卡洛 equity 用 Math.random）。
- 每场 match 开始调 `resetBrainCaches()`，消除进程内缓存历史。
- 配对：发牌只依赖 (masterSeed, handIndex)，与决策无关 → 两遍逐手一致；
  座位 0 的盈亏差值序列算配对 95% CI（见 `verify-paired.ts` 校验）。

## 输出字段（MatchResult）

`seats[*]`：`totalProfit` / `bb100` / `ci95BB100`（单手盈亏序列 ±1.96·SE）/
`vpip` / `pfr`（口径同 src/lib/ai/adapt.ts）/ `rebuys`（筹码 < bb 破产重置回
startStack 的次数）/ `profitSeries` / `topHands`（|盈亏| 最大的 20 手，含街道、
动作摘要、底牌、公共牌、输赢）。配对模式另出 `delta[*]`（B−A 配对 CI）。

## 速度

6 人桌实测：默认精度 ≈ 9 hands/s；`equityIterationsScale: 0.25`
（只缩放蒙特卡洛迭代数，下限 50；河牌单挑精确枚举不受影响）≈ 22-25 hands/s。
大规模锦标赛建议全员统一 scale。

## Phase 3 结论（2026-09-23，加注战护栏修复）

Phase 2（leak-hunt，15000 手结转基准）确认的结构性漏勺与修复：

- **L3（翻后价值加注互加链，估算 -598 bb/100/座下限）**：价值再加注用
  「vs 随机范围 equity ≥ 0.65」无差别触发，双方过线即几何互加至全下，
  且系统性选出被统治方（输家最后加注街真实胜率 24/31 手 <10%）。
- **L1（翻前 premium 互加链，-128 bb/100/座下限）**：pct ≥ 0.965（99+）面对
  3bet+ 无限 ×2.2 互加，无深度封顶。
- **L2（较小）**：面对 3bet+ 的跟注无数额上限。

**修复（brain.ts 加注战护栏，默认开启，`warGuardEnabled:false` 可整体关闭 A/B）**：
按本街攻击性动作层级（streetRaisesSeen：bet 算第 1 次，每次再加注 +1）升档——
翻后被 3bet（层级≥1）价值再加注需 eq ≥ 0.78（warRaiseEq3bet），被 4bet+
（层级≥2）需 ≥ 0.85（warRaiseEq4bet，河牌单挑精确枚举下 0.90），层级 ≥ 3
（warMaxRaises）后禁止再加注（eq ≥ 0.97 坚果豁免）；翻前被 4bet+ 时
pct ≥ 0.985（premium5betPct，约 QQ+/KK+）才允许继续加注，99-JJ 档深筹码
（≥30bb）降级为跟注；面对 3bet+ 非 premium 手牌跟注上限 25bb（callVs3betMaxBB）。

**不结转模式（resetStacksEachHand）**：每手全员重置 100bb，配对 CI 收窄约两个
数量级（15000 手座位 0 配对 CI 半宽从结转模式的 ±600+ 收窄到 ±3-5 bb/100），
成为配对验收的标准模式。注意它也压扁了链条杀伤的绝对值（单手最多 -100bb），
深筹码效应需用更深 startStack 单独测量。

**验收数据**（全 gto 6 人桌、scale 0.25、不结转、配对座位 0 唯一变量）：

| 实验 | 深度 | 种子 | diff bb/100 | 95% CI |
|---|---|---|---|---|
| 新脑 vs 旧脑 | 100bb | 42-49 合并（n=12万） | +0.6 | [-1.3, +2.5] |
| 新脑 vs 旧脑 | 200bb | 42 | **+19.9** | **[+3.6, +36.2]** |
| +valueRaiseEqHU 0.75 | 100bb | 42+43 合并（n=3万） | +5.8 | [+1.1, +10.6] |

结论：
- 护栏在 100bb 固定深度净效应 ≈ 0（8 种子 4 正 4 负，合并 +0.6，无亏损证据、
  最差情形被钳在 -1.3 以内）；链条/深筹杀伤随深度增长，200bb 下显著为正
  （+19.9，CI 全正）——护栏价值 ∝ 筹码深度，生产会话筹码结转 routinely 超
  100bb（Phase 2 基准曾滚到 10⁴ bb），真实价值更接近 200bb 档。机制修复按
  「机理 + 方向一致 + 大样本不亏」保留为默认开启。
- topHands 解剖：差异手仅 ~0.08%（11-13/15000），成本侧全部是 L2 正确弃牌
  （77/88 vs {99+} 全下范围 equity ~34% < 所需 40%）在具体发牌下的实现运气；
  收益侧为 L1/L3 断链（如 JJ 旧脑互加全下 -100bb → 新脑降级跟注中set +220bb）。
- valueRaiseEqHU 0.75：护栏之上叠加后合并 CI 全正（[+1.1, +10.6]）但中值
  +5.8 < +15 采纳线 → **不采纳**，默认保持 0.65。
- 其余 20+ 旋钮维持 Phase 2 结论（证据不足保持默认）。
- 生产精度 smoke：scale 1、3000 手、6 人桌结转模式正常完成（5.1 hands/s 受
  并行任务影响，无错误，VPIP/PFR 正常，零和校验通过）。

配置：`configs/phase3-*.json`；结果：`results/phase3-*.json`；
双种子合并工具：`merge-paired.ts`（ENTRY 覆盖用法见上）。

## Phase 4 结论（2026-09-23，范围推断引擎验收 + blend 定默认值 + L2' 修复）

**范围推断（rangeMode）大样本验收**（配对座位 0 唯一变量 = 开/关范围引擎，
scale 0.25、不结转；详细数据见 `results/phase4-range-*-report.md`）：

| 场景 | n（配对手） | diff bb/100 | 95% CI |
|---|---|---|---|
| 6 人桌 100bb | 96000（s42-49） | +104.1 | [+95.6, +112.7] |
| 9 人桌 100bb | —（s42-49） | +85.7 | [+77.5, +93.9] |
| 单挑 100bb | —（s42-47） | +85.0 | [+76.2, +93.8] |
| 200bb 深筹（6+9 人桌） | 80000 | +156.8 | [+139.3, +174.2] |

全部 CI 全正，范围引擎采纳为默认开启（`rangeModeEnabled: true`）。

**blend 默认值决策**：扫描（vs 关范围基线，各 n=36000）0.0 → +120.8
[+104.5, +137.1]、0.5 → +83.2 [+71.0, +95.4]，呈单调剂量反应；b00 vs b50
同发牌直接对决 +37.6 [+26.0, +49.2]。补上最后缺的 0.0 vs 0.3 直接对决
（`configs/phase4/blend-final/s{45-48}.json`，6 人桌 100bb 不结转、
hands=12000，A 侧座位 0 `rangeBlendRandom:0.3`、B 侧 `0.0`，均开 rangeMode）：

| seed | diff bb/100 | 95% CI |
|---|---|---|
| 45 | +18.1 | [+0.8, +35.4] |
| 46 | +19.0 | [+4.0, +33.9] |
| 47 | +14.3 | [-2.3, +31.0] |
| 48 | +20.5 | [+4.2, +36.7] |
| **合并（n=48000）** | **+18.0** | **[+9.8, +26.1]** |

合并 CI 全正 → **采纳 `rangeBlendRandom: 0`（纯范围胜率）为新默认**
（`DEFAULT_BRAIN_TUNING` 已从 0.3 改为 0）。结果：
`results/phase4-blend-final-s{45-48}.json`。

**L2' 修复（残余漏勺）**：漏勺复查发现「premium 手豁免 25bb 跟注上限」让
99-JJ 档（pct ∈ [premiumPct 0.965, premium5betPct 0.985)）面对 3bet+ 深筹码
形成无限跟注链（实测单手 -26100bb）。修复：`callVs3betMaxBB`(25) 的 premium
豁免收窄——pct ≥ 新旋钮 `callVs3betPremiumExemptPct`（默认 0.985，KK+/AA 档）
才豁免；99-JJ 档面对 >25bb 的 3bet+ 跟注额直接弃牌（该档在 warGuard 里本就
4bet 降级 call，此处把 call 的金额上限也管住）。`callVs3betPremiumExemptPct: 0`
= 全部 premium 豁免（旧行为，供 A/B）。单元测试新增 6 例（warGuard.test.ts
「L2'」组）：99 面对 40bb 4bet 链弃牌、AA/KK 豁免继续加注、浅筹码 18bb 不受
影响维持全下、旋钮 0 与 warGuardEnabled:false 分别恢复旧行为。

**L2' 烟测**（`configs/phase4/leak-l2prime/s42.json`，6 人桌 100bb 不结转、
scale 0.25、12000 手配对，A 侧 `callVs3betPremiumExemptPct:0` vs B 侧 0.985）：
座位 0 diff **+0.7 bb/100，95% CI [-2.3, +3.7]** —— 偏正且无明显负，符合
方向性验收口径。100bb 固定深度下 99-JJ 遇 >25bb 3bet+ 跟注额的触发面很窄
（需 5bet 级链条），净效应 ≈ 0 符合预期；修复价值在深筹/结转场景
（与 Phase 3 护栏「价值 ∝ 筹码深度」同一逻辑）。结果：
`results/phase4-l2prime-smoke-s42.json`。

回归：`npx vitest run` 326/326 全绿（26 文件），`npx tsc --noEmit` 无错误。

## 2026-09-23 审计修复（F1/F2/F4/F5/F6/F10）对台架口径的影响

- **F1**：`match.ts` 构造 DecideInput 的 `callAmount` 按 `min(currentBet - streetBet, stack)`
  封顶（与引擎 legalActions 的 call 口径一致）；修复前深打浅的 overbet/全下会按
  虚高金额计价（双侧同病，配对差值恒为 0 所以旧实验不可见）。
- **F10**：`match.ts` 跨手累积各座位 OpponentStats（与生产 gameStore 同一
  `updateStats` 口径），决策时注入 `opponentModels`——剥削路径（adapt.ts）自此
  进 bench 覆盖。注意：这使 bench 行为与 phase3/phase4 的旧结果不完全可比
  （旧实验全部运行在 IDENTITY_ADJUSTMENT 下）。
- **F4**：引擎 `GameState.streetActions` 升级为 `SeatAction[]`（携带行动者座位）；
  brain 的范围推断画像取本街最后一名抬线下注者，翻前支持按加注者位置调制（F5 旋钮
  `preflopPosAdjustEnabled` / `preflopPosAdjustUTG` / `preflopPosAdjustBTN`）。
- **F6**：`streetRaisesSeen`/`preflopRaiseLevel` 只计「完整加注」（增量 ≥ 当时
  minRaise）；不足最小加注额的 short all-in 是跟注性质，不再触发护栏升档。

**F5 配对验收**（`configs/phase5/posadj-s{42,43}.json`：6max 100bb 不结转、
scale 0.25、hands=12000，座位 0 唯一变量 = 关（A）vs 开（B），B−A）：

| seed | diff bb/100 | 95% CI |
|---|---|---|
| 42 | -1.5 | [-11.5, +8.4] |
| 43 | +11.2 | [+1.4, +20.9] |
| **合并（n=24000）** | **+4.8** | **[-2.2, +11.8]** |

合并 CI 跨零且中值 < +15 采纳线 → **不采纳为新默认**，`preflopPosAdjustEnabled`
默认 false（机制保留，旋钮可供后续更大样本 A/B）。结果：
`results/phase5-posadj-s{42,43}.json`。

## Phase 6 结论（2026-09-23，对手建模 v2：位置维度 + 近因加权）

**机制**（`src/lib/ai/adapt.ts`）：
- **位置分桶**：VPIP/PFR 按翻前行动时身后人数分桶（early ≥5 / middle 2-4 /
  late ≤1，单挑全归 late），总量口径保留；`classifyPositional` 用超额加权
  校正 VPIP（桶基线 0.17/0.30/0.50，挂回总体锚点 0.28），「BTN 松 + UTG 紧」
  不再误判为全面松浪；样本不足的桶回退总体口径。
- **位置敏感剥削**（brain 旋钮 `adaptPositionalEnabled`）：加注者 late 桶
  VPIP 超基线 15pp → 盲位防守放宽（facingRaiseDelta −0.04）；maniac 在
  early 位加注 → 收紧给尊重（+0.04）。作用于翻前 callVsRaisePct /
  value3betPct，按加注者置信度缩放。
- **近因加权**（旋钮 `adaptRecencyLambda`，默认 0.92）：updateStats 每手
  更新前旧计数 ×λ（λ=1.0 = 整数旧口径）；confidence 改用衰减后有效样本量
  （稳态 ≈12.5 手）。模块级旋钮，updateStats 签名不变；台架每场 match 开始
  按座位 0 的 `tuning.adaptRecencyLambda` 应用（配对两臂各自生效）。

**配对验收**（`configs/phase6/adapt-s{42,43,44}.json`：6max 五风格混桌
（座位 1-5 = nit/tag/lag/maniac/calling_station）、座位 0 = gto、100bb
不结转、scale 0.25、hands=15000；A 侧座位 0 旧口径 vs B 侧全开，B−A）：

| seed | diff bb/100 | 95% CI |
|---|---|---|
| 42 | +31.3 | [+17.6, +45.0] |
| 43 | +10.2 | [−2.9, +23.4] |
| 44 | +22.4 | [+8.0, +36.7] |
| **合并（n=45000）** | **+21.3** | **[+13.4, +29.2]** |

合并 CI 全正且中值 +21.3 > +15 采纳线 → **采纳为默认开启**
（`adaptPositionalEnabled: true`、`adaptRecencyLambda: 0.92` 维持默认）。
详细机制与数据：`results/phase6-adapt-report.md`。

## Phase 7（2026-09-26，每座位独立近因 λ 的台架机制）

λ 旋钮从「整场全局」改为「每座位（观察者视角）独立」：
`updateStats` 增加可选第 4 参 `lambdaOverride`（生产 gameStore 不传，走
模块默认 0.92，行为不变）；match.ts 的 oppStats 升级为 [观察者][对象]
二维表，观察者 o 的建模表用座位 o 自己的 `tuning.adaptRecencyLambda`
（缺省 0.92）衰减。配对模式下座位 0 是唯一变量 ⇒ 两臂只有座位 0 的
建模视角 λ 不同，其余座位的建模不再被座位 0 的旋钮污染（Phase 6 时期
是整场一起换）。Phase 6 结论在此机制改动之前取得，数据不可直接对比。
λ=0.96 扫描数据：`results/phase7-lambda-report.md`。

## Phase 8（2026-09-26，翻前范围推断闭环 F5：验收未过线，默认关闭）

**机制**（`preflopRangeModeEnabled`，brain.ts + range.ts）：翻前面对一次加注的
跟注/3bet 判定从「对随机胜率的静态百分位」换成「对加注者开局范围的真实
胜率」——加注者身后人数 → 开局范围宽度分档（≥6→15% / 4-5→20% / 2-3→28% /
1→40% / 0→55%，range.ts `preflopRaiserRangePct`），手牌胜率查 169 牌型 × 5 档
离线静态表 `PREFLOP_VS_RANGE_EQUITY`（`gen-preflop-range-table.ts` 生成，蒙特卡洛
每格 4000 次、固定种子、单调性修整）；判定改绝对口径（对范围胜率 ≥0.42-0.48
跟注 / ≥0.58-0.67 价值 3bet，风格增量/剥削/ICM/大盲折扣继续叠加）。开启时
`preflopPosAdjustEnabled` 失效（不叠加）。中对子对紧范围缩水（77 vs 15% 范围
0.474，百分位口径 0.946）等效应由静态表直接表达。

**配对验收**（`configs/phase8/preflop-s{42,43,44}.json`：6max 100bb 不结转、
scale 0.25、hands=12000，座位 0 唯一变量 = 关（A）vs 开（B），B−A）：

| seed | diff bb/100 | 95% CI |
|---|---|---|
| 42 | +3.3 | [-17.0, +23.6] |
| 43 | +2.3 | [-18.3, +22.8] |
| 44 | +10.4 | [-8.7, +29.6] |
| **合并（n=36000）** | **+5.3** | **[-6.2, +16.9]** |

合并 CI 跨零且中值 +5.3 < +15 采纳线 → **不采纳为新默认**，
`preflopRangeModeEnabled` 默认 false（机制保留；三种子全正、座位 0 VPIP
-6pp 符合设计方向，深筹/混风格桌复测待后续）。
机制/口径映射表/测试清单详见 `results/phase8-preflop-report.md`。

同相位顺带交付：LLM 大底池 self-consistency 投票（opponent.ts，底池 ≥25bb
或河牌街并行采样 3 次多数投票，平票取保守序，金额中位数，全失败回退启发式；
旋钮 `LLMConfig.selfVote` 默认开；单测覆盖，成本原因不做大样本台架）。

## Phase 8b（2026-09-26，摊牌学习 + blocker 效应：验收未过线，默认关闭）

**机制**（`src/lib/ai/adapt.ts` / `range.ts` / brain.ts 接入点）：
- **摊牌学习**（`showdownLearnEnabled`）：updateStats 把对手摊牌亮牌记入
  `showdownsSeen` 环形缓冲（30 条/座位，含位置桶/169 牌型/翻前首个主动作；
  match.ts 的 updateStats 记录自此补齐亮牌注入）；`rangeWidthAdjustment`
  把该桶弱牌占比渲染为范围宽度乘数（<5 样本不动 / 全强 0.9 / 占比 >0.3
  线性放宽至 1.5 封顶），按置信度缩放后作用于翻前面注（范围口径 topPct
  直接乘 / 百分位口径缩放 (1-callPct)）与翻后 facing spec 的 topPct。
- **blocker**（`blockerEnabled`）：equityVsRange 采样按 hero 底牌对范围组合
  降权（hero 持同花色 A → 对手该花色同花听 ×0.55；hero 对子点数在 board →
  对手含该点数三条组合 ×0.5）；均匀池退回旧公式路径，旋钮关闭逐比特回归。

**配对验收**（6max 混风格 100bb 不结转、scale 0.25、hands=12000、seeds 42-44，
座位 0 唯一变量开/关；摊牌学习两组上下文——终默认（preflopRangeMode 关）与
过渡（开）各一组；blocker 一组）：

| 机制（上下文） | 合并 diff bb/100（n=36000） | 95% CI |
|---|---|---|
| 摊牌学习（终默认） | +1.4 | [-3.4, +6.2] |
| 摊牌学习（过渡，preflopRangeMode 开） | +0.0 | [-3.0, +3.1] |
| blocker | -0.3 | [-1.3, +0.7] |

两组均 CI 跨零且中值 << +15 采纳线 → **均不采纳**，`showdownLearnEnabled` /
`blockerEnabled` 默认 false（机制保留供 A/B）。详细数据与机理分析：
`results/phase8-showdown-blocker-report.md`；
配置 `configs/phase8/showdown-final-*.json`（终默认）、`showdown-*.json`
（过渡）、`blocker-*.json`。

## Phase 9（2026-09-26，200bb 深筹 + 混风格桌复测：翻前闭环保底过线，建议开默认）

对 Phase 8/8b 未过线的三机制做 200bb 复测（6max、startStack 2000、不结转、
scale 0.25、hands=12000、seeds 42-44、座位 1-5 = nit/tag/lag/maniac/
calling_station、座位 0 唯一变量开/关，B−A）：

| 组 | 合并 diff bb/100（n=36000） | 95% CI | 判定 |
|---|---|---|---|
| 翻前闭环（preflopRangeMode） | **+29.7** | **[+9.7, +49.7]** | ✅ 过线（三种子全正，s43/s44 单种子 CI 全正） |
| 摊牌学习（showdownLearn） | +3.9 | [-3.8, +11.6] | ❌ |
| 摊牌学习 + adaptRecencyLambda 0.96 | +5.1 | [-6.9, +17.2] | ❌（λ 不是效应量开关，疑因证伪） |
| blocker | +0.1 | [-2.8, +3.1] | ❌（200bb 升值假设不成立） |

翻前闭环深筹下效应兑现：VPIP 29.2%→22.3%（-6.9pp，同 Phase 8 设计方向），
按「合并 CI 全正且中值 >+15」判定线**建议 `preflopRangeModeEnabled` 开默认**
（本相位只出建议，src 默认值未动）。注意归因混杂：100bb 基线是全 gto 桌、
本次是混风格桌，深度与桌型同变（遗留问题：可补 100bb 混风格桌对照拆分）。
详细数据/解读/遗留清单：`results/phase9-deep-retest-report.md`；
配置 `configs/phase9/*.json`；执行器 `configs/phase9/run-all.sh`
（批式 2 并发，esbuild 单次打包后直跑 node，避免并发写同一 bundle）。

## Phase 10（2026-09-29，多人池面注防守 V2 未过线默认关 + HU btn_open 表修正）

- **多人池面注防守 V2**（`multiwayDefenseV2Enabled`，与训练器 2026-09-29
  「只对下注者」防守框架对齐：spec 不按人数收紧、只抽下注者 1 人、跟注门槛
  步进降为 0.01/人实现率税；审计 A1）：6max 混风格 12000 手 × seeds 42-44
  配对合并 **-12.8 bb/100 [-19.0,-6.5]**（n=36000，三种子全负）——CI 全负
  远离采纳线 → **默认关闭，机制保留供 A/B**。HU 6000 手配对 V2 开/关逐手
  差值 0/6000（单挑路径逐比特回归 ✓）。
- **HU btn_open 表**（审计 A4：实装 45% vs 注释「≈80%」）：改为与 9max SB
  对 BB 同一构成（82% 标签 / 76% 组合可玩），brain 与范围表页共用同表同时
  生效。HU 6000 手 × seeds 42-43 前后对比：全桌 VPIP 33.3%→57.5%（回 50%+
  合理区间），EV 逐手同发牌配对合并 -9.5 [-28.5,+9.6]（CI 跨零，无劣化证据）
  → **采纳为表数据修正**。
- 详细数据/判定/解读：`results/phase10-multiway-defense-v2-report.md`；
  配置 `configs/phase10/*.json`；跨版本同发牌配对工具 `diff-runs.ts`
  （before/after 两组 match 结果逐手差值 + 合并 CI）。
