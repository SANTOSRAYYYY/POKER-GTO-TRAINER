import { expect, test, type Page } from "@playwright/test";

/**
 * 冒烟套件：覆盖「跟注按钮点了没反应」这类逻辑层测不出的真实浏览器链路。
 * 选择器约定：源码没有 data-testid（不允许为此改 src），统一用
 * role/文本/占位符定位，个别处用稳定的结构 class（已注明）。
 *
 * 每个 test 都是全新浏览器上下文（IndexedDB/localStorage 为空）：
 * - AI 决策引擎缺省为本地启发式，不会发任何 LLM 请求；
 * - 需要历史数据的用例自己先打一手牌制造数据。
 */

/** hero 两张底牌：翻前牌桌上唯一面朝上的 md 尺寸白底牌（AI 是 sm 背面，公共牌未发出） */
const HERO_CARDS = ".h-16.w-12.bg-white";

/** 结算横幅里的「立即下一手」按钮 */
const nextHandBtn = (page: Page) =>
  page.getByRole("button", { name: /立即下一手/ });

/** hero 行动栏的「弃牌」按钮（exact 避免匹配「提前弃牌」） */
const foldBtn = (page: Page) =>
  page.getByRole("button", { name: "弃牌", exact: true });

/** 直接以 URL 参数开 2 人现金桌，等 hero 两张底牌发出 */
async function startCashHeadsUp(page: Page) {
  await page.goto("/play?mode=cash&seats=2&aiStyle=random&sb=1&bb=2&buyin=200");
  try {
    await expect(page.locator(HERO_CARDS)).toHaveCount(2, { timeout: 20_000 });
  } catch {
    // dev server 首编译/HMR 抖动可能让开局卡住，重载一次再试
    await page.reload();
    await expect(page.locator(HERO_CARDS)).toHaveCount(2);
  }
}

/**
 * 点链接并等 URL 变化。dev server 首编译动态路由或 HMR 整页刷新会吞掉
 * 首次导航（URL 不变），超时后再点一次。
 */
async function clickAndWaitUrl(
  page: Page,
  link: ReturnType<Page["locator"]>,
  urlRe: RegExp,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await link.click();
    try {
      await page.waitForURL(urlRe, { timeout: 20_000 });
      return;
    } catch {
      // 导航没发生（编译停顿/刷新吞点击），重试
    }
  }
  await expect(page).toHaveURL(urlRe);
}

/** 顶栏「第 N 手」计数 */
async function handNumber(page: Page): Promise<number> {
  const text = (await page.getByText(/第 \d+ 手/).first().textContent()) ?? "";
  const m = /第 (\d+) 手/.exec(text);
  return m ? Number(m[1]) : 0;
}

/**
 * 轮询等到「hero 回合（弃牌可点）」或「AI 先弃牌直接结算」。
 * 单挑时 AI 在按钮位会先行动，可能直接弃牌结束本手——这两种分支都合法。
 */
async function waitHeroTurnOrSettled(
  page: Page,
  timeoutMs = 30_000,
): Promise<"heroTurn" | "settled"> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await nextHandBtn(page).isVisible()) return "settled";
    if (await foldBtn(page).isEnabled().catch(() => false)) return "heroTurn";
    await page.waitForTimeout(200);
  }
  throw new Error("30s 内既没轮到 hero 行动也没有结算横幅");
}

/**
 * 打一手「hero 点弃牌结束」的牌：若 AI 抢先弃牌则点「立即下一手」再来，
 * 直到 hero 真正点到弃牌、结算横幅出现为止（兜底最多 5 手）。
 */
async function playHandUntilHeroFolds(page: Page) {
  for (let i = 0; i < 5; i++) {
    const state = await waitHeroTurnOrSettled(page);
    if (state === "heroTurn") {
      await foldBtn(page).click();
      await expect(nextHandBtn(page)).toBeVisible({ timeout: 15_000 });
      return;
    }
    await nextHandBtn(page).click();
  }
  throw new Error("连续 5 手都没等到 hero 行动机会（AI 全部直接弃牌）");
}

test("大厅加载，点「入座开战」（2 人现金）跳 /play 并发牌", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /PokerGTO/ }),
  ).toBeVisible();

  // 默认就是现金局，切成 2 人桌（单挑）后开战
  await page.getByRole("button", { name: /2 人桌/ }).click();
  await page.getByRole("button", { name: /入座开战/ }).click();

  await expect(page).toHaveURL(/\/play\?/);
  await expect(page).toHaveURL(/mode=cash/);
  await expect(page).toHaveURL(/seats=2/);

  // 牌桌渲染出 hero 两张底牌 + 行动栏
  await expect(page.locator(HERO_CARDS)).toHaveCount(2);
  await expect(foldBtn(page)).toBeVisible();
});

