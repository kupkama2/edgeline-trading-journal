import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { useTradeCandles } from "@/lib/data";
import { num } from "@/components/trade-shared";
import type { TradeWithTags } from "@shared/schema";
import { parseExtraTargets } from "@shared/schema";

/**
 * The trade, on its own chart.
 *
 * Every number in this journal is an abstraction of a price path — R, capture,
 * give-back, the excursion bars. This is the path itself, with the four
 * decisions drawn on it: where you got in, where the stop was, where the
 * target was, where you actually got out. Reading "gave back 1.8R" is not the
 * same as seeing the wick that took it.
 *
 * The window extends PAST the exit on purpose. Half the questions this journal
 * asks are about what happened once you were out, and a chart that stops at
 * the exit cannot answer any of them — you would be looking at the version of
 * events where leaving was obviously right.
 *
 * Drawn by hand rather than embedded from a charting service, for one reason
 * that decides it: an embed cannot be annotated. A chart of BTCUSDT with none
 * of your levels on it is a chart of BTCUSDT, and you can already get one of
 * those. The levels are the entire point.
 */
const H = 260;
const PAD = { top: 12, bottom: 20, right: 52 };

export function TradeChart({ trade }: { trade: TradeWithTags }) {
  const { data, isLoading } = useTradeCandles(trade.id);
  const [hover, setHover] = useState<number | null>(null);

  const levels = useMemo(() => {
    const tps = parseExtraTargets(trade.extraTargets);
    return [
      { price: trade.entryPrice, label: "entry", cls: "stroke-foreground/50", text: "text-foreground/70" },
      ...(trade.initialStop != null
        ? [{ price: trade.initialStop, label: "stop", cls: "stroke-red-500/70", text: "text-red-400" }]
        : []),
      ...(trade.initialTarget != null
        ? [{ price: trade.initialTarget, label: "target", cls: "stroke-emerald-500/70", text: "text-emerald-400" }]
        : []),
      ...tps.map((p, i) => ({
        price: p,
        label: `tp${i + 2}`,
        cls: "stroke-emerald-500/40",
        text: "text-emerald-400/70",
      })),
      ...(trade.exitPrice != null
        ? [{ price: trade.exitPrice, label: "exit", cls: "stroke-primary", text: "text-primary" }]
        : []),
    ];
  }, [trade]);

  const geom = useMemo(() => {
    const candles = data?.candles ?? [];
    if (candles.length === 0) return null;
    // The levels are part of the range, not decoration on top of it: a target
    // price never reached must still be visible, or the chart quietly answers
    // "how far away was it" with "off the top".
    const hi = Math.max(...candles.map((c) => c.h), ...levels.map((l) => l.price));
    const lo = Math.min(...candles.map((c) => c.l), ...levels.map((l) => l.price));
    const pad = (hi - lo) * 0.06 || 1;
    const top = hi + pad;
    const bot = lo - pad;
    const W = 760;
    const plotW = W - PAD.right;
    const y = (p: number) => PAD.top + ((top - p) / (top - bot)) * (H - PAD.top - PAD.bottom);
    const bw = Math.max(1, Math.min(9, (plotW / candles.length) * 0.7));
    const x = (i: number) => (i + 0.5) * (plotW / candles.length);
    return { candles, top, bot, W, plotW, y, x, bw };
  }, [data, levels]);

  if (isLoading) {
    return (
      <Card className="border-card-border bg-card p-4">
        <p className="text-[11px] text-muted-foreground" data-testid="chart-loading">
          Loading the price path…
        </p>
      </Card>
    );
  }
  // Not a crypto pair, or the feed had nothing. Silent rather than apologetic:
  // a futures trade is not broken for having no Binance chart.
  if (!geom || !data?.pair) return null;

  const { candles, W, plotW, y, x, bw } = geom;
  /** Level labels, spread vertically so none is drawn over another. */
  const labelled = levels
    .map((l) => ({ ...l, labelY: y(l.price) + 3 }))
    .sort((a, b) => a.labelY - b.labelY)
    .map((l, i, arr) => {
      if (i === 0) return l;
      const gap = l.labelY - arr[i - 1].labelY;
      if (gap >= 9) return l;
      arr[i] = { ...l, labelY: arr[i - 1].labelY + 9 };
      return arr[i];
    });
  const h = hover != null ? candles[hover] : null;
  const entryT = new Date(trade.entryTime).getTime();
  const exitT = trade.exitTime ? new Date(trade.exitTime).getTime() : null;
  /** Index of the first candle at or after an instant — where a marker goes. */
  const idxAt = (ms: number) => {
    const i = candles.findIndex((c) => c.t >= ms);
    return i < 0 ? candles.length - 1 : i;
  };

  return (
    <Card className="relative border-card-border bg-card p-4" data-testid="trade-chart">
      <div className="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="font-mono text-foreground/80">{data.pair}</span>
        {/* Which book, because a perp and its spot pair are different prices
            and the answer to "did my stop get hit" depends on which one you
            were actually resting an order in. */}
        <span>{data.market === "futures" ? "perp" : "spot"}</span>
        <span>{data.interval} candles</span>
        <span className="ml-auto font-mono">
          {h ? `O ${num(h.o)}  H ${num(h.h)}  L ${num(h.l)}  C ${num(h.c)}` : "hover for OHLC"}
        </span>
      </div>

      {/* The plot stretches horizontally to fill the card (preserveAspectRatio
          "none"), which is right for price geometry and wrong for letters —
          SVG text inside it is scaled with the x axis and comes out wider the
          bigger the screen. So the labels are HTML, positioned in the same
          pixel space: the height is fixed, so a viewBox y unit IS a pixel and
          the two agree exactly. */}
      <div className="relative">
        {/* Anchored as a PERCENTAGE, not a pixel width: the svg is stretched
            to the card, so the gutter's real width is PAD.right scaled by the
            same factor. A fixed 52px gutter would drift away from where the
            level lines actually stop, by more the wider the screen. */}
        <div
          className="pointer-events-none absolute inset-y-0 right-0 z-10"
          style={{ left: `${(plotW / W) * 100}%` }}
        >
          {labelled.map((l) => (
            <span
              key={`${l.label}-${l.price}`}
              className={`absolute left-1 font-mono text-[9px] leading-none ${l.text}`}
              style={{ top: l.labelY - 4 }}
              data-testid={`chart-level-${l.label}`}
            >
              {l.label}
            </span>
          ))}
        </div>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          preserveAspectRatio="none"
          style={{ height: H }}
          onMouseLeave={() => setHover(null)}
          className="min-w-full"
        >
          {/* The levels, behind the price. Labels are nudged apart where two
              levels sit within a few pixels of each other — an entry and a
              breakeven stop routinely do, and two labels drawn on top of one
              another are less use than one. */}
          {labelled.map((l) => (
            <line
              key={`${l.label}-${l.price}`}
              x1={0}
              x2={plotW}
              y1={y(l.price)}
              y2={y(l.price)}
              className={l.cls}
              strokeWidth={1}
              strokeDasharray={l.label === "entry" || l.label === "exit" ? undefined : "3 3"}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {candles.map((c, i) => {
            const up = c.c >= c.o;
            const cx = x(i);
            return (
              <g
                key={c.t}
                onMouseEnter={() => setHover(i)}
                className={up ? "stroke-emerald-500 fill-emerald-500" : "stroke-red-500 fill-red-500"}
              >
                <rect x={cx - bw / 2 - 2} y={0} width={bw + 4} height={H} fill="transparent" stroke="none" />
                <line
                  x1={cx}
                  x2={cx}
                  y1={y(c.h)}
                  y2={y(c.l)}
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
                <rect
                  x={cx - bw / 2}
                  y={y(Math.max(c.o, c.c))}
                  width={bw}
                  height={Math.max(1, Math.abs(y(c.o) - y(c.c)))}
                  stroke="none"
                />
              </g>
            );
          })}

          {/* Where you got in and out, on the time axis rather than only the
              price axis — a level line says at what price, these say when. */}
          {[
            { at: entryT, cls: "stroke-foreground/40" },
            ...(exitT ? [{ at: exitT, cls: "stroke-primary/60" }] : []),
          ].map((m, i) => (
            <line
              key={i}
              x1={x(idxAt(m.at))}
              x2={x(idxAt(m.at))}
              y1={PAD.top}
              y2={H - PAD.bottom}
              className={m.cls}
              strokeWidth={1}
              strokeDasharray="2 4"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {hover != null && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={0}
              y2={H}
              className="stroke-foreground/25"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      </div>

      {h && (
        <p className="mt-0.5 text-center text-[10px] text-muted-foreground" data-testid="chart-hover-time">
          {new Date(h.t).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      )}
    </Card>
  );
}
