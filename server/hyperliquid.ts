/**
 * Hyperliquid's perp universe, fetched and cached.
 *
 * One public endpoint, no key: `POST /info {"type":"meta"}` answers with
 * every perp the venue lists, delisted ones flagged. Reading it is in
 * shared/hyperliquid.ts and pure; this file asks, remembers, and reports.
 *
 * The universe is refreshed once a day and read from the database between
 * refreshes, the same way the Binance catalogue is. A venue that cannot be
 * reached is an empty universe with a reason attached, never a thrown error:
 * the picker losing one column of suggestions is not a broken journal.
 */
import { fetch as undiciFetch } from "undici";
import { egressFor } from "./egress";
import {
  parseAllMids,
  parseCandleSnapshot,
  parseFundingHistory,
  parseHistoricalOrders,
  parseHyperliquidMeta,
  parseUserFills,
  type HlFill,
  type HlOrder,
  type HyperliquidPerp,
} from "@shared/hyperliquid";
import type { Candle } from "@shared/binance";
import type { CandleRead, Interval } from "./binance";
import { hyperliquid as universe } from "./storage";

const BASE = (process.env.HYPERLIQUID_BASE || "https://api.hyperliquid.xyz").replace(/\/+$/, "");

const TTL_MS = 24 * 60 * 60 * 1000;
/**
 * How long a failed fetch is left alone before it is tried again.
 *
 * Without this an empty cache is "stale" on every request, and every open of
 * the trade form would wait out a twelve-second timeout against a venue that
 * refused a minute ago.
 */
const RETRY_MS = 10 * 60 * 1000;

export interface HyperliquidStatus {
  lastTriedAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  /** Perps the last successful fetch returned, delisted ones included. */
  perps: number;
}

const status: HyperliquidStatus = { lastTriedAt: null, lastOkAt: null, lastError: null, perps: 0 };
export const hyperliquidStatus = (): HyperliquidStatus => ({ ...status });

const host = () => new URL(BASE).hostname;

/**
 * One question to the venue. Everything Hyperliquid answers — the universe,
 * a wallet's fills, a coin's candles or funding, every mid at once — is a
 * POST to /info with a `type`, and this is the only place the request is
 * written.
 */
async function info(body: Record<string, unknown>, timeoutMs = 12_000): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await undiciFetch(`${BASE}/info`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
      dispatcher: egressFor(BASE),
    } as any);
    if (!res.ok) throw new Error(`${host()} → HTTP ${res.status} on /info (${String(body.type)})`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchHyperliquidPerps(): Promise<HyperliquidPerp[]> {
  status.lastTriedAt = new Date().toISOString();
  try {
    const perps = parseHyperliquidMeta(await info({ type: "meta" }));
    if (perps.length === 0) throw new Error(`${host()} answered /info without a universe`);
    status.lastOkAt = new Date().toISOString();
    status.lastError = null;
    status.perps = perps.length;
    return perps;
  } catch (err: any) {
    status.lastError = String(err?.message ?? err);
    throw err;
  }
}

/** The names the venue lists, delisted included, from the cache. */
export async function hyperliquidNames(): Promise<string[]> {
  return (await ensureHyperliquid()).map((p) => p.name);
}

/* ------------------------------ a wallet ------------------------------ */

/** The most recent fills of a wallet — the venue keeps the last two thousand. */
export async function fetchUserFills(address: string): Promise<HlFill[]> {
  return parseUserFills(await info({ type: "userFills", user: address }, 20_000));
}

/** The wallet's order history, trigger orders included. */
export async function fetchHistoricalOrders(address: string): Promise<HlOrder[]> {
  return parseHistoricalOrders(await info({ type: "historicalOrders", user: address }, 20_000));
}

/* ------------------------------- prices ------------------------------- */

const SNAPSHOT_CAP = 5000;

/**
 * Candles for a window, following the venue's paging to the end of it.
 *
 * One snapshot caps at five thousand bars, and a swing left parked for a
 * month is more one-minute bars than that. Stopping at the cap would scan
 * the first stretch of the window and report "pending" for a trade whose
 * target was hit later — the same trap the Binance reader guards against.
 */
export async function readHlCandles(
  coin: string,
  interval: Interval,
  startMs: number,
  endMs: number,
  maxBars = SNAPSHOT_CAP,
): Promise<CandleRead> {
  const out: Candle[] = [];
  let cursor = startMs;
  while (cursor < endMs && out.length < maxBars) {
    const page = parseCandleSnapshot(
      await info({
        type: "candleSnapshot",
        req: { coin, interval, startTime: Math.floor(cursor), endTime: Math.floor(endMs) },
      }),
    );
    if (page.length === 0) break;
    for (const k of page) if (k.t > cursor - 1 && k.t <= endMs) out.push(k);
    const last = page[page.length - 1].t;
    if (!Number.isFinite(last) || last < cursor) break;
    cursor = last + 1;
    if (page.length < SNAPSHOT_CAP) break;
  }
  const truncated = out.length >= maxBars;
  return {
    candles: out.slice(0, maxBars),
    coveredTo: truncated ? out[out.length - 1].t : endMs,
    source: "api",
  };
}

/** Funding settlements for a coin across a window, hourly, paged. */
export async function fetchHlFunding(
  coin: string,
  startMs: number,
  endMs: number,
): Promise<{ time: number; rate: number }[]> {
  const out: { time: number; rate: number }[] = [];
  let cursor = startMs;
  for (let page = 0; page < 20 && cursor < endMs; page++) {
    const batch = parseFundingHistory(
      await info({ type: "fundingHistory", coin, startTime: Math.floor(cursor), endTime: Math.floor(endMs) }),
    );
    if (batch.length === 0) break;
    out.push(...batch.filter((e) => e.time >= cursor && e.time <= endMs));
    const last = batch[batch.length - 1].time;
    if (last < cursor) break;
    cursor = last + 1;
    if (batch.length < 500) break;
  }
  return out;
}

/** Every book's mid, now. One request for every open trade at once. */
export async function fetchAllMids(): Promise<Record<string, number>> {
  return parseAllMids(await info({ type: "allMids" }, 8_000));
}

/** The cached universe, refreshed when missing or a day old. Never throws. */
export async function ensureHyperliquid(force = false): Promise<HyperliquidPerp[]> {
  const last = await universe.lastFetchedAt();
  const stale = force || !last || Date.now() - new Date(last).getTime() > TTL_MS;
  const triedRecently =
    status.lastTriedAt != null && Date.now() - new Date(status.lastTriedAt).getTime() < RETRY_MS;
  if (stale && (force || !triedRecently)) {
    try {
      const perps = await fetchHyperliquidPerps();
      if (perps.length) await universe.replace(perps);
    } catch {
      // The cache, or nothing. The status endpoint carries the reason.
    }
  }
  return universe.list();
}
