/**
 * App 静态导出构建脚本（npm run build:app）。
 *
 * 流程：APP_EXPORT=1 next build（产物 out/，配置见 next.config.ts）
 *   → npx cap sync android（拷贝 out/ 进 android/ 原生工程并同步插件）。
 *
 * 用 Node 脚本而不是 npm script 内联环境变量，是为了在
 * Windows cmd / PowerShell / Git Bash / *nix 下行为一致。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

process.env.APP_EXPORT = "1";

function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run("npx", ["next", "build"]);

if (existsSync("android")) {
  run("npx", ["cap", "sync", "android"]);
} else {
  console.log(
    "\n[build:app] 未检测到 android/ 原生工程，已跳过 cap sync。" +
      "先执行 npx cap add android 再重新构建。\n",
  );
}
