# 域 E：数据与持久化审计报告

审计日期：2026-09-29 · 只读审计（未改动任何生产代码；临时脚本已删除）
范围：`historyStore`（IndexedDB 手牌/分析/整场报告）、`notebook`（对手笔记本）、`achievements`（成就）、`hudStats`（数据中心聚合）

## 方法与数据集

- **合成数据**：自构造 `HandRecord` 生成器（hero 坐 0 号位、6 人桌 5 名 AI、混合盲注级别 bb∈{2,4,10,20,50,100,200} 模拟升盲、混合风格、含翻前/翻后动作序列），20 项 vitest 断言 + 3 项 Playwright 浏览器实测（chromium，**生产构建** `next start` 实测）。
- 浏览器实测时把 1000 条合成手牌直接写入与应用相同的 IndexedDB 库（`pokergto` / 表 `hands`+`analyses`）。

---

## (a) 统计口径：VPIP / PFR / AF / WTSD / bb100

### 确认无问题（实测断言全过）

| 指标 | 口径验证 |
|---|---|
| VPIP | 翻前 fold / BB check / BB walk（无 hero 动作记录）不计；limp、加注、抬线 allin、短码跟注性 allin 计入。7 情形实测 = 4/7 ✓ |
| PFR | raise 与抬线 allin 计入，短码跟注性 allin（amount < 当前下注线）不计。实测 = 2/7 ✓ |
| WTSD | 翻前弃牌（即使记录含 flop 街，多人池他人继续）不计分母；未进翻牌圈不计分母。实测 = 1/2 ✓ |
| AF | 按动作次数；每街下注线归零重计；allin amount > 本街线计进攻、≤ 计被动。实测 = 3/2 ✓ |
| bb/100 | 逐手归一化 Σ(profitᵢ/bbᵢ)/N×100，混合盲注级别口径正确：50 手 bb=2 各 +4（+2bb/手）+ 50 手 bb=100 各 −100（−1bb/手）→ **+50.0 bb/100** ✓ |
| winRate | 平局 0.5 计，`computeStats` 与 `computeHeroHud` 同口径 ✓ |

### 确认的真 bug

**A1. `isTournamentHand` 把「锦标赛第一滴血之前的所有手牌」判成现金局。**
`isTournamentHand` = 任一玩家带 `finishPlace`（labels.ts:48），而 `finishPlace` 只在出局/夺冠那一手才填写（gameStore.ts:1518-1523）。一场 60 手的 SNG，前 ~20-30 手无人出局 → 全部被识别为现金局。三个后果均有实测证据：

- /stats「仅现金局」筛选混入锦标赛前期手，「仅锦标赛」漏掉它们（filterCompare.ts:46）；
- `maxCashWinStreak` 注释承诺「锦标赛手既不计入也不断连」（achievements.ts:98），**实测 5 手 9 人锦标赛前期手连盈 → streak=5，`cash_streak_5` 被锦标赛手解锁**——实现与注释意图矛盾；
- `renderHandForPrompt` 把这些手标为「现金局」喂给 LLM 复盘（historyStore.ts:158），锦标赛语境（升盲/ICM）丢失。

修复方向：`HandRecord` 增加 `mode` 字段（归档时 `st.mode` 现成），而非事后从 finishPlace 推断。

### 设计内但值得改进

**A2. 混合盲注下「总盈亏」是原始筹码合计。** /history 与 /stats 的 totalProfit 把 1/2 筹码与 100/200 筹码直接相加，可与 bb/100 符号背离（实测：+50 bb/100 但总盈亏 −4800）。bb/100 口径本身正确；建议 UI 上把总盈亏标注为「筹码」或分级别展示。

**A3. AF 分母钳 1 在大样本零跟注时数值爆炸。** `af = aggressive / max(1, passive)`（adapt.ts:599）防小样本除零是合理设计，但实测 50 手纯进攻零跟注 → **AF 显示 50.00**（=进攻次数，随样本线性膨胀）。建议显示封顶（如 99+）或该情形显示 ∞。

