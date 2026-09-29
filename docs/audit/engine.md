# 域 B 审计报告：扑克引擎与牌局流程

- 日期：2026-09-29
- 范围：`src/lib/poker/`（引擎/边池/结算）、`src/lib/store/gameStore.ts`（调局/升盲/淘汰/重购/BBA ante/观战）、`src/lib/store/sessionPersistence.ts`（存档恢复）
- 方法：只读审计。Node 24 原生 type stripping + 自定义 ESM loader（`@/` 别名）跑临时台架脚本，构造边界场景实测；台架用快速 AI stub（仅测试环境经 loader 重定向，生产代码零改动）。另回归了项目自带 vitest（poker+store 282 个测试全绿）。
- 覆盖任务：(a) 多档 all-in 嵌套边池；(b) BBA 盲注轮转与按钮跳淘汰；(c) rebuy 边界；(d) 存档断点恢复；(e) 现金局补码/hero 重置守恒。

---

## 一、确认的真 bug（含复现步骤）

### BUG-E1：盲注级别超过全场最大筹码 → 锦标赛永久卡死（soft-lock）

**现象**：升盲后若所有在局玩家筹码都小于新大盲，`dealNextHand` 调 `createGame({stack: max(stacks)})` 命中引擎校验 `初始筹码必须是不小于大盲的正整数`（`src/lib/poker/game.ts:88-90`）抛错；`advanceToNextHand` 捕获后置 `lastError`（`src/lib/store/gameStore.ts:1202-1207`），状态停在上一手完结处。**每次重试/刷新恢复都同样失败，锦标赛永远打不出冠军。**

**生产可达性**：大厅「无限升盲」模式（`src/app/page.tsx:86`、`src/app/play/page.tsx:98`）用 `extendLevelsInfinite` 把盲注翻倍到 40 级，而总筹码恒定（1500×人数+重购）。打到约 12-13 级（bb=6400/12800）后必然出现 max(stack) < bb。限级模式（默认 10 级表、顶 bb=800）在正常人数下不可达。

**复现**（台架实测，B3 场景）：
```
startTable({ mode:"tournament", seats:3, tournament:{
  startStack:100, handsPerLevel:1,
  levels:[{sb:5,bb:10,ante:0},{sb:1000,bb:2000,ante:0}] }})
→ 打完第 1 手 → advanceToNextHand()
实测输出：
  err="推进下一手失败：初始筹码必须是不小于大盲的正整数"
  handNumber 1→1（重试仍停原手） tournamentOver=false
```
UI 表现：红条 6 秒消失后无任何出路（`TableScreen.tsx:311` 仅展示错误）；存档把卡死状态持久化，「返回当前对战」会复活这张死桌（恢复时 `scheduleAutoAdvance` 触发→再次报错）。

**修复建议**：`dealNextHand` 对 max(stacks) < bb 的情形不应抛错——真实规则是全员被迫 all-in 跑完公共牌。可将引擎 `createGame` 的 `stack >= bigBlind` 校验放宽为 `stack >= 1`（引擎对盲注/ante 已有 `Math.min` 封顶与「无人可行动直接摊牌」路径，`game.ts:189-191`），或在 store 侧检测后走自动 runout。

### BUG-E2：`correctStacks`「全员全下」抛错 → 锦标赛永久卡死

**现象**：两手之间筹码结转时（`gameStore.ts:444-476`），先用 max(stacks) 开对称局再按真实筹码修正。若对称局翻前起点（UTG）有行动能力、但修正后**所有**玩家都被 ante/盲注吃光，命中 `throw new Error("[gameStore] 盲注/ante 已让全员全下，无法开出这一手")`（`gameStore.ts:471`），同样被 `advanceToNextHand` 吞成 `lastError`，永久卡死（同 BUG-E1 的 UX）。

**生产可达性**：默认 ante 模式 `'all'` 且每级 ante = 大盲（`DEFAULT_BLIND_LEVELS`）。残局 3 人筹码形如 `[200, 100, 150]`、级别 50/100/ante100、按钮在桌座 1 时：桌座 0（BB）付 100+100 全下、桌座 1（按钮/UTG）付 100 ante 全下、桌座 2（SB）付 100+50 全下。对称局（stack=200）中 UTG 有 100 可行动，修正后无人可行动 → 抛错。该分布在小筹码残局完全可能出现。

**复现**（台架实测，B4 场景）：
```
tournament: levels [{5/10/0},{50/100/ante100}], handsPerLevel:1
第 1 手完结升盲后注入 tableStacks=[200,100,150] → advanceToNextHand()
实测输出：
  err="推进下一手失败：[gameStore] 盲注/ante 已让全员全下，无法开出这一手" hand#=1（卡住）
```

