# Phase 7：近因衰减 λ 扫描 —— λ=0.96 vs 基准 0.92 配对验收报告

日期：2026-09-26
台架机制改动：`src/lib/ai/adapt.ts`（updateStats 可选第 4 参）/
`scripts/selfplay/match.ts`（每座位独立 λ）
配置：`configs/phase7/lambda-s{42,43,44}.json`；
结果：`results/phase7-lambda-s{42,43,44}.json`

## 结论（先给答案）

**不采纳 λ=0.96，生产默认值维持 0.92 不变**（adapt.ts 未动生产默认值，
本次仅报告数据）。合并三种子（n=36000 配对手）座位 0 diff
**−4.4 bb/100，95% CI [−10.5, +1.7]**——CI 未全正、中值为负，
距「CI 全正且 > +15」的采纳线很远；方向甚至有亏损迹象
（seed42 单种子显著为负 [−19.0, −1.8]）。

## 台架机制改动：每座位独立 λ（本次前置工作）

原实现（Phase 6 时期）：λ 是 adapt.ts 模块级旋钮，match.ts 每场 match
开始按座位 0 的 `tuning.adaptRecencyLambda` 调 `setAdaptRecencyLambda`——
**整场所有座位的建模表一起换 λ**。配对两臂虽只差座位 0 配置，但整张桌
的建模口径都跟着变，座位 0 的 diff 混入了其他座位建模变化的二手效应。

本次改为每座位（观察者视角）独立 λ，最小改动两处：

- `adapt.ts`：`updateStats(stats, record, seat, lambdaOverride?)` 增加可选
  第 4 参（钳制 [0.5, 1]，与 setAdaptRecencyLambda 同口径）；不传走模块
  默认值——生产 gameStore 路径不传参，行为逐比特不变。
- `match.ts`：oppStats 从「按对象座位一维共享表」升级为
  `[观察者][对象]` 二维表；观察者 o 的建模表用座位 o 自己的
  `tuning.adaptRecencyLambda`（缺省 0.92）衰减；决策时行动者从自己视角的
  表 buildModel 注入 opponentModels。每手 updateStats 调用 6×6=36 次
  （原 6 次），实测速度 ~13-14 hands/s（原 ~16，可接受）。

效果：配对两臂只有**座位 0 的建模视角** λ 不同（0.92 vs 0.96），其余
五座视角固定 0.92，变量隔离比 Phase 6 更干净。Phase 6 及更早的 λ 相关
结论是在旧机制（整场同 λ）下取得，与本表数据口径不同，不可直接对比。

正确性校验（改动后、正式跑之前）：

- `verify-paired.ts`：200 手配对，发牌逐比特一致 + 零和校验通过；
- 空配对对照（`configs/phase7/lambda-nullcheck.json`，两臂配置完全相同
  200 手）：六座 diff 全部恰为 +0.0 [+0.0, +0.0]——机制无隐藏污染；
- 烟测（`lambda-smoke.json`，400 手配对）：正常出数，λ 臂间产生非零
  diff（旋钮确实生效）。

## 验收设计（配对，唯一变量 = 座位 0 建模的近因 λ）

- 6max 现金桌 100bb（sb/bb = 5/10，startStack 1000），
  `resetStacksEachHand: true`，`equityIterationsScale: 0.25`，
  hands=12000/种子，seeds 42/43/44，conc=1（比特级可复现）；
- 座位 0 = gto：A 臂 `adaptRecencyLambda: 0.92`（基准），
  B 臂 `0.96`；其余座位 tuning 只有 scale；
- 座位 1-5 = nit/tag/lag/maniac/calling_station（固定风格猎物，
  剥削才有猎物）；
- `adaptPositionalEnabled` 保持默认 true（两臂一致，非本实验变量）。

## 数据（座位 0，B−A）

| seed | A（λ=0.92）bb/100 | B（λ=0.96）bb/100 | diff bb/100 | 95% CI |
|---|---|---|---|---|
| 42 | −3.8 | −14.2 | −10.4 | [−19.0, −1.8] |
| 43 | −16.9 | −17.2 | −0.3 | [−12.7, +12.1] |
| 44 | −3.5 | −5.9 | −2.5 | [−12.9, +7.9] |
| **合并（n=36000）** | | | **−4.4** | **[−10.5, +1.7]** |

合并命令：`ENTRY=scripts/selfplay/merge-paired.ts bash scripts/selfplay/build-and-run.sh results/phase7-lambda-s4{2,3,4}.json`

其余座位 diff（溢出效应参考，非判定依据）：座位 1（nit）三种子一致小正
（+2.9/+2.3/+2.4）——座位 0 建模变慢后 nit 被剥削得略少；其余座位
diff 均跨零。

## 解读与后续

- λ=0.96（稳态有效样本 ~25 手，confidence 上限 ~0.65）相对 0.92
  （~12.5 手 / 上限 ~0.36）：记忆更长、分类置信度更高，但对打法漂移的
  跟踪更慢，且**早期误分类会被更高置信度放大成更强的错误剥削**。
  本桌对手风格虽固定，但 12000 手里按钮轮转/深浅位置带来的分布漂移
  仍存在；实测方向偏负，说明 0.92 的「快跟踪 + 低置信度保守剥削」
  组合在当前剥削规则表下已是更优点。
- 不排除 λ < 0.92（更快衰减）方向有利，或 λ 与 confidence 曲线
  联动重标定（λ=0.96 同时压置信度上限）后再测——超出本次范围，
  留作后续实验候选。
- 遗留：brain.ts 的 BrainTuning.adaptRecencyLambda 注释仍描述旧机制
  （「每场 match 开始按座位 0 调 setAdaptRecencyLambda」）——该文件不在
  本次改动边界内，未动；建议后续顺手更新为「台架按座位经 updateStats
  第 4 参应用」。
