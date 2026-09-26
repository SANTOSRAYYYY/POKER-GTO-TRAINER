# Phase 8：摊牌学习（showdown-calibrated ranges）+ blocker 效应 — 配对验收报告

日期：2026-09-26。台架：6max 现金 100bb、resetStacksEachHand、scale 0.25、
hands=12000、seeds 42/43/44、座位 0 = gto + 被测机制开/关（配对唯一变量）、
其余五座混风格（nit/tag/lag/maniac/calling_station，均 scale 0.25）。
判定纪律：合并 CI 全正且中值 > +15 bb/100 才采纳为默认开启，否则默认关闭保留旋钮。

## 机制实现要点

### 任务 1：摊牌学习（adapt.ts + brain.ts）

- **亮牌记录**：`updateStats` 在每手记录（HandRecord）中读取摊牌玩家的底牌
  （契约：`players[].cards` 仅摊牌且未弃牌时非 null；生产 gameStore 对 hero
  恒亮牌，故要求 `record.showdown && !folded` 双条件），写入
  `stats.showdownsSeen` 环形缓冲（上限 30 条/座位，新在后）。每条记录
  `{ seat, bucket, handType, action }`：bucket = 翻前行动位置桶
  （与 bucketOfPreflop 同口径），handType = 169 型记号（"J4o"/"AKs"/"TT"），
  action = 翻前首个主动作（open_raise / call / three_bet / four_bet_plus /
  check；allin 按下注线归类，与 PFR 同口径）。环形窗口自带近因性，不随 λ 衰减。
  字段类型以 `OpponentStatsWithShowdowns` 结构化扩展挂在 OpponentStats 上
  （types.ts 不动；JSON 持久化天然兼容，旧存档缺字段按空缓冲处理）。
  台架侧 match.ts 的 updateStats 记录补齐亮牌注入（此前 cards 恒 null）。
- **宽度调整** `rangeWidthAdjustment(stats, bucket)`：该桶亮牌 < 5 条 → 1；
  弱牌（翻前强度百分位 < 0.5，强度序为 brain PREFLOP_ORDER 的同源拷贝，
  测试锚点断言一致）占比 = 0 → 0.9 微收；≤ 0.3 → 1（噪声带）；> 0.3 →
  线性放宽 `1 + (占比−0.3)×(0.5/0.7)`，钳顶 1.5（全弱牌触顶）。
- **接入**（brain.ts，`showdownWidthMult` 按模型置信度缩放：1+(w−1)×conf）：
  - 翻前面对一次加注：preflopRangeMode 口径下对加注者开局范围宽度
    （preflopRaiserRangePct）topPct 直接乘；百分位口径下继续范围宽度
    (1−callPct) 同比例缩放（`callPct = 1 − (1−callPct)×w`）。
  - 翻后面对下注/加注：inferFacingSpec 第 5 参 widthMult 作用于 topPct。
  - 旋钮 `showdownLearnEnabled`；关闭/无画像/无亮牌调整时精确跳过，
    逐比特旧行为（单测覆盖）。

### 任务 2：blocker 效应（range.ts）

- `buildRangePool` 增加逐组合权重数组（`strongW`/`bluffW`，仅旋钮开启且规则
  命中时非 null）：hero 持某花色 A → 对手该花色同花听组合（hole+board 恰 4 张
  该花色且 hole ≥1 张，纯公共四花不降权）×0.55；hero 对子点数在 board 出现 →
  对手含该点数的三条组合 ×0.5；两规则命中同组合时连乘。
- 采样：`equityVsRange` 第 7 参 `blockerEnabled`。加权池按权重线性扫描选牌；
  均匀池（无命中）退回旧公式路径——与 blockerEnabled=false **逐比特一致**，
  且缓存键统一归并到 blk0（pool/equity 两级缓存共享）。
- rng 消耗口径：每次抽牌仍恰好 1 次 `rng()`（权重只改变 t→组合的映射），
  单挑（opponents=1）随机数消耗序列长度与旧版一致；多人池冲突重抽次数随
  权重分布可能不同。配对两臂同发牌、各自合法，差值 CI 不受影响。

## 配对结果

### 摊牌学习（座位 0：showdownLearnEnabled false → true）

最终默认上下文（全部座位 preflopRangeModeEnabled=false 钉死，与该机制验收后的
生产默认一致；configs/phase8/showdown-final-s{42,43,44}.json）：

| seed | diff bb/100 | 95% CI |
|---|---|---|
| 42 | +1.5 | [-6.8, +9.9] |
| 43 | +7.1 | [-1.8, +16.1] |
| 44 | -4.5 | [-12.2, +3.1] |
| **合并（n=36000）** | **+1.4** | **[-3.4, +6.2]** |

