import type { AIStyle, GameMode } from "@/lib/types";
import TableScreen from "@/components/poker/TableScreen";
import type { TableConfig } from "@/lib/store/gameStore";
import { DEFAULT_TOURNAMENT } from "@/lib/poker/tournament";

const VALID_STYLES: readonly AIStyle[] = [
  "nit",
  "tag",
  "lag",
  "maniac",
  "calling_station",
  "gto",
  "random",
];

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function parsePositiveInt(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseSeats(v: string | undefined): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 2 && n <= 9 ? n : 2;
}

/**
 * /play?mode=cash|tournament&seats=2-9&aiStyle=random&sb=1&bb=2&buyin=200&rebuys=0-3
 * 缺省：mode=cash、seats=2、aiStyle=random；现金局盲注 1/2、买入 100bb；
 * 锦标赛忽略 sb/bb/buyin，使用默认升盲结构（1500 筹码 / 每 8 手升级），
 * rebuys 为每人可重购次数（0-3，默认 0）。
 *
 * 恢复规则（config 仅作无存档时的回退新局配置）：
 * - ?resume=1，或不带任何开局参数直达 /play：优先从 localStorage 存档
 *   恢复整局（同一手牌、AI 底牌、筹码、盲注级别原样）；
 * - 带正常开局参数（大厅点「入座开战」）：开新局并覆盖存档。
 */
export default async function PlayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const modeRaw = first(sp.mode);
  const mode: GameMode = modeRaw === "tournament" ? "tournament" : "cash";
  const seats = parseSeats(first(sp.seats));
  const styleRaw = first(sp.aiStyle);
  const aiStyle: AIStyle = VALID_STYLES.includes(styleRaw as AIStyle)
    ? (styleRaw as AIStyle)
    : "random";

  const config: TableConfig = { mode, seats, aiStyle };
  if (mode === "cash") {
    const smallBlind = parsePositiveInt(first(sp.sb), 1);
    const bigBlind = parsePositiveInt(first(sp.bb), 2);
    config.cashBlinds = { sb: Math.min(smallBlind, bigBlind), bb: bigBlind };
    config.buyin = parsePositiveInt(first(sp.buyin), bigBlind * 100);
  } else {
    // 锦标赛：忽略 sb/bb/buyin，store 内使用 DEFAULT_TOURNAMENT + rebuys
    const rebuysRaw = Number.parseInt(first(sp.rebuys) ?? "", 10);
    const rebuysAllowed =
      Number.isFinite(rebuysRaw) ? Math.min(3, Math.max(0, rebuysRaw)) : 0;
    config.tournament = { ...DEFAULT_TOURNAMENT, rebuysAllowed };
  }

  // 显式 resume=1，或未带任何开局参数直达 /play（含刷新后的裸地址）：尝试恢复存档
  const hasStartParams = ["mode", "seats", "aiStyle", "sb", "bb", "buyin", "rebuys"].some(
    (k) => first(sp[k]) !== undefined,
  );
  const resume = first(sp.resume) === "1" || !hasStartParams;

  return <TableScreen config={config} resume={resume} />;
}
