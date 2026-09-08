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
import { hlCoinFor, venueOfAccount } from "@shared/hyperliquid";
import { fetchCandles, readCandles, type CandleRead, type Interval } from "./binance";
import { readHlCandles } from "./hyperliquid";

/** The pair a trade is read against, on the venue its account names. */
export function pairForTradeAt(
  trade: { symbol: string; contract?: string | null; account?: string | null },
  cat: BinanceSymbol[],
  hlNames: string[],
): PairRef | null {
  if (trade.contract?.trim()) return null;
  if (venueOfAccount(trade.account) === "hyperliquid") {
    const coin = hlCoinFor(trade.symbol, hlNames);
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
): Promise<CandleRead> {
  if (pair.venue === "hyperliquid") return readHlCandles(pair.symbol, interval, startMs, endMs, maxBars);
  return readCandles(pair, interval, startMs, endMs, maxBars);
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
