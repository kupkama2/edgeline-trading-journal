/**
 * The Sunday pass.
 *
 * Every trade here was logged in the minute after it closed, with the screen
 * still in front of you — which is the only moment you will ever write down
 * what you were thinking, and the worst moment to judge it. Judging is what
 * a week laid out end to end is for: the same six trades read in a row say
 * things no single one of them says, and the pattern is the whole point of
 * keeping the record at all.
 *
 * So a review is a second pass, tracked per trade rather than per week. A
 * week is reviewed when its trades are, which needs no separate record to
 * fall out of step with the trades themselves, and leaves a half-finished
 * Sunday exactly where you left it rather than all-or-nothing.
 *
 * It comes due on Sunday and does not stop being due. A nag that clears
 * itself on Monday is a nag for people who were going to do it anyway.
 */
import type { TradeWithTags } from "./schema";

const DAY = 24 * 60 * 60 * 1000;

/** Monday 00:00 local, of the week containing `d`. */
export function weekStart(d: Date = new Date()): Date {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
  return s;
}

/** The Monday of the week `n` weeks before the one containing `d`. */
export function weekBefore(d: Date, n = 1): Date {
  const s = weekStart(d);
  s.setDate(s.getDate() - 7 * n);
  return s;
}

/** "2026-09-14" — the key a week is remembered by. */
export function weekKey(d: Date): string {
  const s = weekStart(d);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${s.getFullYear()}-${p(s.getMonth() + 1)}-${p(s.getDate())}`;
}

export function weekLabel(d: Date): string {
  const from = weekStart(d);
  const to = new Date(from.getTime() + 6 * DAY);
  const fmt = (x: Date) => x.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${fmt(from)} – ${fmt(to)}`;
}

/**
 * The trades a week's review is about: everything that finished inside it,
 * newest last so the week reads forwards the way it happened.
 *
 * Closed trades only. An open position has not finished having its say, and
 * a cancelled order was never a trade.
 */
export function tradesInWeek(trades: TradeWithTags[], d: Date): TradeWithTags[] {
  const from = weekStart(d).getTime();
  const to = from + 7 * DAY;
  return trades
    .filter((t) => {
      if (t.status !== "closed") return false;
      const when = new Date(t.exitTime ?? t.entryTime).getTime();
      return Number.isFinite(when) && when >= from && when < to;
    })
    .sort((a, b) => (a.exitTime ?? a.entryTime).localeCompare(b.exitTime ?? b.entryTime));
}

export const isReviewed = (t: TradeWithTags) => Boolean(t.reviewedAt);

export interface ReviewProgress {
  week: Date;
  key: string;
  label: string;
  trades: TradeWithTags[];
  reviewed: number;
  /** Still to go, in the order they happened. */
  left: TradeWithTags[];
  /** Every trade in the week has been gone over. A week with none is done. */
  done: boolean;
}

export function reviewProgress(trades: TradeWithTags[], d: Date = new Date()): ReviewProgress {
  const inWeek = tradesInWeek(trades, d);
  const left = inWeek.filter((t) => !isReviewed(t));
  return {
    week: weekStart(d),
    key: weekKey(d),
    label: weekLabel(d),
    trades: inWeek,
    reviewed: inWeek.length - left.length,
    left,
    done: left.length === 0,
  };
}

/**
 * Is a review owed, and for which week?
 *
 * Due from Sunday, for the week that Sunday ends. Once the week is over it
 * stays owed until it is done — an unreviewed week does not expire, it just
 * gets older, and the nag says how old.
 *
 * The newest owed week is the one offered: reviewing last week while three
 * weeks sit behind it is still progress, and a list of every week you ever
 * missed is a reason to close the tab.
 */
export function reviewDue(
  trades: TradeWithTags[],
  now: Date = new Date(),
): { week: Date; weeksAgo: number; progress: ReviewProgress } | null {
  const sunday = now.getDay() === 0;
  // This week only counts once it has reached its Sunday; earlier weeks
  // always count, whatever day it is now.
  const start = sunday ? 0 : 1;
  for (let back = start; back <= 8; back++) {
    const week = weekBefore(now, back);
    const progress = reviewProgress(trades, week);
    if (progress.trades.length > 0 && !progress.done) {
      return { week, weeksAgo: back, progress };
    }
  }
  return null;
}

/** How the nag puts it. */
export function dueSentence(due: { weeksAgo: number; progress: ReviewProgress }): string {
  const n = due.progress.left.length;
  const which =
    due.weeksAgo === 0
      ? "this week"
      : due.weeksAgo === 1
        ? "last week"
        : `${due.weeksAgo} weeks ago`;
  const went = due.weeksAgo === 0 ? "go" : "went";
  return `${n} ${n === 1 ? "trade" : "trades"} from ${which} ${went} unreviewed.`;
}
