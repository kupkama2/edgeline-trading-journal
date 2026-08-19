/**
 * MAE / MFE excursion — how far each trade travelled, and where you got out.
 *
 * Every trade has a range it lived through: the worst it went against you
 * (Maximum Adverse Excursion) and the best it went in your favour (Maximum
 * Favourable Excursion), both in R. Your actual exit sits somewhere inside
 * that range. Plotting all three per trade answers the two questions a P&L
 * column never can:
 *
 *   - Adverse: are your stops too tight? If winners routinely dip to −0.8R
 *     before working, a −0.5R stop is cutting good trades.
 *   - Favourable: are you leaving money on the table? A trade that reached
 *     +3R and closed at +1R gave back two-thirds of the move.
 *
 * Pure and shared so the chart renders without a round trip and the numbers
 * can be tested directly. Everything derives from computeMetrics, so the R
 * here agrees with the R everywhere else in the app.
 */
import type { TradeWithTags } from "./schema";
import { computeMetrics } from "./metrics";
import { EXIT_TIMING_MEANINGFUL_R } from "./metrics";

export interface Excursion {
  tradeId: number;
  symbol: string;
  /** Best in-favour excursion in R (≥0 for a normal trade). */
  mfeR: number;
  /** Worst adverse excursion in R, reported as a NEGATIVE number for the axis. */
  maeR: number;
  /** Where the trade actually closed, in R. */
  actualR: number;
  win: boolean;
  /** actualR / mfeR, clipped to [0,1] — the share of the best move you kept. */
  capture: number | null;
}

/**
 * Build one excursion row per closed trade that recorded its path.
 *
 * A trade with no MAE and no MFE logged has no excursion to show and is left
 * out rather than drawn as a flat line at zero — the chart is about the
 * trades you measured, and saying "12 of 40 have path data" is more honest
 * than padding it with blanks. Ordered most-recent-first, matching the journal.
 */
export function excursions(trades: TradeWithTags[]): Excursion[] {
  return trades
    .filter((t) => t.status === "closed" && t.exitPrice != null && (t.mae != null || t.mfe != null))
    .slice()
    .sort((a, b) => (b.exitTime ?? b.entryTime).localeCompare(a.exitTime ?? a.entryTime))
    .map((t) => {
      const m = computeMetrics(t);
      const actualR = m.actualR ?? 0;
      // A leg the trader didn't record falls back to the exit itself, so the
      // bar never claims the trade travelled further than we actually know.
      const mfeR = m.mfeR ?? Math.max(0, actualR);
      const maeR = m.maeR ?? Math.min(0, actualR);
      return {
        tradeId: t.id,
        symbol: t.symbol,
        mfeR,
        // Clamp to ≤0: an "adverse" excursion that came out positive is noise
        // in the recorded price, and a bar crossing the baseline the wrong way
        // reads as a bug.
        maeR: Math.min(0, maeR),
        actualR,
        win: actualR >= 0,
        capture: m.captureRatioClipped,
      };
    });
}

export interface ExcursionSummary {
  count: number;
  /** Mean best-in-favour reach, in R. */
  avgMfeR: number;
  /** Mean worst adverse dip, in R (negative). */
  avgMaeR: number;
  avgActualR: number;
  /** Mean share of the favourable move captured, 0..1 — the give-back story. */
  avgCapture: number | null;
  /** Worst adverse dip seen among WINNERS — how much heat a good trade took. */
  deepestWinnerMaeR: number;
}

/**
 * The one-line reads under the chart. avgCapture is the headline: a low number
 * means the edge is finding moves the exit isn't keeping.
 */
export function summariseExcursions(rows: Excursion[]): ExcursionSummary | null {
  if (!rows.length) return null;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const captures = rows.map((r) => r.capture).filter((c): c is number => c != null);
  const winnerMaes = rows.filter((r) => r.win).map((r) => r.maeR);
  return {
    count: rows.length,
    avgMfeR: mean(rows.map((r) => r.mfeR)),
    avgMaeR: mean(rows.map((r) => r.maeR)),
    avgActualR: mean(rows.map((r) => r.actualR)),
    avgCapture: captures.length ? mean(captures) : null,
    deepestWinnerMaeR: winnerMaes.length ? Math.min(...winnerMaes) : 0,
  };
}

/* ----------------------------- exit timing ----------------------------- */

/**
 * The two costs an exit can have, summed across the log.
 *
 * GAVE BACK is the late story: reached while in the trade, closed below it.
 * LEFT BEHIND is the early story: the move carried on after the exit, before
 * the stop level broke. They come from different fields, so a trade
 * contributes only the legs it measured — and which total is chronically
 * bigger is the answer to "do I close too early or too late", as a number
 * instead of a hunch.
 */
export interface ExitTimingSummary {
  /** Closed trades with at least one leg measured. */
  measured: number;
  gaveBackTotalR: number;
  gaveBackTrades: number;
  leftBehindTotalR: number;
  leftBehindTrades: number;
  /** Which cost dominates, or null when neither clears the meaningful bar. */
  lean: "early" | "late" | null;
}

export function exitTimingSummary(trades: TradeWithTags[]): ExitTimingSummary | null {
  let measured = 0;
  let gaveBackTotalR = 0;
  let gaveBackTrades = 0;
  let leftBehindTotalR = 0;
  let leftBehindTrades = 0;

  for (const t of trades) {
    if (t.status !== "closed" || t.exitPrice == null) continue;
    const m = computeMetrics(t);
    const gb = m.rLeftOnTable != null ? Math.max(0, m.rLeftOnTable) : null;
    const lb = m.leftBehindR;
    if (gb == null && lb == null) continue;
    measured++;
    if (gb != null && gb >= EXIT_TIMING_MEANINGFUL_R) {
      gaveBackTotalR += gb;
      gaveBackTrades++;
    }
    if (lb != null && lb >= EXIT_TIMING_MEANINGFUL_R) {
      leftBehindTotalR += lb;
      leftBehindTrades++;
    }
  }
  if (!measured) return null;
  const lean =
    leftBehindTotalR === 0 && gaveBackTotalR === 0
      ? null
      : leftBehindTotalR > gaveBackTotalR
        ? "early"
        : "late";
  return { measured, gaveBackTotalR, gaveBackTrades, leftBehindTotalR, leftBehindTrades, lean };
}
