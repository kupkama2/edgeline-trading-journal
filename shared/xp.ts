/**
 * Progression — XP for process, never for outcome.
 *
 * The research on gamified trading is unambiguous: rewarding trades or P&L
 * builds a slot machine (Robinhood's confetti earned a FINRA action and an SEC
 * review, and "encouraged overtrading" is the regulator's phrase, not ours).
 * The same literature says the opposite loop is safe and effective: reward the
 * boring, controllable actions — writing the rationale, setting the stop,
 * reviewing the week — and let the market's outcomes stay uncelebrated.
 *
 * Self-determination theory adds the second rule: rewards that FEEL like
 * surveillance undermine motivation, while rewards that feel like information
 * ("that was a complete entry") support it. So XP here only ever acknowledges;
 * nothing is deducted, nothing nags. A demon logged honestly earns MORE than
 * one hidden, because the journal's one non-negotiable is that lying to it
 * makes every number worthless.
 *
 * Everything derives from data that already exists — no xp table, no counters
 * to drift. Delete a trade and its XP evaporates, which is exactly right.
 */
import type { DailyNote, TradeWithTags, WeeklyReview } from "./schema";
import { dayKey, dayKeyOfIso } from "./daily";
import { isMissed } from "./missed";

/* ------------------------------ XP events ------------------------------ */

export interface XpEvent {
  /** Stable id so the client can diff "what did this save just earn". */
  id: string;
  label: string;
  points: number;
}

/** XP a single trade has earned, itemised. Pure function of the row. */
export function tradeXp(t: TradeWithTags): XpEvent[] {
  const ev: XpEvent[] = [];
  const add = (id: string, label: string, points: number) =>
    ev.push({ id: `${t.id}:${id}`, label, points });

  if (isMissed(t)) {
    // Logging the trade you DIDN'T take is the most honest entry a journal
    // gets, and the easiest one to skip. Paid accordingly.
    add("missed", "Logged a trade you didn't take", 15);
    if (t.wouldHaveHitTarget != null) add("missed-resolved", "Resolved what it did", 5);
    return ev;
  }
  if (t.status === "cancelled") return ev;

  if (t.rationale?.trim()) add("rationale", "Wrote the why before the result", 10);
  if (t.initialStop != null && t.initialTarget != null)
    add("levels", "Entered with stop and target", 5);
  if (t.setupScreenshot || t.imageCount > 0) add("chart", "Attached the chart", 5);

  if (t.status === "closed") {
    if (t.exitReason) add("exit", "Closed with a named exit", 10);
    if (t.mae != null || t.mfe != null || t.noManagementOutcome != null)
      add("outcome", "Measured the path, not just the exit", 5);
    if (t.notes?.trim()) add("reflection", "Wrote the post-mortem", 5);
    // Demons carry no penalty — hiding them must never be the winning move —
    // and a clean, fully-scored trade earns a nod.
    if (t.mistakeTagIds.length === 0 && t.exitReason) add("clean", "No demons on it", 5);
  }
  return ev;
}

const DAY_NOTE_MIN_CHARS = 60;

export function dailyNoteXp(n: DailyNote): XpEvent[] {
  if ((n.body ?? "").trim().length < DAY_NOTE_MIN_CHARS) return [];
  return [{ id: `day:${n.day}`, label: "Reviewed the day in writing", points: 15 }];
}

export function weeklyReviewXp(r: WeeklyReview): XpEvent[] {
  return [{ id: `week:${r.weekStart}`, label: "Closed out the week", points: 30 }];
}

/* ------------------------------- levels ------------------------------- */

/**
 * Titles climb from watching to owning a process. Deliberately about the
 * journaling craft, not market prowess — the app cannot know if you trade
 * well, only whether you examine your trading honestly.
 */
export const LEVEL_TITLES = [
  "Observer",
  "Recorder",
  "Apprentice",
  "Operator",
  "Tactician",
  "Risk Manager",
  "Strategist",
  "Veteran",
  "Edge Holder",
  "Master of Process",
] as const;

/** XP needed to finish level L (1-based): 100, 150, 200 … linear ramp. */
function levelSpan(level: number): number {
  return 100 + (level - 1) * 50;
}

export interface LevelInfo {
  level: number;
  title: string;
  /** XP earned inside the current level. */
  into: number;
  /** XP the current level needs in total. */
  span: number;
  /** 0..1 progress through the current level. */
  progress: number;
  totalXp: number;
}

export function levelInfo(totalXp: number): LevelInfo {
  let level = 1;
  let rest = Math.max(0, totalXp);
  while (rest >= levelSpan(level)) {
    rest -= levelSpan(level);
    level += 1;
  }
  const span = levelSpan(level);
  return {
    level,
    title: LEVEL_TITLES[Math.min(level - 1, LEVEL_TITLES.length - 1)],
    into: rest,
    span,
    progress: rest / span,
    totalXp: Math.max(0, totalXp),
  };
}

