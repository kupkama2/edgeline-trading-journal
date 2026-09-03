/**
 * Hyperliquid's perp universe, read without a network.
 *
 * Hyperliquid is the other venue these trades happen on, and it is a simpler
 * one to describe than Binance: there is no spot pair sharing a name with the
 * perp, no quote currency to choose, no quarterly to skip. The universe is a
 * flat list of coins, one perp each, and the coin IS the instrument.
 *
 * Two things are kept exactly as the venue says them, on purpose.
 *
 *   The name. Hyperliquid writes a thousand-lot with a k — kPEPE is what the
 *   exchange calls a thousand PEPE, and it is what the trader saw on the
 *   order ticket. Rewriting it to 1000PEPE (Binance's spelling) would offer a
 *   name in the picker that appears on no screen they trade from.
 *
 *   The delisted flag. A delisted coin is not dropped, because an old trade
 *   on it still has to be recognised as a Hyperliquid perp; it is flagged, so
 *   the picker can leave it out of what it offers for a NEW trade.
 *
 * Everything here is pure. The fetch lives in server/hyperliquid.ts.
 */
export interface HyperliquidPerp {
  /** The coin as Hyperliquid names it: "BTC", "kPEPE". */
  name: string;
  maxLeverage: number | null;
  delisted: boolean;
}

/**
 * Read the venue's `meta` answer: `{ universe: [{ name, maxLeverage, isDelisted? }] }`.
 *
 * Shaped wrong means nothing, not a partial list — a caller that stores what
 * this returns must not be handed half a universe because one field moved.
 * Within a well-shaped answer, an entry without a usable name is skipped and
 * the rest kept; one bad entry is not a reason to forget two hundred coins.
 */
export function parseHyperliquidMeta(json: unknown): HyperliquidPerp[] {
  const universe = (json as { universe?: unknown } | null)?.universe;
  if (!Array.isArray(universe)) return [];
  const out: HyperliquidPerp[] = [];
  const seen = new Set<string>();
  for (const u of universe as Array<Record<string, unknown>>) {
    const name = typeof u?.name === "string" ? u.name.trim() : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const lev = Number(u.maxLeverage);
    out.push({
      name,
      maxLeverage: Number.isFinite(lev) && lev > 0 ? lev : null,
      delisted: u.isDelisted === true,
    });
  }
  return out;
}

/** Where a trade happens. Read off the account, which is where people write it. */
export type Venue = "binance" | "hyperliquid";

/**
 * Which venue an account name points at, or null when it does not say.
 *
 * Accounts here are free text — "Binance Futures", "Hyperliquid", "HL main"
 * — so this is a reading of the name, not a lookup. It only ever RANKS the
 * picker (which venue's perps come first); it never decides what a symbol
 * means, so a wrong read costs a scroll and nothing else.
 */
export function venueOfAccount(name: string | null | undefined): Venue | null {
  const n = (name ?? "").toLowerCase();
  if (!n) return null;
  if (/hyper|\bhl\b/.test(n)) return "hyperliquid";
  if (/binance|\bbn\b/.test(n)) return "binance";
  return null;
}
