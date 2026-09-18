/**
 * What a closed trade was, in one word.
 *
 * A row in a journal is read in about a second, and the question being asked
 * of it is never "what was the capture ratio" — it is "was that one of mine?"
 * Four answers cover it:
 *
 *   tilt    it should not have been taken. Out of every number, and the only
 *           verdict that overrides the rest: whether a trade you should not
 *           have taken happened to pay is not information, it is noise, and
 *           printing "win" on it would teach exactly the wrong lesson.
 *   great   traded well — waited for it, sized it, left it alone. A verdict on
 *           the execution, so it holds whether the trade paid or not.
 *   win     it made money.
 *   loss    it did not.
 *
 * Deliberately one word rather than two. A trade that was both well traded and
 * profitable is "great" — the money is already on the row, in the R and in the
 * dollars, both signed and both coloured. Saying "great win" would be the row
 * saying the same thing twice, and the second time is the one that starts the
 * habit of grading the outcome instead of the decision.
 *
 * Judged on money rather than R, because R goes missing: a trade logged
 * without a stop has no R at all, and a row that cannot decide between win and
 * loss because a field is blank is a row that has failed at the one job it
 * has. Money is there on every closed trade.
 */
import type { TradeWithTags } from "./schema";
import { isWellTraded } from "./well-traded";
import { computeMetrics } from "./metrics";

export type Verdict = "tilt" | "great" | "win" | "loss";

export const VERDICT_LABELS: Record<Verdict, string> = {
  tilt: "tilt",
  great: "great",
  win: "win",
  loss: "loss",
};

/**
 * The one word. `pnl` is passed in where the caller has already computed the
 * metrics, which every row has — recomputing them per row to answer a question
 * the row already knows the answer to is work for nothing.
 */
export function tradeVerdict(
  t: Pick<TradeWithTags, "tilt" | "wellTraded">,
  pnl: number | null | undefined,
): Verdict {
  if (t.tilt) return "tilt";
  if (isWellTraded(t)) return "great";
  return (pnl ?? 0) >= 0 ? "win" : "loss";
}

/** The verdict from the trade alone, for callers without metrics in hand. */
export function verdictOf(t: TradeWithTags): Verdict {
  return tradeVerdict(t, computeMetrics(t).actualPnL);
}

/**
 * Did this trade make money? Separate from the verdict on purpose: a great
 * trade can lose and a tilt trade can win, and a row wants to show both facts
 * without one silently rewriting the other.
 */
export function isWin(pnl: number | null | undefined): boolean {
  return (pnl ?? 0) >= 0;
}

/* ============================== days ================================= */

export interface DayGroup {
  /** YYYY-MM-DD in local time — the key a day is filed under. */
  key: string;
  /** Midnight local on that day, for formatting in the caller's locale. */
  date: Date;
  trades: TradeWithTags[];
  /** Net of fees, over every trade in the group. */
  pnl: number;
  /** Summed R over the trades that have one; null when none of them do. */
  r: number | null;
  wins: number;
  losses: number;
  /** How many of them were tilt — a note on the day, not a deduction. */
  tilt: number;
}

/** Local YYYY-MM-DD, which is the day a trader means by "that day". */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Closed trades grouped by the day they closed, newest day first and newest
 * trade first inside each day.
 *
 * The day is the unit a trading session is actually lived in, so the header
 * carries what the day came to and the rows underneath can drop their
 * timestamps entirely — which is most of what made the old list noisy.
 *
 * Every trade handed over counts towards the total, tilt included. This
 * function does not get a second opinion about which book is being shown: the
 * scope already decided that before the list got here, and a trade on screen
 * that is silently missing from the sum above it is the header lying about the
 * rows underneath it.
 *
 * Holding tilt out here was wrong in exactly the case it was written for. The
 * plan book — the default — has already dropped tilt trades entirely, so the
 * exclusion could only ever fire once you had switched the filter to Tilt or
 * Both, which is to say once you had explicitly asked to see them. Six rows
 * summing to −$266 under a header reading −$59 is not "tilt kept out of the
 * numbers", it is a subtraction nobody asked for.
 *
 * The tilt count stays on the group, because "6 trades, 2 of them tilt" is
 * worth saying. It is a note about the day, not a deduction from it.
 */
export function groupByDay(trades: TradeWithTags[]): DayGroup[] {
  const by = new Map<string, TradeWithTags[]>();
  for (const t of trades) {
    const stamp = t.exitTime ?? t.entryTime;
    if (!stamp) continue;
    const k = dayKey(stamp);
    const list = by.get(k);
    if (list) list.push(t);
    else by.set(k, [t]);
  }

  const groups: DayGroup[] = [];
  by.forEach((list, key) => {
    list.sort((a, b) =>
      (b.exitTime ?? b.entryTime).localeCompare(a.exitTime ?? a.entryTime),
    );
    let pnl = 0;
    let r = 0;
    let measured = 0;
    let wins = 0;
    let losses = 0;
    let tilt = 0;
    for (const t of list) {
      if (t.tilt) tilt++;
      const m = computeMetrics(t);
      pnl += m.actualPnL ?? 0;
      if (m.actualR != null) {
        r += m.actualR;
        measured++;
      }
      if ((m.actualPnL ?? 0) >= 0) wins++;
      else losses++;
    }
    const [y, mo, d] = key.split("-").map(Number);
    groups.push({
      key,
      date: new Date(y, mo - 1, d),
      trades: list,
      pnl,
      r: measured > 0 ? r : null,
      wins,
      losses,
      tilt,
    });
  });
  return groups.sort((a, b) => b.key.localeCompare(a.key));
}

/** "Today", "Yesterday", or the date — a day you were in has a name. */
export function dayLabel(d: Date, now: Date = new Date()): string {
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (same(d, now)) return "Today";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (same(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}
