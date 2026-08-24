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


/* ------------------------------ the fallback ------------------------------ */

/**
 * Binance USDT perpetual base assets, written down.
 *
 * A cached list is only as good as the fetch that filled it, and the fetch can
 * fail for reasons that have nothing to do with this app — Binance answers 451
 * to US IPs, which is where most cheap hosting calls from. When that happens
 * the catalogue is empty, and an empty catalogue silently disables the two
 * things that do not need prices at all: knowing that "ZROUSDT" means ZRO, and
 * offering real coins in the picker. Neither of those is a market-data
 * question. Neither should depend on reaching a market.
 *
 * So this is the floor. It is used ONLY when the live catalogue is empty, and
 * a successful fetch always wins — the moment the venue is reachable, the real
 * list supersedes this one entirely, including for coins listed after this was
 * written.
 *
 * Two honest limitations, both of which the design absorbs rather than hides:
 *
 *   It goes stale. A coin listed next month is not here, and until the live
 *   fetch works that symbol is simply left alone — which is exactly what an
 *   unrecognised symbol has always done. Nothing breaks; one coin stays
 *   unfolded.
 *
 *   It is written from knowledge rather than read from the venue, so it may
 *   name something that has since been delisted. That is harmless in the
 *   direction that matters: the collapse rule checks whether the WHOLE string
 *   is a known asset before it considers splitting one, so a spurious entry
 *   cannot mangle a real ticker into a shorter one.
 *
 * Quoted in USDT throughout, which is what these actually trade as.
 */
const SEED_ASSETS = [
  "BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "ADA", "AVAX", "LINK", "DOT",
  "MATIC", "LTC", "BCH", "TRX", "ATOM", "XLM", "NEAR", "APT", "ARB", "OP",
  "FIL", "ICP", "HBAR", "VET", "INJ", "SUI", "SEI", "TIA", "IMX", "GRT",
  "AAVE", "MKR", "LDO", "RUNE", "ALGO", "FTM", "SAND", "MANA", "AXS", "GALA",
  "CHZ", "ENJ", "APE", "GMT", "CRV", "SNX", "COMP", "UNI", "SUSHI", "YFI",
  "ZRX", "1INCH", "BAL", "KNC", "OCEAN", "BAND", "STORJ", "ANKR", "CTSI",
  "SKL", "RSR", "DENT", "HOT", "ZIL", "ONE", "IOTA", "ONT", "QTUM", "ZEC",
  "DASH", "XMR", "ETC", "EOS", "NEO", "XTZ", "WAVES", "KAVA", "ROSE", "CELO",
  "FLOW", "EGLD", "THETA", "STX", "ORDI", "WIF", "PEPE", "FLOKI", "BONK",
  "SHIB", "JUP", "PYTH", "JTO", "WLD", "BLUR", "ENA", "ETHFI", "REZ", "OMNI",
  "NOT", "ZK", "ZRO", "IO", "LISTA", "BANANA", "RENDER", "TAO", "FET",
  "AGIX", "ARKM", "PENDLE", "ETHW", "HYPE", "STRK", "MANTA", "ALT", "DYM",
  "PIXEL", "PORTAL", "AEVO", "BOME", "W", "METIS", "ACE", "NFP", "AI", "XAI",
  "SAGA", "TAIKO", "ZETA", "MYRO", "TNSR", "SAFE", "BB", "NEIRO", "EIGEN",
  "DOGS", "CATI", "HMSTR", "POL", "SCR", "MOODENG", "GOAT", "GRASS", "PNUT",
  "ACT", "ME", "MOVE", "VIRTUAL", "AI16Z", "USUAL", "PENGU", "BIO", "S",
  "TRUMP", "MELANIA", "ANIME", "BERA", "LAYER", "IP", "KAITO", "SHELL",
  "PLUME", "NIL", "PARTI", "BABY", "WCT", "ZORA", "HAEDAL", "SXT", "SOPH",
  "RESOLV", "SPK", "NXPC", "HUMA", "SAHARA", "BOMB", "CAKE", "TWT", "XVS",
  "ALPACA", "SUN", "CFX", "ASTR", "JASMY", "LPT", "MASK", "API3", "GMX",
  "DYDX", "MAGIC", "HIGH", "T", "RARE", "POLYX", "ID", "ARK", "EDU", "RDNT",
  "SUIA", "PEOPLE", "LEVER", "TRB", "IDEX", "HOOK", "STG", "SPELL", "GAL",
  "AGLD", "LOKA", "BSW", "MDT", "SLP", "HIFI", "RIF", "QUICK", "LQTY", "JOE",
  "TLM", "ALICE", "DAR", "ATA", "CTK", "BAKE", "BURGER", "XEM", "SFP",
  "AUDIO", "KDA", "RVN", "ICX", "ZEN", "LRC", "ONG", "NKN", "ARPA", "CHR",
  "OGN", "CVC", "COTI", "DUSK", "MTL", "PERP", "UNFI", "LINA", "FLM", "XVG",
];

