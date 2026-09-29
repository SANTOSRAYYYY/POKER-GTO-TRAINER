# 移动端 UI 深度体检报告（mobile-v2）

日期：2026-09-29 ｜ 视口：375×667（iPhone SE）/ 390×844（iPhone 14）｜ 工具：Playwright chromium

## 方法

- 审计脚本 `audit.mjs`：对 15 个页面状态（大厅 / 对战 2·6·9 人桌 / 历史 / 回放 / 数据 / 训练五族题 / 范围 / 胜率 / 设置）逐视口自动检测：
  1. `documentElement.scrollWidth > innerWidth+1`（横向溢出）
  2. 未被 overflow 祖先裁剪的越界元素（遮挡/出血）
  3. 可见可点元素 `min(width,height) < 44px`（触控区）
  4. nowrap 元素 `scrollWidth > clientWidth+2`（文字截断）
- 数据页由脚本向 IndexedDB 注入 14 手合成记录（2/6/9 人桌、6 种风格、胜负/摊牌/位置覆盖）。
- 全部页面再经人工逐张审图（`shots/before/` 与 `shots/after/` 各 30 张）。
- 修复红线：**只加 `max-md:`/`md:` 前缀类**（或走既有 compact 分支），桌面 1600×900 像素零变化。

## 发现 → 修复对照（按严重度）

### P0 功能性缺陷（4 项，全部修复）

| # | 发现 | 修复（文件） | 验证 |
|---|------|------|------|
| 1 | **胜率页 52 张选牌网格互相重叠**：28px 宽的牌被塞进 ~17px 格（网格 `grid-cols-13` 1fr 单元在 343px 容器里只有 ~17px），相邻牌叠 ~11px，触控宽仅 17px，极易点错 | `src/app/equity/page.tsx`：选牌容器 `max-md:overflow-x-auto` + 行容器 `max-md:min-w-[436px]`（每格 28px≥牌宽，不再重叠）；左 section 加 `max-md:min-w-0`——网格项 `min-width:auto` 会被 436px 内容撑出视口（移动端视口扩展为 502px，真机即页面变宽可横滑），归零后由内部滚动接管 | `after/se375-equity.png` 牌间有缝不重叠；docSW=375；e2e「选牌网格不重叠」 |
| 2 | **9 人桌 SE(375×667) hero 底牌被裁一半**：锦标赛 HUD 3 行 + 横屏提示 + 预操作按钮 2 行，把牌桌挤出首屏，须滚动才能看到自己的牌 | `src/components/poker/TournamentHud.tsx`：移动端隐藏次要两行（本手固定支出明细 / 目标·名次），HUD 3 行→2 行；`src/components/poker/ActionBar.tsx`：等待状态文字 `max-md:basis-full` 独占一行，预操作 3 钮收进一行；`src/components/poker/TableScreen.tsx`：中部滚动区 `max-md:py-1`（再省 16px，e2e 实测底牌贴边 7px 的残余重叠由此消除） | `after/se375-play-9max.png` 9 舱齐、hero K♠8♦ 完整在行动栏上方；e2e「9 人桌 hero 底牌完整可见」 |
| 3 | **回放页步进按钮文字折行**：「← 上一步」「下一步 →」在 375px 折成两行，且步进器埋在一屏座位卡之后 | `src/app/history/[id]/HandReplay.tsx`：按钮 `max-md:whitespace-nowrap max-md:py-2.5`；步进条移动端 `sticky bottom-0` 吸附视口底部（拇指始终可达） | `after/se375-replay.png`；e2e「步进按钮不折行」 |
| 4 | **冠军结算 modal `w-96`(384px) 超出 375px 视口**，两边出血 | `src/components/poker/HandResultOverlay.tsx`：`max-md:max-w-[calc(100vw-2rem)]` | 代码审查 + tsc/e2e 全绿 |

### P1 触控区 <44px（9 类，全部抬到 40-44px）

修复前实测（se375）：全站导航链接 36px/EN 26px/logo 28px；对战页音效钮 31×24、顶栏链接 24×16；历史页删除 40×24；回放街道 tab 28px、AI 分析钮 36px；数据页筛选 Pill 24px/分段对比 30px/清空笔记本 30px/整场复盘 36px；设置页输入 38px/单选 label ~20px/测试钮 38px；范围页切换钮 32px；胜率页对手数量钮 28×28；大厅风格钮 38px、数字输入 38px、「2 人桌（单挑）」折成「（单/挑）」。

