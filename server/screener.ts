/**
 * The relative-strength screener's run: the universe off Hyperliquid, two
 * series per coin, the arithmetic in shared/screener.ts, and the result in
 * the database for the page to read.
 *
 * Budget. Hyperliquid's REST limit is an aggregated weight of 1200 a minute
 * per IP; a candle request costs 20 plus one per 60 candles, every other
 * info request 20 (per the venue's docs, read through search since the
 * docs host is unreachable from the build sandbox). A coin is two requests
 * — about 30 days of hourly bars and 400 of daily — near 60 weight; the
 * run spends at most WEIGHT_PER_MIN of the 1200 so the tracker's own
 * reads on the same IP never queue behind it. A 429 waits a minute and
 * tries once more. One coin failing is one row with an error on it; the
 * run goes on.
 *
 * Schedule. 08:00 and 13:30 Europe/Prague, kept by an in-process clock, and
 * a catch-up at boot when the last slot was missed (a free Render service
 * sleeps; it wakes for the first visit and runs then). A cron outside —
 * Render's, or any pinger — can call POST /api/screener/cron with the
 * token instead. Manual refresh keeps a five-minute cooldown.
 */
import { hlInfo, HlHttpError } from "./hyperliquid";
import { screenerStore } from "./storage";
import { notifyAll } from "./events";
import {
  annualizeFunding,
  coinMetrics,
  emptyFlags,
  emptyMetrics,
  flagRows,
  NOT_AN_ALT,
  parseScreenerCandles,
  readScreenerSettings,
  type ScreenerCandle,
  type ScreenerRow,
  type ScreenerSettings,
} from "@shared/screener";

const HOUR = 3600_000;
const DAY = 86400_000;
const HOURLY_DAYS = 30;
const DAILY_DAYS = 400;
const KEEP_DAYS = 60;
export const COOLDOWN_MS = 5 * 60_000;
const WEIGHT_PER_MIN = Number(process.env.SCREENER_WEIGHT_PER_MIN ?? "700");
const RETRY_AFTER_429_MS = Number(process.env.SCREENER_RETRY_MS ?? "60000");

export interface ScreenerRun {
  id: number;
  at: string;
  tookMs: number;
  errors: number;
  universe: number;
  settings: ScreenerSettings;
  rows: ScreenerRow[];
}

