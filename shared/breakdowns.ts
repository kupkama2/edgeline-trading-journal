/**
 * Slicing the record by when, what, and why.
 *
 * The aggregate says what your trading is worth. This says where that number
 * comes from — which hour, which weekday, which instrument, which setup. A
 * session trader's most answerable question is "do I give it back after 11am?",
 * and the data to answer it has always been in the trade log; nothing was
 * asking it.
 *
 * Everything here is one shape (`Slice`) over one dimension, so a new
 * breakdown is a new key function rather than new plumbing. Pure and shared:
 * the client renders it without a round trip, and an export can reuse it.
 */
import type { MistakeTag, TradeWithTags } from "./schema";
import { closedTrades, computeMetrics } from "./metrics";
import { summarizeDays } from "./daily";
import { parseHighlights } from "./highlights";

// Re-exported so slice consumers keep one import site for "trades stats may
// speak about"; the definition lives with the rest of the metric vocabulary.
export { closedTrades };

/** One bucket of trades, already reduced to the numbers worth showing. */
export interface Slice {
  /** Stable identity for sorting and lookup — an hour number, a symbol, a tag id. */
  key: string;
  label: string;
  count: number;
  wins: number;
  losses: number;
  winRate: number;
  totalR: number;
  totalPnL: number;
  /** Mean R per trade in this bucket — the figure that survives comparison
      between buckets of different sizes. */
  expectancyR: number;
  /** Commission paid across the bucket. totalPnL is already net of it. */
  totalFees: number;
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * Bucket trades by an arbitrary key.
 *
 * `keyOf` returns null for a trade that does not belong in this breakdown at
 * all (a trade with no tags contributes to no tag bucket), and may return
 * several keys for a trade that belongs in more than one — which is why tags
 * work here without a special case. A trade in two buckets is counted in both,
 * so tag columns intentionally do not sum to the total.
 */
export function sliceBy(
  trades: TradeWithTags[],
  keyOf: (t: TradeWithTags) => { key: string; label: string }[] | { key: string; label: string } | null,
): Slice[] {
  const buckets = new Map<string, Slice>();

  for (const t of closedTrades(trades)) {
    const raw = keyOf(t);
    if (!raw) continue;
    const keys = Array.isArray(raw) ? raw : [raw];
    const m = computeMetrics(t);
    const r = m.actualR ?? 0;

    for (const { key, label } of keys) {
      let b = buckets.get(key);
      if (!b) {
        b = {
          key, label, count: 0, wins: 0, losses: 0,
          winRate: 0, totalR: 0, totalPnL: 0, expectancyR: 0, totalFees: 0,
        };
        buckets.set(key, b);
      }
      b.count += 1;
      if (r > 0) b.wins += 1;
      else b.losses += 1;
      b.totalR += r;
      b.totalPnL += m.actualPnL ?? 0;
      b.totalFees += m.fees;
    }
  }

  for (const b of Array.from(buckets.values())) {
    b.winRate = b.count ? b.wins / b.count : 0;
    b.expectancyR = b.count ? b.totalR / b.count : 0;
  }
  return Array.from(buckets.values());
}

/**
 * By hour of the trading day, keyed on ENTRY time.
 *
 * Entry rather than exit on purpose: the question is when you decide to put
 * risk on, and a swing held overnight says nothing about the hour it closed.
 * Only hours you actually traded appear — a 24-row table of mostly zeroes
 * hides the four rows that matter.
 */
export function byHour(trades: TradeWithTags[]): Slice[] {
  return sliceBy(trades, (t) => {
    const d = new Date(t.entryTime);
    if (isNaN(d.getTime())) return null;
    const h = d.getHours();
    return { key: String(h).padStart(2, "0"), label: `${String(h).padStart(2, "0")}:00` };
  }).sort((a, b) => a.key.localeCompare(b.key));
}

/** By weekday of entry, Monday first to match the weekly review. */
export function byWeekday(trades: TradeWithTags[]): Slice[] {
  return sliceBy(trades, (t) => {
    const d = new Date(t.entryTime);
    if (isNaN(d.getTime())) return null;
    const idx = (d.getDay() + 6) % 7; // Monday = 0
    return { key: String(idx), label: WEEKDAYS[idx] };
  }).sort((a, b) => Number(a.key) - Number(b.key));
}

/** By instrument, busiest first — the ranking you actually read it for. */
export function bySymbol(trades: TradeWithTags[]): Slice[] {
  return sliceBy(trades, (t) =>
    t.symbol ? { key: t.symbol, label: t.symbol } : null,
  ).sort((a, b) => b.count - a.count);
}

/**
 * By mistake tag. A trade carrying two demons lands in both buckets, so these
 * counts overlap by design — the question is "what do trades with this demon
 * average", not "how do my trades partition".
 */
export function byMistake(trades: TradeWithTags[], tags: MistakeTag[]): Slice[] {
  const names = Object.fromEntries(tags.map((t) => [t.id, t.name]));
  return sliceBy(trades, (t) =>
    t.mistakeTagIds
      .filter((id) => names[id])
      .map((id) => ({ key: String(id), label: names[id] })),
  ).sort((a, b) => a.totalR - b.totalR); // costliest first
}

/**
 * By account — prop eval vs live vs exchange. The same trade idea can behave
 * very differently under different rules (trailing drawdown, fees, leverage),
 * and this is where that difference becomes a number. Trades logged before
 * accounts existed carry none and simply sit this table out.
 */
export function byAccount(trades: TradeWithTags[]): Slice[] {
  return sliceBy(trades, (t) => {
    const a = t.account?.trim();
    return a ? { key: a, label: a } : null;
  }).sort((a, b) => b.count - a.count);
}

/**
 * By whose idea it was.
 *
 * Unlike every other breakdown here, the EMPTY bucket is the point. A trade
 * with no source is not missing data — it is your own idea, and it is the
 * baseline the followed calls have to beat. Dropping it the way byAccount
 * drops accountless trades would leave a table of coaches with nothing to
 * compare them against, which is the only comparison that matters: following
 * someone is only worth it if it beats not following them.
 *
 * Labelled rather than keyed on null so it sorts, renders and links like any
 * other row.
 */
export const OWN_IDEA_LABEL = "My own ideas";

export function bySource(trades: TradeWithTags[]): Slice[] {
  return sliceBy(trades, (t) => {
    const s = t.source?.trim();
    return s ? { key: s, label: s } : { key: "", label: OWN_IDEA_LABEL };
  }).sort((a, b) => b.count - a.count);
}

/**
 * By green flag. Same overlapping shape as demons — a trade with a perfect
 * entry AND a perfect stop counts in both — and the same purpose inverted:
 * this is what turns "I executed well" into an expectancy you can check.
 */
export function byHighlight(trades: TradeWithTags[]): Slice[] {
  return sliceBy(trades, (t) =>
    parseHighlights(t.highlights).map((h) => ({ key: h, label: h })),
  ).sort((a, b) => b.totalR - a.totalR); // best first — the mirror of demons
}

/** By setup, read from the AI-normalised rationale tags. */
export function bySetup(trades: TradeWithTags[]): Slice[] {
  return sliceBy(trades, (t) => {
    if (!t.rationaleTags) return null;
    try {
      const parsed = JSON.parse(t.rationaleTags);
      if (!Array.isArray(parsed)) return null;
      return parsed
        .filter((s): s is string => typeof s === "string" && s.trim() !== "")
        .map((s) => ({ key: s, label: s }));
    } catch {
      return null;
    }
  }).sort((a, b) => b.count - a.count);
}

/**
 * One day's realised result, oldest first — the series every equity curve,
 * drawdown and best/worst-day figure is built from.
 */
export interface DayResult {
  day: string;
  r: number;
  pnl: number;
  trades: number;
}

export function dailyResults(trades: TradeWithTags[]): DayResult[] {
  // One fold owns "which day does a result belong to": summarizeDays, which the
  // calendar already uses. Deriving from it (rather than re-implementing the
  // exit-day attribution here) means the equity curve, the drawdown figures and
  // the calendar can never disagree about what a day made.
  return Array.from(summarizeDays(trades).values())
    .filter((s) => s.closed > 0)
    .map((s) => ({ day: s.day, r: s.totalR, pnl: s.totalPnL, trades: s.closed }))
    .sort((a, b) => a.day.localeCompare(b.day));
}
