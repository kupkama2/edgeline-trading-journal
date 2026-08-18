/**
 * Demon Finder — Tom Dante's mistake tracker.
 *
 * A "demon" is a named, repeatable trading mistake. The taxonomy below is the
 * fixed set from Tom Dante's original tool; the user can add their own on top
 * (any tag they create in Settings is treated as a custom demon).
 *
 * Storage note: demons reuse the existing `mistake_tags` table and the
 * `trade_mistakes` join table rather than introducing a parallel structure —
 * the app already tags every closed trade with mistakes, so this formalizes
 * that mechanism instead of duplicating it. Custom demons therefore need no
 * schema change at all.
 */
import type { MistakeTag, TradeWithTags } from "./schema";

/**
 * The canonical list, in Tom Dante's original order — minus the four timing
 * demons, which the execution grades now own (see DEMON_RETIRED_TO_GRADE),
 * plus one of our own at the end.
 *
 * "Roundtripped" is deliberately NOT a re-run of the retired "Exited Too Late".
 * That demon was retired because it was word-for-word the same claim as an exit
 * graded late, recorded twice. This is the severe tail of that claim rather
 * than the claim itself: giving back 0.5R of a 3R winner is a late exit and
 * still a good trade, while watching the whole thing come back to scratch is
 * the failure worth counting streaks on. A late exit that roundtrips carries
 * both, and that is the point — the grade prices it, the demon names it.
 */
export const DEMON_TAXONOMY: string[] = [
  "Poor Risk/Reward",
  "Trade Not In Plan",
  "Bet Too Large",
  "Bet Too Small",
  "Didn't Take Planned Trade",
  "Roundtripped",
];

/** Earlier free-form tag names that map onto a canonical demon. */
export const DEMON_LEGACY_ALIASES: Record<string, string> = {
  "Poor Risk/Reward Trade": "Poor Risk/Reward",
  "Trade Not In Trading Plan": "Trade Not In Plan",
};

/**
 * Four demons that the grade axes say better, and where each one moves to.
 *
 * "Exited Too Soon" and an exit graded early were the same claim recorded in
 * two places, which is worse than recording it in neither: the demon counts
 * toward streaks and discipline while the grade drives the take-profit
 * arithmetic, so ticking one, both, or the wrong one produced three different
 * pictures of the same trade. The grade wins because it is the one with a
 * price attached.
 *
 * Storage retires them on boot, but only after copying each tick onto the
 * matching axis — nothing recorded is thrown away, it just moves to the column
 * that can price it. See the migration in server/storage.ts.
 */
export const DEMON_RETIRED_TO_GRADE: Record<
  string,
  { column: "entry_grade" | "exit_grade"; grade: string }
> = {
  "Entered Too Soon": { column: "entry_grade", grade: "early" },
  "Entered Too Late": { column: "entry_grade", grade: "late" },
  "Exited Too Soon": { column: "exit_grade", grade: "early" },
  "Exited Too Late": { column: "exit_grade", grade: "late" },
};

/** Soft nudge: same demon three trades running. Also the guardrail trigger. */
export const DEMON_STREAK_WARNING = 3;
/** Tom Dante's rule: eight of the same demon in a row is a serious problem. */
export const DEMON_STREAK_CRITICAL = 8;
/**
 * Hitting the same demon this many trades in a row locks the guardrail (the
 * same stop-trading state the R-loss rules produce) until acknowledged.
 */
export const DEMON_GUARDRAIL_STREAK = 3;

export interface DemonStat {
  id: number;
  name: string;
  /** Lifetime number of trades carrying this demon. */
  total: number;
  /** Consecutive most-recent trades (chronological log order) carrying it. */
  currentStreak: number;
  /** Longest run of consecutive trades this demon ever produced. */
  longestStreak: number;
  /** True when the demon is not part of the fixed taxonomy. */
  custom: boolean;
  severity: "none" | "warning" | "critical";
}

/**
 * Chronological order of the trade log: closed trades ordered by the time they
 * finished (exit time, falling back to entry time). Streaks are measured over
 * this sequence, NOT over lifetime totals.
 */
export function chronologicalClosed(trades: TradeWithTags[]): TradeWithTags[] {
  return trades
    .filter((t) => t.status === "closed")
    .slice()
    .sort((a, b) =>
      (a.exitTime ?? a.entryTime).localeCompare(b.exitTime ?? b.entryTime),
    );
}

export function demonStats(
  trades: TradeWithTags[],
  tags: MistakeTag[],
): DemonStat[] {
  const seq = chronologicalClosed(trades);

  return tags
    .map((tag) => {
      let total = 0;
      let currentStreak = 0;
      let longestStreak = 0;
      let run = 0;

      for (const t of seq) {
        const hit = t.mistakeTagIds.includes(tag.id);
        if (hit) {
          total++;
          run++;
          if (run > longestStreak) longestStreak = run;
        } else {
          run = 0;
        }
      }
      // The trailing run is the current streak.
      currentStreak = run;

      const severity: DemonStat["severity"] =
        currentStreak >= DEMON_STREAK_CRITICAL
          ? "critical"
          : currentStreak >= DEMON_STREAK_WARNING
            ? "warning"
            : "none";

      return {
        id: tag.id,
        name: tag.name,
        total,
        currentStreak,
        longestStreak,
        custom: !DEMON_TAXONOMY.includes(tag.name),
        severity,
      };
    })
    .sort((a, b) => {
      // Loudest problems first: active streak, then lifetime tally, then name.
      if (b.currentStreak !== a.currentStreak) return b.currentStreak - a.currentStreak;
      if (b.total !== a.total) return b.total - a.total;
      return a.name.localeCompare(b.name);
    });
}

/** The single worst active streak, if any demon is at or past the soft limit. */
export function worstDemonStreak(stats: DemonStat[]): DemonStat | null {
  const hit = stats.filter((s) => s.currentStreak >= DEMON_STREAK_WARNING);
  if (!hit.length) return null;
  return hit.reduce((a, b) => (b.currentStreak > a.currentStreak ? b : a));
}

/** Demon occurrences inside a date window (used by the weekly review card). */
export function demonCountsInRange(
  trades: TradeWithTags[],
  tags: MistakeTag[],
  fromIso: string,
  toIso: string,
): { id: number; name: string; count: number }[] {
  const names = new Map(tags.map((t) => [t.id, t.name]));
  const acc = new Map<number, number>();
  for (const t of chronologicalClosed(trades)) {
    const when = t.exitTime ?? t.entryTime;
    if (when < fromIso || when > toIso) continue;
    for (const id of t.mistakeTagIds) {
      acc.set(id, (acc.get(id) ?? 0) + 1);
    }
  }
  return Array.from(acc.entries())
    .map(([id, count]) => ({ id, name: names.get(id) ?? "Unknown", count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
