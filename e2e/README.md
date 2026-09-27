# E2E 冒烟测试（Playwright）

真实浏览器回归，补 672 个逻辑层 vitest 测不出的 UI 链路（如「跟注按钮点了没反应」）。

## 跑一次

```bash
# 首次：装浏览器（下载失败见下方「系统 Chrome 回退」）
npx playwright install chromium

npm run test:e2e
```

- 不用手动起 dev server：`playwright.config.ts` 的 `webServer` 会自动
  `npm run dev -- -p 3105`（端口固定 3105，避开 3000/3001/3100）；
  若 3105 已有 dev server 在跑则直接复用（`reuseExistingServer`）。
- 串行单 worker（对局有真实计时：AI 行动 400-900ms 假延迟、结算 5s 自动推进），
  全套约 1-2 分钟。
- 每个用例都是全新浏览器上下文：AI 引擎缺省为本地启发式，**不会发 LLM 请求**。

## 系统 Chrome 回退（chromium 下载失败/太慢时）

编辑 `playwright.config.ts`，按文件头注释把 `projects` 换成：

```ts
projects: [
  { name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } },
],
```

即可跳过浏览器下载，直接用系统已装的 Chrome 跑。

## 用例清单（共 12 条）

`e2e/smoke.spec.ts`（7 条桌面端冒烟）：

1. 大厅加载 → 点「入座开战」（2 人现金）跳 `/play` → hero 两张底牌 + 行动栏渲染
2. hero 弃牌 → 结算横幅出现 → 不点按钮，等 5s 自动开下一手（手牌计数 +1）
3. `/history` 出现 ≥1 条记录 → 点进详情页 → 回放步骤（步进计数 + 动作序列）可见
4. `/stats` 加载出核心指标卡（总手数/总盈亏/每百手盈亏/胜率/摊牌率）
5. `/trainer` 答一道题（点「全下」）→ 出现 ✓/✗ 对错反馈
6. 设置页填写 API Key/Base URL/模型 → 保存 → 断言 localStorage 落盘 + 刷新回填
7. 语言切换：EN 后导航与大厅变英文，切回中文恢复

`e2e/mobile.spec.ts`（4 条移动端视口）：

1. 大厅单列渲染（快速对战与功能入口纵向堆叠）且无水平溢出
2. 6 人桌发牌渲染，无水平溢出
3. 行动栏所有可点按钮最小高度 ≥40px（触控目标）
4. 9 人桌竖屏横屏提示横幅出现且可关闭（记住关闭）

`e2e/screenshots.spec.ts`（1 条）：

1. 生成宣传截图

## 调试

```bash
npx playwright test --ui        # UI 模式逐步看
npx playwright test --headed    # 有头模式
npx playwright show-report      # 看最近一次 HTML 报告（失败含 trace/截图）
```

## 选择器约定

源码没有 `data-testid`（E2E 不允许为此改 src），统一用 role/文本/占位符定位；
唯一例外是 hero 底牌用结构 class `.h-16.w-12.bg-white`（翻前桌上唯一面朝上的
md 白底牌），已在 `smoke.spec.ts` 顶部注明。
