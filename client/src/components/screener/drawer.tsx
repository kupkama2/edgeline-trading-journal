import { parseLooseNumber } from "@shared/loose-number";
import { useEffect, useRef, useState } from "react";
import { CandlestickSeries, ColorType, createChart, CrosshairMode, HistogramSeries, LineSeries, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { ExternalLink, Loader2, Newspaper } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/trade-shared";
import { OI_READ, SIGNAL_NAMES, SignalDots } from "@/components/screener/table";
import { TIMEFRAMES, type Timeframe } from "@shared/screener";
import { useTheme } from "@/components/shell";
import { ACCEL_ARROW, fmtPct, fmtPx, fmtUsd, fmtX, hostOf, sizeFor, useScreenerCoin, useScreenerNews, type ScreenerCoin, type ScreenerNews } from "@/lib/screener";

function palette(host: HTMLElement) {
  const cs = getComputedStyle(host);
  const tok = (name: string, alpha?: number, fallback = "#888888") => {
    const v = cs.getPropertyValue(name).trim();
    if (!v) return fallback;
    return alpha == null ? `hsl(${v})` : `hsl(${v} / ${alpha})`;
  };
  return { bg: tok("--card", undefined, "transparent"), text: tok("--muted-foreground"), grid: tok("--border", 0.45) };
}

/** The theme changed under a chart that was made once: its colours are read again, after the paint, when the tokens are the new ones. */
function useChartTheme(hostRef: React.RefObject<HTMLDivElement>, chartRef: React.MutableRefObject<IChartApi | null>) {
  const { theme } = useTheme();
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (hostRef.current && chartRef.current) chartRef.current.applyOptions(baseOptions(palette(hostRef.current)));
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);
}

const baseOptions = (colors: ReturnType<typeof palette>) => ({
  autoSize: true,
  layout: { background: { type: ColorType.Solid, color: colors.bg }, textColor: colors.text, fontSize: 10 },
  grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
  rightPriceScale: { borderColor: colors.grid },
  timeScale: { borderColor: colors.grid, timeVisible: true, secondsVisible: false },
  crosshair: { mode: CrosshairMode.Normal },
});

/** The price, as candles, with the structure stop drawn on it. The chart is made once; data and the line are swapped in place. */
function PriceChart({ data, stop }: { data: ScreenerCoin["price"]; stop: number | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const lineRef = useRef<IPriceLine | null>(null);
  useChartTheme(hostRef, chartRef);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = createChart(host, baseOptions(palette(host)));
    chartRef.current = chart;
    seriesRef.current = chart.addSeries(CandlestickSeries, { upColor: "#10b981", downColor: "#ef4444", borderUpColor: "#10b981", borderDownColor: "#ef4444", wickUpColor: "#10b981", wickDownColor: "#ef4444", priceLineVisible: false });
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      lineRef.current = null;
    };
  }, []);
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    series.setData(data.map((c) => ({ time: Math.floor(c.t / 1000) as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c })));
    chartRef.current?.timeScale().fitContent();
  }, [data]);
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    if (lineRef.current) series.removePriceLine(lineRef.current);
    lineRef.current = stop != null ? series.createPriceLine({ price: stop, color: "#ef4444", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "stop" }) : null;
  }, [stop, data]);
  return <div ref={hostRef} className="h-48 w-full sm:h-56" data-testid="screener-price-chart" />;
}

