# Phase 6：对手建模 v2 —— 位置维度建模 + 近因加权 验收报告

日期：2026-09-23
机制实现：`src/lib/ai/adapt.ts` / `src/lib/ai/brain.ts` / `src/lib/ai/prompt.ts`
台架配置：`configs/phase6/adapt-s{42,43,44}.json`；结果：`results/phase6-adapt-s{42,43,44}.json`

## 机制

### 位置分桶（OpponentStats 扩展）

VPIP/PFR 在总量口径之外按翻前行动时「身后人数」分桶累积
（`pfBucketHands/pfBucketVpip/pfBucketPfr`，与总量同步衰减）：

| 桶 | 身后人数 | 6max 对应 | VPIP 基线（6-max 常识） |
|---|---|---|---|
| early | ≥5 | UTG | 0.17 |
| middle | 2-4 | HJ/CO/BTN | 0.30 |
| late | ≤1 | SB/BB（盲位侧） | 0.50 |

单挑特殊处理：两座全归 late。3 人桌 UTG 环绕回按钮（与 positions.ts
actOrderInfo 修复后口径一致）。旧存档/旧对象缺分桶字段时归一化为零桶
（normalizeStats，不炸不丢总量）。

### 桶校正分类（classifyPositional）

超额加权法：`correctedVpip = 0.28（总体锚点）+ Σ w_b·(vpip_b − baseline_b) / Σ w_b`，
只用（有效）样本 ≥ 3 的桶，全不足回退总体口径；分类阈值表不变。
「BTN 开局 40% 正常、UTG 开局 40% 是松浪」——后位松前位紧的玩家不再被
误判为全面松浪/跟注站（单元测试：总体口径判 calling_station、桶校正判 tag）。

### 位置敏感剥削（brain 旋钮 adaptPositionalEnabled）

- 加注者 late 桶 VPIP > 基线+15pp（偷盲狂）→ 盲位防守放宽
  （facingRaiseDelta −0.04，按加注者置信度缩放、不被其他对手稀释）；
- maniac 在 early 位加注 → 收紧给尊重（facingRaiseDelta +0.04）；
- 作用于翻前 callVsRaisePct 与 value3betPct；旋钮关闭/无模型/对手
  unknown 时恒为 0（逐比特旧行为）。

### 近因加权（旋钮 adaptRecencyLambda，默认 0.92）

updateStats 每手更新前旧计数 ×λ；λ=1.0 退化为整数累加旧口径。
稳态有效样本 ≈ 1/(1−λ) ≈ 12.5 手：对打法突变十几手内完成跟踪，代价是
confidence 上限被压到 ≈0.36（10 手起步 0.3 的曲线几乎触顶即平）。
confidence 公式改用有效样本量。updateStats 签名不变（λ 为 adapt.ts 模块级
旋钮；台架每场 match 开始按座位 0 的 tuning.adaptRecencyLambda 应用，
配对两臂各自生效；生产 gameStore 固定默认值）。

## 验收设计（配对，唯一变量 = 座位 0 建模口径）

- 6max：座位 0 = gto；座位 1-5 固定 nit/tag/lag/maniac/calling_station
  （剥削价值只在桌上有不同打法时可测）；
- A 侧座位 0：`adaptPositionalEnabled:false + adaptRecencyLambda:1.0`（旧口径）；
  B 侧座位 0：默认全开（positional on + λ=0.92）；
- resetStacksEachHand: true、equityIterationsScale 0.25（全员）、
  hands=15000、seeds 42/43/44 三场，merge-paired 合并；
- 采纳线（与 F5 同一标准）：合并 CI 全正且中值 > +15 bb/100 → 保持默认开启；
  否则默认关闭旋钮但保留机制。

## 结果

座位 0 配对差值（B − A，发牌逐手一致；正值 = 新口径更赚）：

| seed | hands | diff bb/100 | 95% CI |
|---|---|---|---|
| 42 | 15000 | +31.3 | [+17.6, +45.0] |
| 43 | 15000 | +10.2 | [−2.9, +23.4] |
| 44 | 15000 | +22.4 | [+8.0, +36.7] |
| **合并** | **45000** | **+21.3** | **[+13.4, +29.2]** |

（合并由 `merge-paired.ts` 计算：三座种子差值序列拼接，mean ± 1.96·SE；
sd/手 ≈ 8.6bb。）

参照：A 侧（旧口径）座位 0 三种子 bb/100 为 −30.7 / −26.0 / −27.1，
B 侧（全开）为 +0.6 / −15.7 / −4.7——剥削建模在五风格混桌把 gto 座位
从明显负期望拉到近零/微负。

## 判定

合并 CI 全正（+13.4 > 0）且中值 +21.3 > +15 采纳线 → **采纳**：
`adaptPositionalEnabled: true` 与 `adaptRecencyLambda: 0.92` 保持默认开启，
机制与旋钮同时保留（`adaptPositionalEnabled:false` + λ=1.0 可整体退回旧口径）。

备注：λ=0.92 把 confidence 上限压到 ≈0.36（稳态有效样本 ≈12.5 手），
剥削力度偏保守但仍过线；更大 λ（如 0.96，稳态 25 手）能否兼得「跟踪突变」
与「更高置信度」留待后续扫描（旋钮已就位）。

回归：`npx vitest run` 全绿（30 文件 394 测试），`npx tsc --noEmit` 无错误。
