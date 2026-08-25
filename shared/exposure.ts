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
 *
 * And split by direction, because five longs and no shorts is a different
 * position from three and three even when the two add to the same number.
 * The first is one bet in five pieces; the second cannot lose everything to a
 * single move, since whatever stops one side is paying the other.
 */
import type { Trade, TradeFill } from "./schema";
import { positionLedger } from "./fills";

export interface SideRisk {
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

export interface OpenRisk extends SideRisk {
  /** The book split by direction. */
  long: SideRisk;
  short: SideRisk;
  /**
   * What ONE move against you costs: the worse side standing alone.
   *
   * The headline figure assumes every stop fills, which is the whipsaw — a
   * day that runs you over in both directions. A trend does something else
   * entirely, and the difference is the whole reason to look at the split.
   * Five longs and no shorts go together: one move takes the lot, and the
   * gross number IS the directional number. Three and three do not: the same
   * move that stops the longs is paying the shorts, so the realistic damage
   * is one side, and a book that looked like 6R of exposure is closer to 3R.
   *
   * Not a hedge, and not sold as one — different coins have different betas
   * and both sides can still be stopped by a round trip. It is the honest
   * lower bound to sit next to the honest upper one.
   */
  oneWay: {
    /** Which side carries it. Null only when nothing is priced at all. */
    side: "long" | "short" | null;
    dollars: number;
    r: number;
  };
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
  const blank = (): SideRisk => ({ trades: 0, dollars: 0, r: 0, unpriced: 0 });
  const all = blank();
  const long = blank();
  const short = blank();

  for (const t of trades) {
    if (t.status !== "open") continue;
    // Anything not explicitly short is counted long, which is how direction is
    // read everywhere else here. A book must add up: a row that fell out of
    // both sides would quietly shrink the split below the total it belongs to.
    const side = t.direction === "short" ? short : long;
    all.trades++;
    side.trades++;

    const now = riskOnTrade(t);
    const opened = initialRiskOnTrade(t);
    if (now == null || opened == null) {
      // An open position with no stop on it is the most exposed a trade can
      // be, and the one thing this must not do is quietly report it as zero.
      all.unpriced++;
      side.unpriced++;
      continue;
    }
    all.dollars += now;
    all.r += now / opened;
    side.dollars += now;
    side.r += now / opened;
  }

  /*
   * Chosen on dollars, because the question this answers is "what leaves the
   * account", and R is then reported for that same side rather than for
   * whichever side happens to be larger in R. The two can disagree: a side can
   * hold fewer, bigger positions.
   */
  const worse = short.dollars > long.dollars ? short : long;
  const side = worse.dollars > 0 ? (worse === short ? "short" : "long") : null;

  return {
    ...all,
    long,
    short,
    oneWay: { side, dollars: worse.dollars, r: worse.r },
  };
}
