/**
 * Sources that were living inside the tag list.
 *
 * Before `source` was a column, "this was Severin's call" had nowhere to go
 * except the rationale tags — so that is where it went, next to "61.8 Fib"
 * and "Reclaim". A person's name in the setup list is not a setup: it splits
 * the Setup breakdown with rows that are really the Source breakdown's, and
 * it keeps the trade out of the source stats that exist to judge exactly that
 * call. The name moves to the column that can price it; nothing is deleted.
 */

/** Case-insensitive membership, tolerant of the spacing a typed tag carries. */
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Pull a source out of a tag list, if exactly one is hiding in it.
 *
 * - An already-set source wins: the explicit field is the deliberate answer,
 *   and a leftover tag must not overwrite it. The tag still moves out.
 * - Two DIFFERENT source names in one tag list is ambiguous — a trade has one
 *   origin — so nothing moves and the caller keeps what was typed.
 * - Unknown tags pass through untouched; this promotes, it never filters.
 */
export function splitSourceFromTags(
  tags: string[],
  knownSources: string[],
  currentSource: string | null,
): { tags: string[]; source: string | null } {
  const hits = knownSources.filter((s) => tags.some((t) => same(t, s)));
  if (hits.length === 0) return { tags, source: currentSource };

  const rest = tags.filter((t) => !hits.some((s) => same(t, s)));
  if (currentSource?.trim()) {
    // The field already says whose call it was; the tag is just a duplicate
    // of that claim (or noise), and duplicates of a claim are how two
    // breakdowns end up disagreeing about one trade.
    return { tags: rest, source: currentSource };
  }
  if (hits.length > 1) return { tags, source: currentSource };
  return { tags: rest, source: hits[0] };
}
