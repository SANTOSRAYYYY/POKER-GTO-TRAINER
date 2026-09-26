# 锦标赛报告：preflop 组（翻前策略）

赛制：6 人桌配对种子赛（paired deals），5/10 盲注，起始筹码 1000，全部座位 gto + equityIterationsScale=0.25；唯一变量为座位 0 的 seat0Alt tuning。正式赛每场 8000 手 × 2 遍，masterSeed=42；临界变体加跑 masterSeed=43。

判定规则：配对 diff（B−A，座位 0）95% CI 完全 > 0 且中值 > +15 bb/100 → 采纳；CI 完全 < 0 → 默认更优；CI 跨 0 → 证据不足，保持默认。

## 结果汇总

| 变体 | seed42 diff bb/100 | seed42 95% CI | seed43 diff bb/100 | seed43 95% CI | 判定 |
|---|---|---|---|---|---|
| openBB=2.5（默认 3） | -594.3 | [-1813.7, +625.0] | +13.7 | [-79.9, +107.4] | 证据不足，保持默认 |
| bluff3betK=0.5（默认 0.3） | +5.0 | [-24.5, +34.5] | — | — | 证据不足，保持默认 |
| bbDefendBluffK=0.5（默认 0.35） | +0.0 | [+0.0, +0.0] | — | — | 不适用（死路径），保持默认 |
| premiumPct=0.95 + fourBetMult=2.6（默认 0.965/2.2） | +16.1 | [-49.2, +81.3] | -5.0 | [-350.8, +340.8] | 证据不足，保持默认 |

采纳清单：**无**。4 个变体全部保持默认值。

## 逐变体解读

### 1. openBB=2.5（开池尺度 3bb → 2.5bb）
- seed42 中值 -594.3 bb/100 看似大幅亏损，但 CI 宽达 ±1219——改动开池尺度会改变整条 rng 消耗序列，配对两手牌从翻前起就走向完全不同的牌局树（蝴蝶效应），配对差值的方差爆炸。seed43 加跑中值 +13.7、CI [-79.9, +107.4]，两个种子符号相反。
- 结论：无一致方向性证据，**保持默认 openBB=3**。注：该旋钮方差极大，若未来要评它，8000 手远远不够。

### 2. bluff3betK=0.5（诈唬 3bet 频率系数 0.3 → 0.5）
- diff +5.0 bb/100，CI [-24.5, +34.5]。旋钮确实触发（两遍赢利不再完全相同），配对消噪效果好、CI 很窄，但效应量远未达到 +15 阈值。
- 结论：**证据不足，保持默认 0.3**。在 6-max 全 gto 桌上提高诈唬 3bet 频率基本是零和微调。

### 3. bbDefendBluffK=0.5（大盲防守诈唬系数 0.35 → 0.5）
- 8000 手 × 2 遍结果**逐筹码完全相同**（diff 0.0，CI [0,0]），200 手 smoke 亦然。代码核查（src/lib/ai/brain.ts:768、782-785）：该旋钮只在 `headsUp && behind === 0` 且 `style === "lag" || "maniac"` 的分支中使用——**6 人桌 + 全 gto 赛制下是死代码**，永远不可能触发。
- 结论：**本赛制不可评估，保持默认 0.35**。若锦标赛只跑 6-max gto 配对，建议把该旋钮从调优空间剔除（只在单挑桌或 lag/maniac 对手场景才有意义）。

### 4. premiumPct=0.95 + fourBetMult=2.6（顶端范围放宽 + 4bet 尺度加大）
- seed42：+16.1，CI [-49.2, +81.3]（中值过 +15 但 CI 跨 0，临界）；seed43 加跑：-5.0，CI [-350.8, +340.8]，符号反转。
- 结论：**证据不足，保持默认 0.965/2.2**。顶端范围组合在 8000 手里触发次数少，且 fourBetMult 加大后单池波动大。

## 意外发现 / 台架行为

1. **bbDefendBluffK 死代码**：见上，这是本次最实质的发现——该旋钮在当前赛制下无法被任何样本量评估。
2. **配对消噪对“尺度类”旋钮失效**：openBB 这类改变下注额度的旋钮会让 rng 序列立即分叉，配对模式消不掉方差（CI 比非配对还宽）；而 bluff3betK、premiumPct 这类低频开关型旋钮配对效果极好（CI 收窄到 ±30 左右）。后续为尺度类旋钮设计实验时应预期需要 5 万手以上或改用多座位轮换。
3. 台架本身无异常：4 个旋钮在结果 JSON/stdout 的 tuning 列均正确回显；200 手 smoke 与 8000 手正式赛行为一致；所有 run 的配对 A（基准）在同一 seed 下逐筹码一致（seed42 基准座位 0 赢利 341555 在 4 场中完全相同），证明配对模式确定性良好。

## 产物

- 配置：`scripts/selfplay/configs/tourney/preflop/{smoke-openbb,smoke-bluff3bet,smoke-bbdefend,smoke-premium4bet,openbb25,bluff3betk05,bbdefendbluffk05,premium4bet,openbb25-s43,premium4bet-s43}.json`
- 结果：`scripts/selfplay/results/tourney-preflop-{smoke-openbb,smoke-bluff3bet,smoke-bbdefend,smoke-premium4bet,openbb25,bluff3betk05,bbdefendbluffk05,premium4bet,openbb25-s43,premium4bet-s43}.json`
