/**
 * 语言类型与存储读取的独立模块（无 React 依赖）。
 *
 * store 层（historyStore/gameStore）与纯逻辑层（ai/prompt）需要按当前 UI
 * 语言切换 LLM prompt，但它们不应 import 带 React 的 index.tsx，故抽到此模块。
 */
import { getItemSync } from "@/lib/storage/settings";

export type Lang = "zh" | "en";

/** UI 语言的存储键（与设置页/导航语言切换共用；原生走 Preferences 预载缓存） */
export const LANG_KEY = "pokergto_lang";

/** 读取记忆的 UI 语言；无窗口（SSR/单测）、隐私模式异常、非法值一律回退默认 zh */
export function getStoredLang(): Lang {
  try {
    if (typeof window === "undefined") return "zh";
    const v = getItemSync(LANG_KEY);
    if (v === "en" || v === "zh") return v;
  } catch {
    // 隐私模式等：静默回退默认
  }
  return "zh";
}
