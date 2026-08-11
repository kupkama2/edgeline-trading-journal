/**
 * Three questions about every trade, and the R that answers them.
 *
 * A trade has three decisions in it — where you got in, how much room you gave
 * it, and where you got out — and each can be wrong in one of two directions.
 * That is the whole taxonomy: nine buttons, three of which are "that was
 * right". It is deliberately small enough to fill in from a phone while the
 * chart is still on the screen, because a grading scheme nobody completes
 * produces no statistics at all.
 *
 * The grades are self-reported and the numbers are not. You say "I took that
 * one early"; the journal answers with how much the move went on to offer, in
 * R, across every trade you ever said that about. One late exit that round-
 * trips a winner feels catastrophic on the day — the only useful reply is
 * whether that habit has cost you 12R or 0.4R over a hundred trades, and that
 * reply needs the grade to exist before it can be given.
 *
 * Two costs are tracked per bucket because they answer different questions:
 *   leftOnTableR — what the MOVE offered past your exit (MFE-based)
 *   missedPlanR  — what YOUR OWN untouched plan would have paid (target-based)
 * A tight stop shows up in the second; a premature exit usually in both.
 * Neither is a promise: you cannot go back and collect them. They are a price
 * tag on a habit, which is the only thing that makes a habit worth changing.
 */
import type { Trade, TradeWithTags } from "./schema";
import { closedTrades, computeMetrics } from "./metrics";

export type Axis = "entry" | "stop" | "exit";

/** Entry and exit share the early/perfect/late shape; stops are tight/good/wide. */
export const GRADES = {
  entry: ["early", "perfect", "late"],
  stop: ["tight", "good", "wide"],
  exit: ["early", "perfect", "late"],
} as const;

export type EntryGrade = (typeof GRADES.entry)[number];
export type StopGrade = (typeof GRADES.stop)[number];
export type ExitGrade = (typeof GRADES.exit)[number];

export interface GradeMeta {
  grade: string;
  label: string;
  /** What picking it actually claims — ambiguity here poisons every figure below. */
  hint: string;
  /** Whether this grade is the good one, or a miss in one direction. */
  tone: "good" | "miss";
}

export const AXIS_LABELS: Record<Axis, string> = {
  entry: "Entry",
  stop: "Stop",
  exit: "Take profit",
};

/**
 * The wording matters more than it looks. "Early" has to mean the same thing
 * in January and in July or the aggregate is measuring drift, not trading.
 */
export const GRADE_META: Record<Axis, GradeMeta[]> = {
  entry: [
    {
      grade: "early",
      label: "Early",
      hint: "In before it triggered — the price came to me afterwards.",
      tone: "miss",
    },
    {
      grade: "perfect",
      label: "Perfect",
      hint: "Filled at the level, barely any heat.",
      tone: "good",
    },
    {
      grade: "late",
      label: "Late",
      hint: "Chased it, or held out for a better fill and had to pay up.",
      tone: "miss",
    },
  ],
  stop: [
    {
      grade: "tight",
      label: "Too tight",
      hint: "Taken out on noise, then it went my way.",
      tone: "miss",
    },
    {
      grade: "good",
      label: "Right",
      hint: "The room fitted the idea.",
      tone: "good",
    },
    {
      grade: "wide",
      label: "Too wide",
      hint: "More room than the idea needed — the size paid for it.",
      tone: "miss",
    },
  ],
  exit: [
    {
      grade: "early",
      label: "Early",
      hint: "Took it off and the move kept going.",
      tone: "miss",
    },
    {
      grade: "perfect",
      label: "Perfect",
      hint: "Out at the top (or the bottom).",
      tone: "good",
    },
    {
      grade: "late",
      label: "Late",
      hint: "Held past the peak and gave it back.",
      tone: "miss",
    },
  ],
};

export function gradeLabel(axis: Axis, grade: string | null | undefined): string | null {
  if (!grade) return null;
  return GRADE_META[axis].find((g) => g.grade === grade)?.label ?? null;
}

/**
 * Whether an axis has anything to say about this trade.
 *
 * A trade that hit its stop never went near the target, so where the target
 * was is not a question you failed to answer — it is a question that does not
 * arise. Those two look identical in a nullable column and are worlds apart in
 * a statistic: counted as ungraded they make your coverage look careless, and
 * counted as graded-something they would need a value that does not exist.
 *
 * So the exit axis simply does not apply to a stopped-out trade. The entry and
 * the stop always do — every trade has a price you got in at and a stop you
 * chose, however it ended.
 */
export function axisApplies(t: Trade, axis: Axis): boolean {
  if (axis !== "exit") return true;
  return t.exitReason !== "stop";
}

