/**
 * Daily grouping — the day as the unit of review.
 *
 * The journal's row is the trade; the calendar's row is the day. This module
 * maps between them: which local day a trade belongs to, and what a day adds up
 * to. Everything quantitative about a day is derived from the trades on demand
 * — the daily_notes table stores only the written half, so the numbers can
 * never drift out of sync with the trade log they summarise.
 *
 * Days follow the browser's local clock, same as the weekly review. Times are
 * stored as UTC-ish ISO strings; converting through Date here means "the day I
 * traded" matches the day the trader lived, not the UTC date of the venue.
 */
import type { TradeWithTags } from "./schema";
import { computeMetrics } from "./metrics";

/** yyyy-MM-dd in local time — the canonical key for one trading day. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

export function dayKeyOfIso(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : dayKey(d);
}

/**
 * One day's ledger.
 *
 * Entered and closed are counted separately because a swing crosses days: it
 * belongs to one day's "what did I put on" and another day's "what did it
 * make". P&L and R are REALISED figures, attributed to the day the trade
 * closed — the convention every broker statement uses.
 */
export interface DaySummary {
  day: string;
  entered: number;
  closed: number;
  wins: number;
  losses: number;
  totalR: number;
  totalPnL: number;
}

function blank(day: string): DaySummary {
  return { day, entered: 0, closed: 0, wins: 0, losses: 0, totalR: 0, totalPnL: 0 };
}

/** Fold the whole trade log into per-day rows, keyed yyyy-MM-dd. */
export function summarizeDays(trades: TradeWithTags[]): Map<string, DaySummary> {
  const days = new Map<string, DaySummary>();
  const get = (k: string) => {
    const existing = days.get(k);
    if (existing) return existing;
    const fresh = blank(k);
    days.set(k, fresh);
    return fresh;
  };

  for (const t of trades) {
    // A cancelled order was never a position; it belongs to no day's ledger.
    if (t.status === "cancelled") continue;

    const enteredOn = t.status === "pending" ? null : dayKeyOfIso(t.entryTime);
    if (enteredOn) get(enteredOn).entered += 1;

    if (t.status === "closed" && t.exitPrice != null) {
      const closedOn = dayKeyOfIso(t.exitTime) ?? enteredOn;
      if (!closedOn) continue;
      const s = get(closedOn);
      const m = computeMetrics(t);
      s.closed += 1;
      if ((m.actualR ?? 0) > 0) s.wins += 1;
      else s.losses += 1;
      s.totalR += m.actualR ?? 0;
      s.totalPnL += m.actualPnL ?? 0;
    }
  }
  return days;
}

/** The trades that belong on one day's report: put on that day, or settled on it. */
export function tradesOnDay(
  trades: TradeWithTags[],
  day: string,
): { entered: TradeWithTags[]; closed: TradeWithTags[] } {
  const entered = trades.filter(
    (t) =>
      t.status !== "cancelled" &&
      t.status !== "pending" &&
      dayKeyOfIso(t.entryTime) === day,
  );
  const closed = trades.filter(
    (t) =>
      t.status === "closed" &&
      t.exitPrice != null &&
      (dayKeyOfIso(t.exitTime) ?? dayKeyOfIso(t.entryTime)) === day,
  );
  return { entered, closed };
}

/**
 * The days a month view must draw: a Monday-aligned grid covering the month.
 * Monday-first matches the weekly review, so the calendar's columns and the
 * week's boundaries tell one story.
 */
export function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  const cells: Date[] = [];
  const d = new Date(start);
  // 6 rows of 7 always covers a month, and a fixed height keeps the grid
  // from jumping as you page between months.
  for (let i = 0; i < 42; i++) {
    cells.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return cells;
}
