/**
 * Won-and-managed, lost-and-managed, and what either would have been if you
 * had left it alone.
 *
 * The management card already answers "am I good at managing?" — but it files
 * trades by what the PLAN was going to do, and asks whether you beat it. That
 * is the right frame for finding a habit and the wrong one for the question a
 * trader actually asks after a week: on the ones I won, was interfering worth
 * it? On the ones I lost, did interfering save me?
 *
 * Those are different slices of the same trades and they can disagree
 * violently. A trader can be net positive on management while every winner
 * they touched came in under its own plan — the losers they cut carry the
 * whole number, and the habit costing them the most is invisible inside it.
 *
 * Two rules make the comparison honest, and both matter more than they look:
 *
 *   1. "Managed" is a fact about what you DID, not about how it came out. A
 *      partial is management. Trailing, going to breakeven, closing by hand,
 *      calling the setup dead, running out of time — all management. Hitting
 *      your target or your stop is not. A trade that says nothing about how
 *      it ended is not guessed at, it is counted separately and reported.
 *
 *   2. The counterfactual is summed over exactly the trades it is compared
 *      against. Only trades with a settled "left alone, what would it have
 *      done?" have a plan figure at all, so the actual for the comparison is
 *      re-summed over that same subset. Comparing a total over 20 trades with
 *      a total over the 12 that happen to be answered is how a card ends up
 *      confidently reporting a number that means nothing.
 */
import type { Trade, TradeFill } from "./schema";
import { computeMetrics, type TradeMetrics } from "./metrics";

/** Below this, a result is a scratch rather than a win or a loss. */
const SCRATCH_R = 0.005;

/** Nothing under this is a decision, it is rounding and slippage. */
const FLAT = 0.05;

/** What you did after the entry — a fact about the trade, not about its result. */
export type Hand = "managed" | "left-alone" | "unknown";

/**
 * Did you touch this trade?
 *
 * Direct evidence first. A partial is management whatever else happened, and
 * the named exit reasons split cleanly: the plan finishing is the plan
 * finishing, everything else is you.
 *
 * When no reason was ever given, the arithmetic can still be decisive — an
 * outcome that differs from the untouched plan cannot have happened by
 * leaving it alone. It cannot decide the other way, though: a result that
 * matches the plan is what leaving it alone looks like AND what a hand-close
 * at the target price looks like. So that stays unknown rather than becoming
 * a quiet vote for "left alone".
 */
export function handOn(
  t: Trade & { fills?: TradeFill[] },
  m: Pick<TradeMetrics, "managementDeltaR">,
): Hand {
  if ((t.fills ?? []).some((f) => f.kind === "partial")) return "managed";
  const reason = t.exitReason;
  if (reason === "target" || reason === "stop") return "left-alone";
  if (reason != null && reason !== "") return "managed";
  if (m.managementDeltaR != null && Math.abs(m.managementDeltaR) >= FLAT) return "managed";
  return "unknown";
}

export type CohortId = "wonManaged" | "lostManaged" | "wonAlone" | "lostAlone";

export interface Cohort {
  id: CohortId;
  label: string;
  /** What being in this bucket means, in the trader's words. */
  hint: string;
  hand: "managed" | "left-alone";
  outcome: "won" | "lost";
  trades: number;
  tradeIds: number[];
  /** Realised, over every trade in the cohort. */
  totalR: number;
  avgR: number;
  totalPnL: number;
  /**
   * How many of them can be compared against the untouched plan. The rest
   * have no answer to "what would it have done?" and are left out of every
   * figure below rather than counted as zero.
   */
  measured: number;
  /** Σ realised R over the measured ones — the left half of the comparison. */
  actualOnMeasuredR: number | null;
  actualOnMeasuredPnL: number | null;
  /** Σ what the untouched plan would have paid, over those same trades. */
  planR: number | null;
  planPnL: number | null;
  /** Realised minus plan. Positive means touching it was worth doing. */
  deltaR: number | null;
  deltaPnL: number | null;
}

export interface CohortReport {
  /** Closed trades with an R to their name at all. */
  closed: number;
  /** Closed, but you never said how it ended and the numbers can't tell. */
  unclassified: number;
  /** Closed and finished flat — neither won nor lost. */
  scratched: number;
  cohorts: Cohort[];
}

const META: Record<CohortId, Pick<Cohort, "label" | "hint" | "hand" | "outcome">> = {
  wonManaged: {
    label: "Won, and you managed it",
    hint: "you took a hand in it and finished green",
    hand: "managed",
    outcome: "won",
  },
  lostManaged: {
    label: "Lost, and you managed it",
    hint: "you took a hand in it and finished red",
    hand: "managed",
    outcome: "lost",
  },
  wonAlone: {
    label: "Won, left alone",
    hint: "the target did the work",
    hand: "left-alone",
    outcome: "won",
  },
  lostAlone: {
    label: "Lost, left alone",
    hint: "the stop did its job",
    hand: "left-alone",
    outcome: "lost",
  },
};

