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
import { computeMetrics } from "./metrics";
import { dayKeyOfIso } from "./daily";

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
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * Trades a breakdown can speak about: closed, with a realised outcome.
 * A pending order has no result, and an open one has not finished being wrong.
 */
export function closedTrades(trades: TradeWithTags[]): TradeWithTags[] {
  return trades.filter((t) => t.status === "closed" && t.exitPrice != null);
}

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
          winRate: 0, totalR: 0, totalPnL: 0, expectancyR: 0,
        };
        buckets.set(key, b);
      }
      b.count += 1;
      if (r > 0) b.wins += 1;
      else b.losses += 1;
      b.totalR += r;
      b.totalPnL += m.actualPnL ?? 0;
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
  const byDay = new Map<string, DayResult>();
  for (const t of closedTrades(trades)) {
    // Realised P&L belongs to the day it was realised, which is the convention
    // every broker statement uses. Falls back to entry for a same-day trade
    // whose exit time was never recorded.
    const day = dayKeyOfIso(t.exitTime) ?? dayKeyOfIso(t.entryTime);
    if (!day) continue;
    const m = computeMetrics(t);
    const row = byDay.get(day) ?? { day, r: 0, pnl: 0, trades: 0 };
    row.r += m.actualR ?? 0;
    row.pnl += m.actualPnL ?? 0;
    row.trades += 1;
    byDay.set(day, row);
  }
  return Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
}