**A4. bb=0 坏手稀释一切 bb 归一化指标。** `if (h.bigBlind > 0)` 守卫只跳过分子、不跳过分母：1 手 bb=0 坏数据使 bb/100 从 200.0 → 196.1；profit_10000bb 成就对单手盈利 20000 的 bb=0 坏手不解锁。仅影响坏数据，但缺防御。

---

## (b) 大数据量性能（1000 手，生产构建实测）

| 环节 | 耗时 | 结论 |
|---|---|---|
| IndexedDB 批量写入 1000 手 | 65–86 ms（一次性） | 无压力 |
| IDB `getAll(hands + analyses)` | 11–13 ms | 无压力 |
| 纯函数统计（Node） | computeHeroHud **1.54 ms**、checkAchievements 0.35 ms、computeStats 0.04 ms、filterHands 0.02 ms、compareSegments 0.20 ms（各 20 次均值） | 统计计算远非瓶颈 |
| **/history 渲染** | 页面加载 ~0.21 s + **数据渲染 ~0.68 s** ≈ 0.9 s；**DOM 13,261 节点** | 瓶颈在此 |
| **/stats 渲染** | 页面加载 ~0.4 s + 数据渲染 ~0.17 s ≈ 0.6 s；DOM 338 节点 | 良好 |

**确认的真 bug（性能缺陷，中低危）：/history 无分页/虚拟滚动**，1000 手一次渲染 13k+ DOM 节点（history/page.tsx:111-160 直接 `hands.map`）。桌面生产 ~0.7 s 可接受，但手数继续增长（5000+）或低端移动设备会明显卡顿；`hands_1000` 成就本身鼓励长线使用，数据量只会越来越大。建议按时间分页或虚拟列表。

另注：`/history` 每次渲染都同步执行 `stats()`（computeStats），1000 手 0.04 ms，无问题。

---

## (c) 成就判定边界

### 确认的真 bug

**C1. `nine_max_title`（九人桌之王）在正常对局中不可达。** 判定要求 `h.players.length === 9 && heroFinishPlace(h) === 1`（achievements.ts:140-145），但淘汰者在两手之间即被移出引擎桌（dealNextHand 的 `aliveSeats`，gameStore.ts:871-875），**夺冠那一手必然只剩单挑（players.length=2）**，多人同手出局时也 ≤ 该手开局人数。实测：

- `players.length=2 + hero finishPlace=1` → `first_title` 解锁、`nine_max_title` **不解锁**（这正是 9-max SNG 夺冠的真实归档形态）；
- 只有「9 人全在的一手内 8 人同时出局」（第一场第一手 8 家全下全灭）这种理论情形才解锁。

现有单测（achievements.test.ts:101-106）用 9 人合成记录验证通过，恰好掩盖了真实归档形态。修复方向：HandRecord 增加开赛人数/mode 字段后按开赛人数判定。

### 确认无问题（实测）

- **锦标赛连冠**：连续两场夺冠各自满足 `first_title`/`nine_max_title` 判定，解锁集合幂等只记首次（无「连冠」类成就，定义列表确认）。
- **复仇**：同风格多次遇到（输→输→输→赢）成立 ✓；先赢后输不成立 ✓（内部按时间升序重排，顺序语义正确）；记仇跨 session 无过期 ✓。
- **hands_1000**：999 不解锁 / 1000 解锁 ✓。
- **session_500bb 边界**：相邻两手间隔**恰好 30 分钟 = 同一场**（严格 `>`，achievements.ts:82），30min+1ms 切场 ✓，与描述「超过 30 分钟」一致。

### 设计内但值得改进

**C2. 复仇判定株连同桌无关风格。** 输给 A+B 同桌的手牌会对 A、B 都记仇（桌面级归因，achievements.ts:114-130），之后第一手赢 **只含 B** 的桌即复仇成功——B 可能根本没参与那次底池。与 hudStats byStyle 的「桌上有该类对手」口径一致（注释已声明），属统一口径的固有宽松。另：tie 不记仇也不清账。

**C3. 成就只在 /stats、/history 页触发检查**（AchievementToast.tsx:60）。打满 1000 手的当下不 toast，要逛统计页才解锁。注释自承这是「addHand 后由页面侧触发」的落地形态，但用户感知是延迟的。

