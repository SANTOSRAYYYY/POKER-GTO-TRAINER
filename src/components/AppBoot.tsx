"use client";

import { useEffect } from "react";
import { initSettingsStorage } from "@/lib/storage/settings";
import { installAutoBackup } from "@/lib/storage/backup";

/**
 * App 启动引导（挂根布局，全站一次）：
 * - initSettingsStorage：原生壳内把 localStorage 旧设置一次性迁移进
 *   Preferences，并预载到内存缓存供同步读者使用（Web 为空操作）；
 * - installAutoBackup：原生壳内注册「进入后台自动备份」（Web 为空操作）。
 */
export function AppBoot() {
  useEffect(() => {
    void initSettingsStorage();
    installAutoBackup();
  }, []);
  return null;
}
