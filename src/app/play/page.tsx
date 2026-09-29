import { Suspense } from "react";
import PlayClient from "./PlayClient";

/**
 * /play 页面：纯静态壳。参数解析在 PlayClient（浏览器侧）完成，
 * 使本页既可由 Vercel 动态服务，也可被 `output: export` 静态导出。
 * Suspense 边界是 useSearchParams 参与静态预渲染的要求。
 */
export default function PlayPage() {
  return (
    <Suspense>
      <PlayClient />
    </Suspense>
  );
}
