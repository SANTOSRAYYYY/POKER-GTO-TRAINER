"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AchievementToastHost,
  useAchievementAutoCheck,
} from "@/components/AchievementToast";
import { useI18n } from "@/lib/i18n";
import type { DictKey } from "@/lib/i18n/dict";

const LINKS: { href: string; key: DictKey }[] = [
  { href: "/", key: "nav.home" },
  { href: "/play", key: "nav.play" },
  { href: "/trainer", key: "nav.trainer" },
  { href: "/history", key: "nav.history" },
  { href: "/stats", key: "nav.stats" },
  { href: "/ranges", key: "nav.ranges" },
  { href: "/equity", key: "nav.equity" },
  { href: "/settings", key: "nav.settings" },
];

/** 全站顶部导航（兼作成就 toast 挂载点与语言切换入口） */
export function Nav() {
  const pathname = usePathname();
  const { t, lang, setLang } = useI18n();
  // /stats 与 /history 页加载时检查新解锁成就（toast 队列在 store，跨页面生效）
  useAchievementAutoCheck();
  return (
    <>
      <header className="border-b border-zinc-800 bg-zinc-950/90">
      <div className="mx-auto flex max-w-6xl items-center gap-1 px-4 py-3">
        <Link href="/" className="mr-4 flex items-center gap-2">
          <span className="text-lg font-bold text-emerald-400">PokerGTO</span>
          <span className="hidden text-sm text-zinc-500 sm:inline">Trainer</span>
        </Link>
        <nav className="flex flex-1 flex-wrap items-center gap-1">
          {LINKS.map((l) => {
            const active =
              l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-md px-3 py-1.5 max-md:py-2 text-sm transition-colors ${
                  active
                    ? "bg-emerald-500/15 font-medium text-emerald-400"
                    : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
                }`}
              >
                {t(l.key)}
              </Link>
            );
          })}
        </nav>
        <button
          type="button"
          onClick={() => setLang(lang === "zh" ? "en" : "zh")}
          className="ml-2 rounded-md border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-300 transition-colors hover:border-emerald-500 hover:text-emerald-400"
          title={lang === "zh" ? "Switch to English" : "切换为中文"}
        >
          {t("nav.langToggle")}
        </button>
      </div>
      </header>
      <AchievementToastHost />
    </>
  );
}
