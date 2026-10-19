/**
 * Is there a take-profit that suits how you trade?
 *
 * Every closed trade is replayed against a plain bracket — the original stop,
 * and a take-profit at a fixed multiple of the risk — and the question for
 * each rung is only which level the price reached first. Nothing about the
 * exit you actually took enters into it; that is the point.
 *
 * It runs on the path already stored on each trade, not on a fresh read of
 * the chart: the best and worst prices while you held (mfe, mae) and the
 * aftermath to where the stop would have broken (postExitPeak,
 * postExitAdverse). Those answer the order of events in most trades:
 *
 *   - The stop was never touched while you held. Anything up to the best
 *     reach — in the trade or after it, before the stop broke — was reached
 *     first: a win at that rung. Above it, the stop breaking later in the
 *     window is a loss; neither level touched within the window is OPEN.
 *   - The stop was touched and that is how the trade ended. Everything the
 *     trade reached came before it, so the same split applies, and above the
 *     reach is a loss.
 *   - The stop was touched and the trade carried on (it was moved, or was
 *     never resting). Above the in-trade reach is still a loss — the stop
 *     came and the target never did — but at or below it the order is not on
 *     record: AMBIGUOUS.
 *
 * Open and ambiguous trades are not guessed at. They are counted, and the
 * rung's total is given as a range — every one of them stopped out, every
 * one paid — beside the figure for the trades that were decided. A confident
 * wrong number is worse than a range.
 */
import type { TradeWithTags } from "./schema";
import { computeMetrics } from "./metrics";

export const RUNGS = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5] as const;

/** Below this many decided trades, a best rung is not named. */
export const MIN_DECIDED = 10;

/**
 * What the path says about one trade, in R from the entry. `reach` is the
 * furthest the price went in your favour before the stop was hit (or within
 * the window, if it never was).
 */
export interface Replay {
  tradeId: number;
  reach: number;
  /** true: the stop was hit at some point after the reach; false: not within the window; null: no record. */
  stopAfter: boolean | null;
  /** At or below this rung the order of target and stop is not on record. */
  ambiguousUpTo: number | null;
  /** Fees less funding, in R — taken off a win and added to a loss. */
  costR: number;
  riskDollars: number;
  actualR: number;
}

const EPS = 1e-9;

export function replay(t: TradeWithTags): Replay | null {
  if (t.status !== "closed" || t.scalp || t.initialStop == null || t.exitPrice == null) return null;
  if (t.mfe == null || t.mae == null) return null;
  const risk = Math.abs(t.entryPrice - t.initialStop);
  if (!(risk > 0)) return null;
  const m = computeMetrics(t);
  if (m.actualR == null) return null;
  const sign = t.direction === "short" ? -1 : 1;
  const r = (p: number) => (sign * (p - t.entryPrice)) / risk;

  const heldBest = Math.max(0, r(t.mfe));
  const heldWorst = r(t.mae);
  const exitR = r(t.exitPrice);
  const costR = m.riskDollars > 0 ? (m.fees - m.funding) / m.riskDollars : 0;
  const base = { tradeId: t.id, costR, riskDollars: m.riskDollars, actualR: m.actualR };

  if (heldWorst <= -1 + EPS) {
    // The stop was touched while you held. Ending there means everything
    // reached came before it; slippage can put the fill past the stop.
    const endedAtStop = exitR <= -0.95;
    return endedAtStop
      ? { ...base, reach: heldBest, stopAfter: true, ambiguousUpTo: null }
      : { ...base, reach: heldBest, stopAfter: true, ambiguousUpTo: heldBest };
  }

  const after = t.postExitPeak != null ? Math.max(0, r(t.postExitPeak)) : 0;
  const stopLater = t.postExitAdverse != null ? r(t.postExitAdverse) <= -1 + EPS : null;
  return { ...base, reach: Math.max(heldBest, after), stopAfter: stopLater, ambiguousUpTo: null };
}

export type RungOutcome = "win" | "loss" | "open" | "ambiguous";

export function outcomeAt(p: Replay, n: number): RungOutcome {
  if (p.ambiguousUpTo != null && n <= p.ambiguousUpTo + EPS) return "ambiguous";
  if (p.reach >= n - EPS) return "win";
  return p.stopAfter === true ? "loss" : "open";
}

export interface Rung {
  n: number;
  wins: number;
  losses: number;
  /** Neither level reached within the window, or no aftermath on record. */
  open: number;
  ambiguous: number;
  decided: number;
  /** Over the decided trades, after costs. */
  totalR: number;
  totalDollars: number;
  /** What the same decided trades actually made, so the two are on one footing. */
  actualR: number;
  actualDollars: number;
  expectancy: number | null;
  winRate: number | null;
  /** The win rate this rung needs to break even before costs: 1 / (1 + n). */
  breakEvenWinRate: number;
  /** The whole sample's total if every undecided trade lost, and if every one won. */
  lowR: number;
  highR: number;
}

export interface FixedTargetReport {
  /** Closed trades with a stop and a measured path. */
  sample: number;
  /** Closed trades left out: no stop, no path yet, or a scalp. */
  excluded: number;
  /** What those same trades actually made, after costs. */
  actual: { totalR: number; totalDollars: number; expectancy: number | null };
  rungs: Rung[];
  /** The rung with the best expectancy over trades it decides, when the sample allows naming one. */
  best: Rung | null;
}

export function fixedTargetReport(trades: TradeWithTags[], rungs: readonly number[] = RUNGS): FixedTargetReport {
  const closed = trades.filter((t) => t.status === "closed");
  const plays = closed.map(replay).filter((p): p is Replay => p != null);
  const actualR = plays.reduce((s, p) => s + p.actualR, 0);
  const actualDollars = plays.reduce((s, p) => s + p.actualR * p.riskDollars, 0);

  const out: Rung[] = rungs.map((n) => {
    let wins = 0, losses = 0, open = 0, ambiguous = 0, totalR = 0, totalDollars = 0, actualR = 0, actualDollars = 0;
    for (const p of plays) {
      const o = outcomeAt(p, n);
      if (o === "open") open++;
      else if (o === "ambiguous") ambiguous++;
      else {
        const R = (o === "win" ? n : -1) - p.costR;
        if (o === "win") wins++;
        else losses++;
        totalR += R;
        totalDollars += R * p.riskDollars;
        actualR += p.actualR;
        actualDollars += p.actualR * p.riskDollars;
      }
    }
    const decided = wins + losses;
    const undecided = open + ambiguous;
    return {
      n,
      wins,
      losses,
      open,
      ambiguous,
      decided,
      totalR,
      totalDollars,
      actualR,
      actualDollars,
      expectancy: decided ? totalR / decided : null,
      winRate: decided ? wins / decided : null,
      breakEvenWinRate: 1 / (1 + n),
      lowR: totalR - undecided,
      highR: totalR + undecided * n,
    };
  });

  /*
   * Named only where it rests on enough trades and the rung decided most of
   * the sample: a high rung that leaves half the trades open is answering a
   * different question from the low ones, on fewer trades.
   */
  const fair = out.filter((r) => r.decided >= MIN_DECIDED && r.decided >= plays.length * 0.75 && r.expectancy != null);
  const best = fair.length ? fair.reduce((a, b) => ((b.expectancy as number) > (a.expectancy as number) ? b : a)) : null;

  return {
    sample: plays.length,
    excluded: closed.length - plays.length,
    actual: { totalR: actualR, totalDollars: actualDollars, expectancy: plays.length ? actualR / plays.length : null },
    rungs: out,
    best,
  };
}
