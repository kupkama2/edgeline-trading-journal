import { useEffect, useRef, useState } from "react";
import { ColorType, createChart, CrosshairMode, LineSeries, LineStyle, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { fmtPct } from "@/lib/screener";

/** Twelve hues that stay apart on a dark card; a coin keeps its colour by its position in the set. */
const HUES = ["#38bdf8", "#f472b6", "#a3e635", "#fb923c", "#c084fc", "#2dd4bf", "#facc15", "#60a5fa", "#f87171", "#34d399", "#e879f9", "#fbbf24"];

function palette(host: HTMLElement) {
  const cs = getComputedStyle(host);
  const tok = (name: string, alpha?: number, fallback = "#888888") => {
    const v = cs.getPropertyValue(name).trim();
    if (!v) return fallback;
    return alpha == null ? `hsl(${v})` : `hsl(${v} / ${alpha})`;
  };
  return { bg: tok("--card", undefined, "transparent"), text: tok("--muted-foreground"), grid: tok("--border", 0.45), base: tok("--foreground", 0.5) };
}

const withAlpha = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

/**
 * The spaghetti chart: every chosen coin's RS ratio rebased to 0% at the
 * window's start, BTC the flat line at zero. Hovering a line brings it
 * forward and dims the rest; the legend says which is which and where
 * each one ended.
 */
export function SpaghettiChart({ lines, order, loading }: { lines: Record<string, { t: number; pct: number }[]>; order: string[]; loading?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const baseRef = useRef<ISeriesApi<"Line"> | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const colorOf = (coin: string) => HUES[Math.max(0, order.indexOf(coin)) % HUES.length];

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const colors = palette(host);
    const chart = createChart(host, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: colors.bg }, textColor: colors.text, fontSize: 10 },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: colors.grid, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: colors.grid, timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { priceFormatter: (p: number) => `${p >= 0 ? "+" : ""}${p.toFixed(1)}%` },
    });
    chartRef.current = chart;
    baseRef.current = chart.addSeries(LineSeries, { color: colors.base, lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    chart.subscribeCrosshairMove((param) => {
      const hovered = param.hoveredSeries;
      let coin: string | null = null;
      if (hovered) for (const [c, s] of Array.from(seriesRef.current)) if (s === hovered) coin = c;
      setHover(coin);
    });
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current.clear();
      baseRef.current = null;
    };
  }, []);

  // The lines, replaced when the set or the data changes.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const [coin, s] of Array.from(seriesRef.current)) {
      if (!lines[coin]) {
        chart.removeSeries(s);
        seriesRef.current.delete(coin);
      }
    }
    let from = Infinity;
    let to = -Infinity;
    for (const coin of order) {
      const pts = lines[coin];
      if (!pts || pts.length === 0) continue;
      let s = seriesRef.current.get(coin);
      if (!s) {
        s = chart.addSeries(LineSeries, { color: colorOf(coin), lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: coin, crosshairMarkerRadius: 3 });
        seriesRef.current.set(coin, s);
      }
      s.setData(pts.map((p) => ({ time: Math.floor(p.t / 1000) as UTCTimestamp, value: p.pct * 100 })));
      from = Math.min(from, pts[0].t);
      to = Math.max(to, pts[pts.length - 1].t);
    }
    if (baseRef.current && Number.isFinite(from) && Number.isFinite(to)) {
      baseRef.current.setData([
        { time: Math.floor(from / 1000) as UTCTimestamp, value: 0 },
        { time: Math.floor(to / 1000) as UTCTimestamp, value: 0 },
      ]);
    }
    chart.timeScale().fitContent();
  }, [lines, order]);

  // Hover: the one line forward, the rest faded.
  useEffect(() => {
    for (const [coin, s] of Array.from(seriesRef.current)) {
      const c = colorOf(coin);
      s.applyOptions(hover == null ? { color: c, lineWidth: 2 } : hover === coin ? { color: c, lineWidth: 4 } : { color: withAlpha(c, 0.18), lineWidth: 1 });
    }
  }, [hover, order]);

  const last = (coin: string) => {
    const pts = lines[coin];
    return pts && pts.length ? pts[pts.length - 1].pct : null;
  };

  return (
    <div data-testid="screener-chart">
      <div ref={hostRef} className="h-64 w-full sm:h-80" />
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px]" data-testid="screener-legend">
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <span className="inline-block h-0.5 w-3 border-t border-dashed border-foreground/60" /> BTC 0%
        </span>
        {order.map((coin) => (
          <button
            key={coin}
            type="button"
            className={`inline-flex items-center gap-1 rounded px-0.5 transition-opacity ${hover && hover !== coin ? "opacity-40" : ""}`}
            onMouseEnter={() => setHover(coin)}
            onMouseLeave={() => setHover(null)}
            data-testid={`screener-legend-${coin}`}
          >
            <span className="inline-block h-0.5 w-3" style={{ background: colorOf(coin) }} />
            <span className="font-semibold">{coin}</span>
            <span className="font-mono text-muted-foreground">{fmtPct(last(coin))}</span>
          </button>
        ))}
        {loading && <span className="text-muted-foreground">loading…</span>}
        {!loading && order.length === 0 && <span className="text-muted-foreground">Nothing on the chart. Click a row's dot to add a coin.</span>}
      </div>
    </div>
  );
}
