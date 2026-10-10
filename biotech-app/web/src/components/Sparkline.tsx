import { dailyChangePct, formatPercent, formatPrice, NA, trendOf } from "../../../shared/calc";

const W = 72;
const H = 20;
const PAD = 2;

export function Sparkline({ points, ticker }: { points: number[] | null; ticker: string }) {
  if (!points || points.length < 2) {
    return (
      <span class="bt-muted" title="Not enough daily closes collected yet">
        {NA}
      </span>
    );
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = (W - PAD * 2) / (points.length - 1);
  const coords = points.map((p, i) => `${(PAD + i * step).toFixed(1)},${(H - PAD - ((p - min) / span) * (H - PAD * 2)).toFixed(1)}`);
  const first = points[0]!;
  const last = points.at(-1)!;
  const change = dailyChangePct(last, first);
  const label = `${ticker} last ${points.length} trading days: ${formatPrice(first)} to ${formatPrice(last)} (${formatPercent(change)})`;
  return (
    <svg class={`bt-spark bt-trend--${trendOf(change)}`} width={W} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <title>{label}</title>
      <polyline points={coords.join(" ")} fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
    </svg>
  );
}