/** The four cohorts, in the order the card reads them. */
const ORDER: CohortId[] = ["wonManaged", "lostManaged", "wonAlone", "lostAlone"];

export function managementCohorts(
  trades: (Trade & { fills?: TradeFill[] })[],
): CohortReport {
  const blank = (id: CohortId): Cohort => ({
    id,
    ...META[id],
    trades: 0,
    tradeIds: [],
    totalR: 0,
    avgR: 0,
    totalPnL: 0,
    measured: 0,
    actualOnMeasuredR: null,
    actualOnMeasuredPnL: null,
    planR: null,
    planPnL: null,
    deltaR: null,
    deltaPnL: null,
  });

  const by = new Map<CohortId, Cohort>(ORDER.map((id) => [id, blank(id)]));
  /* Accumulated separately so a cohort with nothing measurable keeps null
     rather than reporting a confident 0.0R comparison. */
  const sums = new Map<CohortId, { actualR: number; actualPnL: number; planR: number; planPnL: number }>(
    ORDER.map((id) => [id, { actualR: 0, actualPnL: 0, planR: 0, planPnL: 0 }]),
  );

  let closed = 0;
  let unclassified = 0;
  let scratched = 0;

  for (const t of trades) {
    if (t.status !== "closed") continue;
    const m = computeMetrics(t);
    // No stop means no R, which means nothing here can be said about it. Not
    // an unanswered question — an unmeasurable one.
    if (m.actualR == null) continue;
    closed++;

    const hand = handOn(t, m);
    if (hand === "unknown") {
      unclassified++;
      continue;
    }
    if (Math.abs(m.actualR) < SCRATCH_R) {
      scratched++;
      continue;
    }

    const won = m.actualR > 0;
    const id: CohortId =
      hand === "managed" ? (won ? "wonManaged" : "lostManaged") : won ? "wonAlone" : "lostAlone";

    const c = by.get(id)!;
    c.trades++;
    c.tradeIds.push(t.id);
    c.totalR += m.actualR;
    c.totalPnL += m.actualPnL ?? 0;

    if (m.potentialR != null) {
      c.measured++;
      const s = sums.get(id)!;
      s.actualR += m.actualR;
      s.actualPnL += m.actualPnL ?? 0;
      s.planR += m.potentialR;
      s.planPnL += m.potentialPnL ?? 0;
    }
  }

  for (const id of ORDER) {
    const c = by.get(id)!;
    c.avgR = c.trades > 0 ? c.totalR / c.trades : 0;
    if (c.measured > 0) {
      const s = sums.get(id)!;
      c.actualOnMeasuredR = s.actualR;
      c.actualOnMeasuredPnL = s.actualPnL;
      c.planR = s.planR;
      c.planPnL = s.planPnL;
      c.deltaR = s.actualR - s.planR;
      c.deltaPnL = s.actualPnL - s.planPnL;
    }
  }

  return { closed, unclassified, scratched, cohorts: ORDER.map((id) => by.get(id)!) };
}

/** One cohort by id, for callers that want a single row. */
export function cohort(report: CohortReport, id: CohortId): Cohort {
  return report.cohorts.find((c) => c.id === id)!;
}

/**
 * The sentence to put at the top of the card.
 *
 * Written from the two managed cohorts and nothing else, because they are the
 * two the trader can act on — and written as two clauses rather than one net
 * figure, since "managing is worth +3R" is exactly the summary that lets a
 * habit costing 6R hide behind one earning 9R.
 */
export function cohortSentence(report: CohortReport): string | null {
  const won = cohort(report, "wonManaged");
  const lost = cohort(report, "lostManaged");
  if (won.measured === 0 && lost.measured === 0) return null;

  const r = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}R`;
  const clause = (c: Cohort, kind: "winners" | "losers") => {
    if (c.measured === 0 || c.deltaR == null) return null;
    const noun = `${c.measured} managed ${kind === "winners" ? "winner" : "loser"}${c.measured === 1 ? "" : "s"}`;
    if (Math.abs(c.deltaR) < FLAT) {
      return `on ${noun} your hand changed nothing (${r(c.actualOnMeasuredR!)} either way)`;
    }
    const verb = c.deltaR > 0 ? "earned you" : "cost you";
    /* The magnitude goes unsigned: "cost you +1.0R" reads as a gain. The two
       totals either side of it keep their signs, which is where the direction
       actually belongs. */
    return `on ${noun} it ${verb} ${Math.abs(c.deltaR).toFixed(1)}R against the untouched plan (${r(
      c.actualOnMeasuredR!,
    )} versus ${r(c.planR!)})`;
  };

  const parts = [clause(won, "winners"), clause(lost, "losers")].filter(Boolean);
  if (parts.length === 0) return null;
  return `Managing: ${parts.join("; ")}.`;
}
