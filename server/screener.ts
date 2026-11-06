/**
 * The relative-strength screener's run: the universe off Hyperliquid, two
 * series per coin, the arithmetic in shared/screener.ts, and the result in
 * the database for the page to read.
 *
 * Budget. Hyperliquid's REST limit is an aggregated weight of 1200 a minute
 * per IP; a candle request costs 20 plus one per 60 candles, every other
 * info request 20 (per the venue's docs, read through search since the
 * docs host is unreachable from the build sandbox). The run spends at most
 * WEIGHT_PER_MIN of the 1200, leaving the tracker's own reads on the same
 * IP their room. A 429 waits a minute and tries once more. One coin
 * failing is one row with an error on it; the run goes on.
 *
 * Cost per coin. The first time, two requests: thirty days of hourly bars
 * and 640 of daily (near 60 weight). After that, one small request: the
 * hourly bars since the stored series' last one (21 weight), merged into
 * the store; the daily series is the stored completed days plus the days
 * the hours cover, so it is not asked for again until the store has a gap
 * the hours cannot bridge. Bars still forming are left out of the
 * arithmetic, so every coin is measured at the same instant — the last
 * completed hour — whatever minute of the run it was fetched in; today's
 * daily bar is built from those hours.
 *
 * Schedule. 08:00 and 13:30 Europe/Prague, kept by an in-process clock, and
 * a catch-up at boot when the last slot was missed (a free Render service
 * sleeps; it wakes for the first visit and runs then). A cron outside —
 * Render's, or any pinger — can call POST /api/screener/cron with the
 * token instead. Manual refresh keeps a five-minute cooldown; a failed run
 * counts for it too, which is the back-off.
 */
import { hlInfo, HlHttpError } from "./hyperliquid";
import { screenerStore } from "./storage";
import { notifyAll } from "./events";
import { readBinanceFlow, readLiqMap, type FlowStatus, type LiqStatus } from "./flow";
import { findAnomalies, type Anomaly } from "@shared/flow";
import {
  annualizeFunding,
  basketSeries,
  breadthOf,
  coinMetrics,
  emptyPrice,
  emptySignals,
  oiRead,
  priceReadings,
  ratioSeries,
  rsiExtremes,
  tfMetrics,
  TF_SPEC,
  TIMEFRAMES,
  type Positioning,
  type Timeframe,
  completeBars,
  DAY_MS,
  deriveDaily,
  emptyFlags,
  emptyMetrics,
  flagRows,
  HOUR_MS,
  mergeBars,
  NOT_AN_ALT,
  parseScreenerCandles,
  readScreenerSettings,
  type ScreenerCandle,
  type ScreenerRow,
  type ScreenerSettings,
} from "@shared/screener";

const HOURLY_DAYS = 30;
/** Enough daily bars for twenty 30-day blocks and the one being measured. */
const DAILY_DAYS = 640;
const KEEP_DAYS = 60;
export const COOLDOWN_MS = 5 * 60_000;
const WEIGHT_PER_MIN = Number(process.env.SCREENER_WEIGHT_PER_MIN ?? "900");
const RETRY_AFTER_429_MS = Number(process.env.SCREENER_RETRY_MS ?? "60000");

export type Series = { "1h": ScreenerCandle[]; "1d": ScreenerCandle[] };

export interface ScreenerRun {
  id: number;
  at: string;
  /** The last completed hour the bars run to: the instant every coin was measured at. */
  barsTo: number;
  tookMs: number;
  errors: number;
  universe: number;
  /** How many coins needed the full two-request read rather than the small incremental one. */
  fullReads: number;
  /** The share of alts whose BTC ratio is above its 20-day average: the breadth of the tape. */
  breadth: number | null;
  /** BTC itself over a day and a week, for the regime. */
  btc: { d1: number | null; w1: number | null };
  /** How the Binance flow pass and the liquidation map went. */
  flowStatus: FlowStatus | null;
  liqStatus: LiqStatus | null;
  /** What stands out across the universe, worst first. */
  anomalies: Anomaly[];
  settings: ScreenerSettings;
  rows: ScreenerRow[];
}

export interface ScreenerStatus {
  running: boolean;
  startedAt: string | null;
  /** Coins done so far in the run that is on, for the progress line, and which pass it is in. */
  progress: { done: number; total: number } | null;
  phase: string | null;
  lastError: string | null;
  /** When a manual refresh may next be asked for. */
  nextAllowedAt: string | null;
}

