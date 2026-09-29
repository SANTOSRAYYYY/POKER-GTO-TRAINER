"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import TableScreen from "@/components/poker/TableScreen";
import { parsePlayConfig } from "./config";

/**
 * /play 客户端壳：解析 URL 参数渲染牌桌。
 *
 * 历史上参数在服务端组件解析；为支持 Capacitor 静态导出（无服务器、
 * searchParams 构建期为空），改为浏览器侧解析——Web 与 App 行为一致。
 * config 以 searchParams 为依赖 memo，URL 不变时引用稳定，
 * 不会触发 TableScreen 的重开局逻辑。
 */
export default function PlayClient() {
  const searchParams = useSearchParams();
  const { config, resume } = useMemo(
    () => parsePlayConfig(Object.fromEntries(searchParams.entries())),
    [searchParams],
  );
  return <TableScreen config={config} resume={resume} />;
}
