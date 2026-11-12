import { useState } from "react";
import { Loader2, ScanSearch, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TIMEFRAMES, type Timeframe } from "@shared/screener";
import { ACCEL_ARROW, fmtPct, fmtPx, fmtUsd, fmtX, fmtPrague, heat, useScreenerScan, type ScreenerScan } from "@/lib/screener";
import { OI_READ, SignalDots } from "@/components/screener/table";

const KEY = "edgeline.screener.scan";
const COIN = /^[A-Za-z0-9:_-]{1,24}$/;

/**
 * A coin of your choosing on every timeframe at once: the table shows one
 * timeframe for every coin; this shows every timeframe for one coin, so a
 * strong hourly against a weak daily is one look rather than six clicks.
 */
export function ScreenerScanCard({ onOpen }: { onOpen: (coin: string) => void }) {
  const [typed, setTyped] = useState("");
  const [coin, setCoin] = useState<string | null>(() => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  });
  const scan = useScreenerScan(coin);
  const go = () => {
    const c = typed.trim();
    if (!COIN.test(c)) return;
    setCoin(c);
    try {
      localStorage.setItem(KEY, c);
    } catch {
      /* fine */
    }
  };
  const clear = () => {
    setCoin(null);
    setTyped("");
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* fine */
    }
  };

  return (
    <Card className="border-card-border bg-card p-3 sm:p-4" data-testid="screener-scan">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Scan a coin</h2>
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="e.g. SOL"
            className="h-7 w-28 font-mono text-xs uppercase placeholder:normal-case"
            aria-label="Coin to scan"
            data-testid="screener-scan-input"
          />
          <Button type="submit" size="sm" className="h-7 px-2.5 text-[11px]" disabled={!COIN.test(typed.trim()) || scan.isFetching} data-testid="screener-scan-go">
            {scan.isFetching ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <ScanSearch className="mr-1 h-3 w-3" />}
            Scan
          </Button>
          {coin && (
            <Button type="button" size="sm" variant="ghost" className="h-7 px-1.5 text-muted-foreground" onClick={clear} title="Close the scan" aria-label="Close the scan" data-testid="screener-scan-close">
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </form>
      </div>
      {!coin && <p className="mt-1 text-[11px] text-muted-foreground">Any Hyperliquid perp, on every timeframe at once. A coin outside the table is read from the venue now and ranked against the last run.</p>}
      {coin && scan.isLoading && <p className="mt-2 text-[11px] text-muted-foreground">Reading {coin.toUpperCase()}…</p>}
      {coin && scan.isError && (
        <p className="mt-2 text-[11px] text-amber-500" data-testid="screener-scan-error">
          {String((scan.error as any)?.message ?? scan.error).replace(/^\d+:\s*/, "").replace(/^\{"message":"|"\}$/g, "")}
        </p>
      )}
      {scan.data && <ScanBody s={scan.data} onOpen={onOpen} />}
    </Card>
  );
}

const sgnTone = (x: number | null | undefined) => (x == null ? "text-muted-foreground" : x > 0 ? "text-emerald-400" : x < 0 ? "text-red-400" : "");
// Against the 20 and 50 period averages, short enough for six columns on a phone.
const EMA_SAY = { 2: "above", 1: "mixed", 0: "below" } as const;

function ScanBody({ s, onOpen }: { s: ScreenerScan; onOpen: (coin: string) => void }) {
  const r = s.row;
  const rowsOf: { label: string; title?: string; cell: (tf: Timeframe) => React.ReactNode }[] = [
    {
      label: "Signals",
      title: "RS, acceleration, RSI, trend, OI, funding, flow: green for, red against, and their sum",
      cell: (tf) => {
        const sg = r.signals?.[tf];
        if (!sg) return <span className="text-muted-foreground">—</span>;
        return (
          <>
            {/* The dots from tablet width up; on a phone the sum alone, so all six timeframes fit. */}
            <span className="hidden sm:inline">
              <SignalDots s={sg} />
            </span>
            <span className={`font-mono font-semibold sm:hidden ${sg.score >= 3 ? "text-emerald-400" : sg.score <= -3 ? "text-red-400" : "text-foreground/80"}`}>{sg.score > 0 ? `+${sg.score}` : sg.score}</span>
          </>
        );
      },
    },
    {
      label: "RS vs BTC",
      cell: (tf) => (
        <span className="rounded px-0.5 font-mono sm:px-1" style={{ background: heat(r.tf[tf].rs) }}>
          {fmtPct(r.tf[tf].rs)}
        </span>
      ),
    },
    { label: "Accel", title: "Whether the last period beat the mean of the ones before", cell: (tf) => <span className="font-mono">{r.tf[tf].accel ? ACCEL_ARROW[r.tf[tf].accel!] : "—"}</span> },
    { label: "Breakout", title: "The ratio closed above its 20-period high", cell: (tf) => (r.tf[tf].breakout == null ? "—" : r.tf[tf].breakout ? <span className="text-emerald-400">yes</span> : <span className="text-muted-foreground">no</span>) },
    { label: "RVOL", cell: (tf) => <span className="font-mono">{fmtX(r.tf[tf].rvol)}</span> },
    {
      label: "RSI",
      cell: (tf) => {
        const v = r.price?.[tf]?.rsi;
        return <span className={`font-mono ${v == null ? "text-muted-foreground" : v >= 70 ? "text-amber-500" : v <= 30 ? "text-sky-400" : ""}`}>{v == null ? "—" : v.toFixed(0)}</span>;
      },
    },
    {
      label: "Trend",
      title: "Price against its 20 and 50 period averages: above both, between them, or below both",
      cell: (tf) => {
        const e = r.price?.[tf]?.ema;
        return <span className={e === 2 ? "text-emerald-400" : e === 0 ? "text-red-400" : ""}>{e == null ? "—" : EMA_SAY[e]}</span>;
      },
    },
    { label: "Off high", title: "How far under the 20-period high", cell: (tf) => <span className="font-mono">{r.price?.[tf]?.offHigh == null ? "—" : fmtPct(-r.price[tf].offHigh!)}</span> },
    { label: "ATR", title: "14-period average true range, as a share of price", cell: (tf) => <span className="font-mono">{r.price?.[tf]?.atrPct == null ? "—" : `${(r.price[tf].atrPct! * 100).toFixed(1)}%`}</span> },
    { label: "RS vs ETH", cell: (tf) => <span className={`font-mono ${sgnTone(r.price?.[tf]?.rsEth)}`}>{fmtPct(r.price?.[tf]?.rsEth)}</span> },
    ...(s.source === "run" ? [{ label: "RS vs alts", title: "Against the volume-weighted basket of the run's alts", cell: (tf: Timeframe) => <span className={`font-mono ${sgnTone(r.price?.[tf]?.rsBasket)}`}>{fmtPct(r.price?.[tf]?.rsBasket)}</span> }] : []),
    {
      label: "Stop",
      title: "The structure stop: the lowest low of the last candles, per the stop lookback",
      cell: (tf) => (
        <span className="font-mono">
          {fmtPx(s.stops[tf]?.stop)}
          {s.stops[tf]?.distance != null && <span className="block text-[9px] text-muted-foreground">{fmtPct(-s.stops[tf].distance!)}</span>}
        </span>
      ),
    },
    {
      label: "Flags",
      cell: (tf) => {
        const f = r.flags?.[tf];
        const d = r.signals?.[tf]?.divergence;
        const tags = [f?.candidate && ["cand", "text-emerald-400"], !f?.candidate && f?.movingFast && ["fast", "text-sky-400"], f?.weakest && ["weak", "text-red-400"], d && [d === "bearish" ? "bear div" : "bull div", d === "bearish" ? "text-red-400" : "text-emerald-400"]].filter(Boolean) as [string, string][];
        return tags.length ? (
          <span className="flex flex-col items-end gap-px">
            {tags.map(([t, c]) => (
              <span key={t} className={`text-[9px] font-semibold uppercase ${c}`}>
                {t}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        );
      },
    },
  ];
  return (
    <div className="mt-2" data-testid={`screener-scan-${s.coin}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px]">
        <button type="button" onClick={() => onOpen(s.coin)} className="font-mono text-base font-bold hover:text-sky-400" title="Open the coin's charts" data-testid="screener-scan-open">
          {s.coin}
        </button>
        <span className="font-mono">{fmtPx(r.mark)}</span>
        <span className="text-muted-foreground">vol {fmtUsd(r.volume24h)}</span>
        <span className={sgnTone(r.fundingAnnual)}>funding {fmtPct(r.fundingAnnual, 0)}/yr</span>
        {r.oiChange != null && <span className={sgnTone(r.oiChange)}>OI {fmtPct(r.oiChange)}</span>}
        {r.positioning?.read && <span className="text-muted-foreground">{OI_READ[r.positioning.read]}</span>}
        {r.leverageDriven && <span className="font-semibold text-amber-500">leverage-driven</span>}
      </div>
      <p className="mt-0.5 text-[10px] text-muted-foreground" data-testid="screener-scan-source">
        {s.source === "run" ? `From the run at ${fmtPrague(s.at)}` : `Read from the venue at ${fmtPrague(s.at)}, ranked against the run's ${s.universe - 1} coins`} · measured to {fmtPrague(new Date(s.barsTo).toISOString())}
        {s.source === "scanned" && " · no RS against the alt basket for a coin outside the run"}
      </p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full max-w-3xl text-[10px] sm:text-[11px]">
          <thead>
            <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="sticky left-0 bg-card py-1 pr-2 text-left font-medium" />
              {TIMEFRAMES.map((tf) => (
                <th key={tf} className="px-1 py-1 text-right font-mono font-medium sm:px-1.5">
                  {tf}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowsOf.map((row) => (
              <tr key={row.label} className="border-b border-border/40 last:border-0" data-testid={`screener-scan-row-${row.label}`}>
                <td className="sticky left-0 whitespace-nowrap bg-card py-1 pr-1 text-muted-foreground sm:pr-2" title={row.title}>
                  {row.label}
                </td>
                {TIMEFRAMES.map((tf) => (
                  <td key={tf} className="whitespace-nowrap px-1 py-1 text-right sm:px-1.5">
                    {row.cell(tf)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {r.error && <p className="mt-1 text-[10px] text-amber-500">{r.error}</p>}
    </div>
  );
}