/* ------------------------------- the asset contexts ------------------------------- */

export interface AssetCtx {
  coin: string;
  funding: number | null;
  openInterest: number | null;
  dayNtlVlm: number | null;
  markPx: number | null;
  oraclePx: number | null;
  delisted: boolean;
}

/** Read `metaAndAssetCtxs`: `[{ universe: [{ name, szDecimals, isDelisted? }] }, [{ funding, openInterest, dayNtlVlm, markPx, ... }]]`, aligned by index. */
export function parseMetaAndAssetCtxs(json: unknown): AssetCtx[] {
  if (!Array.isArray(json) || json.length < 2) return [];
  const universe = Array.isArray((json[0] as any)?.universe) ? ((json[0] as any).universe as any[]) : [];
  const ctxs = Array.isArray(json[1]) ? (json[1] as any[]) : [];
  const n = (v: unknown) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  const out: AssetCtx[] = [];
  universe.forEach((u, i) => {
    const c = ctxs[i] ?? {};
    if (typeof u?.name !== "string") return;
    out.push({ coin: u.name, funding: n(c.funding), openInterest: n(c.openInterest), dayNtlVlm: n(c.dayNtlVlm), markPx: n(c.markPx), oraclePx: n(c.oraclePx), delisted: u.isDelisted === true });
  });
  return out;
}

/* ------------------------------- the budget ------------------------------- */

/** A weight budget over a sliding minute: a request waits until its weight fits. */
class Budget {
  private spent: { at: number; w: number }[] = [];
  constructor(private perMinute: number) {}
  async take(weight: number): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.spent = this.spent.filter((s) => now - s.at < 60_000);
      const used = this.spent.reduce((s, x) => s + x.w, 0);
      if (used + weight <= this.perMinute || this.spent.length === 0) {
        this.spent.push({ at: now, w: weight });
        return;
      }
      const oldest = this.spent[0].at;
      await sleep(Math.max(50, oldest + 60_000 - now + 10));
    }
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const candleWeight = (bars: number) => 20 + Math.ceil(Math.max(1, bars) / 60);

/** One info request under the budget, with one retry after a rate limit. */
async function ask(budget: Budget, weight: number, body: Record<string, unknown>): Promise<unknown> {
  await budget.take(weight);
  try {
    return await hlInfo(body, 20_000, { lane: "background" });
  } catch (err) {
    if (err instanceof HlHttpError && err.status === 429) {
      await sleep(RETRY_AFTER_429_MS);
      await budget.take(weight);
      return await hlInfo(body, 20_000, { lane: "background" });
    }
    throw err;
  }
}

async function candles(budget: Budget, coin: string, interval: "1h" | "1d", startTime: number, endTime: number): Promise<ScreenerCandle[]> {
  const bars = Math.ceil((endTime - startTime) / (interval === "1h" ? HOUR_MS : DAY_MS)) + 1;
  return parseScreenerCandles(await ask(budget, candleWeight(bars), { type: "candleSnapshot", req: { coin, interval, startTime: Math.floor(startTime), endTime: Math.floor(endTime) } }));
}

/**
 * Both series for a coin, as cheaply as the store allows: the hours since
 * the stored series' last bar (that bar read again, since it was still
 * forming), the days derived from the stored days and the hours, and the
 * full two-request read only when there is nothing to build on.
 */
async function fetchSeries(budget: Budget, coin: string, now: number, stored: Series | null): Promise<{ series: Series; full: boolean }> {
  const hourFrom = now - HOURLY_DAYS * DAY_MS;
  const lastStored = stored?.["1h"][stored["1h"].length - 1]?.t ?? null;
  let hourly: ScreenerCandle[];
  let full = false;
  if (stored && lastStored != null && lastStored >= hourFrom && stored["1h"].length >= 24) {
    const fresh = await candles(budget, coin, "1h", lastStored, now);
    hourly = mergeBars(stored["1h"], fresh, hourFrom);
  } else {
    hourly = await candles(budget, coin, "1h", hourFrom, now);
    full = true;
  }
  const dayFrom = now - DAILY_DAYS * DAY_MS;
  let daily = stored ? deriveDaily(stored["1d"], hourly, dayFrom) : null;
  if (!daily) {
    daily = await candles(budget, coin, "1d", dayFrom, now);
    full = true;
  }
  return { series: { "1h": hourly, "1d": daily }, full };
}

