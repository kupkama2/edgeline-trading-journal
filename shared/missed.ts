/**
 * The trades you didn't take.
 *
 * A journal that only records what you did measures half the decisions. The
 * setup you saw and talked yourself out of is a decision too, and it has a
 * price — but only if you write down what the plan was and, later, what the
 * market did with it.
 *
 * The point is not to feel bad about missed winners. It is to find out which
 * way the error runs: if skipped trades would have netted positive, hesitation
 * is a leak; if they would have lost, your filter is working and the discomfort
 * is the cost of a good rule. Both are actionable and they point opposite ways.
 */
import type { TradeWithTags } from "./schema";

/** A missed trade is a plan that was never sent to the venue. */
export function isMissed(t: TradeWithTags): boolean {
  return t.status === "cancelled" && t.cancelReason === "never_placed";
}

export function missedTrades(trades: TradeWithTags[]): TradeWithTags[] {
  return trades.filter(isMissed);
}

/**
 * The R this trade was planned to make: reward over risk, both taken from the
 * levels as written down. This is the whole reason a missed trade must carry a
 * stop and a target — without them there is no unit to price the miss in.
 */
export function plannedR(t: TradeWithTags): number | null {
  if (t.initialStop == null || t.initialTarget == null) return null;
  const risk = Math.abs(t.entryPrice - t.initialStop);
  if (risk <= 0) return null;
  return Math.abs(t.initialTarget - t.entryPrice) / risk;
}

export interface MissedStats {
  count: number;
  /** Missed trades whose outcome is recorded — the only ones that can be priced. */
  resolved: number;
  wouldHaveWon: number;
  wouldHaveLost: number;
  /** R given up by not taking the winners. */
  forgoneR: number;
  /** R saved by not taking the losers, as a positive number. */
  avoidedR: number;
  /**
   * forgone − avoided. Positive means skipping cost you; negative means your
   * filter earned its keep. Unresolved trades are excluded entirely rather
   * than assumed either way.
   */
  netR: number;
}

/**
 * A missed loser is scored at exactly -1R.
 *
 * Not at the planned R, and not at some estimate of where it really went: if
 * you don't take a trade you don't manage it either, so the honest
 * counterfactual is that it hit the stop you had written down. Scoring winners
 * at their full planned R and losers at -1R is the same convention the rest of
 * the journal uses for a trade that ran to one of its levels.
 */
export function missedStats(trades: TradeWithTags[]): MissedStats {
  const missed = missedTrades(trades);
  let wouldHaveWon = 0;
  let wouldHaveLost = 0;
  let forgoneR = 0;
  let avoidedR = 0;

  for (const t of missed) {
    if (t.wouldHaveHitTarget == null) continue;
    if (t.wouldHaveHitTarget) {
      wouldHaveWon += 1;
      forgoneR += plannedR(t) ?? 0;
    } else {
      wouldHaveLost += 1;
      avoidedR += 1;
    }
  }

  return {
    count: missed.length,
    resolved: wouldHaveWon + wouldHaveLost,
    wouldHaveWon,
    wouldHaveLost,
    forgoneR,
    avoidedR,
    netR: forgoneR - avoidedR,
  };
}