**修复建议**：这一手在真实规则下完全合法（全员强制 all-in，直接发完公共牌摊牌）。`correctStacks` 在扫描不到可行动者时不应 throw，而应调用引擎的摊牌跑完路径（等价于 `createGame` 的 `actor === null → settleShowdown` 分支），让调局流程照常 finalize/淘汰。

> 另注（潜在、生产 UI 不可达）：`startTable` 内 `dealNextHand()` 不在 try/catch 中（`gameStore.ts:1050`），自定义锦标赛若 startStack < 首级大盲会让 `startTable` 返回 rejected promise，UI `void startTable(config)` 吞下后停在无牌局状态。生产页面恒用 `DEFAULT_TOURNAMENT`（1500 ≥ 20），故仅自定义配置入口需注意。

---

## 二、设计内行为但值得改进

1. **hero 待决淘汰的名次恒优于同手出局者（与开手筹码无关）**
   `finalizeHand` 对同手多人归零按开手筹码排序定名次（筹码少者名次靠后），但 hero 可重购时挂起 `pendingHeroBust`，其拒绝重购后的名次固定取 `aliveAfter`（`gameStore.ts:1459`）——即使 hero 开手筹码比同手出局者更少。实测（C3b）：4 人局 hero 开手 200、seat2 开手 400 同手归零，seat2 第 4、hero 第 3。代码注释声明这是有意为之（hero 淘汰在决策时刻才记账，故晚于同手出局者），但与「同手按开手筹码排序」规则不一致，建议至少在 UI/文档中明示。

2. **现金局观战快进链是无限 await 递归**
   `runAiLoop` 尾部 `await kickSpectateChain()` → `advanceToNextHand` → `runAiLoop` → …（`gameStore.ts:719-739, 856`）。现金局观战中 AI 筹码不足会被自动补码（永远不会只剩 1 个 AI），链无终止条件，只能靠用户暂停快进/离开解开；期间所有挂起 promise 帧随手数线性累积，`spectateCash()` 返回的 promise 永不 resolve。浏览器里每手约 1 秒、实际内存增长缓慢，但测试环境（零延迟）会直接饿死在微任务链上。建议改成循环驱动（每手结束用 `setTimeout` 重新调度）而非递归 await。

3. **`loadSession` 校验只查形状、不查内容**（`sessionPersistence.ts:235-262`）
   实测（G）：`seatMap` 含越界座位 99、底牌含非法牌 `"Xs"` 的篡改存档均通过校验且 `resumeSession()` 返回 true、不报错，污染会在后续牌局才爆发。localStorage 篡改虽超出一般威胁模型，但存档结构升版或写入竞争产生的半坏档也会走同一路径；建议补 seatMap 值域、52 张牌唯一性、`tableStacks` 非负等廉价校验，失败即清档回退新局。

4. **恢复防御路径（handOver && !handSettled）若真触发会重复记账**
   `resumeSession` 对该态补跑 `finalizeHand`（`gameStore.ts:1119-1124`）。生产防抖（300ms）下该窗口理论上不可达——实测（D5）在「finalize 确未运行」的自洽状态下恢复恰好记账一次、结果正确。但若未来改动保存时序使「finalize 已跑、handSettled 未落盘」的存档真的出现，补跑会重复写历史、重复累加升盲计数与 rebuysUsed。可考虑给 `finalizeHand` 加幂等哨兵（如按 handNumber+deck 指纹去重）。

5. **升盲横幅 `levelUpEvent` 恢复后丢失**（瞬态不存档，`gameStore.ts:1098`）
   刷新恰逢升盲手则看不到升盲横幅，盲注本身正确。注释已声明为瞬态，记录备查。

---

## 三、确认无问题的项

### (a) 多人非对称筹码边池 / 多档 all-in 嵌套 —— 全部正确
- **4 档嵌套 all-in（30/80/150/300）手工对账**：L1=120/L2=150/L3=140 由牌力最强者通吃，L4=150 为单人退还层且**不计入 winners**；终局筹码与手算完全一致（A1）。
- **平分底池奇数筹码**：303 底池两名胜者平分，余数 1 分给「距按钮左邻最近」的胜者（A2，符合确定性规则，`game.ts:299-356`）。
- **弃牌者死钱**：folded 玩家的 handBet 计入对应层并由该层 eligible 胜者获得（A3）。
- **退还层玩家输掉其余层时不被标记 winner**（A4）。
- **全员 all-in 直达摊牌**：一次性发完 5 张公共牌、pot 清零、守恒（A5）。
- **引擎 fuzz**：400 手（2-9 人、随机盲注/ante/BBA/按钮、随机合法动作含随机 bet-to 额），2683 步逐步校验 `Σstack+pot` 守恒、`pot===ΣhandBet`、`currentBet===max(streetBet)`、无负筹码、结算后 pot=0 —— 零失败（A6）。
- **经 store `correctStacks` 的真实非对称路径**：桌座筹码 [30,80,150,1000] 开局逐档全下，终局各座筹码与独立参考实现（分层+逐层比牌）**逐座精确一致**（F1）；BBA 模式下大盲位 12 筹码付 15 ante 的部分支付/全下、UTG 顺推均守恒（F2）。

