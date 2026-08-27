import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type AutoscaleInfo,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { Card } from "@/components/ui/card";
import { useTheme } from "@/components/shell";
import { fetchCandlePage, useTradeCandles } from "@/lib/data";
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
 * Drawn with lightweight-charts, which is TradingView's own charting engine
 * released as a library, rather than with TradingView's embed widget. The
 * widget was the obvious first choice and is the wrong one for exactly one
 * reason: it cannot be annotated. A chart of BTCUSDT with none of your levels
 * on it is a chart of BTCUSDT, and you can already get one of those anywhere.
 * The levels ARE the feature. The engine gives the same panning, zooming and
 * crosshair, and lets the entry, stop, target and exit be drawn on it.
 *
 * The window extends PAST the exit on purpose. Half the questions this journal
 * asks are about what happened once you were out, and a chart that stops at
 * the exit cannot answer any of them — you would be looking at the version of
 * events where leaving was obviously right.
 */
const HEIGHT = 300;

/** What the timeframe row offers. "auto" lets the server fit the hold. */
const TIMEFRAMES = [
  { id: "auto", label: "Auto" },
  { id: "1m", label: "1m" },
  { id: "15m", label: "15m" },
  { id: "1h", label: "1h" },
  { id: "4h", label: "4h" },
  { id: "1d", label: "1D" },
] as const;

type Timeframe = (typeof TIMEFRAMES)[number]["id"];

const pill = (on: boolean) =>
  `rounded-md border px-1.5 py-0.5 font-mono text-[10px] leading-tight transition-colors ${
    on
      ? "border-primary/60 bg-secondary text-foreground"
      : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
  }`;

type Candle = { t: number; o: number; h: number; l: number; c: number };

/** A journal candle as the chart engine wants it: seconds, named fields. */
const toBar = (k: Candle) => ({
  time: (k.t / 1000) as UTCTimestamp,
  open: k.o,
  high: k.h,
  low: k.l,
  close: k.c,
});
type Level = { price: number; label: string; color: string; dashed: boolean };

/**
 * The chart is a canvas, so it cannot inherit a single CSS class the way the
 * rest of the app does — every colour has to be handed to it as a string. They
 * are read from the same custom properties the stylesheet uses, so a theme
 * switch moves the chart with everything else instead of leaving one dark
 * rectangle in the middle of a light page.
 */
function palette(host: HTMLElement) {
  const cs = getComputedStyle(host);
  const tok = (name: string, alpha?: number, fallback = "#888888") => {
    const v = cs.getPropertyValue(name).trim();
    if (!v) return fallback;
    return alpha == null ? `hsl(${v})` : `hsl(${v} / ${alpha})`;
  };
  return {
    bg: tok("--card", undefined, "transparent"),
    text: tok("--muted-foreground"),
    grid: tok("--border", 0.45),
    entry: tok("--foreground", 0.65),
    // Deliberately not --primary: on the default theme that is red, and an
    // exit line the same colour as the stop line is the one confusion this
    // chart cannot afford.
    exit: "#60a5fa",
    up: "#10b981",
    down: "#ef4444",
    stop: "#ef4444",
    target: "#10b981",
  };
}

/**
 * Ticks small enough for the instrument.
 *
 * A price scale pinned at two decimals reads a coin trading at 0.00042 as a
 * flat line at 0.00, which is worse than no chart: it looks like data.
 */
const digitsFor = (p: number) =>
  p >= 1000 ? 2 : p >= 100 ? 3 : p >= 1 ? 4 : p >= 0.01 ? 6 : 8;

