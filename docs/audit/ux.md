# 域 D：UX/UI 全站巡检报告（真实浏览器）

- 日期：2026-09-29 ｜ 工具：Playwright Chromium（dev server :3105）
- 视口：桌面 1600×900 / 移动 375×667（hasTouch+isMobile）
- 语言：zh / en 双巡检（en 经 localStorage `pokergto_lang` 注入）
- 页面：大厅 `/`、`/play`（现金 2 人 + 锦标赛 6 人）、`/trainer`、`/history`、`/history/[id]`、`/stats`、`/ranges`、`/equity`、`/settings`
- 原始数据：`docs/audit/ux-sweep.json`、`ux-play.json`、`ux-replay.json`、`ux-interact.json`；截图 45 张于 `docs/audit/shots/`

## 总结

| 类别 | 结果 |
|---|---|
| (a) 控制台报错 / 失败请求 | 全组合 **0** console error、0 pageerror、0 failed request、0 HTTP≥400（唯一例外是第 2 条刻意的损坏记录探针） |
| (b) i18n 漏网 | **EN 模式 5 处中文残留**（成就、风格名、位置标注、画像分类、toast）；ZH 模式无漏网英文（仅品牌/术语） |
| (c) 交互死路 | **回放页初始「上一步」失效**（见 Bug 1）；其余按钮/空态/loading 全部健康 |
| (d) 移动端遮挡/溢出复测 | 上轮修复点（折叠面板、行动栏、HUD、抽屉、结算层）**全部通过**，0 横向溢出 |
| (e) 回放长跑 | 归一化后 50×双向步进/交替/60 次无间隔混合连点 **状态完全健康**；但初始态步进即 Bug 1 |

---

## 一、确认的真 bug（含证据）

### Bug 1（高）：回放页打开后「← 上一步」按钮失效，需先点街道 tab 才恢复

- **现象**：打开任意回放页（落在最后一步，如 `第 18 / 18 步`），连点「← 上一步」3 次、50 次，计数纹丝不动（`ux-replay.json`：`initialPrevWorks:false`，`afterInitial3Prev = 18/18`）。「下一步 →」此时本就 disabled（在末步），于是两个步进按钮呈现「全死」状态。点击任意街道 tab（如「翻前」→ `1/18`）后，步进立即恢复正常。
- **根因**：`src/app/history/[id]/page.tsx:79` 载入记录后 `setStepIdx(Number.MAX_SAFE_INTEGER)`，渲染时靠 `Math.min(stepIdx, steps.length-1)`（:89）钳到末步；但「上一步」onClick（:336）只把底层值 `-1`，从 `MAX_SAFE_INTEGER` 永远降不回有效区间。
- **影响**：用户打开回放最自然的操作（往前倒着看）无响应且无任何提示，属典型交互死路。修复建议：载入后把 `stepIdx` 直接置为 `steps.length - 1` 或在 `steps` 就绪后钳制写回 state。
- **证据**：`docs/audit/ux-replay.json`；复测同一上下文内点「翻前」tab 后 `prev50→1/18`、`next50→18/18` 均正确。

### Bug 2（中）：一条损坏/异构手牌记录（缺 `players` 字段）使 /history、/stats、回放详情三页整页崩溃，且无应用内恢复路径

- **现象**：探针向 IndexedDB `pokergto.hands` 注入一条缺 `players` 的记录后：
  - `/history`：`headingVisible:false`、`rows:0`，页面仅剩 “This page couldn’t load / Reload / Back”（`ux-interact.json corruptHistory`）；dev 下为 Next 错误浮层 “Runtime TypeError: Cannot read properties of undefined (reading 'length') @ history/page.tsx:117”（截图 `shots/desktop-history-corrupt.png`）。
  - `/stats`：同样整页崩溃（`corruptStats`；调用栈 `computeHeroHud → ai/adapt.ts:346 record.players.some`，由 `stats/page.tsx:175` 触发）。
  - `/history/[id]` 直接打开该记录同样崩溃（`corruptReplayBody`）。
