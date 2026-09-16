/**
 * The trades you got right, and the run of them.
 *
 * Tilt says a trade should not have been taken. This is the opposite verdict
 * and it is about the execution rather than the idea: you waited for it, you
 * sized it, you left it alone, you took it where you said you would. It has
 * nothing to do with whether it paid — a trade can be executed perfectly and
 * lose, and marking that one is the whole point. Anything else is scoring the
 * outcome again under a different name.
 *
 * The run is the reward. One good trade is a good trade; six in a row is the
 * thing that actually makes money, and it is the number worth protecting on
 * an afternoon when you are bored. Breaking it costs nothing but a number,
 * which is exactly as much as a streak should cost.
 *
 * What counts and what breaks it:
 *
 *   Only trades you have written up — closed, with a named exit. A trade you
 *   closed ten minutes ago and have not looked at yet is not a failure, it is
 *   unfinished, and it passes through the way a day you did not trade passes
 *   through the discipline streak.
 *
 *   A written-up trade that is not marked breaks the run. So does a tilt
 *   trade, which can never be marked — the two verdicts are opposites, and a
 *   row carrying both counts as neither.
 */
import type { TradeWithTags } from "./schema";

/** Runs worth naming. Three is a habit forming, twenty-one is a month of them. */
export const WELL_TRADED_MILESTONES = [3, 5, 10, 21] as const;

export const MILESTONE_NAMES: Record<number, string> = {
  3: "Three in a row",
  5: "Five straight",
  10: "Ten straight",
  21: "Twenty-one straight",
};

/** Marked well traded, and not contradicted by a tilt flag on the same row. */
export function isWellTraded(t: { wellTraded?: boolean | null; tilt?: boolean | null }): boolean {
  return t.wellTraded === true && t.tilt !== true;
}

/**
 * The two verdicts are opposites, so setting one clears the other. Applied
 * at the door on both create and edit, because a row carrying both is a
 * question the rest of the journal has no answer for.
 */
export function exclusiveVerdict<T extends { tilt?: boolean | null; wellTraded?: boolean | null }>(
  patch: T,
): T {
  if (patch.wellTraded === true && patch.tilt !== false) return { ...patch, tilt: false };
  if (patch.tilt === true && patch.wellTraded !== false) return { ...patch, wellTraded: false };
  return patch;
}

/** Closed and written up, oldest close first — the trades the run is made of. */
export function judgedCloses(trades: TradeWithTags[]): TradeWithTags[] {
  return trades
    .filter((t) => t.status === "closed" && Boolean(t.exitReason))
    .slice()
    .sort((a, b) => (a.exitTime ?? a.entryTime).localeCompare(b.exitTime ?? b.entryTime));
}

export interface WellTradedStreak {
  /** The run standing right now. */
  current: number;
  /** The longest run there has ever been. */
  best: number;
  /** Every trade ever marked. */
  total: number;
  /** Written-up closed trades — the denominator the share is out of. */
  judged: number;
  /** The next run worth naming, and how many more it takes. Null past the last. */
  next: { at: number; name: string; toGo: number } | null;
  /** The trade that would break the run if it went unmarked: the newest unjudged close. */
  atRisk: TradeWithTags | null;
}

export function wellTradedStreak(trades: TradeWithTags[]): WellTradedStreak {
  const seq = judgedCloses(trades);
  let current = 0;
  let best = 0;
  let total = 0;
  for (const t of seq) {
    if (isWellTraded(t)) {
      current += 1;
      total += 1;
      if (current > best) best = current;
    } else {
      current = 0;
    }
  }

  const at = WELL_TRADED_MILESTONES.find((m) => m > current) ?? null;
  const unjudged = trades
    .filter((t) => t.status === "closed" && !t.exitReason)
    .sort((a, b) => (b.exitTime ?? b.entryTime).localeCompare(a.exitTime ?? a.entryTime));

  return {
    current,
    best,
    total,
    judged: seq.length,
    next: at == null ? null : { at, name: MILESTONE_NAMES[at], toGo: at - current },
    atRisk: current > 0 ? (unjudged[0] ?? null) : null,
  };
}

/** Milestones the record has actually reached. */
export function milestonesEarned(best: number): number[] {
  return WELL_TRADED_MILESTONES.filter((m) => best >= m);
}