/* ------------------------------- the cache ------------------------------- */

/**
 * The process that writes the series is the one that serves them: the
 * latest run and every coin's series stay in memory, loaded from the
 * database once after boot and replaced as a run writes them.
 */
let latest: ScreenerRun | null | undefined;
const seriesCache = new Map<string, Series>();

const parseSeries = (s: string | null): ScreenerCandle[] => {
  try {
    return s ? (JSON.parse(s) as ScreenerCandle[]) : [];
  } catch {
    return [];
  }
};

/** A coin's stored series; empty arrays when the coin was never fetched. */
export async function storedSeries(coin: string): Promise<Series> {
  const hit = seriesCache.get(coin);
  if (hit) return hit;
  const [h, d] = await Promise.all([screenerStore.series(coin, "1h"), screenerStore.series(coin, "1d")]);
  const s: Series = { "1h": parseSeries(h), "1d": parseSeries(d) };
  if (s["1h"].length || s["1d"].length) seriesCache.set(coin, s);
  return s;
}

/** The latest stored run, parsed; null before the first. */
export async function latestScreenerRun(): Promise<ScreenerRun | null> {
  if (latest !== undefined) return latest;
  const r = await screenerStore.latestRun();
  if (!r) return (latest = null);
  let body: any = {};
  try {
    body = JSON.parse(r.body);
  } catch {
    body = {};
  }
  const rows: ScreenerRow[] = (Array.isArray(body) ? body : Array.isArray(body.rows) ? body.rows : []).map((r: any) => ({
    ...r,
    price: r.price ?? emptyPrice(),
    signals: r.signals ?? emptySignals(),
    positioning: r.positioning ?? null,
  }));
  latest = {
    id: r.id,
    at: r.at,
    barsTo: Number(body.barsTo) || new Date(r.at).getTime(),
    tookMs: r.tookMs,
    errors: r.errors,
    universe: r.universe,
    fullReads: Number(body.fullReads) || 0,
    breadth: typeof body.breadth === "number" ? body.breadth : null,
    btc: body.btc ?? { d1: null, w1: null },
    flowStatus: body.flowStatus ?? null,
    liqStatus: body.liqStatus ?? null,
    anomalies: Array.isArray(body.anomalies) ? body.anomalies : [],
    settings: readScreenerSettings(r.settings ? JSON.parse(r.settings) : null),
    rows,
  };
  return latest;
}

/* ------------------------------- the run ------------------------------- */

const status: ScreenerStatus = { running: false, startedAt: null, progress: null, phase: null, lastError: null, nextAllowedAt: null };
let lastRunAt = 0;
let current: Promise<ScreenerRun> | null = null;

/** The run time the cooldown counts from: the one in memory, or the stored run's after a restart. */
function cooldownFrom(storedAt?: string | null): number {
  const stored = storedAt ? new Date(storedAt).getTime() : 0;
  return Math.max(lastRunAt, Number.isFinite(stored) ? stored : 0);
}

export const screenerStatus = (storedAt?: string | null): ScreenerStatus => {
  const from = cooldownFrom(storedAt ?? latest?.at);
  return { ...status, nextAllowedAt: from ? new Date(from + COOLDOWN_MS).toISOString() : null };
};

/** Whether a manual refresh may start now, and when it may if not. */
export function refreshAllowed(storedAt?: string | null, now = Date.now()): { ok: boolean; retryAt: string | null } {
  if (current) return { ok: false, retryAt: null };
  const from = cooldownFrom(storedAt ?? latest?.at);
  if (from && now - from < COOLDOWN_MS) return { ok: false, retryAt: new Date(from + COOLDOWN_MS).toISOString() };
  return { ok: true, retryAt: null };
}

export async function screenerSettings(): Promise<ScreenerSettings> {
  return readScreenerSettings(await screenerStore.settings());
}

