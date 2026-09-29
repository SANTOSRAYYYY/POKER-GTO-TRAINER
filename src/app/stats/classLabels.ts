import type { OpponentClass } from "@/lib/types";

/**
 * 「AI 眼中的你」分类推测的双语标签（与 prompt.ts CLASS_CN 同口径，供展示卡使用）。
 * 独立成模块以便 vitest 直接做双语齐全性测试（filterCompare.ts 同款抽法）。
 */
export const CLASS_LABEL: Record<OpponentClass, { zh: string; en: string }> = {
  nit: { zh: "紧弱岩石（Nit）", en: "Rock (Nit)" },
  tag: { zh: "紧凶（TAG）", en: "Tight-aggressive (TAG)" },
  lag: { zh: "松凶（LAG）", en: "Loose-aggressive (LAG)" },
  maniac: { zh: "疯狂玩家（Maniac）", en: "Maniac" },
  calling_station: { zh: "跟注站", en: "Calling station" },
  unknown: { zh: "样本不足，暂无画像", en: "Not enough samples for a profile yet" },
};
