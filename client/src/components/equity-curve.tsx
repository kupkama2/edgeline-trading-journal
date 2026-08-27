import { useMemo, useRef, useState } from "react";
import { fmtMoney, fmtR } from "@shared/metrics";
import { useDenom } from "@/lib/denom";

/**
 * The equity curve: cumulative R by trading day.
 *
 * One series, so it carries no legend — the card's title names it. The line
 * wears a neutral hue on purpose: emerald and red are this app's win/loss
 * status colors, and an all-red equity line would read as "everything is bad"
 * regardless of what it showed. Sign lives in the zero baseline instead.
 *
 * Hand-rolled SVG rather than a charting dependency: one polyline, one
 * baseline, one hover layer. The stroke uses non-scaling vector effect so the
 * responsive stretch never fattens the line.
 */

export interface EquityPoint {
  day: string;
  cumulativeR: number;
  cumulativePnL: number;
}

const W = 800;
const H = 180;
/*
 * The right gutter holds the end-of-curve label, so it has to fit the widest
 * thing that label can say. "+35.74R" needed 56px; "+$51,209" does not fit in
 * it and ran off the edge of the chart the moment the page could be read in
 * dollars.
 */
const PAD = { top: 12, right: 76, bottom: 20, left: 8 };

export function EquityCurve({
  points,
  onSelect,
}: {
  points: EquityPoint[];
  /** A point here is a DAY, not a trade, so clicking opens that day's page
      rather than a trade dialog — the thing behind the dot. */
  onSelect?: (day: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  /*
   * The curve follows the page's unit. Both series are already on every
   * point, and they are genuinely different curves rather than one rescaled:
   * a run of small winners lifts the R line and barely moves the dollar one.
   * Leaving the biggest chart on the page in R while every figure around it
   * said dollars was the half-done version of this switch.
   */
  const { denom } = useDenom();
  const at = (p: EquityPoint) => (denom === "USD" ? p.cumulativePnL : p.cumulativeR);
  const label = (v: number) => (denom === "USD" ? fmtMoney(v) : fmtR(v));

  const geom = useMemo(() => {
    if (points.length < 2) return null;
    const ys = points.map(at);
    // Zero is always in view: the whole point of the curve is which side of
    // flat you are on, and a clipped baseline hides exactly that.
    const lo = Math.min(0, ...ys);
    const hi = Math.max(0, ...ys);
    const span = hi - lo || 1;
    const x = (i: number) =>
      PAD.left + (i / (points.length - 1)) * (W - PAD.left - PAD.right);
    const y = (v: number) =>
      PAD.top + ((hi - v) / span) * (H - PAD.top - PAD.bottom);
    return { x, y, zero: y(0) };
  }, [points, denom]);

  if (!geom) return null;

  const path = points
    .map((p, i) => `${i ? "L" : "M"}${geom.x(i).toFixed(1)},${geom.y(at(p)).toFixed(1)}`)
    .join(" ");
  const last = points[points.length - 1];
  const h = hover != null ? points[hover] : null;
  const dayDelta =
    hover != null && hover > 0
      ? at(points[hover]) - at(points[hover - 1])
      : (h ? at(h) : 0);

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const fx = ((e.clientX - box.left) / box.width) * W;
    const i = Math.round(
      ((fx - PAD.left) / (W - PAD.left - PAD.right)) * (points.length - 1),
    );
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  }

  return (
    <div ref={wrapRef} className="relative" data-testid="equity-curve">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={`h-44 w-full ${onSelect ? "cursor-pointer" : ""}`}
        preserveAspectRatio="none"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onClick={() => {
          if (onSelect && hover != null) onSelect(points[hover].day);
        }}
      >
        {/* Recessive zero baseline — the only gridline the story needs. */}
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={geom.zero}
          y2={geom.zero}
          className="stroke-border"
          strokeDasharray="3 4"
          vectorEffect="non-scaling-stroke"
        />

        <path
          d={path}
          fill="none"
          className="stroke-sky-400"
          strokeWidth={2}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />

        {h != null && hover != null && (
          <g>
            <line
              x1={geom.x(hover)}
              x2={geom.x(hover)}
              y1={PAD.top}
              y2={H - PAD.bottom}
              className="stroke-muted-foreground/40"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={geom.x(hover)}
              cy={geom.y(at(h))}
              r={4}
              className="fill-sky-400 stroke-background"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )}

        {/* Direct label on the last point: where the account stands now. */}
        <text
          x={Math.min(geom.x(points.length - 1) + 6, W - 2)}
          y={geom.y(at(last)) + 4}
          /* Right-anchored when it would otherwise start past the gutter, so
             a six-figure account still prints inside the picture. */
          textAnchor={geom.x(points.length - 1) + 6 > W - 2 ? "end" : "start"}
          className="fill-foreground font-mono text-[11px]"
        >
          {label(at(last))}
        </text>
      </svg>

      {h && (
        <div
          className="pointer-events-none absolute top-1 rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11px] shadow-md"
          style={{
            left: `${(geom.x(hover!) / W) * 100}%`,
            transform: geom.x(hover!) > W * 0.7 ? "translateX(-105%)" : "translateX(8px)",
          }}
          data-testid="equity-tooltip"
        >
          <p className="font-medium">{h.day}</p>
          <p className="font-mono text-muted-foreground">
            total {fmtR(h.cumulativeR)} · {fmtMoney(h.cumulativePnL)}
          </p>
          <p className="font-mono text-muted-foreground">day {label(dayDelta)}</p>
          {onSelect && <p className="text-muted-foreground">click to open the day</p>}
        </div>
      )}
    </div>
  );
}