/** A patch over the settings; a value out of range keeps what was there. */
export async function saveScreenerSettings(patch: unknown): Promise<ScreenerSettings> {
  const before = await screenerSettings();
  const p = (patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>;
  const next = readScreenerSettings({ ...before, ...p });
  for (const k of Object.keys(next) as (keyof ScreenerSettings)[]) {
    // readScreenerSettings fell back to the default: an invalid value given, so the old one stays.
    if (k in p && next[k] !== Number(p[k])) next[k] = before[k];
  }
  await screenerStore.saveSettings(next);
  return next;
}

/**
 * A run, one at a time. A second call while one is on gets the same
 * promise; a call inside the cooldown is refused unless `force`.
 */
export function runScreener(opts: { force?: boolean; now?: () => number; ai?: boolean } = {}): Promise<ScreenerRun> {
  if (current) return current;
  const nowFn = opts.now ?? Date.now;
  if (!opts.force && lastRunAt && nowFn() - lastRunAt < COOLDOWN_MS) {
    return Promise.reject(Object.assign(new Error("Refreshed less than five minutes ago."), { status: 429, retryAt: new Date(lastRunAt + COOLDOWN_MS).toISOString() }));
  }
  current = run(nowFn, !!opts.ai).finally(() => {
    current = null;
  });
  return current;
}

async function run(nowFn: () => number, ai = false): Promise<ScreenerRun> {
  const t0 = nowFn();
  const now = t0;
  // The instant every coin is measured at: the last completed hour.
  const barsTo = Math.floor(now / HOUR_MS) * HOUR_MS;
  lastRunAt = t0;
  status.running = true;
  status.startedAt = new Date(t0).toISOString();
  status.progress = null;
  status.lastError = null;
  const at = new Date(t0).toISOString();
  try {
    const settings = await screenerSettings();
    const budget = new Budget(WEIGHT_PER_MIN);
    const ctxs = parseMetaAndAssetCtxs(await ask(budget, 20, { type: "metaAndAssetCtxs" }));
    if (ctxs.length === 0) throw new Error("metaAndAssetCtxs answered with no universe");
    const alts = ctxs.filter((c) => !c.delisted && !NOT_AN_ALT.test(c.coin) && (c.dayNtlVlm ?? 0) >= settings.minVolume);
    status.progress = { done: 0, total: alts.length + 1 };
    status.phase = "Hyperliquid candles";
    const previous = await screenerStore.previousSnapshot(at);

    let fullReads = 0;
    const read = async (coin: string): Promise<Series> => {
      const { series, full } = await fetchSeries(budget, coin, now, await storedSeries(coin));
      if (full) fullReads++;
      seriesCache.set(coin, series);
      await screenerStore.saveSeries(coin, series["1h"], series["1d"]);
      return series;
    };
    const btcRaw = await read("BTC");
    if (btcRaw["1h"].length === 0 || btcRaw["1d"].length === 0) throw new Error("BTC candles came back empty; nothing to measure against");
    const btc = measuredSeries(btcRaw, now);
    // The daily series' last bar is today's, built from the completed hours: how much of the day that is.
    const dayPartial = Math.max(1 / 24, ((barsTo - Math.floor(barsTo / DAY_MS) * DAY_MS) / DAY_MS) || 1);
    status.progress.done = 1;

    // Positioning: the hourly snapshots an hour, four hours and a day back (Stage B keeps one an hour).
    const ago = (ms: number) => new Date(t0 - ms).toISOString();
    const [snap1h, snap4h, snap1d] = await Promise.all([
      screenerStore.snapshotNear(ago(HOUR_MS), ago(2.5 * HOUR_MS)),
      screenerStore.snapshotNear(ago(4 * HOUR_MS), ago(6 * HOUR_MS)),
      screenerStore.snapshotNear(ago(DAY_MS), ago(DAY_MS + 6 * HOUR_MS)),
    ]);

    // Every coin's series first, so the alt basket and ETH are in hand before anything is measured against them.
    const measured = new Map<string, Series>();
    const failed = new Map<string, string>();
    for (const c of alts) {
      try {
        measured.set(c.coin, measuredSeries(await read(c.coin), now));
      } catch (err: any) {
        const msg = String(err?.message ?? err).slice(0, 200);
        failed.set(c.coin, msg);
        console.error(`[screener] ${c.coin}: ${msg}`);
      }
      status.progress.done++;
    }
    const weightOf = new Map(alts.map((c) => [c.coin, c.dayNtlVlm ?? 0]));
    const basket: Series = { "1h": [], "1d": [] };
    for (const base of ["1h", "1d"] as const) {
      basket[base] = basketSeries(Array.from(measured, ([coin, s]) => ({ candles: s[base], weight: weightOf.get(coin) ?? 0 })));
    }
    const eth = measured.get("ETH") ?? null;
    const breadth = breadthOf(Array.from(measured.values()).map((s) => ratioSeries(s["1d"], btc["1d"])));

    const rows: ScreenerRow[] = [];
    for (const c of alts) {
      const pos = (snap: Map<string, { openInterest: number | null; mark: number | null }>) => {
        const was = snap.get(c.coin);
        return { oi: oiChange(c.openInterest, was?.openInterest ?? null), px: c.markPx != null && was?.mark ? c.markPx / was.mark - 1 : null };
      };
      const d1 = pos(snap1d);
      const positioning: Positioning = {
        oi1h: pos(snap1h).oi,
        oi4h: pos(snap4h).oi,
        oi1d: d1.oi,
        px1d: d1.px,
        read: oiRead(d1.px, d1.oi),
        premium: c.markPx != null && c.oraclePx ? c.markPx / c.oraclePx - 1 : null,
        fundingPct: null,
      };
      const base: ScreenerRow = {
        coin: c.coin,
        mark: c.markPx,
        volume24h: c.dayNtlVlm,
        fundingHourly: c.funding,
        fundingAnnual: c.funding != null ? annualizeFunding(c.funding) : null,
        openInterest: c.openInterest,
        oiChange: oiChange(c.openInterest, previous.get(c.coin)?.openInterest ?? null),
        leverageDriven: false,
        tf: emptyMetrics(),
        flags: emptyFlags(),
        price: emptyPrice(),
        signals: emptySignals(),
        positioning,
        error: failed.get(c.coin) ?? null,
        bars: { "1h": 0, "1d": 0 },
      };
      const alt = measured.get(c.coin);
      if (alt) {
        base.bars = { "1h": alt["1h"].length, "1d": alt["1d"].length };
        base.tf = coinMetrics(alt, btc, dayPartial);
        const peaks = {} as Record<Timeframe, number | null>;
        const troughs = {} as Record<Timeframe, number | null>;
        for (const tf of TIMEFRAMES) {
          const b = TF_SPEC[tf].base;
          const vsEth = eth && c.coin !== "ETH" ? tfMetrics(ratioSeries(alt[b], eth[b]), tf).rs : null;
          const vsBasket = basket[b].length ? tfMetrics(ratioSeries(alt[b], basket[b]), tf).rs : null;
          base.price[tf] = priceReadings(alt[b], tf, vsEth, vsBasket);
          const ex = rsiExtremes(alt[b], tf);
          peaks[tf] = ex.peak;
          troughs[tf] = ex.trough;
        }
        base.rsiPeak = peaks;
        base.rsiTrough = troughs;
      }
      rows.push(base);
    }
    // Binance's flow through the relay, then Hyperliquid's liquidation map. Each pass's failure is its own.
    const readable = rows.filter((r) => !r.error).map((r) => ({ coin: r.coin, mark: r.mark, fundingHourly: r.fundingHourly }));
    status.phase = "Binance flow";
    status.progress = { done: 0, total: readable.length };
    const flowPass = await readBinanceFlow(readable, (done, total) => (status.progress = { done, total })).catch((err) => ({ status: { source: "none", account: null, outdated: false, coins: 0, failed: 0, error: String(err?.message ?? err) } as FlowStatus, byCoin: new Map() }));
    status.phase = "Liquidation map";
    status.progress = { done: 0, total: 0 };
    const liqPass = await readLiqMap(readable, (done, total) => (status.progress = { done, total })).catch((err) => ({ status: { accounts: 0, failed: 0, error: String(err?.message ?? err) } as LiqStatus, byCoin: new Map() }));
    for (const r of rows) {
      r.flow = flowPass.byCoin.get(r.coin) ?? null;
      r.liq = liqPass.byCoin.get(r.coin) ?? null;
    }
    const flagged = flagRows(rows, settings);
    const anomalies = findAnomalies(flagged.map((r) => ({ coin: r.coin, oi24hHl: r.positioning?.oi1d ?? null, px24h: r.positioning?.px1d ?? null, flow: r.flow ?? null, liq: r.liq ?? null, divergence: r.signals["1D"]?.divergence ?? null })));
    const btcD = btc["1d"];
    const btcMove = { d1: btcD.length > 1 ? btcD[btcD.length - 1].c / btcD[btcD.length - 2].c - 1 : null, w1: btcD.length > 7 ? btcD[btcD.length - 1].c / btcD[btcD.length - 8].c - 1 : null };
    const tookMs = nowFn() - t0;
    const errors = flagged.filter((r) => r.error).length;
    const id = await screenerStore.saveRun({ at, tookMs, body: JSON.stringify({ barsTo, fullReads, breadth, btc: btcMove, flowStatus: flowPass.status, liqStatus: liqPass.status, anomalies, rows: flagged }), errors, universe: flagged.length, settings: JSON.stringify(settings) });
    // The whole snapshot is kept — every perp, filtered or not — so OI history exists before a coin crosses the volume line. After the run, so a failed one leaves none.
    await screenerStore.saveSnapshot(
      at,
      ctxs.map((c) => ({ coin: c.coin, funding: c.funding, openInterest: c.openInterest, volume: c.dayNtlVlm, mark: c.markPx, oracle: c.oraclePx })),
    );
    await screenerStore.prune(new Date(t0 - KEEP_DAYS * DAY_MS).toISOString()).catch(() => {});
    console.log(`[screener] ${flagged.length} coins in ${(tookMs / 1000).toFixed(1)}s, ${fullReads} full reads, ${errors} could not be read, ${ctxs.length} perps listed`);
    latest = { id, at, barsTo, tookMs, errors, universe: flagged.length, fullReads, breadth, btc: btcMove, flowStatus: flowPass.status, liqStatus: liqPass.status, anomalies, settings, rows: flagged };
    notifyAll("screener");
    // The AI read, after the scheduled runs only; it is slow and costs, so it never holds the run up.
    if (ai) {
      const done = latest;
      void import("./screener-ai").then((m) => m.analyzeRun(done)).catch((err) => console.error(`[screener-ai] ${String(err?.message ?? err)}`));
    }
    return latest;
  } catch (err: any) {
    status.lastError = String(err?.message ?? err).slice(0, 300);
    console.error(`[screener] run failed: ${status.lastError}`);
    throw err;
  } finally {
    status.running = false;
    status.progress = null;
    status.phase = null;
  }
}

/**
 * A coin's series as measured: the completed hours only (the bar still
 * forming is left out, so every coin is read at the same instant), and
 * the days as the stored completed days plus the days those hours make —
 * today's bar ending on the same hour for every coin. The routes use the
 * same view with the run's `barsTo`, so the drawer's numbers are the
 * table's.
 */
export function measuredSeries(s: Series, now: number): Series {
  return { "1h": completeBars(s["1h"], HOUR_MS, now), "1d": dailyTo(s, now) };
}

function dailyTo(s: Series, now: number): ScreenerCandle[] {
  const hours = completeBars(s["1h"], HOUR_MS, now);
  const derived = deriveDaily(s["1d"], hours, -Infinity);
  if (derived) return derived;
  // No bridge from the store: the venue's days, the one still forming replaced by the hours' version.
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const done = s["1d"].filter((d) => d.t < today);
  const todays = hours.filter((h) => h.t >= today);
  if (todays.length === 0) return done;
  const [t] = deriveDailyTail(todays);
  return [...done, t];
}
const deriveDailyTail = (hours: ScreenerCandle[]): ScreenerCandle[] => {
  const t = Math.floor(hours[0].t / DAY_MS) * DAY_MS;
  return [{ t, o: hours[0].o, h: Math.max(...hours.map((x) => x.h)), l: Math.min(...hours.map((x) => x.l)), c: hours[hours.length - 1].c, v: hours.reduce((s, x) => s + x.v, 0) }];
};

const oiChange = (now: number | null, before: number | null) => (now != null && before != null && before > 0 ? now / before - 1 : null);

/* ------------------------------- the hourly snapshot ------------------------------- */

/**
 * Open interest, funding, mark and oracle for every perp, once an hour:
 * one request (20 of the venue's 1200 weight a minute). Hyperliquid keeps
 * no OI history, so these rows are the history the positioning read is
 * made from. Skipped when a snapshot under 50 minutes old exists, so a run
 * and the hourly tick do not both write one.
 */
export async function takeSnapshot(nowFn: () => number = Date.now): Promise<{ at: string; perps: number } | null> {
  const last = await screenerStore.latestSnapshotAt();
  const now = nowFn();
  if (last && now - new Date(last).getTime() < 50 * 60_000) return null;
  const ctxs = parseMetaAndAssetCtxs(await hlInfo({ type: "metaAndAssetCtxs" }, 20_000, { lane: "background" }));
  if (ctxs.length === 0) return null;
  const at = new Date(now).toISOString();
  await screenerStore.saveSnapshot(
    at,
    ctxs.map((c) => ({ coin: c.coin, funding: c.funding, openInterest: c.openInterest, volume: c.dayNtlVlm, mark: c.markPx, oracle: c.oraclePx })),
  );
  return { at, perps: ctxs.length };
}

/* ------------------------------- the clock ------------------------------- */

/** The run times, Europe/Prague, as "HH:MM". */
export const SCHEDULE = ["08:00", "13:30"];
const TZ = "Europe/Prague";

/** The Prague wall clock for an instant: the day as YYYY-MM-DD and the minutes since its midnight. */
export function pragueClock(ms: number): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")) };
}

