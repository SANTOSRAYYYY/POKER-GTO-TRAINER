import type { Metadata } from "next";
import type { ReactNode } from "react";
import { I18nProvider } from "@/lib/i18n";
import { AppBoot } from "@/components/AppBoot";
import "./globals.css";

export const metadata: Metadata = {
  title: "PokerGTO Trainer",
  description: "单挑无限注德州扑克 AI 训练器 / Heads-up NLHE AI trainer",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
        <I18nProvider>
          <AppBoot />
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
