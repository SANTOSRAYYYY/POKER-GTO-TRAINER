import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor 配置：Web 静态导出（out/，由 APP_EXPORT=1 next build 生成）套壳成原生 App。
 *
 * - webDir 指向静态导出产物；`npm run build:app` 完成构建后自动 `cap sync`。
 * - android.backgroundColor：WebView 首帧背景，对齐应用深色主题（zinc-950），
 *   避免启动白闪。
 * - 不允许缩放 / 全屏：在原生侧配置（android/ 的 MainActivity 与 styles.xml），
 *   不影响 Web 端的视口与可访问性。
 */
const config: CapacitorConfig = {
  appId: "com.pokergto.trainer",
  appName: "PokerGTO Trainer",
  webDir: "out",
  android: {
    backgroundColor: "#0a0a0a",
  },
};

export default config;