/** The calendar day before a YYYY-MM-DD, by the calendar rather than by 24 hours, so a clock change does not skip a day. */
const dayBefore = (day: string): string => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - DAY_MS).toISOString().slice(0, 10);
};

const slotMinutes = SCHEDULE.map((s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5)));

/**
 * Whether a run is due: a slot has passed today, or yesterday after the
 * last run, with no run since it. Pure, so the clock can be tested.
 */
export function runDue(now: number, lastRunIso: string | null): boolean {
  const { day, minutes } = pragueClock(now);
  const last = lastRunIso ? pragueClock(new Date(lastRunIso).getTime()) : null;
  const passedToday = slotMinutes.filter((m) => m <= minutes);
  if (passedToday.length) {
    const latestSlot = Math.max(...passedToday);
    if (!last || last.day < day || (last.day === day && last.minutes < latestSlot)) return true;
    return false;
  }
  // Before the first slot of the day: the last slot of yesterday is the one to have run.
  const lastSlot = Math.max(...slotMinutes);
  const yesterday = dayBefore(day);
  if (!last) return true;
  if (last.day < yesterday) return true;
  if (last.day === yesterday && last.minutes < lastSlot) return true;
  return false;
}

async function ownerPortfolioTick(): Promise<void> {
  const { accounts, portfolioStore } = await import("./storage");
  const owner = await accounts.owner();
  if (!owner) return;
  const last = await portfolioStore.lastSnapshotAt(owner.id);
  if (last && Date.now() - new Date(last).getTime() < 60 * 60_000) return;
  const { readPortfolio } = await import("./portfolio");
  await readPortfolio(owner.id, { fresh: true });
}

