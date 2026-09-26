/**
 * 宣传截图脚本：真实打几手牌造数据，截 牌桌/回放/数据中心 三张图。
 * 运行：npx playwright test e2e/screenshots.spec.ts
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const OUT = "docs/images";

test.use({ viewport: { width: 1600, height: 900 } });

async function playHands(page: Page, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    // 等轮到 hero 或已结算
    const fold = page.getByRole("button", { name: "弃牌", exact: true });
    const nextHand = page.getByText("立即下一手");
    const settled = page.getByText(/你赢了这手牌|你输了这手牌|赢家/);
    for (let t = 0; t < 60; t++) {
      if (await fold.isEnabled().catch(() => false)) {
        await fold.click();
        break;
      }
      if (await nextHand.isVisible().catch(() => false)) break;
      if (await settled.first().isVisible().catch(() => false)) break;
      await page.waitForTimeout(500);
    }
    // 等自动推进（5s 自动下一手）
    await page.waitForTimeout(6000);
  }
}

test("生成宣传截图", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });

  // 1) 牌桌：6 人现金局
  await page.goto("/play?mode=cash&seats=6&aiStyle=random&sb=1&bb=2&buyin=200");
  await expect(page.locator(".h-16.w-12.bg-white").first()).toBeVisible({
    timeout: 30000,
  });
  // 等一手进行到一半（信息更丰富），先等 AI 动几拍
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/table.png` });

  // 打 6 手造历史与画像数据
  await playHands(page, 6);

  // 2) 回放：第一条记录详情，展开一个参考线徽章
  await page.goto("/history");
  const rows = page.locator("ul li");
  await expect(rows.first()).toBeVisible({ timeout: 15000 });
  await rows.first().getByRole("link").first().click();
  await expect(page.getByText(/手牌回放|第 .* 步/).first()).toBeVisible({
    timeout: 15000,
  });
  const refBtn = page.getByRole("button", { name: "参考线" }).first();
  if (await refBtn.isVisible().catch(() => false)) {
    await refBtn.click();
    await page.waitForTimeout(2500);
  }
  await page.screenshot({ path: `${OUT}/replay.png`, fullPage: false });

  // 3) 数据中心（含「AI 眼中的你」）
  await page.goto("/stats");
  await expect(page.getByText(/总手数/).first()).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/stats.png`, fullPage: true });
});
