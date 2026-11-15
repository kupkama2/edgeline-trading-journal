import { useState } from "react";

export const PALETTE = ["#38bdf8", "#34d399", "#f59e0b", "#a78bfa", "#f472b6", "#fb7185", "#2dd4bf", "#facc15", "#60a5fa", "#c084fc", "#4ade80", "#f97316", "#94a3b8", "#e879f9", "#22d3ee", "#fda4af", "#a3e635"];

/** A value over days as a filled line, with the day under the pointer named above it. */
export function ValueLine({ points, format, testId }: { points: { label: string; value: number }[]; format: (v: number) => string; testId?: string }) {
  const [at, setAt] = useState<number | null>(null);
  if (points.length < 2) return <p className="py-6 text-center text-[11px] text-muted-foreground">The chart draws itself once there are two days to join.</p>;
  const W = 600;
  const H = 150;
  const min = Math.min(...points.map((p) => p.value));
  const max = Math.max(...points.map((p) => p.value));
  const span = max - min || 1;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => H - 6 - ((v - min) / span) * (H - 16);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const up = points[points.length - 1].value >= points[0].value;
  const color = up ? "#34d399" : "#f87171";
  const shown = at ?? points.length - 1;
  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAt(Math.max(0, Math.min(points.length - 1, Math.round(((e.clientX - r.left) / r.width) * (points.length - 1)))));
  };
  return (
    <div data-testid={testId}>
      <p className="mb-1 flex items-baseline justify-between font-mono text-[11px] text-muted-foreground">
        <span>
          {points[shown].label} · <span className="text-foreground">{format(points[shown].value)}</span>
        </span>
        <span>
          {format(min)} – {format(max)}
        </span>
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-36 w-full touch-none" onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setAt(null)} role="img" aria-label="Value over time">
        <path d={`${line} L${W},${H} L0,${H} Z`} fill={color} opacity={0.12} />
        <path d={line} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
        {at != null && <line x1={x(at)} x2={x(at)} y1={0} y2={H} stroke="currentColor" opacity={0.3} vectorEffect="non-scaling-stroke" />}
      </svg>
      <p className="flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>{points[0].label}</span>
        <span>{points[points.length - 1].label}</span>
      </p>
    </div>
  );
}

/** Shares of a whole as a ring; a slice, or its name in the list, can be picked. Small slices are folded into "Other". */
export function Donut({ title, slices, picked, onPick, format, testId }: { title: string; slices: { key: string; value: number }[]; picked: string | null; onPick: (key: string | null) => void; format: (v: number) => string; testId?: string }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return null;
  const R = 42;
  const C = 2 * Math.PI * R;
  let run = 0;
  const arcs = slices.map((s, i) => {
    const len = (s.value / total) * C;
    const arc = { ...s, len, offset: run, color: PALETTE[i % PALETTE.length] };
    run += len;
    return arc;
  });
  return (
    <div data-testid={testId}>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      <div className="flex items-start gap-3">
        <svg viewBox="0 0 100 100" className="h-28 w-28 shrink-0 -rotate-90" role="img" aria-label={title}>
          {arcs.map((a) => (
            <circle
              key={a.key}
              cx={50}
              cy={50}
              r={R}
              fill="none"
              stroke={a.color}
              strokeWidth={picked === a.key ? 15 : 11}
              strokeDasharray={`${Math.max(0, a.len - 0.6)} ${C}`}
              strokeDashoffset={-a.offset}
              opacity={picked && picked !== a.key ? 0.3 : 1}
              className="cursor-pointer transition-all"
              onClick={() => onPick(picked === a.key ? null : a.key)}
            >
              <title>{`${a.key}: ${format(a.value)} (${((a.value / total) * 100).toFixed(1)}%)`}</title>
            </circle>
          ))}
        </svg>
        <ul className="min-w-0 flex-1 space-y-0.5 text-[11px]">
          {arcs.slice(0, 9).map((a) => (
            <li key={a.key}>
              <button type="button" onClick={() => onPick(picked === a.key ? null : a.key)} aria-pressed={picked === a.key} className={`flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-secondary ${picked === a.key ? "bg-secondary" : ""}`}>
                <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: a.color }} />
                <span className="min-w-0 flex-1 truncate">{a.key}</span>
                <span className="font-mono text-muted-foreground">{((a.value / total) * 100).toFixed(1)}%</span>
              </button>
            </li>
          ))}
          {arcs.length > 9 && <li className="px-1 text-muted-foreground">and {arcs.length - 9} smaller</li>}
        </ul>
      </div>
    </div>
  );
}