/** The fallback catalogue: every seeded asset as its USDT perp. */
export const SEED_CATALOGUE: BinanceSymbol[] = SEED_ASSETS.map((baseAsset) => ({
  symbol: `${baseAsset}USDT`,
  baseAsset,
  quoteAsset: "USDT",
  status: "TRADING",
  market: "futures" as const,
}));

/* ------------------------------ the catalogue ------------------------------ */

/** Which book a pair trades in. They are different prices for the same name. */
export type Market = "futures" | "spot";

export interface BinanceSymbol {
  /** The pair as Binance names it: "BTCUSDT". */
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  /** Only "TRADING" pairs are usable; delisted ones stay for old trades. */
  status: string;
  market: Market;
}

/** A pair AND the book to read it from — both are needed to fetch candles. */
export interface PairRef {
  symbol: string;
  market: Market;
}

/**
 * Quote currencies a pair might be written against, longest first.
 *
 * Longest first matters: try "USD" before "USDT" and LTCUSDT loses only the
 * "T"'s worth of meaning and comes out as "LTCUSD".
 *
 * Wider than QUOTE_RANK because this list is for READING what someone wrote,
 * not for choosing which market to read prices from. "LTCUSD" is not a Binance
 * pair at all — it is how TradingView and half the industry write it — and the
 * journal still has to know it means litecoin.
 */
const QUOTE_SUFFIXES = [
  "USDT", "FDUSD", "BUSD", "TUSD", "USDC", "USD",
  "BTC", "ETH", "BNB", "EUR", "TRY", "GBP",
];

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
 * FUTURES BEFORE SPOT, and the reason is correctness rather than preference.
 *
 * A perp and its spot pair share a name and do not share a price. Basis and
 * funding move them apart, and — the part that decides it — a liquidation
 * cascade wicks the perp through levels the spot book never reaches. That wick
 * is what actually took someone's stop. Reading a perp trade off spot candles
 * would answer "did my stop get hit" with the price on a market the order was
 * never resting in, and it would be wrong exactly at the moment it matters:
 * within a hair of the level.
 *
 * Plenty of tokens also list as a perp long before they list on spot, so
 * checking futures first is the difference between charting a trade and
 * declining to.
 */
const MARKET_RANK: Market[] = ["futures", "spot"];

/**
 * The Binance pair a journal symbol means, or null when it cannot be sure.
 *
 * Null is a real answer and the common one for anything that is not a crypto
 * pair at all. Nothing downstream may guess past it.
 */
