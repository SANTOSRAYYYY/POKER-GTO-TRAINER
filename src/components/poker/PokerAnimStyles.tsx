"use client";

/**
 * 牌桌动画 keyframes（组件内联 <style>，集中挂载一次）：
 * - pk-card-deal：发牌滑入（translate + scale + fade，方向由 --pk-deal-x/y 控制）；
 * - pk-card-flip：公共牌/摊牌翻亮（rotateY）；
 * - pk-chip-fly：下注筹码从座位飞向桌中（方向由 --pk-chip-x/y 控制）；
 * - pk-allin-pulse：all-in 座位红色呼吸光环；
 * - pk-pot-collect：结算时底池数字向赢家座位收拢淡出（--pk-collect-x/y）。
 *
 * 性能纪律：全部 transform/opacity（不触发 layout）；
 * prefers-reduced-motion 下降级为无动画。
 */
export default function PokerAnimStyles() {
  return (
    <style>{`
@keyframes pk-card-deal {
  from { transform: translate(var(--pk-deal-x, 0px), var(--pk-deal-y, -70px)) scale(0.35); opacity: 0; }
  60% { opacity: 1; }
  to { transform: translate(0, 0) scale(1); opacity: 1; }
}
@keyframes pk-card-flip {
  from { transform: rotateY(92deg) scale(0.92); opacity: 0.3; }
  to { transform: rotateY(0deg) scale(1); opacity: 1; }
}
@keyframes pk-chip-fly {
  from { transform: translate(var(--pk-chip-x, 0px), var(--pk-chip-y, 40px)) scale(0.5); opacity: 0.2; }
  to { transform: translate(0, 0) scale(1); opacity: 1; }
}
@keyframes pk-allin-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(244, 63, 94, 0.55); }
  50% { box-shadow: 0 0 24px 9px rgba(244, 63, 94, 0.35); }
}
@keyframes pk-pot-collect {
  to { transform: translate(var(--pk-collect-x, 0px), var(--pk-collect-y, 120px)) scale(0.4); opacity: 0; }
}
.pk-anim-deal { animation: pk-card-deal 0.34s cubic-bezier(0.2, 0.9, 0.3, 1.15) both; will-change: transform, opacity; }
.pk-anim-flip { animation: pk-card-flip 0.4s ease-out both; will-change: transform, opacity; backface-visibility: hidden; }
.pk-anim-chip { animation: pk-chip-fly 0.32s cubic-bezier(0.25, 0.8, 0.35, 1.1) both; will-change: transform, opacity; }
.pk-anim-allin { animation: pk-allin-pulse 1.4s ease-in-out infinite; }
.pk-anim-collect { animation: pk-pot-collect 0.5s ease-in both; will-change: transform, opacity; }
@media (prefers-reduced-motion: reduce) {
  .pk-anim-deal, .pk-anim-flip, .pk-anim-chip, .pk-anim-allin, .pk-anim-collect { animation: none !important; }
}
`}</style>
  );
}
