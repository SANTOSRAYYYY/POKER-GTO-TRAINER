/**
 * /stats 双语标签齐全性测试（Bug 3 修复：EN 模式不再残留中文）。
 *
 * - CLASS_LABEL（「AI 眼中的你」分类标签，classLabels.ts）：6 个
 *   OpponentClass 键双语非空，zh 回归锁定原硬编码文案；
 * - POS_LABEL（PositionTable 位置表标注）：覆盖 POSITION_SHORT_NAMES
 *   全部短名，双语非空，zh 回归锁定原 POS_CN 文案。
 */
import { describe, expect, it } from "vitest";
import type { OpponentClass } from "@/lib/types";
import { POSITION_SHORT_NAMES } from "@/lib/ai/positions";
import { CLASS_LABEL } from "../classLabels";
import { POS_LABEL } from "@/components/stats/PositionTable";

describe("CLASS_LABEL 画像分类双语", () => {
  it("6 个 OpponentClass 键双语非空，zh 与原硬编码逐字一致", () => {
    const classes: OpponentClass[] = [
      "nit",
      "tag",
      "lag",
      "maniac",
      "calling_station",
      "unknown",
    ];
    const ZH: Record<OpponentClass, string> = {
      nit: "紧弱岩石（Nit）",
      tag: "紧凶（TAG）",
      lag: "松凶（LAG）",
      maniac: "疯狂玩家（Maniac）",
      calling_station: "跟注站",
      unknown: "样本不足，暂无画像",
    };
    expect(Object.keys(CLASS_LABEL).sort()).toEqual([...classes].sort());
    for (const c of classes) {
      expect(CLASS_LABEL[c].zh.length, `${c}.zh`).toBeGreaterThan(0);
      expect(CLASS_LABEL[c].en.length, `${c}.en`).toBeGreaterThan(0);
      expect(CLASS_LABEL[c].zh).toBe(ZH[c]);
    }
    expect(CLASS_LABEL.nit.en).toBe("Rock (Nit)");
  });
});

describe("POS_LABEL 位置表标注双语", () => {
  it("覆盖 POSITION_SHORT_NAMES 全部短名，双语非空，zh 与原 POS_CN 逐字一致", () => {
    const ALL_SHORTS = [
      ...new Set(Object.values(POSITION_SHORT_NAMES).flat()),
    ];
    const ZH: Record<string, string> = {
      BTN: "按钮位",
      CO: "关煞位",
      HJ: "劫持位",
      LJ: "洛杰克",
      UTG: "枪口位",
      "UTG+1": "枪口+1",
      "UTG+2": "枪口+2",
      SB: "小盲",
      BB: "大盲",
      "CO/UTG": "关煞/枪口",
      "BTN/SB": "按钮/小盲",
    };
    expect(Object.keys(POS_LABEL).sort()).toEqual(ALL_SHORTS.sort());
    for (const short of ALL_SHORTS) {
      const label = POS_LABEL[short];
      expect(label, short).toBeDefined();
      expect(label.zh.length, `${short}.zh`).toBeGreaterThan(0);
      expect(label.en.length, `${short}.en`).toBeGreaterThan(0);
      expect(label.zh).toBe(ZH[short]);
    }
    expect(POS_LABEL["BTN/SB"].en).toBe("Button / Small blind");
  });
});
