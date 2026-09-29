import type { NextConfig } from "next";

/**
 * 双模式构建：
 * - 默认（Vercel 部署）：标准服务端构建，含 /api/llm 代理路由。
 * - APP_EXPORT=1（Capacitor 打包）：静态导出到 out/，无服务器。
 *
 * 导出模式的两个关键开关：
 * - pageExtensions 仅 tsx：唯一的 Route Handler（api/llm/route.ts）不再被
 *   识别为路由而排除在导出之外（静态导出不支持服务端 Route Handler），
 *   源文件保留、Vercel 构建不受影响；app 内其它 .ts 均为被导入的普通模块，
 *   pageExtensions 只决定“哪些文件成为路由”，不影响模块解析。
 * - distDir 设为 out：Next 16（Turbopack）的静态导出直接写入 distDir，
 *   与 Vercel 构建/dev 的 .next 完全隔离，同时正好作为 Capacitor 的 webDir。
 * trailingSlash 让每页生成 <route>/index.html，适配 Capacitor 本地文件服务。
 *
 * NEXT_DIST_DIR：仅为并行验证提供便利（dev server 占用 .next 时可另指目录），
 * 正常构建无需设置。
 */
const isAppExport = process.env.APP_EXPORT === "1";

const nextConfig: NextConfig = isAppExport
  ? {
      output: "export",
      distDir: "out",
      trailingSlash: true,
      pageExtensions: ["tsx"],
    }
  : { distDir: process.env.NEXT_DIST_DIR || ".next" };

export default nextConfig;
