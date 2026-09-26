/**
 * 轻量 i18n 基础设施（零依赖）。
 *
 * - Lang = 'zh' | 'en'，默认 'zh'（保持现有中文体验）；选择存 localStorage
 *   `pokergto_lang`。
 * - 字典：扁平 key（'domain.subKey'）→ { zh, en }；插值用 {name} 占位符。
 * - SSR/首帧一律中文（避免 hydration 不一致），挂载后按存储语言切换。
 *
 * 用法：
 *   const { t, lang, setLang } = useI18n();
 *   t('nav.home')                       → '大厅' / 'Lobby'
 *   t('action.callAmount', { n: 40 })   → '跟注 40' / 'Call 40'
 */
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { DICT, type DictKey } from "./dict";

export type Lang = "zh" | "en";

const LANG_KEY = "pokergto_lang";

interface I18nCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: DictKey, vars?: Record<string, string | number>) => string;
}

const Ctx = createContext<I18nCtx | null>(null);

function readStoredLang(): Lang {
  try {
    const v = window.localStorage.getItem(LANG_KEY);
    if (v === "en" || v === "zh") return v;
  } catch {
    // 隐私模式等：静默回退默认
  }
  return "zh";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  // 首帧与 SSR 一致用 zh；挂载后再读存储值，避免 hydration mismatch
  const [lang, setLangState] = useState<Lang>("zh");
  useEffect(() => {
    setLangState(readStoredLang());
  }, []);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      window.localStorage.setItem(LANG_KEY, l);
    } catch {
      // 写入失败仅影响记忆
    }
  }, []);

  const t = useCallback(
    (key: DictKey, vars?: Record<string, string | number>): string => {
      const entry = DICT[key];
      let s = entry ? entry[lang] : String(key);
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          s = s.replaceAll(`{${k}}`, String(v));
        }
      }
      return s;
    },
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 未包在 Provider 内时回退中文直查（防御：理论上全站都在 Provider 内） */
export function useI18n(): I18nCtx {
  const ctx = useContext(Ctx);
  if (ctx) return ctx;
  return {
    lang: "zh",
    setLang: () => {},
    t: (key, vars) => {
      const entry = DICT[key];
      let s = entry ? entry.zh : String(key);
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          s = s.replaceAll(`{${k}}`, String(v));
        }
      }
      return s;
    },
  };
}