### (b) 锦标赛 BBA 盲注轮转与按钮跳淘汰 —— 全部正确
- 6 人 BBA 锦标赛跑到冠军（18-31 手，多次随机重复）：每手按钮 = 上一手按钮的下一个**未淘汰**座位（含跨淘汰者跳跃），逐手校验通过（B1）。
- BBA ante：每手**仅大盲位**有死钱部分（`handBet − streetBet`），金额 = min(级别 ante, 实付能力)，其余座位为 0；短码封顶逐座重算一致（B1/B2）。
- 全体 ante 模式对照组同样逐座一致（B2）。
- 单挑（2 人）阶段按钮=小盲、先行动，轮转正确（B1 终局段覆盖）。
- 名次：冠军 place=1，其余互不相同、分布在 2..N（B1）。

### (c) rebuy 边界 —— 全部符合设计
- **重购期最后一手恰好升盲**：AI 在重购期最后一个级别（level1）的最后一手归零，判定用**升盲前级别**→ 自动重购成功且同手升盲到 level2（C1）；同一座位在 level2（期外）再归零 → 正常淘汰 place=4（C1b）。
- **hero 期末手归零**：挂起 `pendingHeroBust`（place 正确）、不提前记账淘汰；接受重购 → 回 startStack、次数+1、开新一手（C2）；拒绝 → 记账淘汰/名次、自动快进观战（C2b）。
- **多人同手归零（混合资格）**：有次数的 AI 立即自动重购（在统计幸存人数之前），无次数的 AI 淘汰拿最后名次的逻辑、hero 挂起名次均正确（C3）。
- `rebuyPeriodLevels=0` 时全程不可重购（hero 直接淘汰，无 pending）（C4）。
- hero 挂起且其余同手出局者记账后只剩 1 人时：幸存者**预记**冠军待 hero 决策，拒绝后正式产生冠军、hero place=2（C6）。

### (d) 存档断点恢复 —— 全部正确
- **AI 思考中途刷新**：截取 AI 回合中态快照（含牌堆/底牌）→ `resumeSession` 重启 AI 循环续跑完同一手；handNumber 连续、牌堆未重洗、历史恰好记 1 手、桌面筹码守恒、无错误（D1）。
- **结算横幅刷新**：handOver+handSettled 原样恢复、`heroProfit` 不变、不重复 finalize、重新预约自动推进后可正常开第 2 手（D2）。
- **现金局 hero 重购决策点刷新**：`heroRebuyPrompt` 原样恢复；决策前 `advanceToNextHand` 被阻塞；`resolveRebuy` 后正常开手且 `stackResets+1`（D3）。
- **锦标赛 pendingHeroBust 决策点刷新**：pending 原样恢复、推进被阻塞、`resolveTournamentRebuy` 正常生效（D4）。
- **handOver && !handSettled 防御路径**：恢复时补结算恰好一次、桌面筹码同步到结算结果（D5）。
- **观战快进链中刷新**：恢复后续跑到冠军产生（D6）。
- **JSON 往返完整性**：deck/底牌/全部数组字段原样；`aiEngine`/`llmConfig` 不存档、恢复时从各自 localStorage 键重读（D7）。
- 300ms 防抖窗口内关页至多丢失最后一小段动作，恢复后从上一一致状态重放，无损坏（代码路径审查）。

### (e) 现金局 AI 补码与 hero 重置守恒 —— 全部正确
- 40 手 6-max 全链路（随机 hero 动作）：每手手内守恒（结算后 Σstack == 开手 Σstacks）；两手之间 AI 座位 <bb 时恰好补到 buyin、≥bb 时一分不动（26 次补码逐座核对）；每手都写历史、`session.handsPlayed` 一致（E1）。
- 边界：AI 筹码恰好 = bb **不补**、bb−1 补到 buyin（E2）。
- hero=0 时 `resolveRebuy(false)` 仍强制重置（代码注释与设计一致）；未提示时 `resolveRebuy` 空操作（E3）。
- hero 短码（0<stack<bb）拒绝重置后按原短码继续，不暗补（E1 覆盖）。
- `spectateCash`：hero 座位压缩退出、筹码清零、观战手不写历史、`heroProfit=null`、seatMap 不含 hero；快进可暂停（E4）。

---

## 附：审计台架说明
临时脚本位于 `scripts/audit/`（报告完成后已删除）：Node 24 type stripping + `_alias-loader.mjs`（`@/` 别名、无扩展名补全、可选 `AUDIT_FAST_AI=1` 把 `@/lib/ai/heuristic` 重定向到快速 stub 以加速台架）。全部结论均可由文中场景描述复现。项目自带 vitest（src/lib/poker + src/lib/store，282 测试）审计后回归全绿。