export function TradeChart({ trade }: { trade: TradeWithTags }) {
  const [tf, setTf] = useState<Timeframe>("auto");
  const { data, isLoading, isFetching } = useTradeCandles(
    trade.id,
    tf === "auto" ? undefined : tf,
  );

  const levels = useMemo<Level[]>(() => {
    const tps = parseExtraTargets(trade.extraTargets);
    return [
      { price: trade.entryPrice, label: "entry", color: "entry", dashed: false },
      ...(trade.initialStop != null
        ? [{ price: trade.initialStop, label: "stop", color: "stop", dashed: true }]
        : []),
      ...(trade.initialTarget != null
        ? [{ price: trade.initialTarget, label: "target", color: "target", dashed: true }]
        : []),
      ...tps.map((p, i) => ({
        price: p,
        label: `tp${i + 2}`,
        color: "target",
        dashed: true,
      })),
      ...(trade.exitPrice != null
        ? [{ price: trade.exitPrice, label: "exit", color: "exit", dashed: false }]
        : []),
    ];
  }, [trade]);

  if (isLoading) {
    return (
      <Card className="border-card-border bg-card p-4">
        <p className="text-[11px] text-muted-foreground" data-testid="chart-loading">
          Loading the price path…
        </p>
      </Card>
    );
  }

  /*
   * No chart is two different situations.
   *
   * A futures trade or a ticker Binance does not list has nothing to draw and
   * nothing to apologise for — silence is right, and an error line on every
   * NQ row would be noise. But a feed that could not be REACHED is a broken
   * thing pretending to be an empty one, and rendering nothing there is how a
   * dead price feed stays invisible for a week. So the venue's own words get
   * printed, including which host said them.
   */
  const feedProblem = data?.feed?.lastError ?? data?.error ?? null;
  if (!data?.pair) {
    if (!feedProblem) return null;
    return (
      <Card className="border-amber-500/40 bg-card p-4" data-testid="chart-feed-error">
        <p className="text-[11px] leading-snug text-amber-500">
          No chart: the price feed did not answer.
        </p>
        <p className="mt-1 font-mono text-[10px] leading-snug text-muted-foreground">
          {feedProblem}
        </p>
        <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
          Everything else on this trade is unaffected — the journal simply cannot read prices
          until the venue is reachable from the server.
        </p>
      </Card>
    );
  }

  const candles = data.candles ?? [];

  return (
    <Card className="border-card-border bg-card p-4" data-testid="trade-chart">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
        <span className="font-mono text-foreground/80">{data.pair}</span>
        {/* Which book, because a perp and its spot pair are different prices
            and the answer to "did my stop get hit" depends on which one you
            were actually resting an order in. */}
        <span>{data.market === "futures" ? "perp" : "spot"}</span>
        {/* Spot on a coin that HAS a perp is not a preference, it is a
            refusal — the perp book would not answer the server. Saying so
            here is the difference between a diagnosis and a mystery, and it
            matters: basis moves the two apart, so these candles are close to
            but not the prices your orders were resting among. */}
        {data.market !== "futures" && data.books?.futures === 0 && (
          <span className="text-amber-500" data-testid="chart-no-perp">
            perp book unreachable from the server
          </span>
        )}
        {/* The perp, but out of the published files rather than the live book.
            Worth saying: it is the right instrument, and it stops a day or so
            short of now, because the archive publishes a day at a time. */}
        {data.books?.fallback && (
          <span className="text-muted-foreground" data-testid="chart-from-archive">
            from the file archive
          </span>
        )}
        {tf === "auto" && data.interval && <span>{data.interval} candles</span>}
        {isFetching && <span data-testid="chart-refetching">…</span>}

        <div className="ml-auto flex items-center gap-1" data-testid="chart-timeframes">
          {TIMEFRAMES.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setTf(f.id)}
              aria-pressed={tf === f.id}
              className={pill(tf === f.id)}
              data-testid={`chart-tf-${f.id}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {candles.length === 0 ? (
        /* A timeframe with nothing in it must not take the buttons down with
           it — otherwise one wrong click leaves you with no way back. */
        <p className="py-8 text-center text-[11px] text-muted-foreground" data-testid="chart-empty">
          No candles at this timeframe.
        </p>
      ) : (
        <Candles
          tradeId={trade.id}
          interval={data.interval ?? "1h"}
          candles={candles}
          levels={levels}
          direction={trade.direction}
          entryMs={new Date(trade.entryTime).getTime()}
          exitMs={trade.exitTime ? new Date(trade.exitTime).getTime() : null}
        />
      )}
    </Card>
  );
}

/**
 * The chart itself, kept in its own component so its lifetime is the canvas's
 * lifetime: it mounts once there is something to draw and the engine is torn
 * down when it goes, rather than a chart object outliving the element it was
 * given.
 */
function Candles({
  tradeId,
  interval,
  candles,
  levels,
  direction,
  entryMs,
  exitMs,
}: {
  tradeId: number;
  interval: string;
  candles: Candle[];
  levels: Level[];
  direction: string;
  entryMs: number;
  exitMs: number | null;
}) {
  const { theme } = useTheme();
  const hostRef = useRef<HTMLDivElement>(null);
  /* Read by the autoscale provider, which is installed once and must always
     see the current levels rather than the ones that existed at mount. */
  const levelsRef = useRef(levels);
  levelsRef.current = levels;
  const readoutRef = useRef<HTMLSpanElement>(null);
  /*
   * History fetched by scrolling, kept out of React state on purpose: it is
   * appended to a canvas, nothing renders from it, and putting it in state
   * would re-run every effect in this component on each page.
   */
  const olderRef = useRef<Candle[]>([]);
  const loadingRef = useRef(false);
  /** Binance had nothing before the earliest bar — stop asking. */
  const exhaustedRef = useRef(false);
  const api = useRef<{
    chart: IChartApi;
    series: ISeriesApi<"Candlestick">;
    markers: ISeriesMarkersPluginApi<Time>;
    lines: IPriceLine[];
    colors: ReturnType<typeof palette>;
    /** Which window is on screen, so a refetch of the same bars doesn't refit. */
    shape: string;
  } | null>(null);
  /* Bumped when the engine is rebuilt, so the drawing pass below knows to run
     again against the new chart rather than against a removed one. */
  const [epoch, setEpoch] = useState(0);

  /*
   * A new timeframe is a new set of bars, so the pages scrolled into on the
   * old one are meaningless — and prepending 1m history to 4h candles would
   * draw a chart that is simply wrong. Declared before the drawing effect so
   * it runs first on the commit where both change.
   */
  useEffect(() => {
    olderRef.current = [];
    exhaustedRef.current = false;
  }, [tradeId, interval]);

  /** Everything drawn: pages scrolled into, then the trade's own window. */
  const bars = () => (olderRef.current.length ? [...olderRef.current, ...candles] : candles);

  /**
   * Scrolled off the left edge — go and get the bars that were never asked for.
   *
   * The chart opens on the trade, which is right, but a chart that cannot be
   * scrolled back is a screenshot. Rather than loading every bar Binance holds
   * up front for a view nobody may look at, history arrives a page at a time,
   * and the visible range is shifted by exactly the number of bars prepended
   * so the candles under the cursor stay under the cursor.
   */
  async function loadOlder() {
    const a = api.current;
    if (!a || loadingRef.current || exhaustedRef.current) return;
    const drawn = bars();
    if (drawn.length === 0) return;
    loadingRef.current = true;
    try {
      const page = await fetchCandlePage(tradeId, interval, drawn[0].t - 1);
      const older = (page.candles ?? []).filter((k) => k.t < drawn[0].t);
      if (older.length === 0) {
        exhaustedRef.current = true;
        return;
      }
      olderRef.current = [...older, ...olderRef.current];
      const ts = a.chart.timeScale();
      const was = ts.getVisibleLogicalRange();
      a.series.setData(bars().map(toBar));
      if (was) ts.setVisibleLogicalRange({ from: was.from + older.length, to: was.to + older.length });
    } catch {
      // A failed page is a page you can ask for again by scrolling; there is
      // nothing to say and nothing to undo.
    } finally {
      loadingRef.current = false;
    }
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const colors = palette(host);
    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: colors.bg },
        textColor: colors.text,
        fontSize: 10,
      },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: colors.grid, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderColor: colors.grid, timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      borderUpColor: colors.up,
      borderDownColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
      // The series' own last-price line would land a second unlabelled line
      // among the four that mean something. The axis value stays.
      priceLineVisible: false,
      /*
       * The levels are part of the vertical range, not decoration on top of
       * it. A target that was never reached must still be on the chart, or it
       * quietly answers "how far away was it" with "off the top" — which is
       * the version of the trade where you left nothing on the table.
       */
      autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => {
        const info = base();
        const prices = levelsRef.current.map((l) => l.price);
        if (!info?.priceRange || prices.length === 0) return info;
        return {
          ...info,
          priceRange: {
            minValue: Math.min(info.priceRange.minValue, ...prices),
            maxValue: Math.max(info.priceRange.maxValue, ...prices),
          },
        };
      },
    });

    /* The OHLC readout is written straight into the DOM rather than held in
       state: it changes on every pixel of mouse movement, and re-rendering the
       whole card that often to update four numbers is a lot of work to make a
       chart feel worse. */
    chart.subscribeCrosshairMove((param) => {
      const el = readoutRef.current;
      if (!el) return;
      const bar = param.seriesData.get(series) as CandlestickData | undefined;
      el.textContent = bar
        ? `O ${num(bar.open)}  H ${num(bar.high)}  L ${num(bar.low)}  C ${num(bar.close)}`
        : "";
    });

    api.current = {
      chart,
      series,
      markers: createSeriesMarkers(series, []),
      lines: [],
      colors,
      shape: "",
    };
    setEpoch((n) => n + 1);
    return () => {
      chart.remove();
      api.current = null;
    };
  }, [theme]);

  useEffect(() => {
    const a = api.current;
    if (!a || candles.length === 0) return;
    const { series, colors } = a;

    const digits = digitsFor(candles[candles.length - 1].c);
    series.applyOptions({
      priceFormat: { type: "price", precision: digits, minMove: 10 ** -digits },
    });
    series.setData(bars().map(toBar));

    /* Levels as price lines: they get an axis label too, so a target sitting
       off the top of the visible range still says what it is and how far away
       it was rather than silently vanishing. */
    for (const line of a.lines) series.removePriceLine(line);
    a.lines = levels.map((l) =>
      series.createPriceLine({
        price: l.price,
        color: (colors as any)[l.color] ?? colors.entry,
        lineWidth: 1,
        lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid,
        lineVisible: true,
        axisLabelVisible: true,
        title: l.label,
      }),
    );

    /* And the two instants, because a level line says at what price and these
       say when — the difference between "the stop was there" and "the stop was
       there for two days before it went". */
    const snap = (ms: number) => {
      let best = candles[0];
      for (const k of candles) {
        if (k.t > ms) break;
        best = k;
      }
      return (best.t / 1000) as UTCTimestamp;
    };
    const long = direction === "long";
    const marks: SeriesMarker<Time>[] = [
      {
        time: snap(entryMs),
        position: long ? "belowBar" : "aboveBar",
        shape: long ? "arrowUp" : "arrowDown",
        color: colors.entry,
        text: "in",
      },
      ...(exitMs != null
        ? [
            {
              time: snap(exitMs),
              position: (long ? "aboveBar" : "belowBar") as "aboveBar" | "belowBar",
              shape: "circle" as const,
              color: colors.exit,
              text: "out",
            },
          ]
        : []),
    ];
    a.markers.setMarkers(marks);

    /*
     * Fit only when the window itself changed — a new trade, a new timeframe.
     * A background refetch returns the same bars in a new array, and fitting
     * on that would yank the view back to the default every few minutes,
     * undoing whatever the trader had just zoomed into.
     */
    const shape = `${candles.length}:${candles[0].t}:${candles[candles.length - 1].t}`;
    if (shape !== a.shape) {
      a.shape = shape;
      a.chart.timeScale().fitContent();
    }
  }, [candles, levels, direction, entryMs, exitMs, epoch]);

  useEffect(() => {
    const a = api.current;
    if (!a) return;
    const ts = a.chart.timeScale();
    /* Twelve bars of runway before the edge: enough that the page lands
       before you reach the end of the data, not so much that a small nudge
       fetches history nobody wanted. */
    const onRange = (range: { from: number; to: number } | null) => {
      if (range && range.from < 12) void loadOlder();
    };
    ts.subscribeVisibleLogicalRangeChange(onRange);
    return () => ts.unsubscribeVisibleLogicalRangeChange(onRange);
  }, [epoch, tradeId, interval, candles]);

  return (
    <div className="relative">
      <div ref={hostRef} style={{ height: HEIGHT }} data-testid="chart-canvas" />
      <span
        ref={readoutRef}
        className="pointer-events-none absolute left-1 top-1 z-10 font-mono text-[10px] text-muted-foreground"
        data-testid="chart-ohlc"
      />
    </div>
  );
}
