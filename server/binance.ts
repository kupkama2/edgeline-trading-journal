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
import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { BinanceSymbol, Candle, Market } from "@shared/binance";

/**
 * Overridable so the whole path can be exercised without the live venue —
 * against a stub in a sandbox with no egress, or a regional mirror if
 * api.binance.com is ever blocked from the host. Defaults to the real thing.
 */
const SPOT = (process.env.BINANCE_BASE || "https://api.binance.com").replace(/\/+$/, "");
/**
 * USD-M futures — the perpetuals. A different host and a different price for
 * the same name: basis and funding separate them, and a liquidation cascade
 * wicks the perp through levels the spot book never prints. Reading a perp
 * trade off spot candles answers "did my stop get hit" with the price on a
 * market the order was never resting in.
 */
const FUTURES = (process.env.BINANCE_FUTURES_BASE || "https://fapi.binance.com").replace(/\/+$/, "");

const hostFor = (m: Market) => (m === "futures" ? FUTURES : SPOT);
const klinePath = (m: Market) => (m === "futures" ? "/fapi/v1/klines" : "/api/v3/klines");

/**
 * Egress in the dev sandbox goes through a proxy that Node's built-in fetch
 * ignores. Same reason the Perplexity client builds one; different host, so it
 * gets its own, and in production there is no proxy and this is undefined.
 *
 * NO_PROXY is honoured for loopback and private addresses, which is not
 * housekeeping: a request to a host on this machine sent through an external
 * proxy simply fails, and the failure looks exactly like "the venue is down"
 * — an empty catalogue and every trade left unmatched, with nothing saying
 * why. That is the shape of bug this whole module is written to avoid.
 */
const LOCAL_HOST =
  /^(localhost|127\.|\[?::1\]?|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;

let dispatcher: ProxyAgent | undefined;
function egress(): ProxyAgent | undefined {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy) return undefined;
  try {
    if (LOCAL_HOST.test(new URL(SPOT).hostname)) return undefined;
  } catch {
    /* an unparseable base is someone else's error; proxy as normal */
  }
  if (!dispatcher) dispatcher = new ProxyAgent(proxy);
  return dispatcher;
}

async function get(base: string, path: string, timeoutMs = 12_000): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await undiciFetch(`${base}${path}`, {
      signal: ctl.signal,
      dispatcher: egress(),
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Binance ${res.status} on ${path.split("?")[0]}`);
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
  const [futures, spot] = await Promise.allSettled([
    get(FUTURES, "/fapi/v1/exchangeInfo"),
    get(SPOT, "/api/v3/exchangeInfo?permissions=SPOT"),
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
  if (out.length === 0) {
    throw new Error("Neither Binance book answered");
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
export async function fetchCandles(
  pair: { symbol: string; market: Market },
  interval: Interval,
  startMs: number,
  endMs: number,
  maxBars = 5000,
): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = startMs;
  while (cursor < endMs && out.length < maxBars) {
    const page: any[] = await get(
      hostFor(pair.market),
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