- **旁证**：审计窗口内 dev server 日志真实捕获过同一签名的 `[browser] Uncaught TypeError`（`history/page.tsx:117` 与 `ai/adapt.ts:346`），说明该崩溃面不只存在于理论注入。
- **根因**：`historyStore.listHands`（`src/lib/store/historyStore.ts:492`）读出时只对 `streets` 做旧记录回填（withRunoutStreets），未校验 `players` 存在性；渲染层直接 `h.players.length`。一旦出现坏记录（旧版本数据、第三方写入、同步异常），「清空记录」按钮也随页面一起崩掉，用户只能手动清 IndexedDB。
- **建议**：`loadAll/listHands/getHand` 读入侧过滤或修补缺 `players` 的记录（与既有 streets 回填同一位置，一行 `filter` 即可）。

### Bug 3（中）：EN 模式多处中文残留（i18n 漏网，集中为 3 个硬编码表 + 成就数据）

| 位置 | 残留示例 | 代码出处 |
|---|---|---|
| `/stats` 金手链成就面板 | 首胜 / 初次夺冠 / 九人桌之王… 8 项名称+描述全中文 | `src/lib/store/achievements.ts` 的 `ACHIEVEMENTS` 硬编码；`src/app/stats/AchievementsPanel.tsx:62,70` 直渲 `a.name/a.description` |
| 成就解锁 toast | “Achievement unlocked / **首胜** / **赢下你的第一手牌**”（标题已英文、内容中文） | 同上数据源（toast 直渲同字段） |
| `/stats` 位置表 | “BTN/SB **按钮/小盲**” | `src/components/stats/PositionTable.tsx:6-18` `POS_CN` 无条件渲染（:56-58） |
| `/stats` 对手风格表 + `/history` 列表徽标 + 回放页 | “**紧凶 TAG** / **紧弱 Nit** / **疯子**” | `src/components/history/labels.ts:5-12` `STYLE_NAME` 单语硬编码 |
| 回放页座位标注 / 亮牌名单 | “Seat 0 · **小盲**”“Seat 2 · **按钮位**”“Seat 1 · **紧凶 TAG**” | `labels.ts:17-29` `POSITION_CN` + `seatPositionCn`（:41-45） |
| `/stats`「AI 眼中的你」分类标签 | “紧弱岩石（Nit）/跟注站/样本不足，暂无画像” | `src/app/stats/page.tsx:46-53` `CLASS_LABEL` 硬编码（本次种子数据未触发该卡渲染，为代码层确证） |

- **证据**：截图 `shots/mobile-en-stats.png`（成就整版中文）、`shots/desktop-stats-withdata-en.png`（toast + 按钮/小盲 + 紧凶 TAG）、`shots/desktop-replay-en.png`（座位/亮牌/徽标）、`shots/desktop-history-withdata-en.png`；扫描数据 `ux-sweep.json(desktop-en./stats)`、`ux-replay.json(replayEnHan/historyEnHan)`。
- **不受影响**（EN 已全英文）：大厅、训练、范围、胜率、设置、**/play 牌桌整页**（行动栏/桌面/HUD，`ux-play.json mobile-play-en hanLeaks:[]`）。语言切换按钮自身的「中文」字样为设计内。
- **ZH 模式反向巡检**：无漏网英文，仅品牌词与扑克术语（PokerGTO、VPIP、PFR、AF、WTSD、BTN/SB、bb 等），设计内。

### Bug 4（低）：移动端回放页步进按钮文案折行

375px 下「← 上一步」「下一步 →」在按钮内折成两行（截图 `shots/mobile-replay-withdata.png`）。功能正常，建议加 `whitespace-nowrap`。

### Bug 5（低）：`history.enterStreet` 中英括号风格不一致

zh 为「进入【摊牌】」、en 为 “Entering [Showdown]”（字典文案风格不统一，词典设计问题，可顺手统一）。

---

## 二、设计内行为但值得改进