参考：在并行机制 preflopRangeModeEnabled=true 的过渡上下文下（configs/phase8/
showdown-s{42,43,44}.json，其余相同）合并 +0.0 bb/100 [-3.0, +3.1]（逐种子
+0.6 [-4.9,+6.1] / −1.3 [-6.2,+3.7] / +0.8 [-4.4,+6.0]）——两口径结论一致。

### blocker 效应（座位 0：blockerEnabled false → true）

configs/phase8/blocker-s{42,43,44}.json（blocker 只作用翻后 equity 采样，
与翻前口径无关，无需随 preflopRangeMode 翻转重测）：

| seed | diff bb/100 | 95% CI |
|---|---|---|
| 42 | +0.4 | [-0.8, +1.6] |
| 43 | +0.0 | [-1.2, +1.2] |
| 44 | -1.4 | [-3.9, +1.2] |
| **合并（n=36000）** | **-0.3** | **[-1.3, +0.7]** |

## 判定

- **摊牌学习**：合并 CI 跨零（[-3.4, +6.2]）且中值 +1.4 << +15 采纳线 →
  **不采纳**，`showdownLearnEnabled` 默认 false（机制保留供 A/B；亮牌记录
  本身继续累积数据，决策零影响）。终默认上下文与过渡上下文（+0.0 [-3.0,+3.1]）
  结论一致；seed43 单点 +7.1 但 CI 仍跨零，属噪声量级。
- **blocker**：合并 CI 跨零且中值 -0.3 ≈ 0 → **不采纳**，`blockerEnabled`
  默认 false（机制保留供 A/B；方向性单测证明降权方向正确——hero 持 A♠ 顶对
  场景胜率 +0.9pp（0.8562→0.8648）、hero 对子中 set 场景 +0.2pp——但 100bb
  6max 频次×幅度积不出可测净值；配对 sd/手仅 0.7-1.4bb，CI 已足够窄，
  再堆手数预计仍 ≈0）。
- 两旋钮默认均为 false；生产行为与 Phase 8 前逐比特一致（`tuning={}` 回归
  测试覆盖；亮牌记录本身不影响决策，仅累积数据）。

## 测试

新增 `src/lib/ai/__tests__/showdownBlocker.test.ts`（19 例）：
- updateStats 亮牌记录：open_raise/call/three_bet/four_bet_plus/check 分档、
  allin 抬线归类、非摊牌/弃牌/cards null 不记、环形上限 30 丢最旧、λ 衰减
  不动缓冲、无亮牌手引用前滚；
- rangeWidthAdjustment：样本门槛（<5→1）、方向（全弱→1.5 / 半弱→≈1.143 /
  占比 0.3 边界不放 / 全强→0.9）、桶隔离、强度百分位边界（J5s=0.5 算强、
  Q5o≈0.494 算弱）；showdownWidthMult 置信度缩放（conf 0.5 → 半量、conf 0 → 1）；
- inferFacingSpec 第 5 参：×1.5 钳顶 0.8、×0.9、缺省/1 不变；
- blocker：A♠ 同花听降权方向、对子三条降权方向、无命中逐比特旧路径、
  缺省 ≡ 显式 false 回归；
- brain 接入：百分位口径与 preflopRangeMode 口径各一组（亮牌全弱放宽 /
  旋钮关闭恢复 / 关闭+富亮牌 ≡ 开启+无亮牌逐比特）、翻后无数据 ≡ 关闭逐比特。

回归：`npx tsc --noEmit` 无错误；`npx vitest run` 588 例中 587 通过——唯一失败为
负载敏感的翻牌圈性能基准（120ms 门槛）：空载单跑 71.8ms 通过，全量并行下受机器
负载波动（本机制接入前的基线运行同样失败过 121.5ms；blocker 默认关闭后热点路径
与旧代码逐比特一致，无性能回退）。

## 遗留问题

- 摊牌学习效应量小的可能原因：λ=0.92 近因衰减把稳态置信度压到 ~0.36
  （宽度乘数随之缩到 1+(w−1)×0.36），且每桶 ≥5 亮牌门槛在 30 条环形窗口下
  触发面窄；样本侧（亮牌是条件分布：打到摊牌的牌本身偏强）也有稀释。
  若将来重测，建议配合更大环形窗口/更低 λ 或只在高置信度后生效的门槛。
- 台架配对只覆盖 100bb 6max 混风格一桌型；深筹/单挑场景未测。
- 并行开发的 preflopRangeModeEnabled（F5 闭环）同期验收未过采纳线、默认
  关闭；摊牌学习在其上的 topPct 直接乘路径（档位吸附后效应更粗）保留可用，
  若该机制将来开启，摊牌学习在其上下文下的配对数据见上表参考行。
