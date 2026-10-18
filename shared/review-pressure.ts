/**
 * What the journal owes you a look at, and how hard to push.
 *
 * A review that waits to be remembered does not happen. The weekly pass is
 * five days late by design, and the daily one was a word in the corner of a
 * day header. So the debt is counted, and the count gets louder with age:
 *
 *   clear    — nothing owed.
 *   today    — today's trades are done and not gone over. A suggestion: the
 *              day is not over, and evening is when this is meant to happen.
 *   owed     — a trade from a day that has ended, within the grace. The
 *              journal says so at the top of the page.
 *   overdue  — older than the grace. In "remind" mode the journal says so in
 *              red; in "enforce" mode the record and the statistics stay shut
 *              until those days are gone over (see client/src/components/
 *              review-debt.tsx for what stays open, and why).
 *
 * One rule, so the badge, the banner and the gate can never disagree: a
 * trade is owed when it has finished having its say (closed, or passed on)
 * and nobody has marked it reviewed. Which day it belongs to is the day it
 * ended — the same rule the daily and weekly review pages file it by, so a
 * day cleared here is a day cleared there.
 */
import type { TradeWithTags } from "./schema";
import { dayKey, isMiss, isReviewed } from "./review";

export type ReviewMode = "off" | "remind" | "enforce";
export type ReviewLevel = "clear" | "today" | "owed" | "overdue";

/** Days a finished day may sit unreviewed before it is overdue: yesterday is owed, the day before is late. */
export const REVIEW_GRACE_DAYS = 1;

export interface OwedDay {
  /** yyyy-MM-dd, the local trading day. */
  key: string;
  /** Whole calendar days between that day and today. */
  age: number;
  trades: TradeWithTags[];
}

export interface ReviewDebt {
  level: ReviewLevel;
  /** Finished before today and not reviewed, oldest day first. */
  days: OwedDay[];
  /** How many trades across `days`. */
  owed: number;
  /** Of those, how many are past the grace. */
  overdue: number;
  /** Today's finished, unreviewed trades. */
  today: TradeWithTags[];
  /** The day to send someone to first: the oldest owed, else today. */
  next: string | null;
  /**
   * Whether the overdue part is old enough to close the record in "enforce"
   * mode. Separate from `level`, because only trades that finished after
   * enforcement was turned on may lock anything: switching it on must not
   * lock a person out over a backlog they never agreed to be held to.
   */
  gate: boolean;
}

const finished = (t: TradeWithTags) => t.status === "closed" || isMiss(t);
const endedAt = (t: TradeWithTags) => t.exitTime ?? t.entryTime;

/** Local midnight, as a number, for whole-day arithmetic that survives DST. */
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const daysBetween = (a: Date, b: Date) => Math.round((midnight(b) - midnight(a)) / 86_400_000);

export function reviewDebt(
  trades: ReadonlyArray<TradeWithTags>,
  now: Date = new Date(),
  opts: { graceDays?: number; gateSince?: string | null } = {},
): ReviewDebt {
  const grace = opts.graceDays ?? REVIEW_GRACE_DAYS;
  const since = opts.gateSince ? Date.parse(opts.gateSince) : Number.NEGATIVE_INFINITY;
  const todayKey = dayKey(now);

  const byDay = new Map<string, { at: Date; trades: TradeWithTags[] }>();
  const today: TradeWithTags[] = [];
  let gate = false;

  for (const t of trades) {
    if (!finished(t) || isReviewed(t)) continue;
    const at = new Date(endedAt(t));
    if (Number.isNaN(at.getTime())) continue;
    const key = dayKey(at);
    if (key === todayKey) {
      today.push(t);
      continue;
    }
    // A trade dated in the future (a typo) is not owed yet, and must not be
    // what locks the journal: there is nothing to remember about it.
    if (key > todayKey) continue;
    const slot = byDay.get(key) ?? { at, trades: [] };
    slot.trades.push(t);
    byDay.set(key, slot);
    if (daysBetween(at, now) > grace && at.getTime() >= since) gate = true;
  }

  const days: OwedDay[] = Array.from(byDay.entries())
    .map(([key, v]) => ({
      key,
      age: daysBetween(v.at, now),
      trades: v.trades.sort((a, b) => endedAt(a).localeCompare(endedAt(b))),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const owed = days.reduce((n, d) => n + d.trades.length, 0);
  const overdue = days.filter((d) => d.age > grace).reduce((n, d) => n + d.trades.length, 0);
  const level: ReviewLevel = overdue > 0 ? "overdue" : owed > 0 ? "owed" : today.length > 0 ? "today" : "clear";

  return {
    level,
    days,
    owed,
    overdue,
    today,
    next: days[0]?.key ?? (today.length ? todayKey : null),
    gate,
  };
}

/** "Tuesday", "yesterday", or "12 Oct" for anything older than a week. */
export function owedDayName(d: Pick<OwedDay, "key" | "age">): string {
  if (d.age === 1) return "yesterday";
  const [y, m, day] = d.key.split("-").map(Number);
  const at = new Date(y, m - 1, day, 12);
  return d.age < 7
    ? at.toLocaleDateString(undefined, { weekday: "long" })
    : at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The banner's sentence. */
export function debtSentence(debt: ReviewDebt): string {
  const n = (k: number) => `${k} ${k === 1 ? "trade" : "trades"}`;
  if (debt.level === "today") return `${n(debt.today.length)} from today not gone over yet.`;
  if (debt.days.length === 0) return "Nothing to go over.";
  const oldest = debt.days[0];
  if (debt.days.length === 1) return `${n(debt.owed)} from ${owedDayName(oldest)} not gone over.`;
  return `${n(debt.owed)} not gone over, across ${debt.days.length} days — the oldest from ${owedDayName(oldest)}.`;
}

/**
 * Whether the gate is open right now: enforcing, something old enough to
 * lock, and no snooze running. The snooze is once a day for an hour — enough
 * to check a position or a number in a hurry, not enough to live in.
 */
export const SNOOZE_MS = 60 * 60 * 1000;

export function gateShut(
  mode: ReviewMode,
  debt: ReviewDebt,
  snooze: { day: string; until: number } | null,
  now: Date = new Date(),
): boolean {
  if (mode !== "enforce" || !debt.gate) return false;
  return !(snooze && snooze.day === dayKey(now) && snooze.until > now.getTime());
}

/** A snooze may be taken when none has been taken today. */
export const canSnooze = (snooze: { day: string } | null, now: Date = new Date()) =>
  !snooze || snooze.day !== dayKey(now);
