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
import { dayKey } from "./daily";

export { dayKey };

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
 * A setup that was seen and not taken.
 *
 * Stored as a cancelled trade because that is what it is — no position, no
 * P&L, out of every guardrail — and told apart from the other ways an order
 * dies by its reason. "Not filled" and "changed my mind" are things that
 * happened to an order; this one is a decision you made, which is the kind of
 * thing a week is read to find out about.
 */
export const isMiss = (t: TradeWithTags) =>
  t.status === "cancelled" && t.cancelReason === "never_placed";

/** When a trade had its say: the exit, or the entry for something never taken. */
const endedAt = (t: TradeWithTags) => t.exitTime ?? t.entryTime;

/**
 * The trades a week's review is about: everything that finished inside it,
 * newest last so the week reads forwards the way it happened.
 *
 * Closed trades and the ones you passed on. An open position has not finished
 * having its say, and an order that merely failed to fill was never a
 * decision — but a setup you looked at and let go is exactly the sort of
 * thing that only shows up read back in a row. Six passes in a week say
 * something; one says nothing, which is why it has to be reviewed rather
 * than logged and left.
 *
 * A miss is dated by its entry time, there being no exit to date it by.
 */
export function tradesInWeek(trades: TradeWithTags[], d: Date): TradeWithTags[] {
  const from = weekStart(d).getTime();
  const to = from + 7 * DAY;
  return trades
    .filter((t) => {
      if (t.status !== "closed" && !isMiss(t)) return false;
      const when = new Date(endedAt(t)).getTime();
      return Number.isFinite(when) && when >= from && when < to;
    })
    .sort((a, b) => endedAt(a).localeCompare(endedAt(b)));
}

/**
 * The same pass, on the day it happened.
 *
 * A week read end to end is the only way some patterns show up, and it is also
 * five days after the fact — by Sunday you are reconstructing what you thought
 * on Tuesday from a chart and a sentence. Doing it the same evening costs
 * nothing extra and the memory is still there.
 *
 * What makes the two worth having together rather than being two chores is
 * that there is only ONE reviewed flag on a trade. A trade gone over on
 * Tuesday is already done when Sunday comes: it shows as reviewed in the
 * week, it does not appear in the nag's count, and if every trade in a week
 * was handled on its own day the week is simply finished. Nothing syncs the
 * two because there is nothing to sync — the day and the week are two ways of
 * asking the same column.
 *
 * Which day a trade belongs to is the day it ENDED, the same instant the week
 * files it by: the day it stopped being a live question. A swing opened on
 * Monday and closed on Thursday is Thursday's to judge, because Thursday is
 * when there was something to judge.
 */
export function tradesOnDay(trades: TradeWithTags[], day: Date): TradeWithTags[] {
  const from = new Date(day);
  from.setHours(0, 0, 0, 0);
  const to = from.getTime() + DAY;
  return trades
    .filter((t) => {
      if (t.status !== "closed" && !isMiss(t)) return false;
      const when = new Date(endedAt(t)).getTime();
      return Number.isFinite(when) && when >= from.getTime() && when < to;
    })
    .sort((a, b) => endedAt(a).localeCompare(endedAt(b)));
}

export function dayLabel(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

export const isReviewed = (t: TradeWithTags) => Boolean(t.reviewedAt);

export interface ReviewProgress {
  /** The start of the scope — Monday for a week, midnight for a day. */
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
  return progressOver(inWeek, weekStart(d), weekKey(d), weekLabel(d));
}

/** The same figures for one day. Same flag, so the two agree by construction. */
export function dailyProgress(trades: TradeWithTags[], d: Date = new Date()): ReviewProgress {
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  return progressOver(tradesOnDay(trades, day), day, dayKey(day), dayLabel(day));
}

function progressOver(
  inScope: TradeWithTags[],
  start: Date,
  key: string,
  label: string,
): ReviewProgress {
  const left = inScope.filter((t) => !isReviewed(t));
  return {
    week: start,
    key,
    label,
    trades: inScope,
    reviewed: inScope.length - left.length,
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
  // "trades" covers both here on purpose. Splitting the count into "4 trades
  // and 2 misses" makes the nag about bookkeeping; what is owed is a pass
  // over the week's decisions, and passing on one was a decision.
  const which =
    due.weeksAgo === 0
      ? "this week"
      : due.weeksAgo === 1
        ? "last week"
        : `${due.weeksAgo} weeks ago`;
  const went = due.weeksAgo === 0 ? "go" : "went";
  return `${n} ${n === 1 ? "trade" : "trades"} from ${which} ${went} unreviewed.`;
}
