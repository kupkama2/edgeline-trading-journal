/**
 * The same record, at three zoom levels.
 *
 * A day tells you what just happened, a week tells you whether it was a good
 * week, and a month tells you whether any of it is a trend. The calendar only
 * ever showed the first, which made the second and third a manual exercise in
 * squinting at thirty cells.
 *
 * Weeks are Monday-anchored to match the weekly review; months are calendar
 * months. Both bucket on the day a trade CLOSED — the same attribution the
 * calendar and the equity curve already use, so no two surfaces can disagree
 * about which period a result belongs to.
 */
import type { TradeWithTags } from "./schema";
import { summarizeDays } from "./daily";

export type Period = "day" | "week" | "month";

export interface PeriodBucket {
  /** ISO-ish key: 2026-08-09, 2026-W32 or 2026-08. */
  key: string;
  label: string;
  /** First day covered, for sorting and for opening the right day. */
  start: string;
  closed: number;
  wins: number;
  losses: number;
  winRate: number;
  totalR: number;
  totalPnL: number;
  /** Days inside this bucket that produced at least one close. */
  activeDays: number;
}

/** Monday of the week containing `day` (a YYYY-MM-DD string). */
export function mondayOf(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function isoWeekLabel(monday: string): string {
  const d = new Date(`${monday}T12:00:00`);
  // ISO week number: Thursday of this week decides the year.
  const thu = new Date(d);
  thu.setDate(thu.getDate() + 3);
  const jan1 = new Date(thu.getFullYear(), 0, 1);
  const week = Math.ceil(((thu.getTime() - jan1.getTime()) / 86400000 + 1) / 7);
  return `${thu.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Roll the day summaries up to the requested period, oldest first. Only
 * periods that actually contain a close appear — an empty August is not a
 * result, and padding the list with zeroes buries the months that are.
 */
export function byPeriod(trades: TradeWithTags[], period: Period): PeriodBucket[] {
  const days = Array.from(summarizeDays(trades).values()).filter((d) => d.closed > 0);
  const buckets = new Map<string, PeriodBucket>();

  for (const d of days) {
    const key =
      period === "day" ? d.day : period === "week" ? mondayOf(d.day) : d.day.slice(0, 7);
    let b = buckets.get(key);
    if (!b) {
      b = {
        key: period === "week" ? isoWeekLabel(key) : key,
        label: labelFor(period, key),
        start: period === "month" ? `${key}-01` : key,
        closed: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        totalR: 0,
        totalPnL: 0,
        activeDays: 0,
      };
      buckets.set(key, b);
    }
    b.closed += d.closed;
    b.wins += d.wins;
    b.losses += d.losses;
    b.totalR += d.totalR;
    b.totalPnL += d.totalPnL;
    b.activeDays += 1;
  }

  const out = Array.from(buckets.values());
  for (const b of out) b.winRate = b.closed ? b.wins / b.closed : 0;
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

function labelFor(period: Period, key: string): string {
  if (period === "day") {
    return new Date(`${key}T12:00:00`).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }
  if (period === "week") {
    const start = new Date(`${key}T12:00:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const fmt = (d: Date) =>
      d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `${fmt(start)} – ${fmt(end)}`;
  }
  return new Date(`${key}-01T12:00:00`).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

/** Which figure a period cell shows. */
export type PeriodMetric = "pnl" | "r" | "trades" | "winRate";

export const METRIC_LABELS: Record<PeriodMetric, string> = {
  pnl: "P&L",
  r: "R",
  trades: "Trades",
  winRate: "Win %",
};

/** The chosen metric, and whether it counts as good/bad/neutral for colour. */
export function metricOf(
  b: Pick<PeriodBucket, "totalPnL" | "totalR" | "closed" | "winRate">,
  metric: PeriodMetric,
): { value: number; tone: "good" | "bad" | "flat" } {
  switch (metric) {
    case "r":
      return { value: b.totalR, tone: b.totalR > 0 ? "good" : b.totalR < 0 ? "bad" : "flat" };
    case "trades":
      // Volume is not virtue: a busy day is neither good nor bad by itself.
      return { value: b.closed, tone: "flat" };
    case "winRate":
      return {
        value: b.winRate,
        tone: b.winRate >= 0.5 ? "good" : b.winRate > 0 ? "bad" : "flat",
      };
    default:
      return {
        value: b.totalPnL,
        tone: b.totalPnL > 0 ? "good" : b.totalPnL < 0 ? "bad" : "flat",
      };
  }
}
