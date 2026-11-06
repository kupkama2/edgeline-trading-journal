import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Search, Settings2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Segmented } from "@/components/trade-shared";
import { useToast } from "@/hooks/use-toast";
import { ScreenerTable, type Filter } from "@/components/screener/table";
import { SpaghettiChart } from "@/components/screener/chart";
import { CoinDrawer } from "@/components/screener/drawer";
import { fmtPrague, useSaveScreenerSettings, useScreener, useScreenerLines, useScreenerLookup, useScreenerRefresh, useScreenerStatus } from "@/lib/screener";
import { TIMEFRAMES, type ScreenerRow, type Timeframe } from "@shared/screener";

const TF_KEY = "edgeline.screener.tf";

/** The top eight and bottom three by RS change on the timeframe: the chart's default set. */
function defaultSet(rows: ScreenerRow[], tf: Timeframe): string[] {
  const ranked = rows.filter((r) => r.tf[tf].rs != null).sort((a, b) => b.tf[tf].rs! - a.tf[tf].rs!);
  const top = ranked.slice(0, 8).map((r) => r.coin);
  const bottom = ranked.slice(-3).map((r) => r.coin).filter((c) => !top.includes(c));
  return [...top, ...bottom];
}

/**
 * The screener: alts ranked against BTC on six timeframes, the ones
 * moving fast with volume behind them badged, a chart of their relative
 * strength, and a drawer per coin with the way out planned first. Reads
 * the last stored run; a refresh asks the venue again, five minutes apart
 * at most. Never places a trade.
 */
