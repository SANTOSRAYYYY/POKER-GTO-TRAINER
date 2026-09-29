# 域 C 审计报告：AI 决策质量复审（src/lib/ai/）

- 审计日期：2026-09-29（commit 495ef28，工作区干净）
- 范围：`src/lib/ai/`（brain / range / adapt / prompt / opponent / heuristic / profiles / positions）
- 方式：代码通读 + 临时探针实测（esbuild 打包直跑，探针已删除）+ selfplay 台架 3 组配对 + vitest 重复运行
- 结论速览：**生产决策代码未发现确认的真 bug**；发现 1 处 brain 与训练器新框架的口径矛盾（多人池防守，量化差异最高 2.7×）、4 个测试自身的 flaky 根因（均非生产缺陷）、若干文档/表内容陈旧。 slim prompt 中英版逐行同构，台架 6max/9max/HU 各 6000 手配对逐比特重放、零和、无异常。

---

## (a) 近期改动的口径一致性

### A1. 【口径矛盾，建议统一】brain 多人池面注防守 vs 训练器多人池新框架

昨日 495ef28 把训练器多人池防守判定重构为「只对下注者评估（opponents=1）+ 每多一人 +3pp 实现率税」，commit message 明说旧框架「联合胜率 + 阈值步进对多人摊薄重复计费，顶两对都被判弃牌」。
**brain 的面注防守决策仍是旧框架，且叠了三层收紧**（`brain.ts:1366-1419` + `range.ts:113-160`）：

1. 联合胜率：hero 必须压过全部 N 个对手（`rangeMultiwayJoint: true`，`brain.ts:1390-1394`）；
2. 全部 N 个对手都按下注者的强 spec 采样（`equityVsRange` 单 spec；`inferFacingSpec` 还把 topPct ×0.8^(N-1) 收紧，`range.ts:129-131`）——身后只跟注的对手范围明明是封顶的；
3. 跟注门槛再 +3pp/人（`callMarginPerOpp`，`brain.ts:1418`）。

实测量化（3 人池翻牌 KsQh4h，spec 按各自口径，8000 MC × 7 轮取均值）：

| hero | 训练器口径（只对下注者 top60%） | 中间口径（bettor top60% + caller 封顶 top90%） | brain 口径（2×top44% 联合） |
|---|---|---|---|
| 顶两对 KQo | 0.887 | 0.822 | 0.795 |
| 顶对弱踢 K7o | 0.762 | 0.640 | 0.545 |
| 中对 88 | 0.460 | 0.298 | **0.171** |
| 同花听 7h2h | 0.403 | 0.348 | 0.329 |

同一局面三种口径胜率最高差 2.7 倍。brain 比「逐角色中间口径」系统性偏紧（把 caller 当第二个 bettor 又叠加联合摊薄 + 门槛步进），多人池面注会过度弃牌；这与训练器刚教给用户的「摊薄已被直接赔率计价，防住下注者即可」直接冲突——用户在 trainer 里学到 call，上桌看 AI 却 fold。

注意：`range.ts:33-41` 文件头明确写了「brain 的 AI 决策口径不变（仍走 equityVsRange 单 spec）」——这是**有意的暂缓**，不是疏漏。但 `equityVsRanges`（逐角色联合胜率公共资产）正是为此建的，统一路径现成。

建议（只建议不改代码）：brain 多人池面注改走 `equityVsRanges([bettorSpec, cappedSpec, ...])`（cappedSpec ≈ top 0.85-0.9），`callMarginPerOpp` 0.03 保留为实现率税（与训练器 +0.03/人 量级一致，这层本来就统一）；按 Phase 惯例跑混风格 6max/9max 深筹配对 A/B 过采纳线后再切默认。单挑（opponents=1）两侧口径本就一致（bettor spec 0.55 vs 训练器 0.6，仅 5pp 之差），不受影响。

### A2. 【次要口径差】brain facing spec 街道不分档 vs 训练器街道分档

`inferFacingSpec` 的 BASE_TABLE 三个街道同一张表（`range.ts:91-96`，注释自承「暂不按街道分档」）：raisesSeen=0 恒 {0.55, 0.15}。训练器侧：翻牌防守 0.6（`postflopQuiz.ts:123`）、转牌第二枪 0.45（`turnQuiz.ts:139`）、河牌抓诈极化 {0.25, 0.35}（`riverQuiz.ts:139`）。河牌差异最大：brain 假定下注者范围 = top55%+少量诈唬，训练器教的是极化范围（top25%+35% 诈唬权重）。方向性影响：brain 把河牌下注者的强牌部分估宽（top55% vs 极化 top25%），中等牌力的 eqF 系统性偏高 → 河牌防守偏松、与训练器教的抓诈口径相反。建议后续把 street 维度接进 BASE_TABLE（钩子已留）。

