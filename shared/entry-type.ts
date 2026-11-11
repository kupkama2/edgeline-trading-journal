/**
 * How a trade was entered: a limit that rested on the book, or a market
 * entry that took what was there.
 *
 * The venue answers this on every fill, and it answers the question that
 * matters rather than the one the order ticket asks. A fill that RESTED and
 * was hit is a maker fill; one that crossed the spread is a taker fill. So
 * a market order, a stop-market breakout and a limit priced through the
 * book all read as "market" here — each of them paid the spread to get in
 * now — and only an order that waited for price to come to it reads as a
 * limit. That is the line a "do my limit entries beat my market entries?"
 * question is drawing: waiting versus chasing.
 *
 * The entry ORDER decides, not every fill of the position. Adds are a
 * different decision made later, and a scale-in by market onto a limit
 * entry is still a trade that was entered by limit. Within the entry order,
 * the size decides: a limit that crossed for a sliver and rested for the
 * rest is a limit entry.
 */
export const ENTRY_TYPES = ["limit", "market"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const ENTRY_TYPE_LABEL: Record<EntryType, string> = { limit: "Limit", market: "Market" };

export const isEntryType = (v: unknown): v is EntryType => v === "limit" || v === "market";

/** One opening fill as the classifier needs it. `maker` null or missing: the venue did not say. */
export interface EntryLeg {
  sz: number;
  maker?: boolean | null;
  /** The order the fill belongs to; 0 or missing when the venue gave none. */
  oid?: number | null;
}

/**
 * The entry type from a position's opening fills, in the order they filled.
 * Null when the entry order's fills do not say which side of the book they
 * were on.
 */
export function entryTypeOf(opens: readonly EntryLeg[]): EntryType | null {
  if (!opens.length) return null;
  const first = opens[0];
  // The entry order: every leg with the first leg's id. Without an id, the first leg alone.
  const legs = first.oid ? opens.filter((l) => l.oid === first.oid) : [first];
  let maker = 0;
  let taker = 0;
  for (const l of legs) {
    if (l.maker === true) maker += Math.abs(l.sz);
    else if (l.maker === false) taker += Math.abs(l.sz);
  }
  if (maker === 0 && taker === 0) return null;
  return maker >= taker ? "limit" : "market";
}