test("hero 弃牌 → 结算横幅出现 → 5 秒后自动开下一手", async ({ page }) => {
  await startCashHeadsUp(page);
  await playHandUntilHeroFolds(page);

  // 结算横幅：胜者与 hero 盈亏
  await expect(page.getByText(/胜者：/)).toBeVisible();

  // 不点按钮，等 AUTO_ADVANCE_MS(5s) 自动推进，手牌计数 +1
  const before = await handNumber(page);
  await expect(page.getByText(`第 ${before + 1} 手`)).toBeVisible({
    timeout: 15_000,
  });
});

test("/history 出现记录，点进详情页能看到回放步骤", async ({ page }) => {
  await startCashHeadsUp(page);
  await playHandUntilHeroFolds(page); // 制造 1 条历史记录

  await page.goto("/history");
  await expect(page.getByRole("heading", { name: "手牌历史" })).toBeVisible();
  const rows = page.locator("ul li");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThanOrEqual(1);

  // 点进第一条详情
  await clickAndWaitUrl(
    page,
    rows.first().getByRole("link").first(),
    /\/history\/.+/,
  );
  await expect(page.getByRole("heading", { name: "手牌回放" })).toBeVisible({
    timeout: 15_000,
  });
  // 回放步骤：步进计数 + 当前街动作序列
  await expect(page.getByText(/第 \d+ \/ \d+ 步/)).toBeVisible();
  await expect(page.getByText(/动作序列/).first()).toBeVisible();
});

test("/stats 加载出核心指标卡", async ({ page }) => {
  await startCashHeadsUp(page);
  await playHandUntilHeroFolds(page); // 数据中心需要有手牌数据

  await page.goto("/stats");
  await expect(
    page.getByRole("heading", { name: "个人数据中心" }),
  ).toBeVisible();
  for (const label of ["总手数", "总盈亏", "每百手盈亏", "胜率", "摊牌率"]) {
    await expect(
      page.getByText(label, { exact: true }).first(),
    ).toBeVisible();
  }
});

test("/trainer 答一道题（点「全下」）出现对错反馈", async ({ page }) => {
  await page.goto("/trainer");
  await expect(page.getByRole("heading", { name: "训练器" })).toBeVisible();

  // 首题在客户端挂载后才发出（先显示「发牌中…」）
  const allin = page.getByRole("button", { name: "全下", exact: true });
  await expect(allin).toBeVisible();
  await allin.click();

  // 对错反馈（Nash 表判定，对错都可能）+ 下一题入口
  await expect(page.getByText(/✓ 正确|✗ 错误/)).toBeVisible();
  await expect(page.getByRole("button", { name: "下一手" })).toBeVisible();
});

test("设置页表单填写并保存到 localStorage（不调 LLM）", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();

  await page.getByPlaceholder("sk-...").fill("sk-e2e-dummy-key");
  await page
    .getByPlaceholder("https://api.deepseek.com")
    .fill("https://e2e.example.com/v1");
  await page.getByPlaceholder("deepseek-flash").fill("e2e-model");

  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByText(/已保存到本地浏览器/)).toBeVisible();

  // 直接读 localStorage 验证落盘内容
  const raw = await page.evaluate(() =>
    window.localStorage.getItem("pokergto_llm_config"),
  );
  const cfg = JSON.parse(raw ?? "{}") as Record<string, unknown>;
  expect(cfg.apiKey).toBe("sk-e2e-dummy-key");
  expect(cfg.baseUrl).toBe("https://e2e.example.com/v1");
  expect(cfg.model).toBe("e2e-model");

  // 刷新后表单从 localStorage 回填
  await page.reload();
  await expect(page.getByPlaceholder("sk-...")).toHaveValue(
    "sk-e2e-dummy-key",
  );
});

test("语言切换：EN 后导航与大厅变英文，切回中文恢复", async ({ page }) => {
  await page.goto("/");
  // 默认中文
  await expect(page.getByRole('link', { name: '历史', exact: true })).toBeVisible();
  // 切英文（按钮文本为 EN）
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await expect(page.getByRole('link', { name: 'History', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Stats', exact: true })).toBeVisible();
  // 切回中文
  await page.getByRole('button', { name: '中文', exact: true }).click();
  await expect(page.getByRole('link', { name: '历史', exact: true })).toBeVisible();
});