### A3. 【文档陈旧，非行为问题】两处注释与实现不符

- `brain.ts:753-754`：`preflopRangeModeEnabled: true` 正上方的内联注释仍是「Phase 8 验收未过采纳线……机制保留供 A/B」——容易被误读为默认应为 false。接口文档（`brain.ts:529-539`）和文件头（:12-19）已正确记载 Phase 9 深筹 +29.7 [+9.7,+49.7] 采纳。建议删掉或改写这段内联注释。
- `brain.ts:568-570`：`callVs3betPremiumExemptPct` 注释称「pct ≥ 此值（KK+/AA 档）才豁免」；实测 QQ 的百分位 0.9881 ≥ 0.985 也在豁免档（豁免 = QQ+）。`premium5betPct` 的「约 QQ+/KK+」写法反而更准确。99-JJ 档描述不受影响（JJ 0.982、TT 0.976、99 0.971 均 <0.985 ✓）。

### A4. 【表内容与自身文档矛盾】HU btn_open 表实装 ~45%（组合）/ 55%（标签），注释称「≈80% 可玩」

`gto/ranges.ts:63-88` 的 `btnOpenDecide` 注释与 `ranges.ts:260-261` 表描述都写「约 80% 起手牌可玩」，实测矩阵：raise 63 + call 30 = 93/169 标签（55.0%），组合加权 45.1%。杂色 T7o 以下、9x、8x 几乎全弃——这是 9max BTN 级别的松紧度，不是单挑按钮。直接影响：HU 全桌 VPIP 只有 33.3%（台架实测，见 (b)），按钮第一行动 fold 56.2%（N=4000 探针）。已验证 brain 逐手精确执行表内容（全 1326 组合枚举：开局 598/1326 = 45.1% 与表完全一致），所以这是**表设计/文档问题，不是 brain 执行 bug**。按真实单挑策略（按钮开局 60-90%）该表偏紧——要么修表要么修注释。

### A5. 其余近期改动相互一致性：无矛盾

- 翻前闭环（`preflopRangeModeEnabled: true`）开启时 `preflopPosAdjustEnabled` 被显式旁路（`brain.ts:1127`），二者不叠加 ✓；showdownLearn/blocker/ICM 三个默认关的旋钮在翻前闭环开启下仍各自精确跳过 ✓。
- warGuard 的 `streetRaisesSeen` 与范围推断 `inferFacingSpec` 的 raisesSeen 同源（同一 `bettingLineInfo`）✓；F6「short all-in 不计加注层级」在两处同口径 ✓。
- prompt.ts 多人池常识段（「多人池诈唬成功率显著下降」「顶对贬值」）与训练器 semibluff HU-only / 阈值步进的教学口径方向一致 ✓。
- `callVs3betMaxBB`（25bb）与 L2' 豁免链在 warGuard.test.ts 有 6 例锚定，8 轮运行全绿 ✓。

---

## (b) 台架验证：当前默认配置 6max / 9max / HU（各 6000 手，配对 CI）

设计：A/A 配对（`seat0Alt` = 与座位 0 完全相同的默认 gto），同一 masterSeed=42 两遍发牌逐手一致。A/A 下逐手盈亏差值应恒为 0——既验证全链路 6000×2 手无崩溃、零和记账，又是对「配对密闭性」（缓存复位 / Math.random 补丁不泄漏）的最强检验；VPIP/PFR 顺带做健康检查。台架标准配置：100bb、`resetStacksEachHand`、`equityIterationsScale: 0.25`（README 记载的配对验收标准档；生产 scale 1 成本约 4 倍，审计时限内不现实，精度差异已在历次 Phase 报告中论证可接受）。

| 桌型 | 时长 | hands/s | A/A 逐手差值 | 零和 | VPIP / PFR（臂 A 全员均值） | 座位 bb/100（臂 A，95% CI） |
|---|---|---|---|---|---|---|
| 6max | 371s | 32.3 | **0（36000 seat-hand 全同）** | ✓ 0 | 24.0% / 17.6% | +7.3 / −3.7 / +7.7 / +6.2 / −9.6 / −7.9（CI 半宽 ±37-41，全跨零） |
| 9max | 366s | 32.8 | **0** | ✓ 0 | 17.0% / 12.6% | −12.1 / +11.7 / −14.9 / +21.7 / −4.3 / +18.2 / −15.7 / +17.8 / −22.5（同上量级） |
| HU | 192s | 62.6 | **0** | ✓ 0 | 33.3% / 20.6% | −19.0 [−54.7,+16.7] / +19.0 |