1. **移动端顶部导航折 3 行**（8 个入口，占首屏约 110px，见 `shots/mobile-zh-ranges.png` 顶部）。不遮挡、可点，但可考虑汉堡菜单或二级收纳。
2. **回放页 EN 动作序列/步骤描述已双语**（`replay.ts` 按 lang 直查字典，“Entering [Showdown]”、动作文本全英）——说明该页 i18n 机制在位，缺的只是 Bug 3 中两个硬编码表接入。
3. **`/stats` 笔记卡空态文案**（“No long-term profile yet…”）已双语；但画像一旦生成，分类标签会落入 `CLASS_LABEL` 中文（并入 Bug 3 修复）。
4. **防呆到位**：设置页无 API Key 时「测试连接 / 测试复盘格式」禁用；胜率页未选满牌时「计算胜率」禁用——均非死按钮。

---

## 三、确认无问题（实测通过）

**(a) 控制台与网络**：7 内容页 × 4 组合 + /play 两视口 + 回放页，0 console error / 0 pageerror / 0 failed request / 0 HTTP≥400（噪声仅 dev 的 HMR/favicon，已过滤）。

**(c) 交互链路**（除 Bug 1 外全通）：
- `/equity`：选 hero 2 张 + 公共牌 3 张 → 计算 → 胜率 87.8% / 平 0.6% / 负 11.5% → 重置复原（截图 `shots/desktop-equity-result.png`）；
- `/ranges`：切「大盲位防守」表，统计行 17%→67% 正确刷新；
- `/trainer`：5 个 tab 均可出题作答，pushfold 答题→对错反馈→「下一手」→新题（不卡「发牌中…」），正确率计数 (1/1) 刷新；
- 空态：`/history` 空态有「去大厅开始第一手 →」(href `/`)，`/stats` 空态有「去对战页开始第一手 →」(href `/play`)；
- 大厅：现金 ↔ 锦标赛双向切换，结构预览正常；
- 设置：保存即时反馈「已保存到本地浏览器」。

**(d) 移动端复测（上轮修复点全过，`ux-play.json`）**：
- 折叠信息面板窄条与 hero 底牌 **无重叠**（`stripOverlapsHeroCards.overlap:false`）；展开抽屉 `left:87 right:375` 贴右缘不越界；
- 行动栏 sticky 底边 `bottom:667 = innerH`，完全在视口内；结算层「立即下一手」在视口内可点（`fits:true`）；
- 锦标赛 HUD + 「剩余重购 2 次」徽标不溢出；预操作按钮（提前弃牌/过牌/跟注）不被遮挡；
- **横向溢出**：全部页面两视口 `scrollWidth == innerWidth`，含 13×13 范围矩阵（移动下清晰可用）、`/history` 与回放页带长摘要数据（`mobileHistoryOverflow/mobileReplayOverflow:false`）。

**(e) 回放长跑**：街道 tab 归一化后，50×上一步→`1/18`、50×下一步→`18/18`、25 对交替、60 次无间隔混合连点、5 个街道 tab 轮流跳步——步进计数恒在 `[1,total]`、底池恒定 600（与注入数据的引擎口径一致）、页面无 `NaN/undefined` 文本泄漏、0 控制台错误。

---

## 四、产物清单

- 数据：`docs/audit/ux-sweep.json`（28 页次扫描）、`ux-play.json`（牌桌 4 用例）、`ux-replay.json`（长跑+EN 扫描）、`ux-interact.json`（交互+探针）
- 截图：`docs/audit/shots/` 45 张，关键：`mobile-en-stats.png`、`desktop-stats-withdata-en.png`、`desktop-replay-en.png`、`desktop-history-corrupt.png`、`desktop-stats-corrupt.png`、`mobile-play-zh.png`、`mobile-play-en.png`、`mobile-tour-zh.png`、`mobile-replay-withdata.png`
- 临时脚本：`e2e/ux-*.spec.ts` 已全部删除，未改动任何生产代码；dev server（:3105）已停止
