/**
 * Where the management edge comes from, and where it leaks.
 *
 * Every closed trade with a settled no-management outcome answers two
 * questions at once: what the untouched plan would have made, and what you
 * actually made. The difference is the whole value of managing a trade — and
 * on its own it is one number that says nothing about what to DO.
 *
 * "+6R from management" could be a trader who cuts losers brilliantly and
 * dumps winners, or one who does neither and got lucky. Those want opposite
 * fixes. So each trade is filed by what actually happened to it, and the
 * buckets are summed separately: the edge and the leak are reported as two
 * lists rather than one net figure, because a net figure lets a large leak
 * hide behind a larger edge.
 *
 * Only trades whose plan outcome is known can be measured at all — the ones
 * still owing that answer are counted and reported rather than assumed
 * either way. Half of this journal's discipline is refusing to average over
 * the unanswered.
 */
import type { Trade, TradeFill } from "./schema";
import { computeMetrics, fmtMoney } from "./metrics";

/** Nothing under this is a decision, it is rounding and slippage. */
const FLAT = 0.05;

export type EdgeKind = "edge" | "leak" | "neutral";

export interface EdgeBucket {
  id: string;
  /** What you did, in the trader's words rather than the schema's. */
  label: string;
  /** Why it is filed here — shown under the number. */
  hint: string;
  kind: EdgeKind;
  trades: number;
  /** Summed management delta for the bucket, in R. */
  r: number;
  /**
   * The same, in money: each trade's delta times what 1R was on it. R says
   * whether the habit is good; this says what it has cost or paid, which
   * differs from R whenever the trades were sized differently.
   */
  dollars: number;
  /** The ids behind it, so a number on a card can open the trades under it. */
  tradeIds: number[];
}

export interface ManagementEdge {
  /** Trades that could be measured: closed, with a plan outcome settled. */
  measured: number;
  /** Closed trades still owing the "left alone, what would it have done?" answer. */
  unmeasured: number;
  /** Management, net, in R. The headline — and the least useful figure here. */
  totalR: number;
  /** Management, net, in money. */
  totalDollars: number;
  /** What it came FROM, biggest first. */
  edges: EdgeBucket[];
  /** What it leaked TO, biggest first. */
  leaks: EdgeBucket[];
  /** Trades that went exactly as planned, either way. */
  neutral: EdgeBucket[];
}

interface Row {
  id: string;
  label: string;
  hint: string;
  kind: EdgeKind;
}

/*
 * The seven things that can happen to a trade you managed, named for what
 * they are rather than for their sign. "Cut a winner early" and "sat through
 * a loser" are both negative deltas and have nothing else in common.
 */
const ROWS: Record<string, Row> = {
  savedOnLosers: {
    id: "savedOnLosers",
    label: "Cutting losers early",
    hint: "the plan was a full stop; you got out for less",
    kind: "edge",
  },
  rodePastTarget: {
    id: "rodePastTarget",
    label: "Riding winners past the target",
    hint: "the plan was your target; you held for more",
    kind: "edge",
  },
  cutWinnersEarly: {
    id: "cutWinnersEarly",
    label: "Cutting winners early",
    hint: "the plan reached your target; you took less",
    kind: "leak",
  },
  winnerToLoser: {
    id: "winnerToLoser",
    label: "Winners closed at a loss",
    hint: "the plan reached your target; you finished red",
    kind: "leak",
  },
  heldPastStop: {
    id: "heldPastStop",
    label: "Losers held past the stop",
    hint: "the plan lost 1R; you lost more",
    kind: "leak",
  },
  fullTarget: {
    id: "fullTarget",
    label: "Held to the full target",
    hint: "the plan reached your target and so did you",
    kind: "neutral",
  },
  tookTheStop: {
    id: "tookTheStop",
    label: "Took the stop as planned",
    hint: "the plan lost 1R and so did you",
    kind: "neutral",
  },
};

/** Which of the seven this trade is. */
function fileTrade(
  plan: "target_first" | "stop_first",
  actualR: number,
  deltaR: number,
): Row {
  if (Math.abs(deltaR) < FLAT) return plan === "target_first" ? ROWS.fullTarget : ROWS.tookTheStop;
  if (plan === "stop_first") return deltaR > 0 ? ROWS.savedOnLosers : ROWS.heldPastStop;
  // The plan was a winner. Finishing red is its own row: it is the same
  // arithmetic as taking less than the target and a different mistake.
  if (deltaR > 0) return ROWS.rodePastTarget;
  return actualR < 0 ? ROWS.winnerToLoser : ROWS.cutWinnersEarly;
}

