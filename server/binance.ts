/**
 * The price feed, kept at arm's length.
 *
 * Two things are fetched: the list of pairs Binance actually trades, so the
 * journal knows what a typed ticker means rather than guessing, and candles,
 * so a trade taken off by hand can be told what would have happened if it had
 * been left alone.
 *
 * Everything that DECIDES anything lives in shared/binance.ts and is pure.
 * This file only fetches, caches and hands over — which is what makes the
 * decision logic testable without a network, and it is the decision logic that
 * must never be wrong.
 *
 * Public endpoints, no key, no account. Binance weights requests rather than
 * counting them; klines at these limits are weight 2, exchangeInfo is 20, and
 * the daily catalogue refresh plus a few dozen klines a day is not close to
 * any ceiling. Failures are returned, never thrown into a request handler: a
 * price feed being down is a reason to leave a trade parked, not to break the
 * journal.
 */
import { fetch as undiciFetch } from "undici";
import { egressFor } from "./egress";
import { archiveCandles } from "./binance-archive";
import type { BinanceSymbol, Candle, Market } from "@shared/binance";

/**
 * Overridable so the whole path can be exercised without the live venue —
 * against a stub in a sandbox with no egress, or a regional mirror if
 * api.binance.com is ever blocked from the host. Defaults to the real thing.
 */
/**
 * Spot hosts, tried in order.
 *
 * data-api.binance.vision is Binance's own market-data mirror: same paths, no
 * account, and — the reason it is here — it is not geo-restricted the way the
 * main API is. api.binance.com answers 451 to a US IP, which is where a Render
 * service in Oregon is calling from, and a 451 looks exactly like "no coins
 * exist" once it has been swallowed.
 */
const SPOT_HOSTS = (process.env.BINANCE_BASE
  ? [process.env.BINANCE_BASE]
  : ["https://api.binance.com", "https://data-api.binance.vision"]
).map((h) => h.replace(/\/+$/, ""));
const SPOT = SPOT_HOSTS[0];
/**
 * USD-M futures — the perpetuals. A different host and a different price for
 * the same name: basis and funding separate them, and a liquidation cascade
 * wicks the perp through levels the spot book never prints. Reading a perp
 * trade off spot candles answers "did my stop get hit" with the price on a
 * market the order was never resting in.
 */
const FUTURES_HOSTS = (process.env.BINANCE_FUTURES_BASE
  ? [process.env.BINANCE_FUTURES_BASE]
  : ["https://fapi.binance.com", "https://fapi1.binance.com", "https://fapi2.binance.com"]
).map((h) => h.replace(/\/+$/, ""));
const FUTURES = FUTURES_HOSTS[0];

const hostsFor = (m: Market) => (m === "futures" ? FUTURES_HOSTS : SPOT_HOSTS);
const hostFor = (m: Market) => hostsFor(m)[0];

/**
 * The last thing the feed said when it refused.
 *
 * Kept because the alternative is what shipped: every failure swallowed, an
 * empty pair list, and no way to tell "Binance answered 451" from "nobody has
 * asked yet". Both look like a journal that has quietly decided none of your
 * coins exist.
 */
export interface FeedStatus {
  lastError: string | null;
  lastTriedAt: string | null;
  lastOkAt: string | null;
  /**
   * How many pairs each book returned last time it was asked.
   *
   * A PARTIAL failure is the one that hides best: the perp book refuses, the
   * spot mirror answers, and the catalogue comes back full of pairs with
   * nothing anywhere saying that every perp is missing. Every trade then
   * resolves to spot, the chart says "spot", and it reads as a preference
   * rather than a refusal. These counts are what makes it sayable.
   */
  books: { futures: number; spot: number };
  /**
   * Why a book was missing from the last catalogue fetch.
   *
   * Separate from lastError because that one is cleared by the next success,
   * and successes keep arriving: one spot klines call wipes the record of the
   * perp book's 451 and the status endpoint goes back to looking healthy while
   * every perpetual is still gone. This is only ever written by a catalogue
   * fetch, so it survives until the next one says otherwise.
   */
  catalogueError: string | null;
  /** When the historical archive last answered — the perp path from a US host. */
  archiveOkAt: string | null;
}
const status: FeedStatus = {
  lastError: null,
  lastTriedAt: null,
  lastOkAt: null,
  books: { futures: 0, spot: 0 },
  catalogueError: null,
  archiveOkAt: null,
};
export const feedStatus = (): FeedStatus => ({ ...status });

