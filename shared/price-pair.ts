/**
 * Telling the journal which book a trade happened in, by hand.
 *
 * Every price the journal reads for you — did the stop get hit, how far did it
 * run, what did it do after you were out — comes from candles, and candles
 * come from a pair on a venue. That pair is normally worked out from the
 * ticker: BTC becomes BTCUSDT on Binance, or BTC on Hyperliquid when the
 * account says so.
 *
 * When that fails, it fails silently and permanently. An unmatched trade is
 * counted and skipped, and — because there is nothing to record about a read
 * that never happened — it is never stamped as checked, so it goes back to the
 * head of the queue and is skipped again tomorrow. Nothing looks broken. The
 * trade simply never gets an answer.
 *
 * So the ticker stops being the only way to say it. A trade can be pointed at
 * a pair directly, and that answer wins over anything guessed — including the
 * guess that a trade with a contract code is not a crypto trade at all, since
 * somebody choosing a pair by hand knows something the parser does not.
 *
 * Stored as one string rather than three columns, because it is one fact and
 * it is read far more often than it is written:
 *
 *     binance:BTCUSDT:futures
 *     binance:ETHUSDT:spot
 *     hyperliquid:BTC          (always futures — the venue has nothing else)
 */
import type { PairRef } from "./binance";

/** The venues a pair can be read from. */
export const PAIR_VENUES = ["binance", "hyperliquid"] as const;

export function formatPricePair(ref: PairRef): string {
  const venue = ref.venue ?? "binance";
  if (venue === "hyperliquid") return `hyperliquid:${ref.symbol}`;
  return `binance:${ref.symbol}:${ref.market === "futures" ? "futures" : "spot"}`;
}

/**
 * Read one back. Anything malformed is null rather than a guess — a stored
 * override that cannot be understood must behave as no override at all, so a
 * bad row falls back to the ticker rather than sending the reader somewhere
 * arbitrary.
 */
export function parsePricePair(raw: string | null | undefined): PairRef | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const parts = text.split(":");
  const venue = parts[0]?.toLowerCase();
  const symbol = parts[1]?.trim().toUpperCase();
  if (!symbol) return null;

  if (venue === "hyperliquid") {
    // The venue lists perpetuals and nothing else, so a market segment here
    // would be a third thing to keep consistent and never a third answer.
    return parts.length > 3 ? null : { symbol, market: "futures", venue: "hyperliquid" };
  }
  if (venue === "binance") {
    if (parts.length !== 3) return null;
    const market = parts[2]?.toLowerCase();
    if (market !== "futures" && market !== "spot") return null;
    return { symbol, market, venue: "binance" };
  }
  return null;
}

/** "Binance BTCUSDT perp", for a label that has to fit on one line. */
export function describePair(ref: PairRef): string {
  if ((ref.venue ?? "binance") === "hyperliquid") return `Hyperliquid ${ref.symbol} perp`;
  return `Binance ${ref.symbol} ${ref.market === "futures" ? "perp" : "spot"}`;
}

/**
 * Pairs worth offering for a ticker, best first.
 *
 * Ranked rather than filtered: a ticker that matches nothing exactly still
 * wants a list, because the reason the automatic match failed is usually that
 * the journal's spelling and the venue's differ by a prefix or a suffix — and
 * the trader can see at a glance which row is theirs. An exact base-asset
 * match sorts to the top, then a prefix, then anything containing it.
 *
 * Perps before spot within each tier: these are the trades this journal
 * mostly holds, and settling a perp trade on spot candles answers the question
 * against a book the order was never resting in.
 *
 * And USDT ahead of every other quote among otherwise equal rows. BTCUSDC and
 * BTCUSDT are both exact matches for BTC and would otherwise be ordered
 * alphabetically, which puts the thin book first — the deep one is the one
 * that printed the wick that took the stop.
 */
export function pairCandidates(
  symbol: string,
  binance: { symbol: string; baseAsset: string; quoteAsset?: string; market: "futures" | "spot" }[],
  hyperliquid: { name: string }[],
  limit = 30,
): PairRef[] {
  const want = symbol.trim().toUpperCase();
  if (!want) return [];

  const scored: { ref: PairRef; rank: number; quote: number }[] = [];
  const rankOf = (base: string) => {
    if (base === want) return 0;
    if (base.startsWith(want) || want.startsWith(base)) return 1;
    if (base.includes(want) || want.includes(base)) return 2;
    return -1;
  };

  for (const p of hyperliquid) {
    const rank = rankOf(p.name.toUpperCase());
    if (rank >= 0) {
      scored.push({
        ref: { symbol: p.name, market: "futures", venue: "hyperliquid" },
        rank,
        quote: 0,
      });
    }
  }
  for (const s of binance) {
    const rank = rankOf(s.baseAsset.toUpperCase());
    if (rank >= 0) {
      scored.push({
        ref: { symbol: s.symbol, market: s.market, venue: "binance" },
        // Half a tier, so a perp outranks the spot pair of the same coin
        // without ever outranking an exact match on the other side of it.
        rank: rank * 2 + (s.market === "futures" ? 0 : 1),
        quote: (s.quoteAsset ?? "").toUpperCase() === "USDT" ? 0 : 1,
      });
    }
  }

  return scored
    .sort(
      (a, b) =>
        a.rank - b.rank || a.quote - b.quote || a.ref.symbol.localeCompare(b.ref.symbol),
    )
    .slice(0, limit)
    .map((x) => x.ref);
}
