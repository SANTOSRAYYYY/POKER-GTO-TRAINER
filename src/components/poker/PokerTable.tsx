"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { HERO_SEAT, useGameStore } from "@/lib/store/gameStore";
import { positionName } from "@/lib/ai/positions";
import type { Card, GameState, Seat } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import type { DictKey } from "@/lib/i18n/dict";
import PlayingCard, { type CardSize } from "./PlayingCard";
import PokerAnimStyles from "./PokerAnimStyles";
import { useCountUp } from "./useCountUp";

/** 座位 j 在椭圆上的角度（弧度，屏幕坐标 y 向下：90° + j·360/n 即顺时针） */
function seatRad(j: number, n: number): number {
  return ((90 + (j * 360) / n) * Math.PI) / 180;
}

/**
 * 紧凑模式（<768px 视口）：与 Tailwind md 断点同源（matchMedia 视口判定，
 * 保证 JS 几何与 CSS 断点类始终一致）。SSR/首帧为 false（桌面几何），挂载后同步。
 */
function useCompactTable(): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setCompact(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return compact;
}

/**
 * 紧凑布局座位环（矩形环，% 坐标）：底边中点为 hero（t=0），t=j/n 顺时针。
 * 9 人桌在窄屏椭圆周长不足（座位舱会重叠），矩形环利用四角，周长约为
 * 3.4×桌宽，9 舱各得 ~110px 以上；内缩边界保证舱体不溢出视口。
 */
const RING = { x0: 17, x1: 83, y0: 9, y1: 89 } as const;

function ringPos(t: number): { x: number; y: number } {
  const w = RING.x1 - RING.x0;
  const h = RING.y1 - RING.y0;
  const half = w / 2;
  const total = 2 * (w + h);
  let d = (((t % 1) + 1) % 1) * total;
  if (d < half) return { x: 50 - d, y: RING.y1 };
  d -= half;
  if (d < h) return { x: RING.x0, y: RING.y1 - d };
  d -= h;
  if (d < w) return { x: RING.x0 + d, y: RING.y0 };
  d -= w;
  if (d < h) return { x: RING.x1, y: RING.y0 + d };
  return { x: RING.x1 - (d - h), y: RING.y1 };
}

const ROTATE_HINT_KEY = "pokergto_rotate_hint_dismissed";

/**
 * 竖屏窄屏（<390px）+ 9 人桌时的横屏提示横幅；可关闭，localStorage 记住。
 */
function RotateHint({ show }: { show: boolean }) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!show) {
      setVisible(false);
      return;
    }
    try {
      if (window.localStorage.getItem(ROTATE_HINT_KEY) === "1") return;
    } catch {
      // localStorage 不可用时按未关闭处理
    }
    const mq = window.matchMedia(
      "(orientation: portrait) and (max-width: 389px)",
    );
    const update = () => setVisible(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [show]);
  if (!visible) return null;
  // 在文档流内渲染（非 fixed）：横幅仅出现于 <390px 竖屏 9 人桌，fixed 会压住
  // 锦标赛 HUD 第二行；在流内把牌桌微微下推即可，桌面端永不渲染不受影响。
  return (
    <div className="mx-auto mb-1 flex w-fit max-w-[88vw] items-center gap-2 rounded-full border border-amber-700/60 bg-neutral-900/95 px-3 py-1.5 text-[11px] text-amber-200 shadow-xl">
      <span>{t("table.rotateHint")}</span>
      <button
        type="button"
        aria-label={t("table.dismissHint")}
        onClick={() => {
          try {
            window.localStorage.setItem(ROTATE_HINT_KEY, "1");
          } catch {
            // 忽略持久化失败，仅本次隐藏
          }
          setVisible(false);
        }}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold text-amber-300 hover:bg-neutral-800"
      >
        ×
      </button>
    </div>
  );
}

/**
 * 下注筹码圆片：金额变化时以 key 重挂载，播放「从座位飞向桌中」位移动画
 * （方向 = 座位相对桌心的外向向量，经 --pk-chip-x/y 传入；reduced-motion 降级静止）。
 */
function BetDisc({
  amount,
  tone,
  dx,
  dy,
  compact = false,
}: {
  amount: number;
  tone: "hero" | "ai";
  dx: number;
  dy: number;
  compact?: boolean;
}) {
  if (amount <= 0) return null;
  return (
    <div
      className={`pk-anim-chip flex items-center justify-center rounded-full border-dashed font-bold text-white shadow-lg ${
        compact
          ? "h-8 w-8 border-[3px] text-[11px]"
          : "h-9 w-9 border-4 text-[10px]"
      } ${
        tone === "hero"
          ? "border-amber-300 bg-amber-600"
          : "border-rose-300 bg-rose-700"
      }`}
      style={{ "--pk-chip-x": `${dx}px`, "--pk-chip-y": `${dy}px` } as CSSProperties}
    >
      {amount}
    </div>
  );
}