/** Try each host in turn; the last failure is what gets reported. */
async function getAny(hosts: string[], path: string): Promise<any> {
  let failure: unknown;
  for (const host of hosts) {
    try {
      const out = await get(host, path);
      status.lastOkAt = new Date().toISOString();
      status.lastError = null;
      return out;
    } catch (err) {
      failure = err;
    }
  }
  throw failure ?? new Error("no hosts configured");
}
const klinePath = (m: Market) => (m === "futures" ? "/fapi/v1/klines" : "/api/v3/klines");


async function get(base: string, path: string, timeoutMs = 12_000): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await undiciFetch(`${base}${path}`, {
      signal: ctl.signal,
      dispatcher: egressFor(base),
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      // The status and the host both matter: 451 from api.binance.com is a
      // geo-block, and saying which host said it is the difference between a
      // diagnosis and a shrug.
      throw new Error(`${new URL(base).hostname} → HTTP ${res.status} on ${path.split("?")[0]}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every pair Binance lists, from BOTH books, tagged with which one.
 *
 * Futures first in the returned list and preferred by the matcher. Only
 * PERPETUAL contracts are taken: the quarterlies (BTCUSDT_240329) are a
 * different instrument with a different price, and their names would collide
 * with nothing useful.
 *
 * If either book fails the other still counts — half a catalogue matches half
 * the trades, which beats matching none.
 */
export async function fetchCatalogue(): Promise<BinanceSymbol[]> {
  status.lastTriedAt = new Date().toISOString();
  const [futures, spot] = await Promise.allSettled([
    getAny(FUTURES_HOSTS, "/fapi/v1/exchangeInfo"),
    getAny(SPOT_HOSTS, "/api/v3/exchangeInfo"),
  ]);

  const out: BinanceSymbol[] = [];
  if (futures.status === "fulfilled") {
    for (const s of futures.value?.symbols ?? []) {
      // Quarterlies and anything not a straight perp are skipped.
      if (s?.contractType && s.contractType !== "PERPETUAL") continue;
      out.push({
        symbol: String(s.symbol),
        baseAsset: String(s.baseAsset),
        quoteAsset: String(s.quoteAsset),
        status: String(s.status),
        market: "futures",
      });
    }
  }
  if (spot.status === "fulfilled") {
    for (const s of spot.value?.symbols ?? []) {
      out.push({
        symbol: String(s.symbol),
        baseAsset: String(s.baseAsset),
        quoteAsset: String(s.quoteAsset),
        status: String(s.status),
        market: "spot",
      });
    }
  }
  status.books = {
    futures: out.filter((s) => s.market === "futures").length,
    spot: out.filter((s) => s.market === "spot").length,
  };

  /*
   * A book that refused is recorded even when the other one answered.
   *
   * getAny clears lastError on any success, so without this a spot fetch that
   * lands a second after the futures fetch refuses erases the only evidence
   * that the perps are gone. Written after both have settled, so it is the
   * whole truth about this attempt rather than whichever finished last.
   */
  const why = [
    ["futures", futures] as const,
    ["spot", spot] as const,
  ]
    .filter(([, r]) => r.status === "rejected")
    .map(([book, r]) => `${book}: ${String((r as PromiseRejectedResult).reason?.message ?? (r as PromiseRejectedResult).reason)}`)
    .join(" · ");
  status.catalogueError = why || null;
  if (why) status.lastError = why;

  if (out.length === 0) {
    status.lastError = why || "Neither Binance book returned any symbols";
    throw new Error(status.lastError);
  }
  return out;
}

export type Interval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

/**
 * Candles for a window, following Binance's pagination to the end of it.
 *
 * One request caps at 1000 bars, and a swing left parked for a month is more
 * hourly bars than that. Stopping at the cap would silently scan only the
 * first stretch of the window and report "pending" for a trade whose target
 * was hit in week three — a wrong answer produced by an unexamined limit,
 * which is the kind this module is least allowed to produce.
 */
export interface CandleRead {
  candles: Candle[];
  /**
   * The last instant the data actually reaches.
   *
   * The live API answers up to the moment you ask, so this is the end of the
   * window. The archive answers up to the last file that exists, which is
   * yesterday at best — and a caller writing down a maximum excursion needs to
   * know the difference between "price never went further" and "the files
   * stopped there".
   */
  coveredTo: number;
  source: "api" | "archive";
}

/**
 * Candles, from the live API if it will answer and the archive if it will not.
 *
 * The fallback is what makes perpetuals readable at all from a US host: the
 * API refuses with a 451 and has no mirror, while data.binance.vision serves
 * the same bars as files from an unrestricted domain. It is a day behind, so
 * this returns what exists and says how far it got rather than pretending.
 */
export async function readCandles(
  pair: { symbol: string; market: Market },
  interval: Interval,
  startMs: number,
  endMs: number,
  maxBars = 5000,
): Promise<CandleRead> {
  try {
    const candles = await liveCandles(pair, interval, startMs, endMs, maxBars);
    return { candles, coveredTo: endMs, source: "api" };
  } catch (err) {
    const read = await archiveCandles(pair, interval, startMs, endMs);
    if (read.candles.length === 0) {
      // Nothing from either place. The API's own words are the more useful
      // ones — "451 from fapi.binance.com" is a diagnosis, "no file for
      // today" is a consequence.
      status.lastError = String((err as any)?.message ?? err);
      throw err;
    }
    status.archiveOkAt = new Date().toISOString();
    return { candles: read.candles, coveredTo: read.coveredTo, source: "archive" };
  }
}

/** Just the bars, for callers that do not care where they came from. */
export async function fetchCandles(
  pair: { symbol: string; market: Market },
  interval: Interval,
  startMs: number,
  endMs: number,
  maxBars = 5000,
): Promise<Candle[]> {
  return (await readCandles(pair, interval, startMs, endMs, maxBars)).candles;
}

async function liveCandles(
  pair: { symbol: string; market: Market },
  interval: Interval,
  startMs: number,
  endMs: number,
  maxBars: number,
): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = startMs;
  while (cursor < endMs && out.length < maxBars) {
    const page: any[] = await getAny(
      hostsFor(pair.market),
      `${klinePath(pair.market)}?symbol=${encodeURIComponent(pair.symbol)}&interval=${interval}` +
        `&startTime=${Math.floor(cursor)}&endTime=${Math.floor(endMs)}&limit=1000`,
    );
    if (!Array.isArray(page) || page.length === 0) break;
    for (const k of page) {
      out.push({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]) });
    }
    const last = Number(page[page.length - 1][0]);
    // A page that cannot advance the cursor would loop forever.
    if (!isFinite(last) || last < cursor) break;
    cursor = last + 1;
    if (page.length < 1000) break;
  }
  return out;
}

/**
 * How coarse a bar to scan a window with.
 *
 * Coarser bars mean fewer requests and more ambiguity — the wider the bar, the
 * likelier it swallows both levels and the verdict comes back unusable. So:
 * fine enough that a typical window resolves cleanly, coarse enough that a
 * month-old trade is a handful of requests rather than forty.
 */
export function intervalFor(spanMs: number): Interval {
  const hours = spanMs / 3_600_000;
  if (hours <= 12) return "1m";
  if (hours <= 72) return "5m";
  if (hours <= 24 * 14) return "1h";
  return "4h";
}