export function gradeOf(t: Trade, axis: Axis): string | null {
  if (!axisApplies(t, axis)) return null;
  const raw =
    axis === "entry" ? t.entryGrade : axis === "stop" ? t.stopGrade : t.exitGrade;
  if (!raw) return null;
  return (GRADES[axis] as readonly string[]).includes(raw) ? raw : null;
}

export interface GradeBucket {
  grade: string;
  label: string;
  tone: "good" | "miss";
  count: number;
  /** Share of the graded trades on this axis, 0–1. */
  share: number;
  winRate: number;
  totalR: number;
  expectancyR: number;
  /** Average deepest heat taken, in R (negative). null when no MAE recorded. */
  avgHeatR: number | null;
  /** Σ max(0, MFE_R − actual_R): what the move offered beyond the exit. */
  leftOnTableR: number;
  /** Σ max(0, potential_R − actual_R): what the untouched plan would have paid. */
  missedPlanR: number;
}

export interface AxisReport {
  axis: Axis;
  label: string;
  /** Closed trades carrying a grade on this axis. */
  graded: number;
  /**
   * Closed trades this axis does not apply to at all. Reported so a small
   * denominator reads as "most of these stopped out" rather than as a gap in
   * the record.
   */
  notApplicable: number;
  /** All three buckets, in taxonomy order, present even at zero. */
  buckets: GradeBucket[];
  /** The miss that dominates this axis, when one does. Null when it's clean. */
  lean: GradeBucket | null;
}

/** Below this an axis is one afternoon's mood, not a tendency. */
export const MIN_GRADED = 5;

function bucketOf(
  axis: Axis,
  meta: GradeMeta,
  rows: { m: ReturnType<typeof computeMetrics> }[],
  gradedTotal: number,
): GradeBucket {
  const rs = rows.map((r) => r.m.actualR ?? 0);
  const heats = rows.map((r) => r.m.maeR).filter((x): x is number => x != null);
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  return {
    grade: meta.grade,
    label: meta.label,
    tone: meta.tone,
    count: rows.length,
    share: gradedTotal ? rows.length / gradedTotal : 0,
    winRate: rows.length ? rs.filter((r) => r > 0).length / rows.length : 0,
    totalR: sum(rs),
    expectancyR: rows.length ? sum(rs) / rows.length : 0,
    avgHeatR: heats.length ? sum(heats) / heats.length : null,
    leftOnTableR: sum(rows.map((r) => Math.max(0, r.m.rLeftOnTable ?? 0))),
    missedPlanR: sum(
      rows.map((r) =>
        r.m.potentialR != null && r.m.actualR != null
          ? Math.max(0, r.m.potentialR - r.m.actualR)
          : 0,
      ),
    ),
  };
}

export function axisReport(trades: Trade[], axis: Axis): AxisReport {
  const closed = closedTrades(trades);
  const rows = closed
    .map((t) => ({ t, g: gradeOf(t, axis), m: computeMetrics(t) }))
    .filter((r) => r.g != null);
  const notApplicable = closed.filter((t) => !axisApplies(t, axis)).length;

  const buckets = GRADE_META[axis].map((meta) =>
    bucketOf(axis, meta, rows.filter((r) => r.g === meta.grade), rows.length),
  );

  // The lean is the miss you make most, not the one that costs most: a habit
  // is a frequency, and the cost of it is the next column along.
  //
  // It also has to point somewhere. Being early as often as you are late is
  // not a tendency to correct, it is a wide distribution — so the leading miss
  // must at least double the other one before it is called a lean, otherwise
  // this card would tell a coin-flipper to stop flipping in one direction.
  const misses = buckets.filter((b) => b.tone === "miss" && b.count > 0);
  const ranked = [...misses].sort((a, b) => b.count - a.count);
  const top = ranked[0] ?? null;
  const runnerUp = ranked[1]?.count ?? 0;
  const lean =
    rows.length >= MIN_GRADED &&
    top &&
    top.share >= 0.4 &&
    top.count >= 3 &&
    top.count >= 2 * runnerUp
      ? top
      : null;

  return { axis, label: AXIS_LABELS[axis], graded: rows.length, notApplicable, buckets, lean };
}

export interface ExecutionReport {
  closed: number;
  /** Closed trades with at least one axis graded. */
  graded: number;
  /** Of those, the ones whose take-profit grade is not a question. */
  stoppedOut: number;
  entry: AxisReport;
  stop: AxisReport;
  exit: AxisReport;
}

