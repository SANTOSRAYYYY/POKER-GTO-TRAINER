import { defineConfig, devices } from "@playwright/test";

/**
 * E2E 冒烟配置（真实浏览器回归，补 672 个逻辑层 vitest 测不出的 UI 链路）。
 *
 * 浏览器：默认用 `npx playwright install chromium` 下载的 chromium。
 * 若下载失败/太慢，改用系统已装 Chrome —— 把下面 projects 换成：
 *   projects: [
 *     { name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } },
 *   ],
 *
 * 端口固定 3105（3000/3001/3100 留给其他并行任务）；
 * webServer 复用已起的 dev server，没起则自动 `npm run dev -- -p 3105`。
 */
const PORT = 3105;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // AI 行动有 400-900ms 假延迟、结算后 5s 自动推进，超时整体放宽
  timeout: 120_000,
  expect: { timeout: 30_000 },
  // 共享同一个 dev server，且对局有真实计时，串行最稳
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run dev -- -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