/** The RS ratio as a line, the RS invalidation on it, the alt's volume underneath. Made once, fed on change. */
function RatioChart({ data, invalidation }: { data: ScreenerCoin["ratio"]; invalidation: number | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const lineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const invRef = useRef<IPriceLine | null>(null);
  useChartTheme(hostRef, chartRef);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = createChart(host, { ...baseOptions(palette(host)), rightPriceScale: { borderColor: palette(host).grid, scaleMargins: { top: 0.08, bottom: 0.28 } } });
    chartRef.current = chart;
    // Four significant figures whatever the size: a $0.17 coin over BTC is near 0.0000017, which six fixed decimals printed as 0.000002 on every label.
    lineRef.current = chart.addSeries(LineSeries, { color: "#38bdf8", lineWidth: 2, priceLineVisible: false, priceFormat: { type: "custom", minMove: 1e-12, formatter: (p: number) => (p === 0 ? "0" : String(Number(p.toPrecision(4)))) } });
    volRef.current = chart.addSeries(HistogramSeries, { priceScaleId: "vol", color: "rgba(148, 163, 184, 0.45)", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
    return () => {
      chart.remove();
      chartRef.current = null;
      lineRef.current = null;
      volRef.current = null;
      invRef.current = null;
    };
  }, []);
  useEffect(() => {
    const line = lineRef.current;
    const vol = volRef.current;
    if (!line || !vol) return;
    line.setData(data.map((p) => ({ time: Math.floor(p.t / 1000) as UTCTimestamp, value: p.r })));
    vol.setData(
      data.map((p, i) => ({
        time: Math.floor(p.t / 1000) as UTCTimestamp,
        value: p.v,
        color: i > 0 && p.r >= data[i - 1].r ? "rgba(16, 185, 129, 0.45)" : "rgba(239, 68, 68, 0.45)",
      })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [data]);
  useEffect(() => {
    const line = lineRef.current;
    if (!line) return;
    if (invRef.current) line.removePriceLine(invRef.current);
    invRef.current = invalidation != null ? line.createPriceLine({ price: invalidation, color: "#f59e0b", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "RS inv." }) : null;
  }, [invalidation, data]);
  return <div ref={hostRef} className="h-56 w-full sm:h-64" data-testid="screener-ratio-chart" />;
}

/** One reading in words, for the panel. */
function readingText(k: (typeof SIGNAL_NAMES)[number][0], row: NonNullable<ScreenerCoin["row"]>, tf: Timeframe): string {
  const m = row.tf[tf];
  const p = row.price?.[tf];
  const pos = row.positioning;
  switch (k) {
    case "rs":
      return fmtPct(m.rs);
    case "accel":
      return m.accel ? `${ACCEL_ARROW[m.accel]} ${m.accel}` : "—";
    case "rsi":
      return p?.rsi != null ? p.rsi.toFixed(0) : "—";
    case "trend":
      return p?.ema == null ? "—" : p.ema === 2 ? "above both" : p.ema === 0 ? "below both" : "between";
    case "oi":
      return pos?.read ? pos.read.replace("-", " ") : pos?.oi1d != null ? `${fmtPct(pos.oi1d)} flat` : "no history yet";
    case "funding":
      return pos?.fundingPct != null ? `${fmtPct(row.fundingAnnual, 0)} · ${Math.round(pos.fundingPct * 100)}th pct` : fmtPct(row.fundingAnnual, 0);
    case "cvd":
      return row.flow?.cvd24h != null ? `${fmtPct(row.flow.cvd24h)} of volume` : "no Binance flow";
  }
}

/** A small line, for the CVD and the account ratio. */
function MiniLine({ points, testId }: { points: number[]; testId?: string }) {
  if (points.length < 2) return <span className="text-[11px] text-muted-foreground">—</span>;
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const w = 220;
  const h = 36;
  const d = points.map((v, i) => `${i ? "L" : "M"}${((i / (points.length - 1)) * w).toFixed(1)},${(h - ((v - lo) / (hi - lo || 1)) * h).toFixed(1)}`).join(" ");
  const up = points[points.length - 1] >= points[0];
  return (
    <svg width={w} height={h} className="block max-w-full" aria-hidden data-testid={testId}>
      <path d={d} fill="none" stroke={up ? "#10b981" : "#ef4444"} strokeWidth={1.5} />
    </svg>
  );
}

type Liq = NonNullable<NonNullable<ScreenerCoin["row"]>["liq"]>;

/** Where Hyperliquid's largest accounts would be liquidated: shorts above the mark, longs below, one bar per one-percent band. */
function LiqBars({ liq }: { liq: Liq }) {
  const bands = liq.bands.filter((b) => Math.abs(b.at) <= 0.15);
  if (bands.length === 0) return <p className="text-[11px] text-muted-foreground">No liquidations within 15% among the accounts read.</p>;
  const max = Math.max(...bands.map((b) => b.usd));
  const fmt = (x: number) => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${Math.round(x / 1e3)}K`);
  const above = bands.filter((b) => b.at > 0).sort((a, b) => b.at - a.at);
  const below = bands.filter((b) => b.at < 0).sort((a, b) => b.at - a.at);
  const Row = ({ b }: { b: (typeof bands)[number] }) => (
    <div className="flex items-center gap-2 text-[10px]">
      <span className="w-14 text-right font-mono text-muted-foreground">{b.price.toPrecision(5)}</span>
      <span className="w-10 text-right font-mono text-muted-foreground">{fmtPct(b.at, 0)}</span>
      <span className="h-2 rounded-sm" style={{ width: `${Math.max(2, (b.usd / max) * 140)}px`, background: b.at > 0 ? "rgba(239,68,68,0.7)" : "rgba(16,185,129,0.7)" }} />
      <span className="font-mono">{fmt(b.usd)}</span>
    </div>
  );
  return (
    <div className="space-y-px" data-testid="screener-liq-bars">
      {above.map((b) => (
        <Row key={b.at} b={b} />
      ))}
      <div className="my-0.5 border-t border-dashed border-foreground/40 text-[10px] text-muted-foreground">mark {liq.mark.toPrecision(5)}</div>
      {below.map((b) => (
        <Row key={b.at} b={b} />
      ))}
    </div>
  );
}

/** Binance's flow for the coin and the two venues side by side. */
function FlowPanel({ row }: { row: NonNullable<ScreenerCoin["row"]> }) {
  const f = row.flow;
  const Item = ({ k, v, warn }: { k: string; v: string; warn?: boolean }) => (
    <li className="flex justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      <span className={`font-mono ${warn ? "text-amber-500" : ""}`}>{v}</span>
    </li>
  );
  return (
    <div className="mt-4 rounded-md border border-border/70 p-3" data-testid="screener-flow">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Binance flow{f ? ` · ${f.symbol}` : ""}</h3>
        <span className="text-[10px] text-muted-foreground">through your relay</span>
      </div>
      {f ? (
        <>
          <ul className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
            <Item k="Taker delta 4h · 24h" v={`${fmtPct(f.cvd4h)} · ${fmtPct(f.cvd24h)}`} />
            <Item k="Price 24h (Binance)" v={fmtPct(f.px24h)} />
            <Item k="Accounts long/short · 24h" v={`${f.lsAccounts?.toFixed(2) ?? "—"} · ${fmtPct(f.lsAccounts24h)}`} />
            <Item k="Top traders' positions L/S · 24h" v={`${f.lsTop?.toFixed(2) ?? "—"} · ${fmtPct(f.lsTop24h)}`} />
            <Item k="Open interest 24h · Binance vs HL" v={`${fmtPct(f.oi24h)} · ${fmtPct(row.positioning?.oi1d)}`} />
            <Item k="Funding /yr · HL vs Binance" v={`${fmtPct(f.fundingHl, 0)} · ${fmtPct(f.fundingBn, 0)}`} warn={f.fundingSpread != null && Math.abs(f.fundingSpread) >= 0.25} />
            <Item k="HL mark vs Binance" v={fmtPct(f.basis, 2)} warn={f.basis != null && Math.abs(f.basis) >= 0.003} />
          </ul>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">CVD, last week</p>
              <MiniLine points={f.cvdSeries.map((x) => x.cvd)} testId="screener-cvd-line" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Accounts long/short, 2 days</p>
              <MiniLine points={f.lsSeries.map((x) => x.ratio)} />
            </div>
          </div>
        </>
      ) : (
        <p className="mt-1 text-[11px] text-muted-foreground">No Binance flow for this coin: it is not a Binance USDT perp, or the relay was not running at the last run.</p>
      )}
    </div>
  );
}

function LiqPanel({ row }: { row: NonNullable<ScreenerCoin["row"]> }) {
  const l = row.liq;
  return (
    <div className="mt-4 rounded-md border border-border/70 p-3" data-testid="screener-liq">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Liquidations on Hyperliquid</h3>
        <span className="text-[10px] text-muted-foreground">{l ? `${l.accounts} of the largest accounts hold it` : ""}</span>
      </div>
      {l ? (
        <>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {l.nearestShort ? `Shorts liquidate heaviest at ${l.nearestShort.price.toPrecision(5)} (${fmtPct(l.nearestShort.at)}). ` : ""}
            {l.nearestLong ? `Longs heaviest at ${l.nearestLong.price.toPrecision(5)} (${fmtPct(l.nearestLong.at)}).` : ""}
          </p>
          <div className="mt-2">
            <LiqBars liq={l} />
          </div>
        </>
      ) : (
        <p className="mt-1 text-[11px] text-muted-foreground">None of the largest accounts holds a position with a liquidation price in range.</p>
      )}
    </div>
  );
}

/**
 * The coin, in a drawer: price and RS ratio stacked on one timeframe,
 * volume under the ratio, the way out planned before the way in, and
 * the news on a click.
 */
export function CoinDrawer({
  coin,
  tf,
  onTf,
  defaultRisk,
  onClose,
}: {
  coin: string | null;
  tf: Timeframe;
  onTf: (tf: Timeframe) => void;
  defaultRisk: number;
  onClose: () => void;
}) {
  const [riskText, setRiskText] = useState(String(defaultRisk));
  useEffect(() => setRiskText(String(defaultRisk)), [defaultRisk]);
  const typedRisk = parseLooseNumber(riskText);
  const risk = typedRisk != null && typedRisk > 0 ? typedRisk : defaultRisk;
  const q = useScreenerCoin(coin, tf);
  const news = useScreenerNews();
  const [got, setGot] = useState<ScreenerNews | null>(null);
  // The coin on screen, for an answer that comes back late: a slow news read for one coin must not land under another.
  const coinRef = useRef(coin);
  coinRef.current = coin;
  useEffect(() => {
    setGot(null);
    news.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coin]);
  const d = q.data;
  const row = d?.row ?? null;
  const m = row?.tf[tf];
  const plan = d?.plan;
  const sized = plan ? sizeFor(risk, d?.mark ?? null, plan.structureStop) : { size: null, notional: null };
  return (
    <Sheet open={!!coin} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto p-4 sm:max-w-xl" data-testid="screener-drawer">
        <SheetHeader className="text-left">
          <SheetTitle className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-xl font-bold">{coin}</span>
            {row && (
              <span className="font-mono text-sm text-muted-foreground">
                {fmtPx(row.mark)} · vol {fmtUsd(row.volume24h)} · funding {fmtPct(row.fundingAnnual, 0)}/yr · OI {fmtPct(row.oiChange)}
              </span>
            )}
          </SheetTitle>
        </SheetHeader>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Segmented value={tf} onChange={onTf} options={TIMEFRAMES.map((t) => ({ id: t, label: t }))} size="sm" ariaLabel="Timeframe" testId="screener-drawer-tf" />
          {m && (
            <span className="font-mono text-xs" data-testid="screener-drawer-rs">
              RS {fmtPct(m.rs)} {m.accel ? ACCEL_ARROW[m.accel] : ""} · RVOL {fmtX(m.rvol)}
              {m.breakout ? " · breakout" : ""}
            </span>
          )}
          {row?.flags[tf].candidate && <span className="rounded border border-emerald-500/60 bg-emerald-500/15 px-1 text-[10px] font-semibold uppercase text-emerald-400">Candidate</span>}
          {row?.leverageDriven && <span className="rounded border border-amber-500/50 bg-amber-500/10 px-1 text-[10px] font-semibold uppercase text-amber-500">Leverage-driven</span>}
        </div>

        {q.isLoading && (
          <p className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the stored series…
          </p>
        )}
        {d && d.price.length === 0 && <p className="mt-6 text-xs text-muted-foreground">No stored candles for this coin yet. The next run reads them.</p>}
        {d && d.price.length > 0 && (
          <>
            <p className="mt-3 text-[10px] uppercase tracking-wider text-muted-foreground">
              Price · {tf} · bars to {new Date(d.barsTo).toISOString().slice(11, 16)}Z
            </p>
            <PriceChart data={d.price} stop={plan?.structureStop ?? null} />
            <p className="mt-3 text-[10px] uppercase tracking-wider text-muted-foreground">RS ratio vs BTC · {tf} · volume below</p>
            <RatioChart data={d.ratio} invalidation={plan?.rsInvalidation ?? null} />
          </>
        )}

        {/* ------------------------------ the way out ------------------------------ */}
        {plan && (
          <div className="mt-4 rounded-md border border-border/70 p-3" data-testid="screener-exit">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">Outs, before the in</h3>
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                risk $
                <Input value={riskText} onChange={(e) => setRiskText(e.target.value)} inputMode="decimal" className="h-7 w-20 text-xs" data-testid="screener-risk" />
              </label>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
              <div>
                <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">Structure stop</dt>
                <dd className="font-mono text-red-400" data-testid="screener-stop">
                  {fmtPx(plan.structureStop)}
                </dd>
                <dd className="text-[10px] text-muted-foreground">
                  {plan.structureStop != null ? `lowest low of the last ${plan.stopCandles} ${tf} candles` : `fewer than ${d?.stopLookback ?? "N"} ${tf} candles on record`}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">Stop distance</dt>
                <dd className="font-mono" data-testid="screener-stop-distance">
                  {plan.stopDistance != null ? `${(plan.stopDistance * 100).toFixed(2)}%` : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">Size for ${risk}</dt>
                <dd className="font-mono" data-testid="screener-size">
                  {sized.size != null ? `${sized.size.toFixed(sized.size >= 100 ? 0 : sized.size >= 1 ? 2 : 4)} ${coin}` : "—"}
                </dd>
                <dd className="text-[10px] text-muted-foreground">{sized.notional != null ? `≈ ${fmtUsd(sized.notional)} notional` : plan.structureStop == null ? "not enough candles" : "stop above the mark"}</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">RS invalidation</dt>
                <dd className="font-mono text-amber-500" data-testid="screener-rs-invalidation">
                  {plan.rsInvalidation != null ? plan.rsInvalidation.toPrecision(5) : "—"}
                </dd>
                <dd className="text-[10px] text-muted-foreground">
                  {plan.ratioNow != null && plan.rsInvalidation != null
                    ? plan.ratioNow > plan.rsInvalidation
                      ? `ratio now ${plan.ratioNow.toPrecision(5)}, above it; a close back under is out`
                      : `ratio now ${plan.ratioNow.toPrecision(5)}, still under the 20-period high: no RS breakout yet`
                    : "the 20-period RS high"}
                </dd>
              </div>
            </dl>
          </div>
        )}

        {/* ------------------------------ the readings ------------------------------ */}
        {row && (
          <div className="mt-4 rounded-md border border-border/70 p-3" data-testid="screener-readings">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">Do the readings agree? · {tf}</h3>
              <SignalDots s={row.signals?.[tf]} />
            </div>
            <ul className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
              {SIGNAL_NAMES.map(([k, name]) => {
                const v = row.signals?.[tf]?.[k] ?? 0;
                return (
                  <li key={k} className="flex items-baseline justify-between gap-2">
                    <span className="text-muted-foreground">{name}</span>
                    <span className={`font-mono ${v > 0 ? "text-emerald-400" : v < 0 ? "text-red-400" : "text-muted-foreground"}`}>{readingText(k, row, tf)}</span>
                  </li>
                );
              })}
              <li className="flex items-baseline justify-between gap-2">
                <span className="text-muted-foreground">RS vs ETH · vs alt basket</span>
                <span className="font-mono">
                  {fmtPct(row.price?.[tf]?.rsEth)} · {fmtPct(row.price?.[tf]?.rsBasket)}
                </span>
              </li>
              <li className="flex items-baseline justify-between gap-2">
                <span className="text-muted-foreground">ATR · off the 20-period high</span>
                <span className="font-mono">
                  {row.price?.[tf]?.atrPct != null ? `${(row.price[tf].atrPct! * 100).toFixed(2)}%` : "—"} · {row.price?.[tf]?.offHigh != null ? `${(row.price[tf].offHigh! * 100).toFixed(1)}%` : "—"}
                </span>
              </li>
              <li className="flex items-baseline justify-between gap-2">
                <span className="text-muted-foreground">OI 1h · 4h · 24h · premium</span>
                <span className="font-mono">
                  {fmtPct(row.positioning?.oi1h)} · {fmtPct(row.positioning?.oi4h)} · {fmtPct(row.positioning?.oi1d)} · {fmtPct(row.positioning?.premium, 2)}
                </span>
              </li>
            </ul>
            {row.signals?.[tf]?.divergence && (
              <p className={`mt-2 text-xs ${row.signals[tf].divergence === "bearish" ? "text-red-400" : "text-emerald-400"}`} data-testid="screener-divergence">
                {row.signals[tf].divergence === "bearish"
                  ? "Bearish divergence: price at a 20-period high that relative strength or RSI does not confirm."
                  : "Bullish divergence: price at a 20-period low while relative strength or RSI holds up."}
              </p>
            )}
            {row.positioning?.read && <p className="mt-1 text-[11px] text-muted-foreground">{OI_READ[row.positioning.read]}.</p>}
          </div>
        )}

        {row && <FlowPanel row={row} />}
        {row && <LiqPanel row={row} />}

        {/* ------------------------------ the arithmetic ------------------------------ */}
        {d?.audit && (
          <details className="mt-3 rounded-md border border-border/50 px-3 py-2 text-[11px] text-muted-foreground" data-testid="screener-audit">
            <summary className="cursor-pointer select-none text-foreground/80">How the {tf} RS change was computed</summary>
            <div className="mt-1.5 space-y-0.5 font-mono">
              <p>
                now ({new Date(d.audit.now.t).toISOString().slice(0, 16).replace("T", " ")}Z): {coin} {fmtPx(d.audit.now.alt)} ÷ BTC {fmtPx(d.audit.now.btc)} = ratio {d.audit.now.ratio.toPrecision(6)}
              </p>
              <p>
                {d.audit.lookbackBars} {d.audit.base} bar{d.audit.lookbackBars === 1 ? "" : "s"} back ({new Date(d.audit.then.t).toISOString().slice(0, 16).replace("T", " ")}Z): {coin} {fmtPx(d.audit.then.alt)} ÷ BTC {fmtPx(d.audit.then.btc)} = ratio {d.audit.then.ratio.toPrecision(6)}
              </p>
              <p className="text-foreground">
                {d.audit.now.ratio.toPrecision(6)} ÷ {d.audit.then.ratio.toPrecision(6)} − 1 = <b>{fmtPct(d.audit.rs, 2)}</b>
              </p>
            </div>
          </details>
        )}

        {/* ------------------------------ the news ------------------------------ */}
        <div className="mt-4 rounded-md border border-border/70 p-3" data-testid="screener-news">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">News</h3>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-[11px]"
              disabled={!coin || news.isPending}
              onClick={() => {
                if (!coin) return;
                const asked = coin;
                const land = (n: ScreenerNews) => {
                  if (coinRef.current === asked) setGot(n);
                };
                news.mutateAsync(asked).then(land).catch(() => land({ coin: asked, links: [], summary: null, sources: [], reason: "The news could not be read." }));
              }}
              data-testid="screener-news-button"
            >
              {news.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Newspaper className="mr-1 h-3 w-3" />}
              Check news
            </Button>
          </div>
          {!(got && got.coin === coin) && <p className="mt-1 text-[11px] text-muted-foreground">Fetched only when you ask: the links, and a 7-day read with web search when the server has an Anthropic key.</p>}
          {got && got.coin === coin && (
            <div className="mt-2 space-y-2 text-xs">
              <div className="flex flex-wrap gap-2">
                {got.links.map((l) => (
                  <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] hover:border-primary/40" data-testid="screener-news-link">
                    {l.label} <ExternalLink className="h-3 w-3" />
                  </a>
                ))}
              </div>
              {got.summary && got.summary.length > 0 ? (
                <ul className="list-disc space-y-1 pl-4">
                  {got.summary.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">{got.reason ?? "No read this time."}</p>
              )}
              {got.sources.length > 0 && (
                <p className="flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                  {got.sources.map((s) => (
                    <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="underline decoration-dotted hover:text-foreground">
                      {s.title || hostOf(s.url)}
                    </a>
                  ))}
                </p>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