/* ------------------------------- streak ------------------------------- */

export interface Streak {
  /** Consecutive journaled trading days, counting back from today. */
  days: number;
  /** True when today has already been journaled. */
  todayDone: boolean;
}

/**
 * The discipline streak counts JOURNALED TRADING DAYS, not calendar days.
 *
 * Duolingo's own research is that grace makes streaks stronger, not weaker —
 * brittle streaks end in quitting, forgiving ones in habits. Here the grace is
 * structural: a day with no trades and no note is nobody's failure (weekends,
 * holidays, days you stood aside) and is skipped, not broken on. A day WITH
 * trades where nothing was written is the one thing that breaks it. Today
 * never breaks it — the day is not over.
 */
export function disciplineStreak(
  trades: TradeWithTags[],
  notes: DailyNote[],
  today = new Date(),
): Streak {
  const notedDays = new Set(
    notes.filter((n) => (n.body ?? "").trim().length >= DAY_NOTE_MIN_CHARS).map((n) => n.day),
  );

  // A trading day's journaling bar: every real trade touched that day carries
  // a written why (rationale or notes), or the day itself has a review.
  const tradesByDay = new Map<string, TradeWithTags[]>();
  for (const t of trades) {
    if (t.status === "cancelled" && !isMissed(t)) continue;
    for (const key of [dayKeyOfIso(t.entryTime), dayKeyOfIso(t.exitTime)]) {
      if (!key) continue;
      const list = tradesByDay.get(key) ?? [];
      if (!list.includes(t)) list.push(t);
      tradesByDay.set(key, list);
    }
  }

  const journaled = (key: string): boolean | null => {
    const dayTrades = tradesByDay.get(key);
    const hasNote = notedDays.has(key);
    if (!dayTrades?.length && !hasNote) return null; // nothing happened — neutral
    if (hasNote) return true;
    return dayTrades!.every((t) => t.rationale?.trim() || t.notes?.trim());
  };

  const cursor = new Date(today);
  const todayKey = dayKey(cursor);
  const todayState = journaled(todayKey);
  let days = todayState === true ? 1 : 0;

  // Walk backwards; neutral days pass through, the first failed day stops it.
  for (let i = 0; i < 400; i++) {
    cursor.setDate(cursor.getDate() - 1);
    const state = journaled(dayKey(cursor));
    if (state === null) continue;
    if (!state) break;
    days += 1;
  }

  return { days, todayDone: todayState === true };
}

/* ----------------------------- achievements ----------------------------- */

export interface Achievement {
  id: string;
  name: string;
  desc: string;
  earned: boolean;
}

/* ------------------------------ the bundle ------------------------------ */

export interface Progression {
  level: LevelInfo;
  streak: Streak;
  events: XpEvent[];
  achievements: Achievement[];
}

export function computeProgression(
  trades: TradeWithTags[],
  notes: DailyNote[],
  reviews: WeeklyReview[],
  today = new Date(),
): Progression {
  const events = [
    ...trades.flatMap(tradeXp),
    ...notes.flatMap(dailyNoteXp),
    ...reviews.flatMap(weeklyReviewXp),
  ];
  const total = events.reduce((a, e) => a + e.points, 0);
  const streak = disciplineStreak(trades, notes, today);

  const fullEntries = trades.filter(
    (t) => t.status !== "cancelled" && t.rationale?.trim() && t.initialStop != null,
  ).length;
  const journaledDays = new Set(
    notes.filter((n) => (n.body ?? "").trim().length >= DAY_NOTE_MIN_CHARS).map((n) => n.day),
  ).size;
  const demonFreeCleanCloses = trades.filter(
    (t) => t.status === "closed" && t.exitReason && t.mistakeTagIds.length === 0,
  ).length;

  const achievements: Achievement[] = [
    {
      id: "first-ink",
      name: "First Ink",
      desc: "Log a trade with its rationale written down",
      earned: fullEntries >= 1,
    },
    {
      id: "week-of-ink",
      name: "Week of Ink",
      desc: "A 5-day discipline streak",
      earned: streak.days >= 5,
    },
    {
      id: "honest-miss",
      name: "The One That Got Away",
      desc: "Log a trade you didn't take",
      earned: trades.some(isMissed),
    },
    {
      id: "reviewer",
      name: "Sunday Editor",
      desc: "Complete a weekly review",
      earned: reviews.length >= 1,
    },
    {
      id: "clean-ten",
      name: "Ten Clean Closes",
      desc: "Close 10 trades with a named exit and no demons",
      earned: demonFreeCleanCloses >= 10,
    },
    {
      id: "diarist",
      name: "Diarist",
      desc: "Write 20 daily reviews",
      earned: journaledDays >= 20,
    },
    {
      id: "hundred-entries",
      name: "Process of Record",
      desc: "100 fully journaled trades",
      earned: fullEntries >= 100,
    },
  ];

  return { level: levelInfo(total), streak, events, achievements };
}
