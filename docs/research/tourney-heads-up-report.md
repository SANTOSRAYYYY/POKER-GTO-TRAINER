# 锦标赛报告：heads-up（单挑专精组）

- 日期：2026-09-23
- 台架：`scripts/selfplay/.dist/run.cjs`（预打包，未重新构建）
- 通用配置：seats=2，hands=12000，blinds 5/10，startStack=1000，masterSeed=42，两座均为 `gto` + `equityIterationsScale=0.25`，唯一变量为 seat0Alt 的旋钮
- Smoke 验证：200 手配对赛确认三个旋钮名均被台架接受并在结果 JSON `b.seats[0].tuning` 中回显（`scripts/selfplay/results/tourney-heads-up-smoke.json`）

## 结果汇总（座位 0 配对差值 B - A，seed 42）

| 变体 | 默认值 | diff bb/100 | 95% CI | 判定 |
|---|---|---|---|---|
| huNitLimpCullProb=0.2 | 0.5 | +0.00 | [+0.00, +0.00] | 旋钮不触发（结构性无效），保持默认 |
| huNitLimpCullProb=0.8 | 0.5 | +0.00 | [+0.00, +0.00] | 旋钮不触发（结构性无效），保持默认 |
| openBBHeadsUp=2 | 2.5 | -6.33 | [-33.25, +20.58] | 证据不足，保持默认 |
| valueBetEqHU=0.48 | 0.52 | -4.75 | [-114.65, +105.15] | 证据不足，保持默认 |

判定规则：采纳 = CI 完全 > 0 且中值 > +15 bb/100；CI 完全 < 0 = 默认更优；CI 跨 0 = 证据不足。

## 逐变体解读

### huNitLimpCullProb ∈ {0.2, 0.8} —— 旋钮在 gto 自对战中不触发

两个取值都给出**逐手完全一致**的结果：diff 精确为 0、CI 宽度为 0、连 rebuy 次数（83/173）都与基准逐项相同。查 `src/lib/ai/brain.ts:727`，该旋钮唯一的读取点是：

```
if (style === "nit" && act === "call" && rng() < T.huNitLimpCullProb) act = "fold";
```

仅在 `style === "nit"` 时生效，且此时才消耗一次 `rng()`。本组实验两座均为 gto 风格，该分支永不进入、随机流不被扰动，因此 0.2 / 0.5 / 0.8 产出比特级相同的对局。**这不是统计意义上的"证据不足"，而是结构上无法在本实验组中产生效应**。若要调它，需要 seat0Alt 用 `style: "nit"` 的实验设计（超出本组范围）。判定：保持默认 0.5，无需 seed 43 加跑。

### openBBHeadsUp=2 —— diff -6.33 [-33.25, +20.58]，证据不足

配对 CI 相当窄（±27 bb/100），因为该旋钮只改变 SB 位开池尺度（3bb→2bb 是微调），大量手牌两条世界线行为一致，配对降噪有效。中值略为负（-6.3），CI 双侧对称跨 0，且中值距离 +15 的采纳线很远、方向偏负。不满足"CI 跨 0 但中值看起来大"的加跑条件，不做 seed 43。判定：证据不足，保持默认 2.5；现有证据方向略偏"默认更好"。

### valueBetEqHU=0.48 —— diff -4.75 [-114.65, +105.15]，证据不足

降低价值下注权益门槛（下注更薄）后中值略负。CI 宽达 ±110——门槛一改，大量手牌的行动分歧，配对差值的逐手方差自然变大，这是单挑高方差的体现。12000 手不足以分辨 ±10 bb/100 量级的效应，但中值同样远离 +15 采纳线且偏负，不做 seed 43。判定：证据不足，保持默认 0.52。

## 意外发现 / 台架观察

1. **huNitLimpCullProb 对 gto 风格完全无效**（见上，brain.ts:727 的 `style === "nit"` 门控）。其他并行组若用 gto 风格测此旋钮也会得到精确 0。
2. **台架确定性良好**：4 场 pair A（同 seed、同配置）结果逐项一致（座位 0 profit 均为 170627，+142.2 bb/100），可复现性无问题。
3. **单挑座位优势巨大**：基准 gto 座位 0 对座位 1 稳定 +142 bb/100（座位 0 应为按钮/小盲位，单挑中后手位置优势）。这凸显了配对模式的必要性——非配对比较会被座位效应淹没。
4. **配对 CI 宽度随旋钮类型差异巨大**：尺度微调类旋钮（openBBHeadsUp）配对 CI ±27，行动门槛类旋钮（valueBetEqHU）±110。后者在单挑 12000 手下只能分辨 ~±100 bb/100 的效应，若要分辨更小效应需显著增加手数。
5. 负载下吞吐：pair A ~17-19 hands/s、pair B ~11-12 hands/s（6 个 agent 并行期间），单场约 29 分钟。

## 结果文件

- `scripts/selfplay/results/tourney-heads-up-huNitLimpCullProb-02.json`
- `scripts/selfplay/results/tourney-heads-up-huNitLimpCullProb-08.json`
- `scripts/selfplay/results/tourney-heads-up-openBBHeadsUp-2.json`
- `scripts/selfplay/results/tourney-heads-up-valueBetEqHU-048.json`
- `scripts/selfplay/results/tourney-heads-up-smoke.json`（200 手冒烟）
- 配置：`scripts/selfplay/configs/tourney/heads-up/*.json`
