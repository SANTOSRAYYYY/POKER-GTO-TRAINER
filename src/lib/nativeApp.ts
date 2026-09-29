/**
 * Capacitor 原生壳检测与 App 模式链接辅助。
 *
 * 静态导出（App）模式下没有服务器，Next App Router 的动态路由
 * /history/[id] 只有 generateStaticParams 预生成的占位壳 /history/_/
 * 存在实体文件；客户端跳转到任意真实 id 会因 RSC payload（.txt）404 失败。
 * 因此 App 内复盘页统一走占位壳 + 查询参数：/history/_/?id=<handId>，
 * 页面组件（HandReplay）在 useParams 为占位值时回退读 ?id=。
 * Web（Vercel）模式不受影响，仍用 /history/<id> 直链。
 */

/** 是否运行在 Capacitor 原生壳内（WebView 注入 window.Capacitor） */
export function isNativeApp(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (
    window as { Capacitor?: { isNativePlatform?: () => boolean } }
  ).Capacitor;
  return cap?.isNativePlatform?.() === true;
}

/** App 模式复盘页地址（占位壳 + 查询参数），Web 模式不应使用 */
export function nativeHandReplayHref(id: string): string {
  return `/history/_/?id=${encodeURIComponent(id)}`;
}