---

## (d) 笔记本衰减（模拟 30 天）

### 核心结论：30 天不玩 = 零衰减（机制如此，数值实测）

衰减只按「流逝手数」计算（`λ^elapsedHands`，notebook.ts:90-99），**墙钟时间完全不进入公式**（`updatedAt` 仅展示用）。30 天不玩 → 历史总手数不变 → 流逝量 0 → `decayStats` 同引用原样返回（实测）。AI 对一个一年没玩的 hero 画像分毫未忘。

流逝手数下的衰减数值（λ=0.92，实测表）：

| 流逝手数 | 系数 | 100 手画像的有效样本 | VPIP 比率 |
|---|---|---|---|
| 1 | 0.920 | 92.0 | 40%（不变） |
| 10 | 0.434 | 43.4 | 40% |
| 25 | 0.124 | 12.4 | 40% |
| 50 | 0.016 | 1.6（< 分类下限 10 → AI 回「样本不足」） | 40% |
| 100 | 0.0002 | 0.02 | 40% |

语义合理：衰减只缩样本量（置信度），不改比率画像；`showdownsSeen` 亮牌环形缓冲（30 条上限自带近因性）不衰减（实测引用前滚）。

### 设计内但值得改进（按影响排序）

1. **正常路径下衰减几乎永不触发**：笔记本防抖 1s 紧随历史写入，水位线随手数推进，流逝量 ≈ 0；唯一触发场景是「结算后 1s 内关页」漏写几手。衰减机制实质是防漏写补偿，不是「遗忘」。若要真人式遗忘，需引入时间维度。
2. **衰减是否生效取决于用户导航顺序**：`loadDecayedHeroStats` 依赖 `historyStore.loaded`，未加载时保守返回原值（notebook.ts:236-238，实测情形 1）。/play 页从不调 `loadAll`——直达 /play（书签/恢复链接）开局时衰减完全不生效；经大厅（/）或 /stats 跳转才生效。
3. **清空历史 ≠ 清空笔记本**：clearAll 后总手数低于水位线，负流逝钳 0 → 旧画像 100 有效样本**原值保留**（实测情形 3）。用户清历史求「重新做人」，AI 依旧全知。/stats 有独立「清空笔记本」按钮，但两处无联动提示。

### 确认无问题

- λ 钳制 [0.5, 1]（λ=5 恒等、λ=0.1 按 0.5 计）、NaN 回退默认 0.92、负流逝钳 0，全部符合注释（实测）；
- 笔记本损坏/版本不符 → 删除坏档返回 null 重建；localStorage 三路（notebook / achievements / session_reports）读写全部 try/catch 包裹，隐私模式静默降级（saveSessionReport 失败时报告保留在内存返回值）。

---

## (e) IndexedDB 异常路径

### 确认的真 bug

**E1. IndexedDB 不可用（隐私模式/被禁用）时，/history 与 /stats 永久卡死「加载中…」，无任何错误提示。**
`loadAll` 的 rejection 被页面 `.catch(() => {})` 静默吞掉（history/page.tsx:38、stats/page.tsx:168），`loaded` 恒为 false。
浏览器实测（`addInitScript` 移除 `window.indexedDB`）：4 秒后两页仍只显示「加载中…」，页面无错误文案，`pageerror` 计数 0——用户会以为数据在加载，实际永远不来。成就检查（listHands 拒绝）同样静默失败。建议：loadAll 失败置 `loaded: true` + 错误态，或页面 catch 后展示「浏览器存储不可用」横幅。

**E2. openDB 失败的 promise 被永久缓存，一次失败 = 会话级瘫痪。**
`dbPromise` 一旦置为 rejected（配额满/隐私模式瞬态），后续 `getDB()` 永远返回同一 rejected promise（historyStore.ts:52-63），本页会话内 saveHand/loadAll/analyzeHand 全部失败，只能刷新页面。无重试/重建逻辑。

