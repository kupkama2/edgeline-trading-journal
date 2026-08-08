import { useMemo, useState } from "react";
import { fmtR } from "@shared/metrics";
import type { Excursion } from "@shared/excursion";

/**
 * The MAE/MFE excursion chart — one bar per trade.
 *
 * Each trade is a vertical bar spanning from its worst adverse dip (below the
 * zero line, red) to its best favourable reach (above, emerald), with a tick
 * marking where you actually got out. Read top-to-tick as give-back (money the
 * move offered and you didn't keep) and zero-to-bottom as heat (how far a trade
 * dropped before it worked, or before it stopped you).
 *
 * Emerald/red is the app's win/loss language, reused so the polarity needs no
 * legend. One value axis (R); the tick is the only per-bar annotation, because
 * a number on every bar would bury the shape the chart exists to show.
 */

const H = 220;
const PAD = { top: 14, bottom: 14 };
const BAR_MIN = 10; // px per bar incl. gap; the chart scrolls past ~60 trades

export function ExcursionChart({
  rows,
  onSelect,
}: {
  rows: Excursion[];
  /** Open the trade behind a bar. Every bar IS a trade, so the chart is a
      way into the log rather than a picture of it. */
  onSelect?: (tradeId: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const geom = useMemo(() => {
    if (!rows.length) return null;
    const hi = Math.max(1, ...rows.map((r) => r.mfeR), ...rows.map((r) => r.actualR));
    const lo = Math.min(-1, ...rows.map((r) => r.maeR), ...rows.map((r) => r.actualR));
    const span = hi - lo;
    const barW = Math.max(BAR_MIN, Math.min(28, 720 / rows.length));
    const width = Math.max(rows.length * barW, 320);
    const y = (r: number) => PAD.top + ((hi - r) / span) * (H - PAD.top - PAD.bottom);
    return { hi, lo, barW, width, y, zero: PAD.top + (hi / span) * (H - PAD.top - PAD.bottom) };
  }, [rows]);

  if (!geom) return null;
  const { barW, width, y, zero } = geom;
  const h = hover != null ? rows[hover] : null;

  return (
    <div className="relative">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${H}`}
          width={width}
          height={H}
          className="max-w-none"
          onMouseLeave={() => setHover(null)}
        >
          {/* Zero line — the entry. Everything above is profit reached, below is heat taken. */}
          <line
            x1={0}
            x2={width}
            y1={zero}
            y2={zero}
            className="stroke-border"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />

          {rows.map((r, i) => {
            const cx = i * barW + barW / 2;
            const bw = Math.max(3, barW * 0.6);
            const topY = y(r.mfeR);
            const botY = y(r.maeR);
            const exitY = y(r.actualR);
            return (
              <g
                key={r.tradeId}
                onMouseEnter={() => setHover(i)}
                onClick={() => onSelect?.(r.tradeId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect?.(r.tradeId);
                  }
                }}
                tabIndex={onSelect ? 0 : undefined}
                role={onSelect ? "button" : undefined}
                aria-label={onSelect ? `Open ${r.symbol} trade` : undefined}
                className={onSelect ? "cursor-pointer focus:outline-none" : undefined}
                data-testid={`excursion-bar-${r.tradeId}`}
              >
                {/* invisible full-height hit target so thin bars are hoverable */}
                <rect x={i * barW} y={0} width={barW} height={H} fill="transparent" />
                {/* favourable reach, above zero */}
                <rect
                  x={cx - bw / 2}
                  y={topY}
                  width={bw}
                  height={Math.max(0, zero - topY)}
                  rx={1.5}
                  className="fill-emerald-500/70"
                />
                {/* adverse dip, below zero */}
                <rect
                  x={cx - bw / 2}
                  y={zero}
                  width={bw}
                  height={Math.max(0, botY - zero)}
                  rx={1.5}
                  className="fill-red-500/60"
                />
                {/* the exit tick — where you actually got out inside that range */}
                <line
                  x1={cx - bw / 2 - 1.5}
                  x2={cx + bw / 2 + 1.5}
                  y1={exitY}
                  y2={exitY}
                  className={r.win ? "stroke-emerald-200" : "stroke-red-200"}
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
                {hover === i && (
                  <rect
                    x={i * barW}
                    y={0}
                    width={barW}
                    height={H}
                    className="fill-foreground/5"
                  />
                )}
                {/* Keyboard focus needs its own ring — the hover wash is a
                    pointer affordance and never fires from the keyboard. */}
                {onSelect && (
                  <rect
                    x={i * barW}
                    y={0}
                    width={barW}
                    height={H}
                    fill="none"
                    className="stroke-transparent [g:focus-visible>&]:stroke-primary"
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                  />
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {h && (
        <div
          className="pointer-events-none absolute top-1 left-1 rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11px] shadow-md"
          data-testid="excursion-tooltip"
        >
          <p className="font-medium">{h.symbol}</p>
          <p className="font-mono text-emerald-500">reached {fmtR(h.mfeR)}</p>
          <p className="font-mono text-muted-foreground">
            exited {fmtR(h.actualR)}
            {h.capture != null && ` · kept ${Math.round(h.capture * 100)}%`}
          </p>
          <p className="font-mono text-red-500">dipped {fmtR(h.maeR)}</p>
          {onSelect && <p className="text-muted-foreground">click to open</p>}
        </div>
      )}

      <div className="mt-1.5 flex items-center justify-center gap-4 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500/70" /> best reach (MFE)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-3 border-t-2 border-foreground/60" /> your exit
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-red-500/60" /> worst dip (MAE)
        </span>
      </div>
    </div>
  );
}
