import { Suspense } from "react";
import HandReplay from "./HandReplay";

/**
 * /history/[id] 页面壳（server component）。
 *
 * 静态导出（Capacitor App）模式要求动态路由声明 generateStaticParams：
 * 这里只预生成占位壳 /history/_/（手牌 id 存于设备 IndexedDB，构建期不可知）。
 * App 内跳转为 /history/_/?id=<handId>，HandReplay 在占位 id 时回退读 ?id=；
 * Vercel 部署 dynamicParams 默认为 true，任意 /history/<id> 仍按需渲染，行为不变。
 * Suspense 边界是 HandReplay 内 useSearchParams 参与静态预渲染的要求。
 */
export function generateStaticParams() {
  return [{ id: "_" }];
}

export default function HandReplayPage() {
  return (
    <Suspense>
      <HandReplay />
    </Suspense>
  );
}
