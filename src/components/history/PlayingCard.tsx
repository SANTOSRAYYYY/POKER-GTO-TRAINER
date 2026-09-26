import type { Card, Suit } from "@/lib/types";

const SUIT_SYMBOL: Record<Suit, string> = {
  s: "♠",
  h: "♥",
  d: "♦",
  c: "♣",
};

const SUIT_COLOR: Record<Suit, string> = {
  s: "text-zinc-100",
  h: "text-red-400",
  d: "text-sky-400",
  c: "text-emerald-400",
};

const SIZE_CLASS = {
  sm: "h-9 w-7 text-sm rounded",
  md: "h-12 w-9 text-base rounded-md",
  lg: "h-16 w-12 text-xl rounded-md",
} as const;

export interface PlayingCardProps {
  card: Card;
  size?: keyof typeof SIZE_CLASS;
  /** 置灰（例如牌选择器中已用过的牌） */
  dimmed?: boolean;
}

/** 轻量牌面渲染（数据组自绘，不依赖 components/poker） */
export function PlayingCard({ card, size = "md", dimmed }: PlayingCardProps) {
  const rank = card[0];
  const suit = card[1] as Suit;
  return (
    <span
      className={`inline-flex select-none items-center justify-center border border-zinc-700 bg-zinc-900 font-semibold ${SIZE_CLASS[size]} ${SUIT_COLOR[suit]} ${dimmed ? "opacity-30" : ""}`}
    >
      {rank}
      {SUIT_SYMBOL[suit]}
    </span>
  );
}

/** 牌背（对手未公开的底牌） */
export function CardBack({ size = "md" }: { size?: keyof typeof SIZE_CLASS }) {
  return (
    <span
      className={`inline-flex select-none items-center justify-center border border-emerald-900 bg-emerald-950/60 text-emerald-700 ${SIZE_CLASS[size]}`}
    >
      ?
    </span>
  );
}