export interface ScreenerStatus {
  running: boolean;
  startedAt: string | null;
  /** Coins done so far in the run that is on, for the progress line. */
  progress: { done: number; total: number } | null;
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
    out.push({ coin: u.name, funding: n(c.funding), openInterest: n(c.openInterest), dayNtlVlm: n(c.dayNtlVlm), markPx: n(c.markPx), delisted: u.isDelisted === true });
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
const candleWeight = (bars: number) => 20 + Math.ceil(bars / 60);

/** One info request under the budget, with one retry after a rate limit. */
async function ask(budget: Budget, weight: number, body: Record<string, unknown>): Promise<unknown> {
  await budget.take(weight);
  try {
    return await hlInfo(body, 20_000);
  } catch (err) {
    if (err instanceof HlHttpError && err.status === 429) {
      await sleep(RETRY_AFTER_429_MS);
      await budget.take(weight);
      return await hlInfo(body, 20_000);
    }
    throw err;
  }
}

/** Both series for a coin, the budget charged for what each should return. */
async function fetchSeries(budget: Budget, coin: string, now: number): Promise<{ "1h": ScreenerCandle[]; "1d": ScreenerCandle[] }> {
  const hourly = parseScreenerCandles(
    await ask(budget, candleWeight(HOURLY_DAYS * 24), { type: "candleSnapshot", req: { coin, interval: "1h", startTime: now - HOURLY_DAYS * DAY, endTime: now } }),
  );
  const daily = parseScreenerCandles(
    await ask(budget, candleWeight(DAILY_DAYS), { type: "candleSnapshot", req: { coin, interval: "1d", startTime: now - DAILY_DAYS * DAY, endTime: now } }),
  );
  return { "1h": hourly, "1d": daily };
}

/* ------------------------------- the run ------------------------------- */

const status: ScreenerStatus = { running: false, startedAt: null, progress: null, lastError: null, nextAllowedAt: null };
let lastRunAt = 0;
let current: Promise<ScreenerRun> | null = null;

/** The run time the cooldown counts from: the one in memory, or the stored run's after a restart. */
function cooldownFrom(storedAt?: string | null): number {
  const stored = storedAt ? new Date(storedAt).getTime() : 0;
  return Math.max(lastRunAt, Number.isFinite(stored) ? stored : 0);
}

export const screenerStatus = (storedAt?: string | null): ScreenerStatus => {
  const from = cooldownFrom(storedAt);
  return { ...status, nextAllowedAt: from ? new Date(from + COOLDOWN_MS).toISOString() : null };
};

export async function screenerSettings(): Promise<ScreenerSettings> {
  return readScreenerSettings(await screenerStore.settings());
}

export async function saveScreenerSettings(patch: unknown): Promise<ScreenerSettings> {
  const next = readScreenerSettings({ ...(await screenerSettings()), ...((patch && typeof patch === "object" ? patch : {}) as object) });
  await screenerStore.saveSettings(next);
  return next;
}

/** Whether a manual refresh may start now, and when it may if not. */
export function refreshAllowed(storedAt?: string | null, now = Date.now()): { ok: boolean; retryAt: string | null } {
  if (current) return { ok: false, retryAt: null };
  const from = cooldownFrom(storedAt);
  if (from && now - from < COOLDOWN_MS) return { ok: false, retryAt: new Date(from + COOLDOWN_MS).toISOString() };
  return { ok: true, retryAt: null };
}

/**
 * A run, one at a time. A second call while one is on gets the same
 * promise; a call inside the cooldown is refused unless `force`.
 */
export function runScreener(opts: { force?: boolean; now?: () => number } = {}): Promise<ScreenerRun> {
  if (current) return current;
  const nowFn = opts.now ?? Date.now;
  if (!opts.force && lastRunAt && nowFn() - lastRunAt < COOLDOWN_MS) {
    return Promise.reject(Object.assign(new Error("Refreshed less than five minutes ago."), { status: 429, retryAt: new Date(lastRunAt + COOLDOWN_MS).toISOString() }));
  }
  current = run(nowFn).finally(() => {
    current = null;
  });
  return current;
}

async function run(nowFn: () => number): Promise<ScreenerRun> {
  const t0 = nowFn();
  const now = t0;
  lastRunAt = t0;
  status.running = true;
  status.startedAt = new Date(t0).toISOString();
  status.progress = null;
  status.lastError = null;
  const at = new Date(t0).toISOString();
  const settings = await screenerSettings();
  const budget = new Budget(WEIGHT_PER_MIN);
  try {
    const ctxs = parseMetaAndAssetCtxs(await ask(budget, 20, { type: "metaAndAssetCtxs" }));
    if (ctxs.length === 0) throw new Error("metaAndAssetCtxs answered with no universe");
    const byCoin = new Map(ctxs.map((c) => [c.coin, c]));
    const alts = ctxs.filter((c) => !c.delisted && !NOT_AN_ALT.test(c.coin) && (c.dayNtlVlm ?? 0) >= settings.minVolume);
    status.progress = { done: 0, total: alts.length + 1 };

    // The whole snapshot is kept — every perp, filtered or not — so OI history exists before a coin crosses the volume line.
    await screenerStore.saveSnapshot(
      at,
      ctxs.map((c) => ({ coin: c.coin, funding: c.funding, openInterest: c.openInterest, volume: c.dayNtlVlm, mark: c.markPx })),
    );
    const previous = await screenerStore.previousSnapshot(at);

    const btc = await fetchSeries(budget, "BTC", now);
    if (btc["1h"].length === 0 || btc["1d"].length === 0) throw new Error("BTC candles came back empty; nothing to measure against");
    await screenerStore.saveSeries("BTC", "1h", JSON.stringify(btc["1h"]));
    await screenerStore.saveSeries("BTC", "1d", JSON.stringify(btc["1d"]));
    status.progress.done = 1;

    const rows: ScreenerRow[] = [];
    for (const c of alts) {
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
        error: null,
        bars: { "1h": 0, "1d": 0 },
      };
      try {
        const series = await fetchSeries(budget, c.coin, now);
        base.bars = { "1h": series["1h"].length, "1d": series["1d"].length };
        base.tf = coinMetrics(series, btc);
        await screenerStore.saveSeries(c.coin, "1h", JSON.stringify(series["1h"]));
        await screenerStore.saveSeries(c.coin, "1d", JSON.stringify(series["1d"]));
      } catch (err: any) {
        base.error = String(err?.message ?? err).slice(0, 200);
        console.error(`[screener] ${c.coin}: ${base.error}`);
      }
      rows.push(base);
      status.progress.done++;
    }
    const flagged = flagRows(rows, settings);
    const tookMs = nowFn() - t0;
    const errors = flagged.filter((r) => r.error).length;
    const id = await screenerStore.saveRun({ at, tookMs, body: JSON.stringify(flagged), errors, universe: flagged.length, settings: JSON.stringify(settings) });
    await screenerStore.prune(new Date(t0 - KEEP_DAYS * DAY).toISOString()).catch(() => {});
    console.log(`[screener] ${flagged.length} coins in ${(tookMs / 1000).toFixed(1)}s, ${errors} could not be read, ${byCoin.size} perps listed`);
    notifyAll("screener");
    return { id, at, tookMs, errors, universe: flagged.length, settings, rows: flagged };
  } catch (err: any) {
    status.lastError = String(err?.message ?? err).slice(0, 300);
    console.error(`[screener] run failed: ${status.lastError}`);
    throw err;
  } finally {
    status.running = false;
    status.progress = null;
  }
}

