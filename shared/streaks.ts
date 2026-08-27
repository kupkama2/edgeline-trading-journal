/**
 * Streaks, drawdown, and the shape of the equity curve.
 *
 * Expectancy tells you what a trade is worth on average; it says nothing about
 * the path. Two systems with identical expectancy can differ entirely in
 * whether you could actually sit through them — and the number that decides
 * that is peak-to-trough drawdown, not the average.
 *
 * Drawdown is measured in R as well as dollars, and R is the one to trust: it
 * is comparable across a period where size changed, which dollars are not.
 */
import type { TradeWithTags } from "./schema";
import { computeMetrics } from "./metrics";
import { closedTrades, dailyResults, type DayResult } from "./breakdowns";

export interface Streaks {
  longestWin: number;
  longestLoss: number;
  /** Signed: positive means N wins running right now, negative means N losses. */
  current: number;
}

/**
 * Streaks over trades in the order they were REALISED, not the order they were
 * entered — a streak is a psychological run, and what you feel is the sequence
 * of results landing.
 */
export function streaks(trades: TradeWithTags[]): Streaks {
  const rs = closedTrades(trades)
    .slice()
    .sort((a, b) =>
      (a.exitTime ?? a.entryTime).localeCompare(b.exitTime ?? b.entryTime),
    )
    .map((t) => computeMetrics(t).actualR ?? 0);

  let longestWin = 0;
  let longestLoss = 0;
  let run = 0;

  for (const r of rs) {
    const win = r > 0;
    // A run continues while the sign holds; any flip restarts it at one.
    if (run === 0 || win !== run > 0) run = win ? 1 : -1;
    else run += win ? 1 : -1;

    if (run > longestWin) longestWin = run;
    if (-run > longestLoss) longestLoss = -run;
  }

  return { longestWin, longestLoss, current: run };
}

export interface DrawdownStats {
  /** Deepest peak-to-trough fall, as a positive number. */
  maxDrawdownR: number;
  maxDrawdownPnL: number;
  /** The day the trough was reached, so it can be looked up and read about. */
  troughDay: string | null;
  /** How many days the deepest drawdown lasted from peak to trough. */
  troughLengthDays: number;
  /** Whether the curve has since recovered past that peak. */
  recovered: boolean;
  currentDrawdownR: number;
  /** The same open drawdown in dollars — the peak-to-here fall in money. */
  currentDrawdownPnL: number;
  bestDay: DayResult | null;
  worstDay: DayResult | null;
  /** Cumulative R after each trading day, for drawing the curve. */
  equityR: { day: string; cumulativeR: number; cumulativePnL: number }[];
}

const EMPTY: DrawdownStats = {
  maxDrawdownR: 0,
  maxDrawdownPnL: 0,
  troughDay: null,
  troughLengthDays: 0,
  recovered: false,
  currentDrawdownR: 0,
  currentDrawdownPnL: 0,
  bestDay: null,
  worstDay: null,
  equityR: [],
};

/**
 * Walk the daily series once, tracking the running peak. Drawdown is measured
 * from the highest equity seen SO FAR — a later, higher peak does not retro-
 * actively deepen an earlier decline.
 *
 * Daily rather than per-trade: a day is the unit you actually experience, and
 * measuring intra-day peaks would report drawdowns you never sat through.
 */
export function drawdown(trades: TradeWithTags[]): DrawdownStats {
  const days = dailyResults(trades);
  if (!days.length) return EMPTY;

  let cumR = 0;
  let cumPnL = 0;
  let peakR = 0;
  let peakPnL = 0;
  let peakDay = days[0].day;

  let maxDD = 0;
  let maxDDPnL = 0;
  let troughDay: string | null = null;
  let troughLength = 0;
  let recovered = false;

  const equityR: DrawdownStats["equityR"] = [];

  for (const d of days) {
    cumR += d.r;
    cumPnL += d.pnl;
    equityR.push({ day: d.day, cumulativeR: cumR, cumulativePnL: cumPnL });

    if (cumR >= peakR) {
      // A new high ends whatever decline preceded it.
      if (troughDay && !recovered) recovered = true;
      peakR = cumR;
      peakPnL = cumPnL;
      peakDay = d.day;
      continue;
    }

    const dd = peakR - cumR;
    if (dd > maxDD) {
      maxDD = dd;
      maxDDPnL = peakPnL - cumPnL;
      troughDay = d.day;
      troughLength = daysBetween(peakDay, d.day);
      // Reopened: this is now the deepest hole, and it is not climbed out of
      // until equity prints a new high after it.
      recovered = false;
    }
  }

  const sortedByPnL = days.slice().sort((a, b) => a.pnl - b.pnl);

  return {
    maxDrawdownR: maxDD,
    maxDrawdownPnL: maxDDPnL,
    troughDay,
    troughLengthDays: troughLength,
    recovered,
    currentDrawdownR: Math.max(0, peakR - cumR),
    currentDrawdownPnL: Math.max(0, peakPnL - cumPnL),
    bestDay: sortedByPnL[sortedByPnL.length - 1] ?? null,
    worstDay: sortedByPnL[0] ?? null,
    equityR,
  };
}

function daysBetween(a: string, b: string): number {
  const ms = new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime();
  return Math.max(0, Math.round(ms / 86400000));
}