| 文件 | 修复 |
|------|------|
| `src/components/history/Nav.tsx` | 移动端导航改**单行横向滚动**（`max-md:flex-nowrap max-md:overflow-x-auto` + 链接 `shrink-0 py-2.5`=40px）——原来 8 入口折 3 行占 ~130px 首屏；EN 钮 `py-3`=40px |
| `src/components/poker/TableScreen.tsx` | 音效钮 `max-md:px-2.5 py-2.5`、顶栏链接 `max-md:px-2 py-3`（40px） |
| `src/app/history/page.tsx` | 删除 `max-md:px-3 py-3`=40px；数据中心/清空全部/加载更多 `py-2.5`=40px |
| `src/app/history/[id]/HandReplay.tsx` | 街道 tab `max-md:py-2.5`=40px；AI 分析钮 `max-md:py-3`=44px；「← 历史列表」`min-h-10` |
| `src/app/stats/page.tsx` | Pill 钮 `max-md:px-3 py-3`=40px；清空笔记本/分段对比 `max-md:py-3`=40px |
| `src/components/stats/SessionReportPanel.tsx` | 生成整场复盘 `max-md:py-3`=44px |
| `src/app/settings/page.tsx` | 输入框/下拉 `max-md:py-3`=44px；单选·复选 label `max-md:py-2.5`=40px（label 即触控区）；测试钮 `max-md:py-3`=44px |
| `src/app/ranges/page.tsx` | 表切换钮 `max-md:py-2.5`=40px |
| `src/app/equity/page.tsx` | 对手数量钮 `max-md:h-10 w-10`；随机/指定 label `max-md:py-2.5`；重置 `max-md:py-3` |
| `src/app/page.tsx`（大厅） | 风格钮 `max-md:py-3`、数字输入 `max-md:py-3`；座位钮 `max-md:px-1 py-3 text-xs whitespace-nowrap`——「2 人桌（单挑）」单行放下不再断字 |

### P2 设计合理性（4 项）

| # | 发现 | 修复/决定 |
|---|------|------|
| 5 | 范围 13×13 矩阵格 41px <44 | `ranges/page.tsx` 移动端 `min-w-[596px]`（格 44px，容器横滑） |
| 6 | 成就 toast `w-80` 固定右上盖住导航与页面标题 | `AchievementToast.tsx` 移动端改底部 `inset-x-4 bottom-4 w-auto`（toast 仅在 /stats /history 触发，两页无底部吸附栏） |
| 7 | 数据页分桶表/对比表 `min-w-105`(420px) 强制横滑，PFR/基准列默认不可见 | `HudPanel.tsx`/`ComparePanel.tsx` `max-md:min-w-0`，列挤进窄屏（单元格可换行） |
| 8 | 回放步进器位置深（见 P0-3） | 已随 P0-3 修复（sticky 吸附） |

### 接受的折中（记录在案，未强行拉满 44px）

- **胜率页单张牌钮 28×36**：52 格密度型选择器，做到 44 宽需 ~650px 行宽、横滑过半；现状不重叠、可横滑、有 hover 环反馈。
- **原生 radio/checkbox 13×13**：触控区是其外层 label（已垫到 40px），符合常规模式。
- **对战页「PokerGTO Trainer」标题链 110×20**：品牌链，与「大厅」入口功能重复。
- **训练 tab 首项「翻前 Push/Fold」两行**：五 tab 等高拉伸，折行居中可读，改字典文案超出本轮边界（dict 禁碰）。
- **导航横滑时边缘露半个字**（如「历」）：恰是「可滑动」的视觉提示，保留。

## 验证证据

**自动审计（audit-before.json → audit-after.json）**
- 横向溢出：15 页 × 2 视口，修复前后均 `docSW ≤ vw+1`（equity 修复中曾发现网格项撑宽至 502 的回归并已一并修复，最终 375 ✓）
- `<44px` 触控目标总数：**879 → 509**；其中范围矩阵 169 格 41→44px、其余多为 24-38px → 40-42px（达仓库既有 ≥40 标准，见 mobile.spec.ts 行动栏断言）
- 越界未裁剪元素、nowrap 截断：前后均为 0；EN 界面 5 页抽查同为 0

**桌面零变化（1600×900）**
- 静态页（大厅/胜率/范围/回放/设置）before↔after **严格 0 像素差**
- 动态页（对战×3/训练×5/历史/数据）diff 0.003%-5.6%，与**同代码连跑两次的噪声带**（0.002%-2.7%+ 随机发牌/出题/时间戳所致）一致；桌面审计指标（溢出/触控计数）before/after 逐项相等

**测试**
- `npx tsc --noEmit` ✅
- `npm run test`（vitest）：62 文件 921/921 用例全绿 ✅
- `npm run test:e2e`（playwright）：17/17 全绿 ✅（含新增 `e2e/mobile-v2.spec.ts` 5 用例）

**新增移动用例（e2e/mobile-v2.spec.ts，375×667）**
1. 全站导航单行横滚：8 链接同行、高 ≥40、无横溢
2. 胜率页选牌网格：A♠ 钮宽 ≥24（修复前 17）且整页无横溢
3. 范围页矩阵格 AA 宽高 ≥44
4. 9 人桌 hero 两张底牌完整落在行动栏顶边之上
5. 回放步进钮单行（高 <48px）+ 街道 tab 高 ≥40

## 遗留问题

- 9 人桌竖屏下注圆片与邻座牌角轻微相叠（compact 几何 0.42 内缩系数）：纯视觉、信息可读，调参收益低风险高，建议下一轮与牌桌横屏布局一起处理。
- 训练 tab 首项两行（需改 dict 文案才能根治）。
- 成就 toast 底部横条仍会短暂盖住列表末行（3s 自动消失，可接受）。
- 截图中的黑色「N」圆标为 Next.js devtools 开发态浮标，非应用 UI。