export default function ScreenerPage() {
  const page = useScreener();
  const refresh = useScreenerRefresh();
  const save = useSaveScreenerSettings();
  const { toast } = useToast();
  const [tf, setTf] = useState<Timeframe>(() => {
    try {
      const v = localStorage.getItem(TF_KEY);
      return TIMEFRAMES.includes(v as Timeframe) ? (v as Timeframe) : "4h";
    } catch {
      return "4h";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(TF_KEY, tf);
    } catch {
      /* fine */
    }
  }, [tf]);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  // The chart's set: the default for the timeframe until a row is toggled by hand.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [pickedFor, setPickedFor] = useState<Timeframe>(tf);
  const rows = page.data?.run?.rows ?? [];
  const charted = useMemo(() => {
    if (picked && pickedFor === tf) return picked;
    return new Set(defaultSet(rows, tf));
  }, [picked, pickedFor, rows, tf]);
  const order = useMemo(() => Array.from(charted), [charted]);
  const lines = useScreenerLines(tf, order);
  // Only the coins that have a line, memoized: a new array here would re-feed the chart and reset its zoom on every render.
  const drawn = useMemo(() => order.filter((c) => !!lines.data?.lines[c]), [order, lines.data]);
  const toggle = (coin: string) => {
    const next = new Set(charted);
    if (next.has(coin)) next.delete(coin);
    else next.add(coin);
    setPicked(next);
    setPickedFor(tf);
  };

  // While a run is on, the small status answer is polled for the progress line; the table arrives with the "screener" event.
  const live = useScreenerStatus(!!page.data?.status.running);
  const status = live.data ?? page.data?.status;
  // The refresh button: off while a run is on, and for five minutes after one. The clock ticks only while there is something to count down.
  const [now, setNow] = useState(() => Date.now());
  const nextAt = status?.nextAllowedAt ? new Date(status.nextAllowedAt).getTime() : 0;
  const waitMs = Math.max(0, nextAt - now);
  useEffect(() => {
    if (!nextAt || nextAt <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [nextAt]);
  const canRefresh = !!page.data && !status?.running && waitMs === 0 && !refresh.isPending;
  const onRefresh = async () => {
    try {
      await refresh.mutateAsync();
      toast({ title: "Reading the venue", description: "The table refreshes on its own when the run lands." });
    } catch (err: any) {
      toast({ title: "Not now", description: String(err?.message ?? err).replace(/^\d+:\s*/, "").slice(0, 160), variant: "destructive" });
    }
  };

  const run = page.data?.run ?? null;
  const settings = page.data?.settings;
  // A search that matches no row asks the server why: not listed, under the volume line, or read failed.
  const q = search.trim();
  const matches = useMemo(() => (q ? rows.filter((r) => r.coin.toLowerCase().includes(q.toLowerCase())).length : -1), [rows, q]);
  const lookup = useScreenerLookup(q && matches === 0 && /^[A-Za-z0-9:_-]{1,24}$/.test(q) ? q : null);
  const counts = useMemo(() => {
    const c = { candidates: 0, fast: 0, weakest: 0 };
    for (const r of rows) {
      const f = r.flags[tf];
      if (f.candidate) c.candidates++;
      if (f.movingFast) c.fast++;
      if (f.weakest) c.weakest++;
    }
    return c;
  }, [rows, tf]);

  return (
    <div className="space-y-4" data-testid="page-screener">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Screener</h1>
          <p className="text-[11px] text-muted-foreground" data-testid="screener-asof">
            {run ? (
              <>
                Data as of <span className="font-mono text-foreground">{fmtPrague(run.at)}</span> Prague · bars to {new Date(run.barsTo).toISOString().slice(11, 16)}Z · {run.universe} coins · read in {(run.tookMs / 1000).toFixed(0)}s
                {run.errors ? ` · ${run.errors} could not be read` : ""}
              </>
            ) : page.isLoading ? (
              "Loading…"
            ) : (
              "No run yet. Refresh to read the venue."
            )}
            {status?.running && status.progress && (
              <span className="ml-2 inline-flex items-center gap-1 text-sky-400" data-testid="screener-progress">
                <Loader2 className="h-3 w-3 animate-spin" /> reading {status.progress.done}/{status.progress.total}
              </span>
            )}
            {status?.lastError && !status.running && <span className="ml-2 text-red-400">Last run failed: {status.lastError}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {settings && (
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="ghost" className="h-8 px-2" title="Settings" data-testid="screener-settings">
                  <Settings2 className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 space-y-2 text-xs">
                <p className="font-semibold">Screener settings</p>
                {(
                  [
                    ["minVolume", "Min 24h volume, $", "Coins under this are not read."],
                    ["rvolMin", "RVOL for volume-confirmed", "Last period over the mean of the previous 20."],
                    ["stopLookback", "Stop lookback, candles", "The structure stop is the lowest low of the last N."],
                    ["riskDollars", "Default risk, $", "What the exit planner sizes for."],
                    ["oiJumpMin", "OI jump for leverage-driven", "As a fraction: 0.15 is 15%."],
                  ] as const
                ).map(([k, label, hint]) => (
                  <label key={k} className="block">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
                    <Input
                      defaultValue={String(settings[k])}
                      inputMode="decimal"
                      className="mt-0.5 h-7 text-xs"
                      onBlur={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v) && v !== settings[k]) save.mutate({ [k]: v });
                      }}
                      data-testid={`screener-setting-${k}`}
                    />
                    <span className="text-[10px] text-muted-foreground">{hint}</span>
                  </label>
                ))}
                <p className="text-[10px] text-muted-foreground">The volume line applies on the next run.</p>
              </PopoverContent>
            </Popover>
          )}
          <Button size="sm" variant="outline" className="h-8" disabled={!canRefresh} onClick={onRefresh} data-testid="screener-refresh" title={waitMs ? `Again in ${Math.ceil(waitMs / 1000)}s` : "Read the venue now"}>
            {status?.running || refresh.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
            {status?.running ? "Running" : waitMs ? `Refresh in ${Math.ceil(waitMs / 1000)}s` : "Refresh now"}
          </Button>
        </div>
      </div>

      <Card className="border-card-border bg-card p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented value={tf} onChange={setTf} options={TIMEFRAMES.map((t) => ({ id: t, label: t }))} size="sm" ariaLabel="Timeframe" testId="screener-tf" />
          <label className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Find a coin"
              className="h-7 w-32 pl-7 text-xs"
              aria-label="Find a coin"
              data-testid="screener-search"
            />
          </label>
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ["all", `All (${rows.length})`],
                ["candidates", `Candidates only (${counts.candidates})`],
                ["fast", `Moving fast (${counts.fast})`],
                ["weakest", `Show weakest (${counts.weakest})`],
              ] as [Filter, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setFilter(id)}
                className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${filter === id ? "border-primary/60 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"}`}
                aria-pressed={filter === id}
                data-testid={`screener-filter-${id}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          RS change is the alt-over-BTC ratio's move over the timeframe; the arrow says whether the last period beat the mean of the ones before. <b>Candidate</b> = top 10% and accelerating, RVOL ≥ {settings?.rvolMin ?? 1.5}, not leverage-driven. Click a row for the coin; the dot puts it on the chart.
        </p>
        <div className="mt-2">
          <ScreenerTable rows={rows} tf={tf} filter={filter} search={search} rvolMin={settings?.rvolMin ?? 1.5} charted={charted} onToggleChart={toggle} onOpen={setOpen} />
          {q && matches === 0 && (
            <p className="px-2 pb-2 text-center text-xs" data-testid="screener-lookup">
              {lookup.isLoading ? <span className="text-muted-foreground">Looking it up…</span> : lookup.data ? <span className={lookup.data.where === "not-listed" ? "text-amber-500" : "text-foreground/90"}>{lookup.data.reason}</span> : null}
            </p>
          )}
        </div>
      </Card>

      <Card className="border-card-border bg-card p-3 sm:p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Relative strength vs BTC · {tf}</h2>
          <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setPicked(null)} data-testid="screener-chart-reset">
            Top 8 + bottom 3
          </button>
        </div>
        <div className="mt-2">
          <SpaghettiChart lines={lines.data?.lines ?? {}} order={drawn} loading={lines.isLoading} />
        </div>
      </Card>

      <CoinDrawer coin={open} tf={tf} onTf={setTf} defaultRisk={settings?.riskDollars ?? 250} onClose={() => setOpen(null)} />
    </div>
  );
}