解读：
- 三种桌型 A/A 均逐比特重放（差值序列全 0，CI [0,0]）——台架密闭性完好，近期 range.ts 多人池重构（今日 13:26 改动）没有引入跨臂污染。
- VPIP/PFR 单调合理：9max（17.0/12.6）< 6max（24.0/17.6）< HU（33.3/20.6）。9max 与 6max 数值与 Phase 8/9 报告（翻前闭环使 VPIP −6~7pp）同向吻合。HU 33% 偏紧，根因是 btn_open 表（见 A4），非台架异常。
- 无 rebuy、无崩溃、无超 CI 的座位出血。**结论：当前默认配置三桌型无异常。**
- 环境备注：`node_modules/.bin/esbuild` 在 fresh checkout 缺失（esbuild 不在 package.json），`build-and-run.sh` 会失败；本次用 `npm install --no-save esbuild` 补齐后运行。建议把 esbuild 加进 devDependencies。
- 证据：`docs/audit/selfplay/audit-{6max,9max,hu}-s42.json`（含 profitSeries/topHands），配置同目录 `config-*.json`。

---

## (c) 测试 flaky 根因与修复建议（只建议，不改代码）

本轮实测：ai 域单跑 8 轮（268 测试/轮）失败 2 轮（25%）；全套（853 测试，57 worker）连跑 2 轮均在同一处超时。四个根因**全部是测试设施问题，生产决策逻辑无涉**。

### C1. heuristic.test.ts:145「同花听牌面对大注」——缓存化的单次 MC 抽样决定整组断言（实测翻转率 7.4%）

- 机理：`heuristicDecide` 就是 `brainDecide`（`heuristic.ts:254-259`）。面注胜率 eqF 来自 rangeMode 的蒙特卡洛，**用未播种的 Math.random**，且 `rangeEquityCache` 是模块级——同一 (hero|board|spec|iters) 键在一个进程里只算一次。N=400 的循环全部命中同一缓存值，统计效力 = 1 个样本。
- 实测该样本分布（3000 次独立抽样，400 iters/次）：mean 0.4071、sd 0.0243。测试注释声称「混合后 ≈0.43」「两侧距混合胜率均 ≥2.5σ」——**两个数字都是错的**：station 阈值 0.372 一侧只有 **1.45σ**（P(翻转)=7.4%），nit 阈值 0.492 一侧 3.49σ。
- 观测失败形态与机理吻合：`stationFolds/N = 1`（400 次全弃——单样本落进 <0.372 的 7.4% 尾部后整组翻转）。
- 附带结论：调整注额救不了这个测试——窗口 [0.372, 0.492] 总宽 4.9σ，两侧都要 ≥2.5σ 需要 ≥5σ，数学上不可达；注释「70 是稳健分隔点」的前提不成立。
- 修复建议（任选其一，按推荐排序）：
  1. 测试开头 stub Math.random 为 mulberry32（台架 match.ts 同款补丁手法）+ `resetBrainCaches()`，选一颗 eqF 落窗中段的种子 → 完全确定；
  2. 重构为两段：先显式 `equityVsRange`（种子 rng）断言 eqF ∈ (0.372, 0.492)，再用种子决策 rng 断言 nit 弃/station 跟——诚实面对「这是单样本测试」；
  3. 至少把注释里的 0.43 / ≥2.5σ 改成实测值，避免下一个人按错误前提再调注额。

### C2. adapt.test.ts:917「对偷盲狂：BB 防守放宽」——断言阈距仅 ~2σ 且是严格不等号（实测失败率 ~6.7%/轮）

- 机理：base/off 两臂的弃牌率真值 0.91（Q5s 百分位 0.5952 < 门槛 0.60 必弃，仅 bluff3bet 掷签 0.3×0.3=0.09 转加注），N=100 → sd≈0.0286，断言 `toBeGreaterThan(0.85)` 只有 2.1σ 富余。P(单臂 ≤0.85)=3.4%，两条同类断言（#1 baseFolds、#3 offFolds）合计 ≈6.7%/轮。
- 观测失败：`expected 0.85 to be greater than 0.85`（恰好 85/100，严格不等号边界）。
- 修复建议：该测试已经在给 `brainDecide` 传 rng（第 3 参），把 `Math.random` 换成 `mulberry32(固定种子)` 即零成本彻底确定（推荐）；或 N 100→400 且阈值 0.85→0.80（≥4σ）。

