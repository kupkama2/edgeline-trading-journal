/**
 * Which venue's bars a trade is read against.
 *
 * Until now every trade was read against Binance, whatever exchange it
 * happened on. For a Hyperliquid trade that is close and wrong in the way
 * this journal least tolerates: basis moves the two books apart, and a
 * liquidation cascade on Hyperliquid wicks through levels Binance never
 * prints — the wick that actually took the stop. Settling that trade on
 * Binance's candles answers "did my stop get hit" with a price the order
 * was never resting against.
 *
 * So the account decides. An account whose name says Hyperliquid reads
 * Hyperliquid's candles for any coin the venue lists; everything else, and
 * any coin Hyperliquid does not have, reads Binance as before. Both callers
 * — the chart and the settler — go through here, because the two already
 * disagreed once when a rule lived in only one of them.
 */
import {
  pairForTradeWithFallback,
  type BinanceSymbol,
  type Candle,
  type PairRef,
} from "@shared/binance";
import { hlAssetFor, splitHlAsset, venueOfAccount } from "@shared/hyperliquid";
import { parsePricePair } from "@shared/price-pair";
import { fetchCandles, readCandles, type CandleRead, type Interval } from "./binance";
import { readHlCandles } from "./hyperliquid";
import { BAR_MS } from "./binance";
import { candleStore } from "./storage";

/** The pair a trade is read against, on the venue its account names. */
export function pairForTradeAt(
  trade: {
    symbol: string;
    contract?: string | null;
    account?: string | null;
    pricePair?: string | null;
  },
  cat: BinanceSymbol[],
  /**
   * Qualified names, or the rows themselves. The rows carry the delisted
   * flag, which decides an otherwise ambiguous ticker — see hlAssetFor.
   */
  hlNames: (string | { name: string; dex: string | null; delisted?: boolean })[],
): PairRef | null {
  /*
   * A pair chosen by hand wins everything below, including the contract check.
   * The rules under here are inference — from a ticker, from an account name —
   * and somebody who went and picked a book knows something none of them do.
   * That includes overriding "this has a contract code, so it is not crypto":
   * the point of the override is the case the inference got wrong.
   */
  const said = parsePricePair(trade.pricePair);
  if (said) return said;
  if (trade.contract?.trim()) return null;
  if (venueOfAccount(trade.account) === "hyperliquid") {
    // hlNames carries builder books qualified ("vntls:NVDA"), and resolving
    // is deliberately strict: the coin universe wins outright, and a ticker
    // only it does not list resolves to a builder book when exactly one of
    // them has it. Two candidates is a question for the pair picker, never a
    // tie broken by sort order.
    const coin = hlAssetFor(
      trade.symbol,
      hlNames.map((n) => {
        if (typeof n !== "string") return n;
        const { dex, coin } = splitHlAsset(n);
        return { name: coin, dex };
      }),
    );
    if (coin) return { symbol: coin, market: "futures", venue: "hyperliquid" };
    // The account says Hyperliquid but the venue does not list the coin.
    // Binance's book is a wrong venue rather than no venue, and the chart
    // says which it drew; falling through beats a blank.
  }
  return pairForTradeWithFallback(trade, cat);
}

/** Candles for a window, from whichever venue the pair names. */
export async function readCandlesAt(
  pair: PairRef,
  interval: Interval,
  startMs: number,
  endMs: number,
  maxBars = 5000,
  /**
   * Whether the run may BEGIN after the window does, when the archive has no
   * files that far back — a newly listed coin. The chart says yes; the
   * settler must not, and the default is its answer. See the prefix rule in
   * binance-archive.ts.
   */
  allowLateStart = false,
): Promise<CandleRead> {
  const bar = BAR_MS[interval] ?? 60_000;
  // A window that ends in the past is the same bars every time it is asked
  // for; one that runs to now is the same bars until the current bar closes.
  const liveEnd = endMs > Date.now() - bar;
  const key = `${pair.venue ?? "binance"}:${pair.symbol}:${pair.market}:${interval}:${Math.floor(startMs)}:${liveEnd ? Math.floor(endMs / bar) : Math.floor(endMs)}:${maxBars}:${allowLateStart ? 1 : 0}`;
  const held = candleCache.get(key);
  if (held && held.until > Date.now()) return held.read;
  const flying = inFlight.get(key);
  if (flying) return flying;
  const run = (async () => {
    // A window read by an earlier process: served from the table, remembered here.
    if (!liveEnd) {
      const row = await candleStore.get(key).catch(() => null);
      if (row && row.until > Date.now()) {
        try {
          const read = JSON.parse(row.body) as CandleRead;
          if (Array.isArray(read.candles) && read.candles.length) {
            candleCache.set(key, { read, until: row.until });
            return read;
          }
        } catch {
          /* an unreadable row is a miss */
        }
      }
    }
    const read = pair.venue === "hyperliquid" ? await readHlCandles(pair.symbol, interval, startMs, endMs, maxBars) : await readCandles(pair, interval, startMs, endMs, maxBars, allowLateStart);
    // A past window is kept for good only when the read reached its end: the archive
    // stops a day short, and tomorrow's file is the whole reason to ask again.
    const complete = read.coveredTo >= endMs - bar;
    const ttl = liveEnd || !complete ? Math.min(bar, LIVE_TTL_MS) : CLOSED_TTL_MS;
    remember(key, read, ttl);
    if (!liveEnd && complete && read.candles.length) void candleStore.put(key, Date.now() + ttl, JSON.stringify(read)).catch(() => {});
    return read;
  })();
  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    inFlight.delete(key);
  }
}

/*
 * Bars already read, kept in memory.
 *
 * Opening a trade used to cost a round trip to the venue every time, and a
 * venue that refuses — a US host, a rate ban — turned that into an archive
 * read of a dozen day-files. The bars of a window that ended in the past do
 * not change, so they are kept for the life of the process; a window that
 * runs to now is kept until the bar closes. Two charts asking for the same
 * window at once share one read.
 */
const CLOSED_TTL_MS = 30 * 24 * 60 * 60_000;
const LIVE_TTL_MS = 60_000;
const CACHE_MAX = 500;
const candleCache = new Map<string, { read: CandleRead; until: number }>();
const inFlight = new Map<string, Promise<CandleRead>>();
function remember(key: string, read: CandleRead, ttl: number): void {
  // Nothing worth keeping: an empty read is asked again next time.
  if (read.candles.length === 0) return;
  candleCache.delete(key);
  candleCache.set(key, { read, until: Date.now() + ttl });
  while (candleCache.size > CACHE_MAX) {
    const oldest = candleCache.keys().next().value;
    if (oldest == null) break;
    candleCache.delete(oldest);
  }
}
/** For tests and ?refresh=1: every held window forgotten. */
export function forgetCandles(): void {
  candleCache.clear();
}

/** Just the bars, for callers that do not care where they came from. */
export async function fetchCandlesAt(
  pair: PairRef,
  interval: Interval,
  startMs: number,
  endMs: number,
  maxBars = 5000,
): Promise<Candle[]> {
  if (pair.venue === "hyperliquid") {
    return (await readHlCandles(pair.symbol, interval, startMs, endMs, maxBars)).candles;
  }
  return fetchCandles(pair, interval, startMs, endMs, maxBars);
}
