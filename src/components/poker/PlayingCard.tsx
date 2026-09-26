"use client";

import type { CSSProperties } from "react";
import type { Card, Rank, Suit } from "@/lib/types";
import { useI18n } from "@/lib/i18n";

const SUIT_SYMBOL: Record<Suit, string> = {
  s: "♠",
  h: "♥",
  d: "♦",
  c: "♣",
};

const SUIT_COLOR: Record<Suit, string> = {
  s: "text-neutral-900",
  c: "text-neutral-900",
  h: "text-red-600",
  d: "text-red-600",
};

const RANK_LABEL: Record<Rank, string> = {
  "2": "2",
  "3": "3",
  "4": "4",
  "5": "5",
  "6": "6",
  "7": "7",
  "8": "8",
  "9": "9",
  T: "10",
  J: "J",
  Q: "Q",
  K: "K",
  A: "A",
};

export type CardSize = "xs" | "sm" | "md" | "lg";

const SIZE_CLASS: Record<CardSize, string> = {
  xs: "h-9 w-7 rounded text-xs",
  sm: "h-11 w-8 rounded-md text-sm",
  md: "h-16 w-12 rounded-lg text-xl",
  lg: "h-24 w-[4.5rem] rounded-xl text-3xl",
};

const CORNER_CLASS: Record<CardSize, string> = {
  xs: "hidden",
  sm: "hidden",
  md: "absolute left-1 top-1 flex flex-col items-center text-[10px] leading-none",
  lg: "absolute left-1.5 top-1.5 flex flex-col items-center text-sm leading-none",
};

export type CardAnim = "deal" | "flip";

export interface PlayingCardProps {
  /** 牌面；null/undefined 或 faceDown 时显示背面 */
  card?: Card | null;
  size?: CardSize;
  faceDown?: boolean;
  /**
   * 入场动画（挂载时播放一次；调用方用 key 控制重挂载时机）：
   * deal = 从牌堆滑入（方向由 style 里的 --pk-deal-x/y 控制）；
   * flip = rotateY 翻亮。keyframes 见 PokerAnimStyles。
   */
  animate?: CardAnim;
  /** 入场动画 stagger 延迟（ms） */
  animDelay?: number;
}

export default function PlayingCard({
  card,
  size = "md",
  faceDown = false,
  animate,
  animDelay = 0,
}: PlayingCardProps) {
  const { t } = useI18n();
  const sizeCls = SIZE_CLASS[size];
  const animCls = animate ? ` pk-anim-${animate}` : "";
  const animStyle: CSSProperties = {
    ...(animDelay > 0 ? { animationDelay: `${animDelay}ms` } : {}),
  };

  if (faceDown || !card) {
    return (
      <div
        className={`${sizeCls}${animCls} border border-white/25 shadow-lg shadow-black/40`}
        style={{
          background:
            "repeating-linear-gradient(45deg, #172554, #172554 5px, #1d4ed8 5px, #1d4ed8 10px)",
          ...animStyle,
        }}
        aria-label={t("table.cardBack")}
      />
    );
  }

  const rank = card[0] as Rank;
  const suit = card[1] as Suit;
  const color = SUIT_COLOR[suit];

  return (
    <div
      className={`${sizeCls}${animCls} relative flex items-center justify-center bg-white font-bold shadow-lg shadow-black/40 ${color}`}
      style={animStyle}
    >
      <span className={CORNER_CLASS[size]}>
        <span>{RANK_LABEL[rank]}</span>
        <span>{SUIT_SYMBOL[suit]}</span>
      </span>
      <span className="flex flex-col items-center leading-none">
        <span>{RANK_LABEL[rank]}</span>
        <span>{SUIT_SYMBOL[suit]}</span>
      </span>
    </div>
  );
}