export function matchBinanceSymbol(
  raw: string | null | undefined,
  catalogue: BinanceSymbol[],
): PairRef | null {
  const key = (raw ?? "").trim().toUpperCase();
  if (!key) return null;
  const live = catalogue.filter((s) => s.status === "TRADING");
  const pick = (rows: BinanceSymbol[]) => {
    for (const m of MARKET_RANK) {
      const hit = rows.find((s) => s.market === m);
      if (hit) return { symbol: hit.symbol, market: hit.market };
    }
    return null;
  };

  // Already a pair: "BTCUSDT" typed straight in. It may exist in both books.
  const exact = pick(live.filter((s) => s.symbol === key));
  if (exact) return exact;

  // A bare asset: "HYPE" -> the best-quoted pair it trades in.
  const asBase = live.filter((s) => s.baseAsset === key);
  if (asBase.length === 0) return null;
  for (const q of QUOTE_RANK) {
    const hit = pick(asBase.filter((s) => s.quoteAsset === q));
    if (hit) return hit;
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
): PairRef | null {
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

/* ------------------------- what did you actually type ------------------------- */

/**
 * The INSTRUMENT behind a pair as it was written.
 *
 * "LTC/USDT", "LTCUSDT", "LTCUSDT.P" and "LTC" are one instrument and have to
 * group as one, or the same coin fragments into four sets of statistics
 * depending on where the string was copied from — a TradingView title, an
 * exchange screenshot, or typed by hand.
 *
 * Driven by the catalogue rather than by a list of quote suffixes, because the
 * suffix approach is quietly dangerous. Strip "BTC" off "WBTC" and the journal
 * starts logging Wrapped Bitcoin as a token called "W", which is itself a real
 * coin. So the order of questions is:
 *
 *   1. Is the whole string a base asset in its own right? Then it IS the
 *      instrument. WBTC stops here, and so does every other coin whose ticker
 *      happens to end in one.
 *   2. Is the whole string a listed pair? Then take that pair's base.
 *   3. Was there an explicit separator? A human writing "FOO/USDT" has said
 *      which half is the instrument, and that beats not knowing the ticker.
 *   4. Otherwise leave it alone. Not recognising a symbol is not a licence to
 *      start cutting letters off it.
 */
export function collapseToInstrument(
  raw: string | null | undefined,
  catalogue: BinanceSymbol[],
): string {
  const typed = (raw ?? "").trim().toUpperCase();
  if (!typed) return "";

  // TradingView writes perps as LTCUSDT.P; the suffix is notation, not name.
  const noPerp = typed.replace(/\.P$/, "");
  const sep = noPerp.match(/^([A-Z0-9]+)\s*[\/\-:]\s*([A-Z0-9]+)$/);
  const joined = sep ? `${sep[1]}${sep[2]}` : noPerp.replace(/[\s\/\-:]/g, "");
  if (!joined) return typed;

  const bases = new Set(catalogue.map((s) => s.baseAsset));
  if (bases.has(joined)) return joined;

  const pair = catalogue.find((s) => s.symbol === joined);
  if (pair) return pair.baseAsset;

  if (sep) return sep[1];

  /*
   * Last resort: peel a quote off the end, but only when what is left is a
   * coin the catalogue knows. That condition is the whole safety of it —
   * "LTCUSD" is not a listed pair anywhere, yet LTC plainly is a coin, while
   * "WBTC" never reaches here because step 1 already recognised it as one in
   * its own right. Without the condition this would happily turn any string
   * ending in three familiar letters into a shorter string.
   */
  for (const q of QUOTE_SUFFIXES) {
    if (!joined.endsWith(q) || joined.length <= q.length) continue;
    const stem = joined.slice(0, -q.length);
    if (bases.has(stem)) return stem;
  }
  return joined;
}

/**
 * The window the question is asked over: ENTRY to now.
 *
 * Not exit to now, which is what this did at first and is wrong in a way that
 * writes false answers. The question is what an UNTOUCHED plan would have
 * done, and an untouched plan is live from the moment of entry. Usually the
 * two agree, because a trade whose stop was hit while it was on would have
 * been stopped out rather than closed by hand — but the interesting trades
 * are exactly the ones where that is not true. Hold through your own stop and
 * close later at a better price, or widen the stop and close at breakeven,
 * and scanning only the aftermath skips the stop being hit and can come back
 * "target_first" on a trade the original plan lost. That is a confident wrong
 * answer in the one field this whole module exists to protect.
 */
export function scanWindow(
  t: { entryTime: string; exitTime?: string | null },
  now = Date.now(),
): { from: number; to: number } | null {
  const from = new Date(t.entryTime).getTime();
  if (!isFinite(from) || now <= from) return null;
  return { from, to: now };
}