/** The clock: a minute's tick, a run when one is due. `SCREENER_CLOCK_MS=0` is off (tests). */
export function startScreenerClock(everyMs = Number(process.env.SCREENER_CLOCK_MS ?? "60000")): void {
  if (!(everyMs > 0)) return;
  const tick = async () => {
    // The hourly snapshot, whatever the run schedule says; its own failure is its own.
    if (!status.running) await takeSnapshot().catch((err) => console.error(`[screener] snapshot: ${String(err?.message ?? err)}`));
    // The macro and earnings calendar, downloaded once a day.
    await import("./calendar").then((m) => m.calendarTick()).catch((err) => console.error(`[calendar] ${String(err?.message ?? err)}`));
    // The owner's portfolio value, an hour at most apart, so its chart fills in with the page closed.
    await ownerPortfolioTick().catch((err) => console.error(`[portfolio] ${String(err?.message ?? err)}`));
    try {
      if (status.running) return;
      // A run that failed is not tried again every minute: the cooldown is the back-off.
      if (lastRunAt && Date.now() - lastRunAt < COOLDOWN_MS) return;
      const last = await latestScreenerRun();
      if (runDue(Date.now(), last?.at ?? null)) await runScreener({ force: true, ai: true });
    } catch (err: any) {
      console.error(`[screener] clock: ${String(err?.message ?? err)}`);
    }
  };
  // The catch-up: a service that slept through a slot runs once it is up.
  setTimeout(() => void tick(), 15_000).unref?.();
  setInterval(() => void tick(), everyMs).unref?.();
}
