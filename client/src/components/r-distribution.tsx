import { useState } from "react";
import type { RDistribution } from "@shared/distribution";

/**
 * The R-outcome histogram — where the results actually cluster.
 *
 * Bars stand on a shared baseline and are coloured by side, so the split
 * between the losing half and the winning half is readable before any number
 * is: the red mass on the left is what the edge costs, the green mass on the
 * right is what it earns. A dashed rule marks the zero boundary that the bin
 * edges are aligned to.
 *
 * Hand-rolled SVG for the same reason as the other two charts here: one
 * geometry, one hover layer, no dependency.
 */

const H = 170;
const PAD = { top: 10, bottom: 26 };

export function RDistributionChart({ d }: { d: RDistribution }) {
  const [hover, setHover] = useState<number | null>(null);
  const bins = d.bins;
  const max = Math.max(1, ...bins.map((b) => b.count));
  const W = 800;
  const bw = W / bins.length;
  const y = (c: number) => PAD.top + (1 - c / max) * (H - PAD.top - PAD.bottom);
  const zeroIdx = bins.findIndex((b) => b.from >= -1e-9);
  const zeroX = zeroIdx < 0 ? null : zeroIdx * bw;
  const h = hover != null ? bins[hover] : null;

  return (
    <div className="relative" data-testid="r-distribution">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-[170px] w-full"
        preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)}
      >
        {/* Baseline. */}
        <line
          x1={0}
          x2={W}
          y1={H - PAD.bottom}
          y2={H - PAD.bottom}
          className="stroke-border"
          vectorEffect="non-scaling-stroke"
        />
        {/* The win/loss boundary the bins are aligned to. */}
        {zeroX != null && (
          <line
            x1={zeroX}
            x2={zeroX}
            y1={PAD.top - 4}
            y2={H - PAD.bottom}
            className="stroke-muted-foreground/50"
            strokeDasharray="3 4"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {bins.map((b, i) => {
          const top = y(b.count);
          return (
            <g key={b.label} onMouseEnter={() => setHover(i)} data-testid={`r-bin-${i}`}>
              <rect x={i * bw} y={0} width={bw} height={H} fill="transparent" />
              {b.count > 0 && (
                <rect
                  x={i * bw + bw * 0.12}
                  y={top}
                  width={bw * 0.76}
                  height={H - PAD.bottom - top}
                  rx={2}
                  className={
                    b.losing
                      ? hover === i
                        ? "fill-red-500/90"
                        : "fill-red-500/60"
                      : hover === i
                        ? "fill-emerald-500/90"
                        : "fill-emerald-500/70"
                  }
                />
              )}
            </g>
          );
        })}
      </svg>

      {/* Axis labels sit outside the stretched SVG so the type never distorts. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-1 flex">
        {bins.map((b, i) => (
          <span
            key={b.label}
            className={`shrink-0 text-center font-mono text-[9px] ${
              hover === i ? "text-foreground" : "text-muted-foreground/70"
            }`}
            style={{ width: `${100 / bins.length}%` }}
          >
            {/* Only the lower edge, and only when there is room for it. */}
            {bins.length <= 10 || i % 2 === 0 ? fmtEdge(b.from) : ""}
          </span>
        ))}
      </div>

      {h && (
        <div
          className="pointer-events-none absolute top-0 rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11px] shadow-md"
          style={{
            left: `${((hover! + 0.5) / bins.length) * 100}%`,
            transform:
              hover! + 0.5 > bins.length * 0.6
                ? "translateX(calc(-100% - 8px))"
                : "translateX(8px)",
          }}
          data-testid="r-bin-tooltip"
        >
          <p className="font-mono font-medium">{h.label}</p>
          <p className="font-mono text-muted-foreground">
            {h.count} {h.count === 1 ? "trade" : "trades"} · {Math.round(h.share * 100)}%
          </p>
        </div>
      )}
    </div>
  );
}

function fmtEdge(v: number): string {
  const s = Math.abs(v) % 1 === 0 ? v.toFixed(0) : String(v);
  return s.replace("-", "−");
}