export function executionReport(trades: Trade[]): ExecutionReport {
  const closed = closedTrades(trades);
  return {
    closed: closed.length,
    graded: closed.filter(
      (t) => gradeOf(t, "entry") || gradeOf(t, "stop") || gradeOf(t, "exit"),
    ).length,
    /** Closed trades where the take-profit question does not arise. */
    stoppedOut: closed.filter((t) => !axisApplies(t, "exit")).length,
    entry: axisReport(trades, "entry"),
    stop: axisReport(trades, "stop"),
    exit: axisReport(trades, "exit"),
  };
}

/**
 * The two numbers worth being angry about, side by side.
 *
 * Taking profit early and taking it late feel like opposite sins, and traders
 * usually only remember whichever one bit them this week. Both are priced from
 * the same arithmetic — R the move offered past the exit — so the comparison
 * is honest: whichever total is larger is the habit actually costing money,
 * regardless of which one stings today.
 */
export interface ExitCost {
  earlyCount: number;
  lateCount: number;
  /** R the move went on to offer after an exit graded early. */
  earlyR: number;
  /** R reached and handed back on an exit graded late. */
  lateR: number;
  /** Which side is expensive; null when they're within a rounding error. */
  worse: "early" | "late" | null;
}

export function exitCost(trades: Trade[]): ExitCost {
  const r = axisReport(trades, "exit");
  const early = r.buckets.find((b) => b.grade === "early")!;
  const late = r.buckets.find((b) => b.grade === "late")!;
  const diff = early.leftOnTableR - late.leftOnTableR;
  return {
    earlyCount: early.count,
    lateCount: late.count,
    earlyR: early.leftOnTableR,
    lateR: late.leftOnTableR,
    worse: Math.abs(diff) < 0.1 ? null : diff > 0 ? "early" : "late",
  };
}

/* ==================== ignoring the plan: did it pay? ==================== */

/**
 * Every exit that wasn't the plan running its course.
 *
 * Target and stop are the plan doing what it said. Everything else — trailing,
 * scratching, closing by hand, walking away at the bell — is a decision made
 * after the trade was already on, and those are exactly the decisions this
 * journal exists to price. An unlabelled exit is not assumed either way; it is
 * left out and reported as uncovered, because guessing "they probably held on"
 * from the exit price is how a statistic becomes a story.
 */
export function overrodeThePlan(t: Trade): boolean {
  if (t.status !== "closed" || t.exitPrice == null) return false;
  const r = t.exitReason;
  if (!r) return false;
  return r !== "target" && r !== "stop";
}

export interface OverrideReport {
  /** Closed trades whose exit was a decision rather than the plan finishing. */
  count: number;
  /** Of those, the ones where the untouched plan's outcome is known. */
  judged: number;
  /** Judged overrides that beat what the plan would have paid. */
  ahead: number;
  /** Σ (actual R − plan R) across the judged overrides. */
  netR: number;
  avgR: number;
  /** Plain-language read, safe to print verbatim. */
  verdict: string;
}

export function overrideReport(trades: Trade[]): OverrideReport {
  const overrides = closedTrades(trades).filter(overrodeThePlan);
  const judged = overrides
    .map((t) => computeMetrics(t))
    .filter((m) => m.managementDeltaR != null)
    .map((m) => m.managementDeltaR as number);

  const netR = judged.reduce((a, b) => a + b, 0);
  const ahead = judged.filter((d) => d > 0).length;
  const avgR = judged.length ? netR / judged.length : 0;

  let verdict: string;
  if (judged.length === 0) {
    verdict =
      overrides.length > 0
        ? `${overrides.length} exits were your call rather than the plan's, but none of them record what the untouched trade would have done — add the outcome screenshot and this starts answering itself.`
        : "Every closed trade so far ended at its target or its stop. Nothing to judge yet.";
  } else if (netR > 0.5) {
    verdict = `Overriding your own target has paid ${netR.toFixed(
      1,
    )}R across ${judged.length} trades — ${ahead} of them beat the plan. Your reads are better than your levels.`;
  } else if (netR < -0.5) {
    verdict = `Overriding your own target has cost ${Math.abs(netR).toFixed(
      1,
    )}R across ${judged.length} trades — only ${ahead} beat the plan. The levels you set when you were calm are winning.`;
  } else {
    verdict = `Across ${judged.length} judged overrides you are within half an R of simply leaving the plan alone. The discretion is neither earning nor costing.`;
  }

  return { count: overrides.length, judged: judged.length, ahead, netR, avgR, verdict };
}

/** Grades carried by a set of trades, for a compact "you graded 12 of 30" line. */
export function gradedCoverage(trades: TradeWithTags[]): { graded: number; closed: number } {
  const r = executionReport(trades);
  return { graded: r.graded, closed: r.closed };
}
