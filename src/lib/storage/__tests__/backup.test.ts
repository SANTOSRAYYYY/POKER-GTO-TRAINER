/**
 * 自动备份纯函数测试（lib/storage/backup.ts）：
 * - autoBackupFilename：ISO 8601 周轮换文件名（同一周同名、跨周换名、
 *   年末/年初边界归到正确周年）；
 * - pruneAutoBackupManifest：清单去重后保留最近 N 份。
 */
import { describe, expect, it } from "vitest";
import {
  autoBackupFilename,
  pruneAutoBackupManifest,
} from "@/lib/storage/backup";

describe("autoBackupFilename（ISO 周轮换）", () => {
  it("同一周内任意一天文件名相同（覆盖写），跨周换名", () => {
    // 2026-09-29 是周二，同属 2026-W40 的还有周一 09-28 与周日 10-04
    const mon = autoBackupFilename(new Date(2026, 8, 28));
    const tue = autoBackupFilename(new Date(2026, 8, 29));
    const sun = autoBackupFilename(new Date(2026, 9, 4));
    expect(tue).toBe("pokergto-autobackup-2026-W40.json");
    expect(mon).toBe(tue);
    expect(sun).toBe(tue);
    // 下周一进入 W41
    expect(autoBackupFilename(new Date(2026, 9, 5))).toBe(
      "pokergto-autobackup-2026-W41.json",
    );
  });

  it("年末/年初边界归到正确 ISO 周年", () => {
    // 2026-01-01 是周四，属 2026-W01
    expect(autoBackupFilename(new Date(2026, 0, 1))).toBe(
      "pokergto-autobackup-2026-W01.json",
    );
    // 2025-12-29（周一）属 2026-W01（周四落在 2026-01-01）
    expect(autoBackupFilename(new Date(2025, 11, 29))).toBe(
      "pokergto-autobackup-2026-W01.json",
    );
    // 2026-12-31（周四）：周四落在 2026 年，本周归 2026-W53（2026 有 53 个 ISO 周）
    expect(autoBackupFilename(new Date(2026, 11, 31))).toBe(
      "pokergto-autobackup-2026-W53.json",
    );
    // 2027-01-01（周五）与 12-31 同一周，仍属 2026-W53
    expect(autoBackupFilename(new Date(2027, 0, 1))).toBe(
      "pokergto-autobackup-2026-W53.json",
    );
    // 2027-01-04（周一）开启 2027-W01
    expect(autoBackupFilename(new Date(2027, 0, 4))).toBe(
      "pokergto-autobackup-2027-W01.json",
    );
  });
});

describe("pruneAutoBackupManifest（保留最近 N 份）", () => {
  it("去重后按最新在前保留 keep 份，其余进入删除列表", () => {
    const { kept, removed } = pruneAutoBackupManifest(
      ["w40.json", "w39.json", "w40.json", "w38.json"],
      2,
    );
    expect(kept).toEqual(["w40.json", "w39.json"]);
    expect(removed).toEqual(["w38.json"]);
  });

  it("不足 keep 份时不删除任何文件", () => {
    const { kept, removed } = pruneAutoBackupManifest(["w40.json"], 2);
    expect(kept).toEqual(["w40.json"]);
    expect(removed).toEqual([]);
  });
});
