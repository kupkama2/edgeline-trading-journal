/**
 * What is on the table right now.
 *
 * Every other number in this journal is about trades that are over. This one
 * is about the ones that are not, and it answers a single question: if every
 * stop currently working were hit at the same moment, what would that cost?
 *
 * It is the only figure here you can act on. Expectancy and capture describe
 * a record; open risk describes an exposure, and correlated instruments have a
 * habit of stopping out together on the day it matters. Three trades that each
 * felt like a normal 1R are a 3R day when the market moves as one thing.
 *
 * Two units, because they answer to different masters. DOLLARS is what leaves
 * the account and what a prop firm's drawdown limit counts. R is what tells
 * you whether you are sized the way you meant to be — a trade half scaled out
 * carries half the risk it opened with, so a book of four untouched trades is
 * 4R and a book of four half-taken ones is 2R, on the same four rows.
 */
import type { Trade, TradeFill } from "./schema";
import { positionLedger } from "./fills";

export interface OpenRisk {
  /** Live positions. Resting orders are not exposure; nothing is filled yet. */
  trades: number;
  /** Sum of what each open trade would lose at its own stop, in dollars. */
  dollars: number;
  /**
   * The same, in R. One untouched trade is 1R by construction; a partially
   * closed one is the fraction still on.
   */
  r: number;
  /** Open trades with no stop recorded — real exposure this cannot price. */
  unpriced: number;
}

/**
 * Risk still working on one trade, in dollars, or null when it cannot be said.
 *
 * Measured on what is STILL OPEN and against the average entry the ledger
 * arrived at, not on the size the trade was opened with. Scale half off and
 * half the risk goes with it; add to the position and the risk grows, which
 * is the honest reading even though the trade's R denominator deliberately
 * does not move.
 *
 * The stop is the ORIGINAL stop, because that is the only one the journal
 * stores. A stop moved to breakeven in your platform is not known here, so
 * this is a ceiling on what is at risk rather than a live wire — which is the
 * right direction to be wrong in.
 */
export function riskOnTrade(t: Trade & { fills?: TradeFill[] }): number | null {
  if (t.initialStop == null) return null;
  const led = positionLedger(t);
  const perPoint = led.openQty * (t.pointValue ?? 1);
  const distance = Math.abs(led.avgEntry - t.initialStop);
  if (!(distance > 0) || !(perPoint > 0)) return null;
  return distance * perPoint;
}

/** What the trade risked when it was opened — the denominator of its R. */
export function initialRiskOnTrade(t: Trade & { fills?: TradeFill[] }): number | null {
  if (t.initialStop == null) return null;
  const led = positionLedger(t);
  const perPoint = led.initialQty * (t.pointValue ?? 1);
  const distance = Math.abs(t.entryPrice - t.initialStop);
  if (!(distance > 0) || !(perPoint > 0)) return null;
  return distance * perPoint;
}

/**
 * Everything currently exposed, summed.
 *
 * Only open trades. A pending order has no position and no risk — counting a
 * resting limit as exposure would inflate the number every time you queued a
 * plan and quietly train you to ignore it.
 */
export function openRisk(trades: (Trade & { fills?: TradeFill[] })[]): OpenRisk {
  let count = 0;
  let dollars = 0;
  let r = 0;
  let unpriced = 0;

  for (const t of trades) {
    if (t.status !== "open") continue;
    count++;
    const now = riskOnTrade(t);
    const opened = initialRiskOnTrade(t);
    if (now == null || opened == null) {
      // An open position with no stop on it is the most exposed a trade can
      // be, and the one thing this must not do is quietly report it as zero.
      unpriced++;
      continue;
    }
    dollars += now;
    r += now / opened;
  }
  return { trades: count, dollars, r, unpriced };
}
