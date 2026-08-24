/**
 * Letting the market answer the one question the journal cannot.
 *
 * A trade taken off by hand leaves "would it have hit the target or the stop
 * first, left alone?" open, and the only place that answer exists is the price
 * path after you exited. For crypto that path is free and public, so the
 * journal can go and read it instead of asking you to.
 *
 * Everything here is pure and offline: a candle list in, a verdict out. The
 * fetching lives in server/binance.ts. That split is the point — the part that
 * decides what a trade's outcome WAS is the part that must be tested to death,
 * and it should not need a network to run.
 *
 * The governing rule is that this may only ever WRITE an answer it is certain
 * of. It is filling in noManagementOutcome, which is what potentialR and
 * managementDeltaR are built from; a confident wrong answer there is worse
 * than a blank, because a blank is visibly missing and a wrong answer is not.
 * So every ambiguity below resolves to "don't know" rather than to a guess.
 */

/** One OHLC bar. Times are epoch ms at the bar's OPEN. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export type Touch =
  /** Price reached the original target before the original stop. */
  | { verdict: "target_first"; at: number }
  | { verdict: "stop_first"; at: number }
  /** Neither level reached yet — the question is still live. */
  | { verdict: "pending" }
  /**
   * One bar touched BOTH levels, so their order is not knowable at this
   * resolution. The caller re-runs on finer bars; if it is still ambiguous
   * there, the trade stays parked. Never resolved by picking one.
   */
  | { verdict: "ambiguous"; at: number };

/**
 * Which level price reached first, walking bars in time order.
 *
 * Bars, not closes: a wick through the stop IS the stop being hit, and a
 * close-only scan would quietly report that trades survive levels they were
 * taken out at. The comparison is inclusive — price trading exactly AT the
 * level fills there — and gaps need no special case, because a bar that opens
 * beyond a level has that level inside its high-low range anyway.
 */
export function firstTouch(
  candles: Candle[],
  plan: { direction: string; stop: number | null; target: number | null },
): Touch {
  const { stop, target } = plan;
  if (stop == null || target == null) return { verdict: "pending" };
  const long = plan.direction !== "short";

  for (const c of candles) {
    const hitTarget = long ? c.h >= target : c.l <= target;
    const hitStop = long ? c.l <= stop : c.h >= stop;
    if (hitTarget && hitStop) return { verdict: "ambiguous", at: c.t };
    if (hitTarget) return { verdict: "target_first", at: c.t };
    if (hitStop) return { verdict: "stop_first", at: c.t };
  }
  return { verdict: "pending" };
}

/* ------------------------------ the catalogue ------------------------------ */

export interface BinanceSymbol {
  /** The pair as Binance names it: "BTCUSDT". */
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  /** Only "TRADING" pairs are usable; delisted ones stay for old trades. */
  status: string;
}

/**
 * Which quote currency to prefer when a base trades against several.
 *
 * USDT first because it is the deepest book and the one a retail crypto trader
 * is almost always quoted in, so its candles are the ones that match what they
 * were watching. Stablecoins before BTC, because a BTC-quoted chart measures a
 * different thing entirely — a level in dollars is not a level in satoshis,
 * and resolving a trade against the wrong denominator is exactly the confident
 * wrong answer this module exists to avoid.
 */
const QUOTE_RANK = ["USDT", "USDC", "FDUSD", "BUSD", "TUSD"];

/**
 * The Binance pair a journal symbol means, or null when it cannot be sure.
 *
 * Null is a real answer and the common one for anything that is not a spot
 * crypto pair. Nothing downstream may guess past it.
 */
export function matchBinanceSymbol(
  raw: string | null | undefined,
  catalogue: BinanceSymbol[],
): string | null {
  const key = (raw ?? "").trim().toUpperCase();
  if (!key) return null;
  const live = catalogue.filter((s) => s.status === "TRADING");

  // Already a pair: "BTCUSDT" typed straight in.
  const exact = live.find((s) => s.symbol === key);
  if (exact) return exact.symbol;

  // A bare asset: "HYPE" -> the best-quoted pair it trades in.
  const asBase = live.filter((s) => s.baseAsset === key);
  if (asBase.length === 0) return null;
  for (const q of QUOTE_RANK) {
    const hit = asBase.find((s) => s.quoteAsset === q);
    if (hit) return hit.symbol;
  }
  return null;
}

/**
 * The pair for a TRADE, which is the same question plus one refusal.
 *
 * A futures trade carries its contract ("MNQU6"), and its instrument root can
 * collide with a crypto ticker — there is nothing stopping a token called ES
 * or NQ from listing tomorrow. Resolving a Nasdaq future against a memecoin's
 * candles would be a confident wrong answer of the worst kind, so a trade with
 * a contract on it is never matched at all.
 */
export function binanceSymbolForTrade(
  trade: { symbol: string; contract?: string | null },
  catalogue: BinanceSymbol[],
): string | null {
  if (trade.contract?.trim()) return null;
  return matchBinanceSymbol(trade.symbol, catalogue);
}
