import { useMemo, useState } from "react";
import { fmtR } from "@shared/metrics";
import type { Excursion } from "@shared/excursion";

/**
 * The MAE/MFE excursion chart — one bar per trade.
 *
 * Each trade is one column, in three bands, all measured from the entry:
 *
 *   slate, below the red  how much further it fell AFTER you were out
 *   red, below zero       heat — how far it went against you first
 *   emerald, above zero   the move you were IN THE TRADE for, up to the
 *                         in-trade high, with a tick where you got out
 *   slate, above that     ground the trade made AFTER you were out
 *
 * Every pixel belongs to the phase in which it was first reached, so the two
 * halves of "it went higher" stay visually separate: emerald above the tick is
 * give-back, money the move offered while you held and you didn't keep, and
 * that is a management story. Slate is a different event entirely — it ran on
 * without you — and that is an exit-timing story. Reading them off one colour
 * is how a trade closed too EARLY gets diagnosed as held too LATE.
 *
 * The bottom band is the same idea mirrored, and it is the only thing here
 * that can come out in an exit's favour: on a stop-out it is what the stop
 * saved you. Without it the chart has one lesson to teach — hold longer, stop
 * wider — which is true right up until it isn't.
 *
 * The slate band starts at the in-trade high rather than at the exit, because
 * the stretch between the exit and that high was already travelled while you
 * were holding: drawing it twice would show one move as two. So the band is
 * the NEW ground, and the tooltip carries the full run from the exit — which
 * is the number the summary totals.
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
  // Tracked in state rather than via a :focus-visible CSS variant: an <svg>
  // <g> is an unusual focus target and the variant silently did nothing.
  const [focus, setFocus] = useState<number | null>(null);

  const geom = useMemo(() => {
    if (!rows.length) return null;
    const ups = rows.flatMap((r) =>
      [r.mfeR, r.actualR, r.postPeakR].filter((v): v is number => v != null && isFinite(v) && v > 0),
    );
    const downs = rows.flatMap((r) =>
      [r.maeR, r.actualR, r.postAdverseR].filter(
        (v): v is number => v != null && isFinite(v) && v < 0,
      ),
    );
    const rawHi = Math.max(1, ...ups);
    const rawLo = Math.min(-1, ...downs);

    /*
     * One monster flattens the rest.
     *
     * A single trade that ran on 15R without you sets the axis for everyone
     * and turns thirty ordinary trades into a grey smear at the bottom of the
     * card — the chart still contains the information and stops carrying any.
     * So the axis is set by the BODY of the distribution and the few beyond it
     * are drawn clipped, with a torn top edge and their real number still in
     * the tooltip. Nothing is hidden; what is off the scale says so.
     *
     * Only when it would actually help: an axis within a quarter of the cap is
     * already readable, and clipping it would add a warning about nothing.
     */
    const ceiling = (vals: number[], floor: number) => {
      if (vals.length === 0) return floor;
      const sorted = [...vals].map(Math.abs).sort((a, b) => a - b);
      const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
      return Math.max(floor, p90 * 1.35);
    };
    const capHi = ceiling(ups, 1);
    const capLo = -ceiling(downs, 1);
    const clipHi = rawHi > capHi * 1.25;
    const clipLo = rawLo < capLo * 1.25;
    const hi = clipHi ? capHi : rawHi;
    const lo = clipLo ? capLo : rawLo;

    const span = hi - lo;
    const barW = Math.max(BAR_MIN, Math.min(28, 720 / rows.length));
    const width = Math.max(rows.length * barW, 320);
    const clamp = (r: number) => Math.min(hi, Math.max(lo, r));
    const y = (r: number) => PAD.top + ((hi - clamp(r)) / span) * (H - PAD.top - PAD.bottom);
    /*
     * Counted the same way the torn edges are drawn — on EITHER value per
     * side, not the post-exit one where it exists. A trade whose in-trade dip
     * ran past the axis while its aftermath did not is still a clipped bar,
     * and a footnote that disagrees with the picture is worse than no
     * footnote.
     */
    const past = (vals: (number | null | undefined)[], edge: number, below: boolean) =>
      vals.some((v) => v != null && isFinite(v) && (below ? v < edge : v > edge));
    const over = rows.filter(
      (r) => past([r.mfeR, r.postPeakR], hi, false) || past([r.maeR, r.postAdverseR], lo, true),
    );
    return {
      hi,
      lo,
      rawHi,
      rawLo,
      barW,
      width,
      y,
      clipped: (r: number) => r > hi + 1e-9 || r < lo - 1e-9,
      over: over.length,
      zero: PAD.top + (hi / span) * (H - PAD.top - PAD.bottom),
    };
  }, [rows]);

  if (!geom) return null;
  const { barW, width, y, zero, clipped, over, hi, lo, rawHi, rawLo } = geom;
  const h = hover != null ? rows[hover] : null;

  return (
    <div className="relative">
      <div className="overflow-x-auto">
        {/* Stretches to fill the card when there are few trades and scrolls
            once there are many. Horizontal-only scaling (preserveAspectRatio
            "none" at a fixed height) widens the bars without stretching the R
            axis; the strokes opt out via non-scaling-stroke. */}
        <svg
          viewBox={`0 0 ${width} ${H}`}
          width={width}
          height={H}
          preserveAspectRatio="none"
          className="max-w-none min-w-full"
          style={{ height: H }}
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
            // Where the in-trade story ends: normally the high, but a trade
            // whose MFE was never recorded stops at the exit itself.
            const inTradeTopR = Math.max(r.mfeR, r.actualR);
            // Under a hundredth of an R is a rounding artefact, not a run.
            const ranOn = r.postPeakR != null && r.postPeakR > inTradeTopR + 0.01;
            const ghostTopY = ranOn ? y(r.postPeakR!) : 0;
            const ghostBotY = ranOn ? y(inTradeTopR) : 0;
            // Mirror image below: new ground made against you after the exit.
            const inTradeBotR = Math.min(r.maeR, r.actualR);
            const fellOn = r.postAdverseR != null && r.postAdverseR < inTradeBotR - 0.01;
            const underTopY = fellOn ? y(inTradeBotR) : 0;
            const underBotY = fellOn ? y(r.postAdverseR!) : 0;
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
                onFocus={() => {
                  setFocus(i);
                  setHover(i); // the tooltip is the label; keyboard needs it too
                }}
                onBlur={() => setFocus((f) => (f === i ? null : f))}
                tabIndex={onSelect ? 0 : undefined}
                role={onSelect ? "button" : undefined}
                aria-label={onSelect ? `Open ${r.symbol} trade` : undefined}
                className={onSelect ? "cursor-pointer focus:outline-none" : undefined}
                data-testid={`excursion-bar-${r.tradeId}`}
              >
                {/* invisible full-height hit target so thin bars are hoverable */}
                <rect x={i * barW} y={0} width={barW} height={H} fill="transparent" />
                {/* what it made after you were out — behind the in-trade
                    bands in the stacking order so they always read first */}
                {ranOn && (
                  <>
                    <rect
                      x={cx - bw / 2}
                      y={ghostTopY}
                      width={bw}
                      height={Math.max(0, ghostBotY - ghostTopY)}
                      rx={1.5}
                      className="fill-muted-foreground/25"
                    />
                    {/* A thin cap so a shallow run still has a visible top
                        edge instead of dissolving into the background. */}
                    <line
                      x1={cx - bw / 2}
                      x2={cx + bw / 2}
                      y1={ghostTopY}
                      y2={ghostTopY}
                      className="stroke-muted-foreground/70"
                      strokeWidth={1.5}
                      vectorEffect="non-scaling-stroke"
                    />
                  </>
                )}
                {/* what it did against you after you were out — on a
                    stop-out, the part the stop saved you from */}
                {fellOn && (
                  <>
                    <rect
                      x={cx - bw / 2}
                      y={underTopY}
                      width={bw}
                      height={Math.max(0, underBotY - underTopY)}
                      rx={1.5}
                      className="fill-muted-foreground/25"
                    />
                    <line
                      x1={cx - bw / 2}
                      x2={cx + bw / 2}
                      y1={underBotY}
                      y2={underBotY}
                      className="stroke-muted-foreground/70"
                      strokeWidth={1.5}
                      vectorEffect="non-scaling-stroke"
                    />
                  </>
                )}
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
                {/* A torn edge where a bar runs past the axis. The number is
                    still in the tooltip; what this says is "there is more of
                    this bar than the card can show", which is the one thing a
                    silently clipped bar cannot. */}
                {clipped(r.postPeakR ?? r.mfeR) && (
                  <polyline
                    points={`${cx - bw / 2},${PAD.top + 3} ${cx - bw / 6},${PAD.top} ${cx + bw / 6},${PAD.top + 3} ${cx + bw / 2},${PAD.top}`}
                    fill="none"
                    className="stroke-foreground/60"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                    data-testid={`excursion-clipped-top-${r.tradeId}`}
                  />
                )}
                {clipped(r.postAdverseR ?? r.maeR) && (
                  <polyline
                    points={`${cx - bw / 2},${H - PAD.bottom - 3} ${cx - bw / 6},${H - PAD.bottom} ${cx + bw / 6},${H - PAD.bottom - 3} ${cx + bw / 2},${H - PAD.bottom}`}
                    fill="none"
                    className="stroke-foreground/60"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                    data-testid={`excursion-clipped-bottom-${r.tradeId}`}
                  />
                )}
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
                {focus === i && (
                  <rect
                    x={i * barW + 1}
                    y={1}
                    width={barW - 2}
                    height={H - 2}
                    rx={2}
                    fill="none"
                    className="stroke-primary"
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                  />
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {over > 0 && (
        <p
          className="mt-1 text-center text-[10px] text-muted-foreground"
          data-testid="excursion-clip-note"
        >
          Axis held to {hi.toFixed(1)}R / {lo.toFixed(1)}R so the rest stays readable —{" "}
          {over} {over === 1 ? "trade runs" : "trades run"} past it, out to{" "}
          {[rawHi > hi ? `+${rawHi.toFixed(1)}R` : null, rawLo < lo ? `${rawLo.toFixed(1)}R` : null]
            .filter(Boolean)
            .join(" and ")}
          . Hover a torn bar for its real number.
        </p>
      )}

      {h && hover != null && (
        <div
          /* Follows the bar instead of parking top-left, where it covered the
             first two trades. Flips side past the midpoint so it never leaves
             the card. */
          className="pointer-events-none absolute top-1 rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11px] shadow-md"
          style={{
            left: `${(((hover + 0.5) * barW) / width) * 100}%`,
            transform:
              (hover + 0.5) * barW > width * 0.6
                ? "translateX(calc(-100% - 8px))"
                : "translateX(8px)",
          }}
          data-testid="excursion-tooltip"
        >
          <p className="font-medium">{h.symbol}</p>
          <p className="font-mono text-emerald-500">reached {fmtR(h.mfeR)}</p>
          <p className="font-mono text-muted-foreground">
            exited {fmtR(h.actualR)}
            {h.capture != null && ` · kept ${Math.round(h.capture * 100)}%`}
          </p>
          <p className="font-mono text-red-500">dipped {fmtR(h.maeR)}</p>
          {h.leftBehindR != null && h.leftBehindR > 0.01 && (
            <p className="font-mono text-muted-foreground">
              ran {fmtR(h.leftBehindR)} more after you left
            </p>
          )}
          {h.avoidedR != null && h.avoidedR > 0.01 && (
            <p className="font-mono text-muted-foreground">
              {h.stopped ? "stop saved" : "avoided"} {fmtR(h.avoidedR)} after you left
            </p>
          )}
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
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-muted-foreground/25" /> after you
          were out (either way)
        </span>
      </div>
    </div>
  );
}
