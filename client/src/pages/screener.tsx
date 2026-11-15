import { ScreenerScanCard } from "@/components/screener/scan";
import { useEffect, useMemo, useState } from "react";
import { Loader2, Pin, RefreshCw, Search, Settings2, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Segmented } from "@/components/trade-shared";
import { useToast } from "@/hooks/use-toast";
import { ScreenerTable, type Filter } from "@/components/screener/table";
import { SpaghettiChart } from "@/components/screener/chart";
import { CoinDrawer } from "@/components/screener/drawer";
import { ScreenerInsights } from "@/components/screener/insights";
import { ScreenerTrackCard } from "@/components/screener/track";
import { ASSET_CLASSES, ASSET_CLASS_LABEL, assetClassOf, sectorOf, type AssetClass } from "@shared/sectors";
import { fmtPct, fmtPrague, usePinScreenerCoin, useSaveScreenerSettings, useScreener, useScreenerLines, useScreenerLookup, useScreenerRefresh, useScreenerStatus } from "@/lib/screener";
import { sectorTable, TIMEFRAMES, type ScreenerRow, type Timeframe } from "@shared/screener";
import { parseLooseNumber } from "@shared/loose-number";

const TF_KEY = "edgeline.screener.tf";
const UNIVERSE_KEY = "edgeline.screener.universe";
type Universe = "all" | AssetClass;

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
/** Five past the next hour: when the server's hourly run starts. */
const nextHourly = (now: number) => {
  const H = 3600_000;
  const off = 5 * 60_000;
  return Math.floor((now - off) / H) * H + off + H;
};

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
  const [sector, setSector] = useState<string | null>(null);
  // Which kind of market is on the page: everything, or crypto, stocks, indices, commodities, companies not yet listed.
  const [universe, setUniverseState] = useState<Universe>(() => {
    try {
      const v = localStorage.getItem(UNIVERSE_KEY);
      return v === "all" || (ASSET_CLASSES as readonly string[]).includes(v ?? "") ? (v as Universe) : "all";
    } catch {
      return "all";
    }
  });
  const setUniverse = (u: Universe) => {
    setUniverseState(u);
    setSector(null);
    setPicked(null);
    try {
      localStorage.setItem(UNIVERSE_KEY, u);
    } catch {
      /* fine */
    }
  };
  const [open, setOpen] = useState<string | null>(null);
  // The chart's set: the default for the timeframe until a row is toggled by hand.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [pickedFor, setPickedFor] = useState<Timeframe>(tf);
  const allRows = page.data?.run?.rows ?? [];
  const classCounts = useMemo(() => {
    const c = {} as Record<AssetClass, number>;
    for (const r of allRows) c[assetClassOf(r.coin)] = (c[assetClassOf(r.coin)] ?? 0) + 1;
    return c;
  }, [allRows]);
  // A kind with nothing in this run shows everything rather than an empty page.
  const shownUniverse: Universe = universe !== "all" && !classCounts[universe] ? "all" : universe;
  const rows = useMemo(() => (shownUniverse === "all" ? allRows : allRows.filter((r) => assetClassOf(r.coin) === shownUniverse)), [allRows, shownUniverse]);
  const charted = useMemo(() => {
    if (picked && pickedFor === tf) return picked;
    return new Set(defaultSet(rows, tf));
  }, [picked, pickedFor, rows, tf]);
  const order = useMemo(() => Array.from(charted), [charted]);
  /*
   * The lines loaded are the default set plus every coin put on the chart
   * since, for this timeframe: hiding or isolating a line only changes what
   * shows, so it neither refetches nor redraws. Only a coin never loaded
   * asks the server, and the lines already up stay while it does.
   */
  const [extra, setExtra] = useState<{ tf: Timeframe; coins: string[] }>({ tf, coins: [] });
  const loaded = useMemo(() => {
    const base = defaultSet(rows, tf);
    const more = extra.tf === tf ? extra.coins : [];
    return Array.from(new Set([...base, ...more, ...order]));
  }, [rows, tf, extra, order]);
  // Remembered against the default set and the extras, not against `loaded` (which already holds the chart's
  // coins, so nothing was ever "missing" and a coin dropped out of the load the moment it was hidden).
  useEffect(() => {
    const base = defaultSet(rows, tf);
    const have = extra.tf === tf ? extra.coins : [];
    const missing = order.filter((c) => !base.includes(c) && !have.includes(c));
    if (missing.length || extra.tf !== tf) setExtra({ tf, coins: [...have, ...missing] });
  }, [order, rows, tf, extra]);
  const lines = useScreenerLines(tf, loaded);
  // What shows, in a stable order; memoized so the chart only hears about real changes.
  const drawn = useMemo(() => order.filter((c) => !!lines.data?.lines[c]), [order, lines.data]);
  const [resetCount, setResetCount] = useState(0);
  const resetChart = () => {
    setPicked(null);
    setResetCount((n) => n + 1);
  };
  // From the set as it is when the update runs: a single click is acted on a beat late (it waits to see whether
  // a second follows), and built from the render's copy it would undo whatever was clicked in between.
  const current = (prev: Set<string> | null) => (prev && pickedFor === tf ? prev : new Set(defaultSet(rows, tf)));
  const toggle = (coin: string) => {
    setPicked((prev) => {
      const next = new Set(current(prev));
      if (next.has(coin)) next.delete(coin);
      else next.add(coin);
      return next;
    });
    setPickedFor(tf);
  };
  // A coin found by the search, put on the chart beside what is there.
  const addToChart = (coin: string) => {
    setPicked((prev) => new Set([...Array.from(current(prev)), coin]));
    setPickedFor(tf);
  };
  const pin = usePinScreenerCoin();
  const onPin = async (coin: string) => {
    try {
      const r = await pin.mutateAsync({ coin, pin: true });
      addToChart(r.coin ?? coin);
      toast({ title: `${r.coin ?? coin} is on the chart`, description: "Pinned: every run reads it from now on, whatever its volume, and it joins the table after the next one." });
    } catch (err: any) {
      toast({ title: "Not added", description: String(err?.message ?? err).replace(/^\d+:\s*/, "").replace(/^\{"message":"|"\}$/g, "").slice(0, 160), variant: "destructive" });
    }
  };
  // Keep only this coin; a second double click on the only coin left brings the default set back.
  const solo = (coin: string) => {
    if (charted.size === 1 && charted.has(coin)) setPicked(null);
    else {
      setPicked(new Set([coin]));
      setPickedFor(tf);
    }
  };

  // While a run is on, the small status answer is polled for the progress line; the table arrives with the "screener" event.
  const live = useScreenerStatus(!!page.data?.status.running);
  // The polled answer only while a run is on: once it stops, the cache holds the last run's cooldown, not this one's.
  const status = page.data?.status.running ? (live.data ?? page.data.status) : page.data?.status;
  // The refresh button: off while a run is on, and for five minutes after one. The clock ticks only while there is something to count down.
  const [now, setNow] = useState(() => Date.now());
  const nextAt = status?.nextAllowedAt ? new Date(status.nextAllowedAt).getTime() : 0;
  const waitMs = Math.max(0, nextAt - now);
  useEffect(() => {
    if (!nextAt || nextAt <= Date.now()) return;
    // Stops itself when the wait is over; it used to tick, and re-render the page, for the life of the tab.
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= nextAt) clearInterval(t);
    }, 1000);
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
  // The groups on this timeframe, strongest first: a strong coin in a strong group is the better read.
  const sectors = useMemo(() => sectorTable(rows, tf, sectorOf), [rows, tf]);
  // Why a coin has no taker flow, when it is the run's doing and not the coin's.
  const spot = run?.spotStatus;
  const flowNote = !run ? null : !spot ? "Taker flow arrives with the next run" : !spot.coins && run.flowStatus?.source !== "relay" ? `Taker flow could not be read this run: ${spot.error ?? "Binance did not answer"}` : null;
  const counts = useMemo(() => {
    const c = { candidates: 0, fast: 0, weakest: 0, diverging: 0 };
    for (const r of rows) {
      const f = r.flags[tf];
      if (f.candidate) c.candidates++;
      if (f.movingFast) c.fast++;
      if (f.weakest) c.weakest++;
      if (r.signals?.[tf]?.divergence) c.diverging++;
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
                Data as of <span className="font-mono text-foreground">{fmtPrague(run.at)}</span> Prague · bars to {new Date(run.barsTo).toISOString().slice(11, 16)}Z · {run.universe} coins · read in {(run.tookMs / 1000).toFixed(0)}s · runs hourly, next {new Date(nextHourly(Date.now())).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                {Date.now() - new Date(run.at).getTime() > 75 * 60_000 && !status?.running && (
                  <span className="ml-1 text-amber-500" data-testid="screener-stale">
                    · over an hour old: refresh, or it updates when the server next runs
                  </span>
                )}
                {run.breadth != null && " "}
                {run.breadth != null && (
                  <span
                    className={`ml-1 ${run.breadth >= 0.6 ? "text-emerald-400" : run.breadth <= 0.35 ? "text-red-400" : "text-foreground/80"}`}
                    title="Breadth: the share of alts whose ratio to BTC is above its own 20-day average. High is a tape where alts lead; low is one where BTC does."
                    data-testid="screener-breadth"
                  >
                    · breadth {(run.breadth * 100).toFixed(0)}%
                  </span>
                )}
                {run.errors ? ` · ${run.errors} could not be read` : ""}
              </>
            ) : page.isLoading ? (
              "Loading…"
            ) : (
              "No run yet. Refresh to read the venue."
            )}
            {status?.running && status.progress && (
              <span className="ml-2 inline-flex items-center gap-1 text-sky-400" data-testid="screener-progress">
                <Loader2 className="h-3 w-3 animate-spin" /> {status.phase ?? "reading"} {status.progress.total ? `${status.progress.done}/${status.progress.total}` : ""}
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
                    ["minVolumeBooks", "Min 24h volume for stocks and the rest, $", "Their own line: these markets are thinner, pre-IPO ones most of all."],
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
                        const raw = e.target.value.trim();
                        // Blank is "leave it": Number("") is 0, which read every listed perp on the next run.
                        if (raw === "") return void (e.target.value = String(settings[k]));
                        const v = parseLooseNumber(raw);
                        if (v == null) {
                          e.target.value = String(settings[k]);
                          return void toast({ title: "Not a number", description: `"${raw}" was not saved.`, variant: "destructive" });
                        }
                        if (v === settings[k]) return;
                        const field = e.target;
                        save.mutate(
                          { [k]: v },
                          {
                            onSuccess: (saved) => {
                              // Out of range, the server keeps what was there: show that, not what was typed.
                              if (saved[k] !== v) {
                                field.value = String(saved[k]);
                                toast({ title: "Out of range", description: `${label} stays at ${saved[k]}.`, variant: "destructive" });
                              }
                            },
                          },
                        );
                      }}
                      data-testid={`screener-setting-${k}`}
                    />
                    <span className="text-[10px] text-muted-foreground">{hint}</span>
                  </label>
                ))}
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={settings.builderBooks}
                    onChange={(e) => save.mutate({ builderBooks: e.target.checked })}
                    data-testid="screener-setting-builderBooks"
                  />
                  <span>
                    Stocks, indices, commodities, pre-IPO
                    <span className="block text-[10px] text-muted-foreground">Hyperliquid's builder markets (xyz:XYZ100 and the like), over their own volume line.</span>
                  </span>
                </label>
                <p className="text-[10px] text-muted-foreground">The volume line and the markets read apply on the next run.</p>
                <div data-testid="screener-pinned">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Pinned coins</span>
                  {settings.pinned.length === 0 ? (
                    <p className="text-[10px] text-muted-foreground">None. Search for a coin under the volume line to add it.</p>
                  ) : (
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {settings.pinned.map((c) => (
                        <span key={c} className="inline-flex items-center gap-0.5 rounded border border-border px-1 py-0.5 font-mono text-[10px]">
                          {c}
                          <button type="button" className="text-muted-foreground hover:text-red-400" onClick={() => pin.mutate({ coin: c, pin: false })} title={`Unpin ${c}: read only while over the volume line`} data-testid={`screener-unpin-${c}`}>
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          )}
          <Button size="sm" variant="outline" className="h-8" disabled={!canRefresh} onClick={onRefresh} data-testid="screener-refresh" title={waitMs ? `Again in ${Math.ceil(waitMs / 1000)}s` : "Read the venue now"}>
            {status?.running || refresh.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
            {status?.running ? "Running" : waitMs ? `Refresh in ${Math.ceil(waitMs / 1000)}s` : "Refresh now"}
          </Button>
        </div>
      </div>

      {Object.keys(classCounts).length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="screener-universe">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground" title="Which markets the chart and the table show. Crypto is ranked against crypto, and the other markets against each other.">
            Universe
          </span>
          {(["all", ...ASSET_CLASSES.filter((c) => classCounts[c])] as Universe[]).map((u) => (
            <button
              key={u}
              type="button"
              onClick={() => setUniverse(u)}
              className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${shownUniverse === u ? "border-primary/60 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"}`}
              aria-pressed={shownUniverse === u}
              data-testid={`screener-universe-${u}`}
            >
              {u === "all" ? "All" : ASSET_CLASS_LABEL[u]} <span className="font-mono text-[10px] text-muted-foreground">{u === "all" ? allRows.length : classCounts[u]}</span>
            </button>
          ))}
        </div>
      )}

      <Card className="border-card-border bg-card p-3 sm:p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Relative strength vs BTC · {tf}{shownUniverse !== "all" ? ` · ${ASSET_CLASS_LABEL[shownUniverse]}` : ""}</h2>
          <Button size="sm" variant="outline" className="h-7 px-2.5 text-[11px]" onClick={resetChart} title="Back to the top 8 and bottom 3, zoomed to fit" data-testid="screener-chart-reset">
            <RefreshCw className="mr-1 h-3 w-3" /> Reset
          </Button>
        </div>
        <div className="mt-2">
          <SpaghettiChart lines={lines.data?.lines ?? {}} order={drawn} colors={loaded} resetKey={resetCount} loading={lines.isLoading} onHide={toggle} onSolo={solo} />
        </div>
      </Card>

      {run && <ScreenerInsights run={run} onOpen={setOpen} />}

      <ScreenerScanCard onOpen={setOpen} />

      <ScreenerTrackCard />

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
                ["diverging", `Diverging (${counts.diverging})`],
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
        {sectors.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="screener-sectors">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground" title={`Each group's median RS change on ${tf} and how many of its coins beat BTC, strongest first. Click one to see only its coins.`}>
              Sectors
            </span>
            {sectors.map((s) => (
              <button
                key={s.sector}
                type="button"
                onClick={() => setSector(sector === s.sector ? null : s.sector)}
                className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${sector === s.sector ? "border-primary/60 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"}`}
                aria-pressed={sector === s.sector}
                title={`${s.sector}: median RS ${fmtPct(s.rs)} on ${tf}, ${Math.round((s.breadth ?? 0) * s.coins)} of ${s.coins} beating BTC, led by ${s.leader} (${fmtPct(s.leaderRs)})`}
                data-testid={`screener-sector-${s.sector}`}
              >
                {s.sector} <span className={`font-mono ${(s.rs ?? 0) > 0 ? "text-emerald-400" : (s.rs ?? 0) < 0 ? "text-red-400" : ""}`}>{fmtPct(s.rs)}</span>
              </button>
            ))}
          </div>
        )}
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          RS change is the alt-over-BTC ratio's move over the timeframe; the arrow says whether the last period beat the mean of the ones before. <b>Candidate</b> = top 10% and accelerating, RVOL ≥ {settings?.rvolMin ?? 1.5}, not leverage-driven. <b>Rtg</b> is the 1–99 rank over 1D, 1W and 1M; <b>Alpha</b> the move with BTC's beta taken out; <b>Hold</b> what it keeps on BTC's red hours. Click a row for the coin. Its name puts it on the chart or takes it off; a double click keeps only it.
        </p>
        <div className="mt-2">
          <ScreenerTable rows={rows} tf={tf} filter={filter} search={search} sector={sector} flowNote={flowNote} rvolMin={settings?.rvolMin ?? 1.5} charted={charted} onToggleChart={toggle} onSolo={solo} onOpen={setOpen} />
          {q && matches === 0 && (
            <p className="px-2 pb-2 text-center text-xs" data-testid="screener-lookup">
              {lookup.isLoading ? <span className="text-muted-foreground">Looking it up…</span> : lookup.data ? <span className={lookup.data.where === "not-listed" ? "text-amber-500" : "text-foreground/90"}>{lookup.data.reason}</span> : null}
              {lookup.data?.coin && (lookup.data.canPin || lookup.data.pinned) && (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-2 h-7 text-[11px]"
                  disabled={pin.isPending || (lookup.data.pinned && charted.has(lookup.data.coin))}
                  onClick={() => (lookup.data!.pinned ? addToChart(lookup.data!.coin!) : void onPin(lookup.data!.coin!))}
                  data-testid="screener-pin"
                >
                  {pin.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Pin className="mr-1 h-3 w-3" />}
                  {lookup.data.pinned && charted.has(lookup.data.coin) ? `${lookup.data.coin} is on the chart` : `Add ${lookup.data.coin} to the chart`}
                </Button>
              )}
            </p>
          )}
        </div>
      </Card>

      <CoinDrawer coin={open} tf={tf} onTf={setTf} defaultRisk={settings?.riskDollars ?? 250} onClose={() => setOpen(null)} />
    </div>
  );
}
