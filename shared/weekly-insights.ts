/**
 * Weekly insights — the half of a review that numbers alone can't give you.
 *
 * The journal already computes what happened: win rate, expectancy, which demon
 * fired most, what it cost. What it can't compute is what you *thought* — the
 * "should have waited for the retest", "the perfect version of this was half the
 * size" you write in the notes after the fact. Those are the actual diagnosis;
 * the numbers are the symptoms.
 *
 * This module assembles both into one evidence bundle. It is deliberately pure
 * and shared: the client can show you exactly what would be sent before anything
 * is sent, and the server derives the same bundle rather than trusting a payload.
 */
import type { MistakeTag, TradeWithTags } from "./schema";
import { aggregate, computeMetrics, mistakeCostLeaderboard } from "./metrics";
import { demonCountsInRange } from "./demons";

/** Monday 00:00 local, as the canonical start of a trading week. */
export function startOfWeek(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

export function weekStartKey(d = startOfWeek()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** One trade's written reflection, paired with how it actually went. */
export interface ReflectionEntry {
  symbol: string;
  /** Realised R — lets the model separate "won but sloppy" from "lost and knew it". */
  r: number | null;
  demons: string[];
  note: string;
}

export interface InsightsBundle {
  weekStart: string;
  weekEnd: string;
  closedCount: number;
  /** Trades that carried a written note — the ones this analysis can learn from. */
  reflectionCount: number;
  stats: {
    winRate: number;
    expectancyR: number;
    totalR: number;
    totalPnL: number;
    avgWinnerR: number;
    avgLoserR: number;
    /** Negative means management cost money versus leaving the trade alone. */
    totalDeltaR: number;
    avgCapture: number;
  };
  demons: { name: string; count: number }[];
  costliest: { name: string; cost: number; trades: number }[];
  reflections: ReflectionEntry[];
}

/* Bounds on what gets sent to the model: enough to find a pattern, not so much
   that a heavy journaling week turns into an expensive request. */
const MAX_REFLECTIONS = 40;
const MAX_NOTE_CHARS = 600;

/**
 * Assemble the week's evidence. Only closed trades count — an open position has
 * no outcome to reflect on, and a pending one was never a position at all.
 */
export function buildInsightsBundle(
  trades: TradeWithTags[],
  tags: MistakeTag[],
  weekStartDate = startOfWeek(),
): InsightsBundle {
  const end = new Date(weekStartDate);
  end.setDate(end.getDate() + 7);
  const fromIso = weekStartDate.toISOString();
  const toIso = end.toISOString();

  const inWeek = trades.filter((t) => {
    if (t.status !== "closed") return false;
    const when = t.exitTime ?? t.entryTime;
    return when >= fromIso && when < toIso;
  });

  const tagNames = Object.fromEntries(tags.map((t) => [t.id, t.name]));
  const agg = aggregate(inWeek);

  const reflections: ReflectionEntry[] = inWeek
    .map((t) => {
      // Both fields are the trader's own words; rationale is written before the
      // trade and notes after, and a retrospective can live in either.
      const note = [t.notes, t.rationale]
        .map((s) => (s ?? "").trim())
        .filter(Boolean)
        .join(" — ");
      return { t, note };
    })
    .filter((x) => x.note.length > 0)
    .slice(0, MAX_REFLECTIONS)
    .map(({ t, note }) => ({
      symbol: t.symbol,
      r: computeMetrics(t).actualR,
      demons: t.mistakeTagIds.map((id) => tagNames[id]).filter(Boolean),
      note: note.slice(0, MAX_NOTE_CHARS),
    }));

  return {
    weekStart: weekStartKey(weekStartDate),
    weekEnd: weekStartKey(new Date(end.getTime() - 86400000)),
    closedCount: inWeek.length,
    reflectionCount: reflections.length,
    stats: {
      winRate: agg.winRate,
      expectancyR: agg.expectancyR,
      totalR: agg.totalR,
      totalPnL: agg.totalPnL,
      avgWinnerR: agg.avgWinnerR,
      avgLoserR: agg.avgLoserR,
      totalDeltaR: agg.totalDeltaR,
      avgCapture: agg.avgCapture,
    },
    demons: demonCountsInRange(trades, tags, fromIso, toIso)
      .slice(0, 6)
      .map((d) => ({ name: d.name, count: d.count })),
    costliest: mistakeCostLeaderboard(inWeek, tagNames)
      .slice(0, 5)
      .map((c) => ({ name: c.name, cost: c.cost, trades: c.trades })),
    reflections,
  };
}

/** What the model returns. Every field is optional so a partial reply still renders. */
export interface WeeklyInsights {
  /** Recurring ideas across the week's notes, most frequent first. */
  themes?: { theme: string; occurrences?: number; evidence?: string[] }[];
  /** The single most correctable pattern, and why it is the one to pick. */
  focus?: { name: string; why: string };
  /** One concrete, checkable change for next week. */
  oneChange?: string;
  /** Places the notes and the numbers disagree — the most useful output here. */
  contradictions?: string[];
}