export function managementEdge(
  trades: (Trade & { fills?: TradeFill[] })[],
): ManagementEdge {
  const byId = new Map<string, EdgeBucket>();
  let measured = 0;
  let unmeasured = 0;
  let totalR = 0;
  let totalDollars = 0;

  for (const t of trades) {
    if (t.status !== "closed") continue;
    const plan = t.noManagementOutcome;
    if (plan !== "target_first" && plan !== "stop_first") {
      unmeasured++;
      continue;
    }
    const m = computeMetrics(t);
    if (m.actualR == null || m.managementDeltaR == null) {
      // A trade with no stop has no R to compare in. It is not an unanswered
      // question, it is an unmeasurable one, and counting it as owed would
      // send you looking for an answer that does not exist.
      continue;
    }

    measured++;
    totalR += m.managementDeltaR;
    const dollars = m.managementDeltaDollars ?? 0;
    totalDollars += dollars;
    const row = fileTrade(plan, m.actualR, m.managementDeltaR);
    const b =
      byId.get(row.id) ??
      ({ ...row, trades: 0, r: 0, dollars: 0, tradeIds: [] } as EdgeBucket);
    b.trades++;
    b.r += m.managementDeltaR;
    b.dollars += dollars;
    b.tradeIds.push(t.id);
    byId.set(row.id, b);
  }

  const of = (kind: EdgeKind) =>
    Array.from(byId.values())
      .filter((b) => b.kind === kind)
      .sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

  return {
    measured,
    unmeasured,
    totalR,
    totalDollars,
    edges: of("edge"),
    leaks: of("leak"),
    neutral: of("neutral"),
  };
}

/**
 * The one sentence to put at the top.
 *
 * Written from the biggest bucket on each side rather than the net, because
 * the net is the figure that hides the problem: a trader gaining 14R by
 * cutting losers and giving 9R back by cutting winners is not "up 5R on
 * management", they are two habits, one of which is worth fixing.
 */
export function edgeSentence(e: ManagementEdge): string | null {
  if (e.measured === 0) return null;
  const best = e.edges[0];
  const worst = e.leaks[0];
  const r = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}R`;
  // R and the money it was, side by side: the habit, and what it came to.
  const rd = (b: EdgeBucket) => `${r(b.r)}, ${fmtMoney(b.dollars)}`;

  if (!best && !worst) return "Every measured trade went exactly as planned.";
  if (best && !worst) {
    return `Your management is all gain: ${best.label.toLowerCase()} is worth ${rd(best)} across ${best.trades}.`;
  }
  if (!best && worst) {
    return `Your management only costs you here: ${worst.label.toLowerCase()} has taken ${rd(worst)} across ${worst.trades}.`;
  }
  return `Your edge comes from ${best!.label.toLowerCase()} (${rd(best!)} across ${best!.trades}); it leaks to ${worst!.label.toLowerCase()} (${rd(worst!)} across ${worst!.trades}).`;
}

/** One point of the management curve: running totals after each closed trade, in R and in money. */
export interface CurvePoint {
  i: number;
  tradeId: number;
  label: string;
  actual: number;
  potential: number;
  delta: number;
  dollars: number;
  potentialUsd: number;
  deltaUsd: number;
}

/**
 * Actual against no-management, trade by trade, in R and in money.
 *
 * A trade whose plan outcome is not known yet has no counterfactual, so it
 * counts the same on both lines. It used to count on the actual line and as
 * nothing on the no-management one: the gap between the lines was then the
 * management delta PLUS every unmeasured trade's result, and the chart's
 * three totals did not add up. Now actual − no-management = delta, always.
 */
export function managementCurve(closed: (Trade & { fills?: TradeFill[] })[]): CurvePoint[] {
  let a = 0;
  let p = 0;
  let d = 0;
  let a$ = 0;
  let p$ = 0;
  let d$ = 0;
  return closed.map((t, i) => {
    const m = computeMetrics(t);
    a += m.actualR ?? 0;
    a$ += m.actualPnL ?? 0;
    const known = m.potentialR != null;
    p += known ? m.potentialR! : (m.actualR ?? 0);
    p$ += known ? (m.potentialPnL ?? 0) : (m.actualPnL ?? 0);
    d += m.managementDeltaR ?? 0;
    d$ += m.managementDeltaDollars ?? 0;
    return {
      i: i + 1,
      tradeId: t.id,
      label: `#${i + 1} ${t.symbol}`,
      actual: +a.toFixed(3),
      potential: +p.toFixed(3),
      delta: +d.toFixed(3),
      dollars: +a$.toFixed(2),
      potentialUsd: +p$.toFixed(2),
      deltaUsd: +d$.toFixed(2),
    };
  });
}
