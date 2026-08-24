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

/* ------------------------------ the path ------------------------------ */

export interface PathExtremes {
  /** Worst price against you WHILE THE TRADE WAS ON. */
  mae: number | null;
  /** Best price in your favour while it was on. */
  mfe: number | null;
  /** Best price in your favour AFTER the exit, before the thesis died. */
  postExitPeak: number | null;
  /** Worst price against you after the exit, over a bounded horizon. */
  postExitAdverse: number | null;
}

/** How long after the exit the adverse extreme is still attributed to it. */
export const AFTERMATH_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The four path numbers, read off the candles.
 *
 * They are four different questions and each has its own window, which is the
 * whole reason this is one function rather than four one-liners:
 *
 *   MAE and MFE cover ENTRY TO EXIT and nothing else. They are what the trade
 *   did while you were holding it, and letting a single minute of aftermath
 *   leak in is precisely the bug that made an early exit read as a late one.
 *
 *   postExitPeak runs from the exit until price trades beyond the ORIGINAL
 *   STOP — the thesis dying by the trade's own definition. Without that bound
 *   "it would have gone higher" is eventually true of everything, and this
 *   must mean the same thing as the values entered by hand or the exit-timing
 *   read is comparing two different measurements.
 *
 *   postExitAdverse is bounded by TIME instead, because the stop level cannot
 *   bound it: how far past the stop price went IS the measurement, and
 *   stopping at the stop would answer "what did the stop save you" with
 *   "nothing" every time. A month is long enough to cover the move that
 *   followed and short enough that the next cycle is not attributed to it.
 *
 * Every value is null when its window held no bars — an unmeasured leg is not
 * a zero leg, and the rest of the app depends on being able to tell.
 */
export function pathExtremes(
  candles: Candle[],
  t: { direction: string; entryMs: number; exitMs: number | null; stop: number | null },
): PathExtremes {
  const long = t.direction !== "short";
  const best = (bars: Candle[]) =>
    bars.length === 0 ? null : long ? Math.max(...bars.map((c) => c.h)) : Math.min(...bars.map((c) => c.l));
  const worst = (bars: Candle[]) =>
    bars.length === 0 ? null : long ? Math.min(...bars.map((c) => c.l)) : Math.max(...bars.map((c) => c.h));

  const exitMs = t.exitMs;
  const held = candles.filter((c) => c.t >= t.entryMs && (exitMs == null || c.t <= exitMs));
  const after = exitMs == null ? [] : candles.filter((c) => c.t > exitMs);

  // The favourable aftermath stops at the bar BEFORE the stop level breaks:
  // once it breaks, a position left alone would not have been there for what
  // came next.
  const alive: Candle[] = [];
  for (const c of after) {
    if (t.stop != null && (long ? c.l <= t.stop : c.h >= t.stop)) break;
    alive.push(c);
  }
  const withinHorizon =
    exitMs == null ? [] : after.filter((c) => c.t - exitMs <= AFTERMATH_HORIZON_MS);

  return {
    mae: worst(held),
    mfe: best(held),
    postExitPeak: best(alive),
    postExitAdverse: worst(withinHorizon),
  };
}