### C3. range.test.ts:130「多人池联合摊薄」——无超时声明，全套并发下必超 5s 默认超时（全套 2/2 失败）

- 机理：3 次 `equityVsRange` 各 8000 迭代 + 每次前 `resetRangeCaches()` 强制重建牌池（~1081 组合 evaluate7 打分排序），单跑 ~2.6s；vitest 每文件一 worker，全套 57 worker 抢 16 核时稳定超过默认 5000ms。ai 域 17 文件单跑时通过。
- 修复建议：补显式超时（`it(..., 15_000)`，brain fuzz 测试已有 30_000 先例）；迭代数 8000→2000（断言间隙 e4 < e1−0.2 很大，σ≈0.01 足够）；后两次 `resetRangeCaches()` 可省（同 hero/board/spec 的池可复用，只换 opponents）。

### C4. brain.test.ts:377 性能基准——已加固，残余风险低

- 现状：min-of-3 × 每轮换种子（4091210 加固），本机 7 轮 best 68-84ms，距 120ms 阈值 1.4-1.7× 富余，未见失败。残余风险仅在共享 CPU 的 CI 上被持续 >1.7× 拖慢。
- 修复建议（可选）：vitest `retry: 1`；或改机器相对口径（先测一段 evaluate7 基准耗时做校准系数）。维持现状也可接受。

### C5. opponent 测试：确认无 flaky

`opponent.test.ts` / `opponentVote.test.ts` 全程 mock fetch + fake timers + 断言结构而非概率，确定性设计，8 轮全绿。投票的平票保守序 / 金额中位数 / 全失败回退逻辑代码走读无问题。

---

## (d) LLM slim prompt 中英一致性：确认一致

脚本对拍 `buildSlimPrompt(input, "zh")` 与 `"en"`（现金局 17 行 vs 17 行、锦标赛局 18 行 vs 18 行），逐行同构：

- 事实顺序与数值完全一致：街道/人数、底牌、公共牌、位置+座位、底池、筹码/本街已注、（锦标赛行）、对手逐座状态、本街行动序列（带座位，F4）、跟注额、合法动作逐条（含 bet/raise 的 bet-to 语义与最小额）、收尾指令。
- system 同构：人设句 + 职业标准句 + amount 语义段 + JSON 输出协议（reasoning 语言各自要求中文/English ✓ 与 4091210「EN 输出跟随 UI 语言」一致）。
- 刻意的本地化差异仅两处（均有注释声明，合理）：位置名 ZH 用 `positionName`（"BB（大盲）"）/ EN 用 `positionShortName`（"BB"）；表格标签语言。
- 两个可改可不改的吹毛求疵：EN 的 "2-max table" 单挑场景用 "heads-up" 更地道；`buildPrompt`（full 对照路径）无英文版（`opponent.ts:79` 注释声明刻意保持中文对照实验 ✓）。
- 既有 `prompt.test.ts` 对 EN 版有 3 例锚定 ✓。

---

## 汇总

**确认的真 bug（测试代码，均附实测证据）**
1. heuristic.test.ts:145 同花听牌——单样本缓存翻转，实测 7.4%/轮（C1）。
2. adapt.test.ts:917 偷盲狂——阈距 2.1σ + 严格不等号，~6.7%/轮（C2）。
3. range.test.ts:130 联合摊薄——缺超时声明，全套并发 2/2 失败（C3）。

**设计内行为但值得改进（按优先级）**
1. brain 多人池面注防守三层收紧 vs 训练器「只对下注者」新框架——量化差最高 2.7×，统一资产（equityVsRanges）已存在，建议 A/B 后统一（A1）。
2. btn_open 表 45% 实装 vs「≈80%」自述，HU 开局系统性偏紧（A4）。
3. brain facing spec 街道不分档，河牌与训练器极化口径差距大（A2）。
4. brain.ts 两处注释陈旧（Phase 8 未过线残留 / 豁免档「KK+」实为 QQ+）（A3）。
5. build-and-run.sh 依赖的 esbuild 不在 devDependencies，fresh checkout 台架不可跑（(b) 环境备注）。
6. 性能基准可选 retry 加固（C4）。

**确认无问题**
- 默认配置 6max/9max/HU 各 6000 手配对：逐比特重放、零和、VPIP/PFR 单调合理、无异常（(b)）。
- slim prompt 中英逐行同构（(d)）。
- warGuard / 翻前闭环 / 范围引擎 / adapt 剥削链的内部口径相互一致（A5）；opponent 投票与降级链确定性且测试覆盖（C5）。
