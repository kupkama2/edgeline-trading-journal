import { useEffect, useRef, useState } from "react";
import { CandlestickSeries, ColorType, createChart, CrosshairMode, HistogramSeries, LineSeries, LineStyle, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import { ExternalLink, Loader2, Newspaper } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/trade-shared";
import { TIMEFRAMES, type Timeframe } from "@shared/screener";
import { ACCEL_ARROW, fmtPct, fmtPx, fmtUsd, fmtX, useScreenerCoin, useScreenerNews, type ScreenerCoin, type ScreenerNews } from "@/lib/screener";

function palette(host: HTMLElement) {
  const cs = getComputedStyle(host);
  const tok = (name: string, alpha?: number, fallback = "#888888") => {
    const v = cs.getPropertyValue(name).trim();
    if (!v) return fallback;
    return alpha == null ? `hsl(${v})` : `hsl(${v} / ${alpha})`;
  };
  return { bg: tok("--card", undefined, "transparent"), text: tok("--muted-foreground"), grid: tok("--border", 0.45) };
}

const baseOptions = (colors: ReturnType<typeof palette>) => ({
  autoSize: true,
  layout: { background: { type: ColorType.Solid, color: colors.bg }, textColor: colors.text, fontSize: 10 },
  grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
  rightPriceScale: { borderColor: colors.grid },
  timeScale: { borderColor: colors.grid, timeVisible: true, secondsVisible: false },
  crosshair: { mode: CrosshairMode.Normal },
});

/** The price, as candles, with the structure stop drawn on it. */
function PriceChart({ data, stop }: { data: ScreenerCoin["price"]; stop: number | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = createChart(host, baseOptions(palette(host)));
    chartRef.current = chart;
    const series = chart.addSeries(CandlestickSeries, { upColor: "#10b981", downColor: "#ef4444", borderUpColor: "#10b981", borderDownColor: "#ef4444", wickUpColor: "#10b981", wickDownColor: "#ef4444", priceLineVisible: false });
    series.setData(data.map((c) => ({ time: Math.floor(c.t / 1000) as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c })));
    if (stop != null) series.createPriceLine({ price: stop, color: "#ef4444", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "stop" });
    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [data, stop]);
  return <div ref={hostRef} className="h-48 w-full sm:h-56" data-testid="screener-price-chart" />;
}

/** The RS ratio as a line, the RS invalidation on it, the alt's volume underneath. */
function RatioChart({ data, invalidation }: { data: ScreenerCoin["ratio"]; invalidation: number | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = createChart(host, { ...baseOptions(palette(host)), rightPriceScale: { borderColor: palette(host).grid, scaleMargins: { top: 0.08, bottom: 0.28 } } });
    const line = chart.addSeries(LineSeries, { color: "#38bdf8", lineWidth: 2, priceLineVisible: false, priceFormat: { type: "price", precision: 6, minMove: 0.000001 } });
    line.setData(data.map((p) => ({ time: Math.floor(p.t / 1000) as UTCTimestamp, value: p.r })));
    if (invalidation != null) line.createPriceLine({ price: invalidation, color: "#f59e0b", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "RS inv." });
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: "vol", color: "rgba(148, 163, 184, 0.45)", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
    vol.setData(
      data.map((p, i) => ({
        time: Math.floor(p.t / 1000) as UTCTimestamp,
        value: p.v,
        color: i > 0 && p.r >= data[i - 1].r ? "rgba(16, 185, 129, 0.45)" : "rgba(239, 68, 68, 0.45)",
      })),
    );
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [data, invalidation]);
  return <div ref={hostRef} className="h-56 w-full sm:h-64" data-testid="screener-ratio-chart" />;
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
  const risk = Number(riskText) > 0 ? Number(riskText) : defaultRisk;
  const q = useScreenerCoin(coin, tf, risk);
  const news = useScreenerNews();
  const [got, setGot] = useState<ScreenerNews | null>(null);
  useEffect(() => {
    setGot(null);
    news.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coin]);
  const d = q.data;
  const row = d?.row ?? null;
  const m = row?.tf[tf];
  const plan = d?.plan;
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
            <p className="mt-3 text-[10px] uppercase tracking-wider text-muted-foreground">Price · {tf}</p>
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
                <dd className="text-[10px] text-muted-foreground">lowest low of the last {d?.stopLookback ?? "N"} {tf} candles</dd>
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
                  {plan.size != null ? `${plan.size.toFixed(plan.size >= 100 ? 0 : plan.size >= 1 ? 2 : 4)} ${coin}` : "—"}
                </dd>
                <dd className="text-[10px] text-muted-foreground">{plan.notional != null ? `≈ ${fmtUsd(plan.notional)} notional` : "stop above the mark"}</dd>
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
              onClick={() => coin && news.mutateAsync(coin).then(setGot).catch(() => setGot({ coin, links: [], summary: null, sources: [], reason: "The news could not be read." }))}
              data-testid="screener-news-button"
            >
              {news.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Newspaper className="mr-1 h-3 w-3" />}
              Check news
            </Button>
          </div>
          {!got && <p className="mt-1 text-[11px] text-muted-foreground">Fetched only when you ask: the links, and a 7-day read with web search when the server has an Anthropic key.</p>}
          {got && (
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
                      {s.title || new URL(s.url).hostname}
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
