/**
 * 备份文件的平台落地与自动备份：
 *
 * - 导出落盘 saveBackupFile：Web 走 Blob 下载；原生走 @capacitor/filesystem
 *   写入 Documents 目录并返回 uri（UI 展示给用户）。
 * - 导入 pickBackupJson：<input type="file"> 选择器读文本（Web 与 App WebView
 *   通用）；窗口重获焦点且未选文件按取消处理。
 * - 自动备份（仅原生，默认开，pokergto_autobackup 开关）：App 插件 pause
 *   事件（进入后台）触发，把全量备份写到 Documents；文件名按 ISO 周轮换
 *   （同一周重复备份覆盖同一文件），通过设置存储里的清单保留最近 2 份。
 *
 * 纯函数（autoBackupFilename / pruneAutoBackupManifest）与 DOM/插件调用分离，
 * 便于 vitest 在 node 环境直测。
 */
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { App } from "@capacitor/app";
import { isNativeApp } from "@/lib/nativeApp";
import { getItemSync, setItem } from "@/lib/storage/settings";
import { useHistoryStore } from "@/lib/store/historyStore";

/** 自动备份开关键（"1" 开 / "0" 关，缺省开） */
export const AUTO_BACKUP_KEY = "pokergto_autobackup";
/** 自动备份文件清单键（JSON 数组，最新在前；按它做轮换删除） */
const AUTO_BACKUP_MANIFEST_KEY = "pokergto_autobackup_files";
/** 自动备份保留份数 */
export const AUTO_BACKUP_KEEP = 2;

// ---------------------------------------------------------------------------
// 导出 / 导入文件
// ---------------------------------------------------------------------------

export type SaveBackupResult =
  | { kind: "download"; filename: string }
  | { kind: "filesystem"; filename: string; uri: string };

/** 保存备份：原生写 Documents，Web 触发浏览器下载 */
export async function saveBackupFile(
  filename: string,
  json: string,
): Promise<SaveBackupResult> {
  if (isNativeApp()) {
    const { uri } = await Filesystem.writeFile({
      path: filename,
      data: json,
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
      recursive: true,
    });
    return { kind: "filesystem", filename, uri };
  }
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { kind: "download", filename };
}

/** 弹出文件选择器读取备份 JSON；用户取消/读取失败返回 null */
export function pickBackupJson(): Promise<string | null> {
  if (typeof document === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    let settled = false;
    const onFocus = () => {
      // 取消选择没有事件：窗口重获焦点后若仍未选文件按取消处理
      setTimeout(() => {
        if (!input.files?.length) done(null);
      }, 400);
    };
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus);
      resolve(v);
    };
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        done(null);
        return;
      }
      file.text().then(done, () => done(null));
    };
    window.addEventListener("focus", onFocus);
    input.click();
  });
}

// ---------------------------------------------------------------------------
// 自动备份
// ---------------------------------------------------------------------------

export function isAutoBackupEnabled(): boolean {
  return getItemSync(AUTO_BACKUP_KEY) !== "0";
}

export function setAutoBackupEnabled(on: boolean): void {
  void setItem(AUTO_BACKUP_KEY, on ? "1" : "0");
}

/**
 * 自动备份文件名（按 ISO 周轮换）：pokergto-autobackup-<ISO周年>-W<周数>.json。
 * 同一周内的重复备份覆盖同一文件；跨年/跨周自然切换新文件名。
 */
export function autoBackupFilename(d: Date = new Date()): string {
  // ISO 8601 周：周四所在的年即「周年」
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // 周一=0 … 周日=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // 本周周四
  const weekYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week =
    1 + Math.round((date.getTime() - firstThursday.getTime()) / 604800000);
  return `pokergto-autobackup-${weekYear}-W${String(week).padStart(2, "0")}.json`;
}

/** 清单轮换（纯函数）：最新在前去重后保留 keep 份，返回保留与待删除列表 */
export function pruneAutoBackupManifest(
  names: string[],
  keep: number = AUTO_BACKUP_KEEP,
): { kept: string[]; removed: string[] } {
  const unique = [...new Set(names)];
  return { kept: unique.slice(0, keep), removed: unique.slice(keep) };
}

function readManifest(): string[] {
  try {
    const raw = getItemSync(AUTO_BACKUP_MANIFEST_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr.filter((n): n is string => typeof n === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * 执行一次自动备份（仅原生且开关打开时）：全量导出 → 写 Documents →
 * 按清单轮换删除旧文件（保留最近 AUTO_BACKUP_KEEP 份）。
 * 任何失败只记日志，不打扰用户；成功返回文件名，否则 null。
 */
export async function runAutoBackup(
  now: Date = new Date(),
): Promise<string | null> {
  if (!isNativeApp() || !isAutoBackupEnabled()) return null;
  try {
    const { json } = await useHistoryStore.getState().exportBackup();
    const name = autoBackupFilename(now);
    await Filesystem.writeFile({
      path: name,
      data: json,
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
      recursive: true,
    });
    const { kept, removed } = pruneAutoBackupManifest(
      [name, ...readManifest()],
      AUTO_BACKUP_KEEP,
    );
    for (const old of removed) {
      await Filesystem.deleteFile({
        path: old,
        directory: Directory.Documents,
      }).catch(() => {});
    }
    void setItem(AUTO_BACKUP_MANIFEST_KEY, JSON.stringify(kept));
    return name;
  } catch (err) {
    console.error("[backup] 自动备份失败:", err);
    return null;
  }
}

let autoBackupInstalled = false;

/** 注册「进入后台自动备份」（仅原生；重复调用安全，只装一次） */
export function installAutoBackup(): void {
  if (autoBackupInstalled || typeof window === "undefined" || !isNativeApp()) {
    return;
  }
  autoBackupInstalled = true;
  void App.addListener("pause", () => {
    void runAutoBackup();
  });
}
