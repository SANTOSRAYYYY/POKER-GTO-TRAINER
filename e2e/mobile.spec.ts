/**
 * 移动端冒烟：真实移动视口（iPhone SE 375x667）下的布局回归。
 * 选择器约定与 smoke.spec.ts 一致（role/文本/aria-label），横屏提示横幅
 * 用 aria-label「关闭提示」定位。
 *
 * 每个 test 都是全新浏览器上下文（localStorage 为空，横屏提示默认未关闭）。
 */
import { expect, test, type Page } from "@playwright/test";

const SE = { width: 375, height: 667 } as const;

test.use({ viewport: SE });

/** 发牌后 hero 两张面朝上的白底牌（紧凑模式 sm 尺寸，公共牌未发出时唯一） */
const FACE_UP = "div.bg-white";

async function waitHeroCards(page: Page) {
  try {
    await expect(page.locator(FACE_UP).first()).toBeVisible({
      timeout: 20_000,
    });
  } catch {
    // dev server 首编译/HMR 抖动可能让开局卡住，重载一次再试
    await page.reload();
    await expect(page.locator(FACE_UP).first()).toBeVisible({
      timeout: 20_000,
    });
  }
}

/** 无水平溢出：body 滚动宽度不超过视口 1px */
async function expectNoHOverflow(page: Page) {
  const sw = await page.evaluate(() => document.body.scrollWidth);
  expect(sw).toBeLessThanOrEqual(SE.width + 1);
}

test("大厅单列渲染（快速对战与功能入口纵向堆叠）且无水平溢出", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /PokerGTO/ })).toBeVisible();

  // lg 以下主网格塌缩为单列：快速对战卡与功能入口卡左缘对齐、纵向排列
  const quick = page.getByRole("heading", { name: "快速对战" });
  const entry = page.getByRole("link", { name: /手牌历史/ }).first();
  const qb = await quick.boundingBox();
  const eb = await entry.boundingBox();
  expect(qb).not.toBeNull();
  expect(eb).not.toBeNull();
  expect(Math.abs(qb!.x - eb!.x)).toBeLessThanOrEqual(24);
  expect(eb!.y).toBeGreaterThan(qb!.y);

  await expectNoHOverflow(page);
});

test("6 人桌发牌渲染，无水平溢出", async ({ page }) => {
  await page.goto("/play?mode=cash&seats=6&aiStyle=random&sb=1&bb=2&buyin=200");
  await waitHeroCards(page);
  await expect(
    page.getByRole("button", { name: "弃牌", exact: true }),
  ).toBeVisible();
  await expectNoHOverflow(page);
});

test("行动栏所有可点按钮最小高度 ≥40px（触控目标）", async ({ page }) => {
  await page.goto("/play?mode=cash&seats=2&aiStyle=random&sb=1&bb=2&buyin=200");
  await waitHeroCards(page);

  // 行动栏（sticky 底栏）内当前渲染的全部按钮：hero 回合的行动按钮，
  // 或等待时的预操作按钮——两态按钮都按 min-h-11（44px）设计
  const bar = page.locator("div.sticky.bottom-0");
  await expect(bar).toBeVisible();
  const buttons = bar.getByRole("button");
  await expect(buttons.first()).toBeVisible({ timeout: 15_000 });
  const count = await buttons.count();
  expect(count).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < count; i++) {
    const box = await buttons.nth(i).boundingBox();
    expect(box, `行动栏第 ${i + 1} 个按钮应有布局框`).not.toBeNull();
    expect(
      box!.height,
      `行动栏第 ${i + 1} 个按钮高度应 ≥40px（当前 ${box!.height}px）`,
    ).toBeGreaterThanOrEqual(40);
  }
});

test("9 人桌竖屏横屏提示横幅出现且可关闭（记住关闭）", async ({ page }) => {
  await page.goto("/play?mode=tournament&seats=9&aiStyle=random");
  await waitHeroCards(page);

  const hint = page.getByText("9 人桌在竖屏较拥挤，旋转屏幕获得最佳体验");
  await expect(hint).toBeVisible();

  await page.getByRole("button", { name: "关闭提示" }).click();
  await expect(hint).toBeHidden();
  const saved = await page.evaluate(() =>
    window.localStorage.getItem("pokergto_rotate_hint_dismissed"),
  );
  expect(saved).toBe("1");
});