**E3. saveHand 失败时该手牌静默丢失（内存里也没有）。**
`saveHand` 先 `await db.put` 再更新内存（historyStore.ts:481-485）：写入失败 → 异常上抛 → 内存 set 不执行 → 该手既没落盘也没进内存。gameStore 仅 `console.error`（gameStore.ts:1563-1566）后继续牌局。牌局不阻断是设计意图，但至少应把记录先放内存（乐观更新 + 失败回滚/标记），给用户导出/重试的机会。

**E4. 单条损坏记录拖垮整页（浏览器实测）。** 6 条记录中混入 1 条缺 `players` 的记录：

- /history：**0 个 li + Next.js 错误遮罩 + pageerror**（渲染期 `handSummary` 访问 `h.players.find`，history/page.tsx:22）——`loadAll` 本身只做 getAll+排序不校验，坏数据直达 React 渲染期才炸；
- /stats：**HUD 完全不显示 + 错误遮罩**（`computeHeroHud` → `updateStats` 的 `record.players.some`，adapt.ts:346，在 useMemo 渲染期抛出）；
- 成就检查 `checkAchievements` 同因抛异常（achievements.ts:69），被 AchievementToast 静默吞掉 → **成就永久停止检查**；
- 缺 `streets` → `listHands`/`getHand` 的 `withRunoutStreets` 展开 undefined 抛 TypeError（runout.ts:30），整场复盘 `analyzeSession` 因此失败；
- 缺 `profit` → `computeStats.totalProfit = NaN`，统计卡显示 "NaN"。

正常路径下记录由本应用自写自读不易损坏，但 IDB 可被 DevTools/扩展/半截事务污染，且 `loadAll` 不做任何逐条校验/过滤。建议读出路增加逐条宽容校验（仿 `normalizeSessionReport` 的先例），坏记录跳过+计数提示。

### 确认无问题

- `analyses` 表缓存命中正常，getAnalysis 内存未命中回查 IDB 并回填内存 ✓；
- 整场报告 localStorage（最多 5 份截断）脏数据宽容丢弃（normalizeSessionReport）✓；
- `withRunoutStreets` 对合法记录幂等，末尾未知街防御返回 ✓；
- LLM 分析/整场复盘的一次自动重试与容错解析（fence 剥离、末尾 "}" 回退、score 钳制）逻辑完备（本次未复测，代码走读）。

---

## 汇总

**确认的真 bug（5+1 项）**

| # | 问题 | 位置 | 严重度 |
|---|---|---|---|
| A1 | 锦标赛前期手被判为现金局：/stats 局型筛选错乱、cash_streak_5 被锦标赛手解锁（与注释意图矛盾）、LLM 复盘丢锦标赛语境 | labels.ts:48 + gameStore.ts:1518 | 中 |
| C1 | `nine_max_title` 成就不可达（夺冠手恒为单挑，players.length≠9） | achievements.ts:140 | 中 |
| E1 | IDB 不可用时 /history、/stats 永久「加载中…」，零错误提示 | historyStore.ts:49 + 两页 catch | 中 |
| E4 | 单条损坏记录使 /history、/stats 整页渲染崩溃、成就检查永久停摆 | 读出路无校验 | 中 |
| B1 | /history 1000 手无分页渲染 13k DOM 节点（~0.7s），随数据量线性恶化 | history/page.tsx:111 | 中低 |
| E2+E3 | openDB 失败 promise 永久缓存；saveHand 失败丢手牌（内存也没有） | historyStore.ts:52,481 | 低 |

**设计内但值得改进**：AF 零跟注数值爆炸（A3）；复仇同桌株连（C2）；成就只在统计/历史页触发（C3）；笔记本零时间衰减/衰减依赖导航顺序/清历史不清笔记本（d 三项）；混合级别总盈亏为筹码口径（A2）；bb=0 坏手稀释归一化指标（A4）。

**确认无问题**：VPIP/PFR/AF/WTSD/bb100 核心口径（7 情形 + 混合级别实测）；成就其余边界（999/1000、30min 整、先赢后输）；笔记本 λ 钳制与损坏重建；纯函数层与 IDB 读写性能；localStorage 三路防御性。