const oiChange = (now: number | null, before: number | null) => (now != null && before != null && before > 0 ? now / before - 1 : null);

/** The latest stored run, parsed; null before the first. */
export async function latestScreenerRun(): Promise<ScreenerRun | null> {
  const r = await screenerStore.latestRun();
  if (!r) return null;
  let rows: ScreenerRow[] = [];
  try {
    rows = JSON.parse(r.body);
  } catch {
    rows = [];
  }
  return { id: r.id, at: r.at, tookMs: r.tookMs, errors: r.errors, universe: r.universe, settings: readScreenerSettings(r.settings ? JSON.parse(r.settings) : null), rows };
}

/** A coin's stored series, parsed; empty when the coin was never fetched. */
export async function storedSeries(coin: string): Promise<{ "1h": ScreenerCandle[]; "1d": ScreenerCandle[] }> {
  const parse = (s: string | null): ScreenerCandle[] => {
    try {
      return s ? (JSON.parse(s) as ScreenerCandle[]) : [];
    } catch {
      return [];
    }
  };
  const [h, d] = await Promise.all([screenerStore.series(coin, "1h"), screenerStore.series(coin, "1d")]);
  return { "1h": parse(h), "1d": parse(d) };
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
    const latest = Math.max(...passedToday);
    if (!last || last.day < day || (last.day === day && last.minutes < latest)) return true;
    return false;
  }
  // Before the first slot of the day: the last slot of yesterday is the one to have run.
  const lastSlot = Math.max(...slotMinutes);
  const yesterday = pragueClock(now - DAY).day;
  if (!last) return true;
  if (last.day < yesterday) return true;
  if (last.day === yesterday && last.minutes < lastSlot) return true;
  return false;
}

/** The clock: a minute's tick, a run when one is due. `SCREENER_CLOCK_MS=0` is off (tests). */
export function startScreenerClock(everyMs = Number(process.env.SCREENER_CLOCK_MS ?? "60000")): void {
  if (!(everyMs > 0)) return;
  const tick = async () => {
    try {
      if (status.running) return;
      const latest = await screenerStore.latestRun();
      if (runDue(Date.now(), latest?.at ?? null)) await runScreener({ force: true });
    } catch (err: any) {
      console.error(`[screener] clock: ${String(err?.message ?? err)}`);
    }
  };
  // The catch-up: a service that slept through a slot runs once it is up.
  setTimeout(() => void tick(), 15_000).unref?.();
  setInterval(() => void tick(), everyMs).unref?.();
}
