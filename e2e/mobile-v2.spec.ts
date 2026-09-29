/**
 * 移动端深度体检回归（mobile-v2 审计修复的防退化用例，375x667 iPhone SE）。
 *
 * 覆盖：
 * 1. 全站导航移动端单行横滚（不再折 3 行挤压首屏），链接触控高 ≥40px；
 * 2. 胜率页 52 张选牌网格：移动端横向滚动且每张牌按钮宽 ≥24px（修复前 17px
 *    互相重叠、极易点错）；
 * 3. 范围页 13x13 矩阵格触控边长 ≥44px；
 * 4. 9 人桌（锦标赛 HUD + 横屏提示横幅并存的最挤形态）hero 底牌完整落在
 *    行动栏上方，不被裁切（修复前需滚动才能看到自己的牌）；
 * 5. 回放页步进按钮单行不折行（修复前「← 上一步」折成两行）。
 */
import { expect, test, type Page } from "@playwright/test";

const SE = { width: 375, height: 667 } as const;

test.use({ viewport: SE });

const FACE_UP = "div.bg-white";

async function waitHeroCards(page: Page) {
  try {
    await expect(page.locator(FACE_UP).first()).toBeVisible({
      timeout: 20_000,
    });
  } catch {
    await page.reload();
    await expect(page.locator(FACE_UP).first()).toBeVisible({
      timeout: 20_000,
    });
  }
}

test("全站导航单行横滚：所有链接同行、触控高 ≥40px、无水平溢出", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /PokerGTO/ })).toBeVisible();

  const nav = page.locator("header nav");
  const links = nav.getByRole("link");
  const count = await links.count();
  expect(count).toBe(8);
  let firstY: number | null = null;
  for (let i = 0; i < count; i++) {
    const box = await links.nth(i).boundingBox();
    expect(box).not.toBeNull();
    if (firstY === null) firstY = box!.y;
    // 单行：所有链接顶边一致（折行时第二行 y 会增大）
    expect(Math.abs(box!.y - firstY)).toBeLessThanOrEqual(2);
    expect(box!.height).toBeGreaterThanOrEqual(40);
  }

  const sw = await page.evaluate(() => document.body.scrollWidth);
  expect(sw).toBeLessThanOrEqual(SE.width + 1);
});

test("胜率页选牌网格：牌按钮不重叠（宽 ≥24px）且整页无水平溢出", async ({
  page,
}) => {
  await page.goto("/equity");
  await expect(
    page.getByRole("heading", { name: "胜率计算器" }),
  ).toBeVisible();

  // ♠ 行第一张 A♠ 的按钮：修复前格子 ~17px 互相重叠，修复后横向滚动、格 ≥30px
  const spadeA = page.getByRole("button", { name: "A♠", exact: true });
  await expect(spadeA).toBeVisible();
  const box = await spadeA.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(24);

  const sw = await page.evaluate(() => document.body.scrollWidth);
  expect(sw).toBeLessThanOrEqual(SE.width + 1);
});

test("范围页矩阵格触控边长 ≥44px", async ({ page }) => {
  await page.goto("/ranges");
  await expect(page.getByRole("heading", { name: "翻前范围表" })).toBeVisible();

  const cell = page.getByRole("button", { name: "AA", exact: true });
  await expect(cell).toBeVisible();
  const box = await cell.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
});

test("9 人桌 hero 底牌完整可见（不被行动栏/视口裁切）", async ({ page }) => {
  await page.goto("/play?mode=tournament&seats=9&aiStyle=random");
  await waitHeroCards(page);
  // 等发牌滑入动画落定再量（动画中底牌带向下位移，bottom 虚高）
  await page.waitForTimeout(2000);

  const pod = page.locator("#poker-hero-pod");
  await expect(pod).toBeVisible();
  const heroCards = pod.locator(FACE_UP);
  await expect(heroCards).toHaveCount(2);

  const bar = page.locator("div.sticky.bottom-0");
  await expect(bar).toBeVisible();
  const barBox = await bar.boundingBox();
  expect(barBox).not.toBeNull();

  for (let i = 0; i < 2; i++) {
    const box = await heroCards.nth(i).boundingBox();
    expect(box).not.toBeNull();
    // 底牌完整落在行动栏顶边之上（修复前 hero 舱被挤出首屏约一半）
    expect(box!.y + box!.height).toBeLessThanOrEqual(barBox!.y + 1);
  }
});

test("回放页步进按钮单行不折行、街道 tab 触控高 ≥40px", async ({ page }) => {
  // 先打一手造记录（与 smoke.spec.ts 同链路）
  await page.goto("/play?mode=cash&seats=2&aiStyle=random&sb=1&bb=2&buyin=200");
  await waitHeroCards(page);
  const fold = page.getByRole("button", { name: "弃牌", exact: true });
  const nextHand = page.getByText("立即下一手");
  for (let t = 0; t < 60; t++) {
    if (await fold.isEnabled().catch(() => false)) {
      await fold.click();
      break;
    }
    if (await nextHand.isVisible().catch(() => false)) break;
    await page.waitForTimeout(500);
  }

  await page.goto("/history");
  const firstRow = page.locator("ul li").first();
  await expect(firstRow).toBeVisible({ timeout: 15_000 });
  await firstRow.getByRole("link").first().click();
  await expect(
    page.getByRole("heading", { name: "手牌回放" }),
  ).toBeVisible({ timeout: 15_000 });

  const prev = page.getByRole("button", { name: /上一步/ });
  const next = page.getByRole("button", { name: /下一步/ });
  await expect(prev).toBeVisible();
  for (const btn of [prev, next]) {
    const box = await btn.boundingBox();
    expect(box).not.toBeNull();
    // 单行 text-sm（行高 20px + 上下 padding 各 10px ≈ 40px）；折行会 ≥56px
    expect(box!.height).toBeLessThan(48);
  }

  const streetTab = page.getByRole("button", { name: "翻前", exact: true });
  await expect(streetTab).toBeVisible();
  const tabBox = await streetTab.boundingBox();
  expect(tabBox).not.toBeNull();
  expect(tabBox!.height).toBeGreaterThanOrEqual(40);
});
