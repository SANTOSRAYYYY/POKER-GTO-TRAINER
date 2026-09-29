"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { DictKey } from "@/lib/i18n/dict";
import { useHistoryStore } from "@/lib/store/historyStore";
import {
  isAutoBackupEnabled,
  pickBackupJson,
  saveBackupFile,
  setAutoBackupEnabled,
} from "@/lib/storage/backup";
import { isNativeApp } from "@/lib/nativeApp";

type Status =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ok" | "fail"; key: DictKey; vars?: Record<string, string | number> };

/**
 * 数据备份卡（设置页）：全量导出（Web 下载 / App 写 Documents）、按 id 去重
 * 合并导入、App 进入后台自动备份开关（默认开）。
 */
export function BackupCard() {
  const { t } = useI18n();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [autoBackup, setAutoBackup] = useState(true);
  const [showAuto, setShowAuto] = useState(false);

  // 挂载后再读开关真实值与原生判定（SSR 恒 false，避免 hydration 不一致）
  useEffect(() => {
    setShowAuto(isNativeApp());
    setAutoBackup(isAutoBackupEnabled());
  }, []);

  const onExport = async () => {
    setStatus({ kind: "busy" });
    try {
      const { filename, json } = await useHistoryStore.getState().exportBackup();
      const saved = await saveBackupFile(filename, json);
      setStatus(
        saved.kind === "filesystem"
          ? { kind: "ok", key: "settings.backup.exportSavedApp", vars: { path: saved.uri } }
          : { kind: "ok", key: "settings.backup.exportDone", vars: { filename } },
      );
    } catch {
      setStatus({ kind: "fail", key: "settings.backup.exportFail" });
    }
  };

  const onImport = async () => {
    setStatus({ kind: "busy" });
    try {
      const json = await pickBackupJson();
      if (json === null) {
        setStatus({ kind: "idle" });
        return;
      }
      const { imported, skipped } = await useHistoryStore
        .getState()
        .importBackup(json);
      setStatus({
        kind: "ok",
        key: "settings.backup.importDone",
        vars: { imported, skipped },
      });
    } catch {
      setStatus({ kind: "fail", key: "settings.backup.importFail" });
    }
  };

  const busy = status.kind === "busy";

  return (
    <section className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="mb-1 font-semibold">{t("settings.backup.title")}</h2>
      <p className="mb-4 text-xs leading-5 text-zinc-500">
        {t("settings.backup.desc")}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void onExport()}
          disabled={busy}
          className="rounded-lg border border-zinc-600 px-4 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-800 disabled:opacity-40 max-md:py-3"
        >
          {busy ? t("settings.backup.busy") : t("settings.backup.export")}
        </button>
        <button
          onClick={() => void onImport()}
          disabled={busy}
          className="rounded-lg border border-zinc-600 px-4 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-800 disabled:opacity-40 max-md:py-3"
        >
          {busy ? t("settings.backup.busy") : t("settings.backup.import")}
        </button>
      </div>

      {status.kind === "ok" && (
        <p className="mt-3 break-all text-sm text-emerald-400">
          ✓ {t(status.key, status.vars)}
        </p>
      )}
      {status.kind === "fail" && (
        <div className="mt-3 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
          ✗ {t(status.key, status.vars)}
        </div>
      )}

      {showAuto && (
        <div className="mt-4 border-t border-zinc-800 pt-3">
          <label className="flex items-center gap-2 text-sm max-md:py-2.5">
            <input
              type="checkbox"
              checked={autoBackup}
              onChange={(e) => {
                setAutoBackup(e.target.checked);
                setAutoBackupEnabled(e.target.checked);
              }}
              className="accent-emerald-500"
            />
            {t("settings.backup.auto")}
          </label>
          <p className="mt-1 text-xs leading-5 text-zinc-500">
            {t("settings.backup.autoHint")}
          </p>
        </div>
      )}
    </section>
  );
}