/** 思考中三点动画；dotsOnly（紧凑模式窄列放不下文字）只留三点 */
function ThinkingDots({ dotsOnly = false }: { dotsOnly?: boolean }) {
  const { t } = useI18n();
  return (
    <span
      className="inline-flex items-end gap-1 whitespace-nowrap text-[10px] text-emerald-200"
      aria-label={t("action.thinking")}
    >
      {dotsOnly ? null : t("action.thinking")}
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block h-1 w-1 animate-bounce rounded-full bg-emerald-200"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  );
}

/** 按钮位（庄家）标记 */
function ButtonMarker({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={`flex items-center justify-center rounded-full border border-neutral-300 bg-white font-black text-neutral-900 shadow ${
        compact ? "h-4 w-4 text-[9px]" : "h-5 w-5 text-[10px]"
      }`}
    >
      D
    </span>
  );
}

/** 位置名缩写：positionName 返回「BTN（按钮位）」长名，取括号前的缩写 */
function positionAbbrev(seat: Seat, game: GameState): string {
  return positionName(seat, game).split("（")[0];
}

interface SeatPodProps {
  /** 引擎座位 */
  seat: Seat;
  /** 紧凑模式（<768px）：舱体收窄、牌缩小、隐藏「风格 ?」占位徽标 */
  compact?: boolean;
}

/** 单个座位舱：筹码、底牌、状态标记、位置名、行动光环 */
function SeatPod({ seat, compact = false }: SeatPodProps) {
  const { t } = useI18n();
  const game = useGameStore((s) => s.game);
  const aiThinking = useGameStore((s) => s.aiThinking);
  const heroSpectating = useGameStore((s) => s.heroSpectating);
  const seatMap = useGameStore((s) => s.seatMap);
  const player = game?.players[seat];
  const stack = useCountUp(player?.stack ?? 0);
  if (!game || !player) return null;

  const isHero = seat === HERO_SEAT && !heroSpectating;
  const tableSeat = seatMap[seat] ?? seat;
  const isTurn = !game.handOver && game.currentSeat === seat;
  // AI 底牌：摊牌且未弃牌时亮出，否则背面
  const reveal = !isHero && game.showdown && !player.folded;
  const cards: (Card | null)[] =
    isHero || (reveal && player.holeCards)
      ? (player.holeCards ?? [null, null])
      : [null, null];
  // all-in 脉冲光环（红色呼吸；结算后停止）
  const allInPulse = player.allIn && !game.handOver;
  const cardSize: CardSize = compact
    ? isHero
      ? "sm"
      : "xs"
    : isHero
      ? "md"
      : "sm";

  return (
    <div
      className={`flex flex-col items-center rounded-xl transition-all ${
        compact
          ? `${isHero ? "w-28" : "w-[6.5rem]"} gap-0.5 px-1 py-1`
          : "w-36 gap-1 px-2 py-1.5"
      } ${
        isTurn
          ? "bg-black/40 shadow-[0_0_24px_rgba(52,211,153,0.55)] ring-2 ring-emerald-300/80"
          : "bg-black/25"
      } ${player.folded ? "opacity-40" : ""} ${allInPulse ? "pk-anim-allin" : ""}`}
    >
      <div
        className={`flex items-center text-[11px] text-emerald-100/90 ${compact ? "gap-1" : "gap-1.5"}`}
      >
        <span className="rounded bg-black/40 px-1 py-0.5 font-mono font-bold text-sky-300">
          {positionAbbrev(seat, game)}
        </span>
        <span className="font-semibold">{isHero ? t("common.you") : `AI ${tableSeat}`}</span>
        {!isHero && !compact && (
          <span className="rounded-full border border-emerald-300/40 px-1.5 py-0.5 text-[9px] tracking-wide">
            {t("common.styleUnknown")}
          </span>
        )}
        {game.buttonSeat === seat && <ButtonMarker compact={compact} />}
      </div>
      <div className={`flex items-center ${compact ? "gap-1" : "gap-2"}`}>
        {/* 发牌滑入方向：hero 在底部，牌堆在其上方（-y）；其余座位牌堆在其下方（+y） */}
        <div
          className="relative flex gap-1"
          style={{ "--pk-deal-y": isHero ? "-70px" : "60px" } as CSSProperties}
        >
          {cards.map((c, i) => (
            <PlayingCard
              key={`${game.handNumber}-${i}-${reveal ? "r" : "d"}`}
              card={c}
              size={cardSize}
              faceDown={c === null}
              animate={reveal ? "flip" : "deal"}
              animDelay={i * 90}
            />
          ))}
          {/* 紧凑模式窄列放不下文字徽标：已弃牌/ALL-IN 改为覆盖在底牌上 */}
          {compact && player.folded && (
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="whitespace-nowrap rounded bg-neutral-700/90 px-1.5 py-0.5 text-[10px] text-neutral-300">
                {t("table.folded")}
              </span>
            </span>
          )}
          {compact && player.allIn && (
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="whitespace-nowrap rounded bg-rose-800/90 px-1.5 py-0.5 text-[10px] font-bold text-rose-100">
                ALL-IN
              </span>
            </span>
          )}
        </div>
        <div className="flex flex-col items-start">
          <span
            className={`font-bold tabular-nums text-amber-300 ${compact ? "text-[11px]" : "text-sm"}`}
          >
            {stack}
          </span>
          {isTurn && !isHero && aiThinking && (
            <ThinkingDots dotsOnly={compact} />
          )}
          {!compact && player.folded && (
            <span className="rounded bg-neutral-700/80 px-1.5 py-0.5 text-[10px] text-neutral-300">
              {t("table.folded")}
            </span>
          )}
          {!compact && player.allIn && (
            <span className="rounded bg-rose-800/80 px-1.5 py-0.5 text-[10px] font-bold text-rose-100">
              ALL-IN
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

const STREET_KEY: Record<string, DictKey> = {
  preflop: "table.street.preflop",
  flop: "table.street.flop",
  turn: "table.street.turn",
  river: "table.street.river",
  showdown: "table.street.showdown",
};

/** 结算时底池收拢动画的瞬态（向赢家座位方向淡出） */
interface PotCollect {
  amount: number;
  x: number;
  y: number;
}

/**
 * 椭圆牌桌（2-9 人）：hero 固定底部居中（6 点钟方向），其余座位按行动顺序
 * 顺时针排布；被淘汰玩家不参与新一手（引擎座位压缩），不在桌上渲染。
 * 紧凑模式（<768px）：毛毡内缩为竖长椭圆，座位改沿矩形环排布（周长更大，
 * 9 舱不重叠），公共牌/底池上移居中。
 */
export default function PokerTable() {
  const { t } = useI18n();
  const game = useGameStore((s) => s.game);
  const pot = useCountUp(game?.pot ?? 0);
  const compact = useCompactTable();

  // 底池收拢：引擎结算把 pot 清零并入赢家 stack——在清零瞬间按清零前数额
  // 生成一个向赢家座位方向淡出的副本（reduced-motion 下不生成）。
  const [collect, setCollect] = useState<PotCollect | null>(null);
  const lastPotRef = useRef(0);
  useEffect(() => {
    if (!game) return;
    if (game.pot > 0) {
      lastPotRef.current = game.pot;
      return;
    }
    if (!game.handOver || lastPotRef.current <= 0) return;
    const amount = lastPotRef.current;
    lastPotRef.current = 0;
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const winner = game.winners?.[0] ?? 0;
    const rad = seatRad(winner, game.players.length);
    // 收拢位移按视口宽度等比缩小（桌面 1024px 基准），避免移动端飞出屏幕
    const s = Math.min(1, window.innerWidth / 1024);
    setCollect({
      amount,
      x: Math.cos(rad) * 1.15 * 380 * s,
      y: Math.sin(rad) * 240 * s,
    });
  }, [game]);
  useEffect(() => {
    if (!collect) return;
    const timer = setTimeout(() => setCollect(null), 550);
    return () => clearTimeout(timer);
  }, [collect]);

  if (!game) {
    return (
      <div className="flex h-96 items-center justify-center text-neutral-400">
        {t("table.starting")}
      </div>
    );
  }

  const n = game.players.length;
  // 座位 j 位于椭圆角度 θ_j = 90° + j·(360°/n)（屏幕坐标 y 向下：θ 增大即顺时针）
  const seatPos = (j: number, radiusPct: number) => {
    const rad = seatRad(j, n);
    return {
      left: `${50 + radiusPct * 1.15 * Math.cos(rad)}%`,
      top: `${50 + radiusPct * Math.sin(rad)}%`,
    };
  };

  return (
    <div className="mx-auto w-full max-w-5xl">
      <PokerAnimStyles />
      <RotateHint show={n === 9} />
      {/* 牌桌容器：紧凑模式纵横比 10/11（比初版 4/5 矮 ~12%，9 人桌 + 横屏提示
          + 信息条 + 行动栏在 667px 高视口内基本一屏放下，底排座位不被吸附的
          行动栏遮盖）；矩形环/毛毡/中央均为 % 坐标，随容器自适应。
          桌面端 md:aspect-[8/5] 与原版一致 */}
      <div className="relative aspect-[10/11] md:aspect-[8/5]">
        {/* 毛毡：移动端内缩给环形座位让位；桌面端（md:）铺满，像素与原版一致 */}
        <div
          className="absolute inset-x-[6%] inset-y-[10%] rounded-[50%] border-[6px] border-amber-950 shadow-2xl md:inset-0 md:border-[10px]"
          style={{
            background:
              "radial-gradient(ellipse at center, #15803d 0%, #166534 55%, #14532d 100%)",
          }}
        />
        {/* 中央：公共牌 + 底池（移动端上移居中，给底部 hero 舱与行动栏留出视觉空间） */}
        <div className="absolute left-1/2 top-[40%] flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5 md:top-1/2 md:gap-2">
          <div className="flex items-center gap-1.5 text-xs text-emerald-100/80 md:gap-2 md:text-sm">
            <span>{STREET_KEY[game.street] ? t(STREET_KEY[game.street]) : game.street}</span>
            <span className="rounded-full bg-black/30 px-2 py-0.5 text-sm font-bold tabular-nums text-amber-200 md:px-3 md:py-1 md:text-base">
              {t("common.pot")} {pot}
            </span>
            {game.ante > 0 && (
              <span className="rounded-full bg-black/30 px-2 py-1 text-xs text-neutral-300">
                ante {game.ante}
              </span>
            )}
          </div>
          <div className="flex min-h-11 gap-1.5 md:min-h-16">
            {/* 公共牌逐张入场：key 含 handNumber，跨手重挂载；同街已发牌不重播 */}
            {game.board.map((c, i) => (
              <PlayingCard
                key={`${game.handNumber}-${c}`}
                card={c}
                size={compact ? "sm" : "md"}
                animate="flip"
                animDelay={Math.min(i, 2) * 120}
              />
            ))}
            {game.board.length === 0 && (
              <span className="self-center text-xs text-emerald-200/50">
                {t("street.waitingBoard")}
              </span>
            )}
          </div>
        </div>

        {/* 结算收拢：底池数字副本向赢家座位方向淡出 */}
        {collect && collect.amount > 0 && (
          <div
            className="pk-anim-collect pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/40 px-3 py-1 text-base font-bold tabular-nums text-amber-200"
            style={
              {
                "--pk-collect-x": `${collect.x}px`,
                "--pk-collect-y": `${collect.y}px`,
              } as CSSProperties
            }
          >
            {t("common.pot")} {collect.amount}
          </div>
        )}

        {/* 座位与下注圆片（圆片位于座位与桌心之间；紧凑模式沿矩形环） */}
        {game.players.map((p, j) => {
          const rad = seatRad(j, n);
          // 筹码飞入起点 = 座位方向（外向向量）偏移
          let chipDx = Math.cos(rad) * 1.15 * 72;
          let chipDy = Math.sin(rad) * 56;
          let discStyle: { left: string; top: string };
          let podStyle: { left: string; top: string };
          if (compact) {
            const rp = ringPos(j / n);
            podStyle = { left: `${rp.x}%`, top: `${rp.y}%` };
            discStyle = {
              left: `${rp.x + (50 - rp.x) * 0.42}%`,
              top: `${rp.y + (50 - rp.y) * 0.42}%`,
            };
            const len = Math.hypot(rp.x - 50, rp.y - 50) || 1;
            chipDx = ((rp.x - 50) / len) * 60;
            chipDy = ((rp.y - 50) / len) * 60;
          } else {
            discStyle = seatPos(j, 30);
            podStyle = seatPos(j, 44);
          }
          return (
            <div key={p.seat}>
              <div
                className="absolute -translate-x-1/2 -translate-y-1/2"
                style={discStyle}
              >
                <BetDisc
                  key={p.streetBet}
                  amount={p.streetBet}
                  tone={j === HERO_SEAT ? "hero" : "ai"}
                  dx={chipDx}
                  dy={chipDy}
                  compact={compact}
                />
              </div>
              <div
                className="absolute -translate-x-1/2 -translate-y-1/2"
                style={podStyle}
                {...(j === HERO_SEAT ? { id: "poker-hero-pod" } : {})}
              >
                <SeatPod seat={p.seat} compact={compact} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
