import { useMemo, useRef, useState } from "react";
import { fmtMoney, fmtR } from "@shared/metrics";

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
const PAD = { top: 12, right: 56, bottom: 20, left: 8 };

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

  const geom = useMemo(() => {
    if (points.length < 2) return null;
    const ys = points.map((p) => p.cumulativeR);
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
  }, [points]);

  if (!geom) return null;

  const path = points
    .map((p, i) => `${i ? "L" : "M"}${geom.x(i).toFixed(1)},${geom.y(p.cumulativeR).toFixed(1)}`)
    .join(" ");
  const last = points[points.length - 1];
  const h = hover != null ? points[hover] : null;
  const dayDelta =
    hover != null && hover > 0
      ? points[hover].cumulativeR - points[hover - 1].cumulativeR
      : h?.cumulativeR ?? 0;

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
              cy={geom.y(h.cumulativeR)}
              r={4}
              className="fill-sky-400 stroke-background"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )}

        {/* Direct label on the last point: where the account stands now. */}
        <text
          x={geom.x(points.length - 1) + 6}
          y={geom.y(last.cumulativeR) + 4}
          className="fill-foreground font-mono text-[11px]"
        >
          {fmtR(last.cumulativeR)}
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
          <p className="font-mono text-muted-foreground">day {fmtR(dayDelta)}</p>
          {onSelect && <p className="text-muted-foreground">click to open the day</p>}
        </div>
      )}
    </div>
  );
}
