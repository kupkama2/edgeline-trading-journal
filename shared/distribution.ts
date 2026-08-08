/**
 * The shape of the edge, not just its average.
 *
 * Expectancy says a trade is worth +0.4R. It does not say whether that comes
 * from a steady drip of +0.5R wins or from one +12R monster carrying eighty
 * scratches — and those two edges need completely different amounts of
 * patience, position size and drawdown tolerance. This module answers that by
 * histogramming the actual R outcomes, and by measuring how much of the
 * profit depends on the very best trades.
 *
 * Bin width adapts to the range so the picture is never twelve empty bars or
 * three fat ones, and bin edges always land on multiples of the width, which
 * puts a boundary exactly at zero: no bar ever straddles win and loss.
 */
import type { TradeWithTags } from "./schema";
import { closedTrades, computeMetrics } from "./metrics";

export interface RBin {
  /** Inclusive lower edge in R. */
  from: number;
  /** Exclusive upper edge in R. */
  to: number;
  label: string;
  count: number;
  /** Fraction of all trades in this bin, 0..1. */
  share: number;
  /** True when the whole bin is at or below zero. */
  losing: boolean;
}

export interface RDistribution {
  bins: RBin[];
  binSize: number;
  count: number;
  /** Middle outcome — resistant to the outlier that drags the mean. */
  medianR: number;
  /** Mean R per trade; the same expectancy the rest of the app reports. */
  meanR: number;
  /** Biggest single win as a share of gross winnings, 0..1. */
  topWinShare: number;
  /** Share of gross winnings from the best 10% of winners, 0..1. */
  top10PctShare: number;
  /** Largest win and loss, in R. */
  bestR: number;
  worstR: number;
}

/** Bin widths we are willing to draw, smallest first. */
const WIDTHS = [0.25, 0.5, 1, 2, 5];
const MAX_BINS = 16;

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function rDistribution(trades: TradeWithTags[]): RDistribution | null {
  const rs = closedTrades(trades)
    .map((t) => computeMetrics(t).actualR)
    .filter((r): r is number => r != null && isFinite(r));
  if (!rs.length) return null;

  const sorted = [...rs].sort((a, b) => a - b);
  const lo = sorted[0];
  const hi = sorted[sorted.length - 1];

  // Widest range first: pick the finest width that still fits in MAX_BINS.
  const binSize =
    WIDTHS.find((w) => Math.ceil(hi / w) - Math.floor(lo / w) + 1 <= MAX_BINS) ??
    WIDTHS[WIDTHS.length - 1];

  const firstIdx = Math.floor(lo / binSize);
  const lastIdx = Math.floor(hi / binSize);
  const bins: RBin[] = [];
  for (let k = firstIdx; k <= lastIdx; k++) {
    const from = k * binSize;
    const to = from + binSize;
    // The topmost bin owns its upper edge, so the best trade has a home.
    const count = rs.filter((r) => (k === lastIdx ? r >= from && r <= to : r >= from && r < to))
      .length;
    bins.push({
      from,
      to,
      label: fmtBin(from, to),
      count,
      share: count / rs.length,
      losing: to <= 0.0000001,
    });
  }

  const wins = rs.filter((r) => r > 0).sort((a, b) => b - a);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const topN = Math.max(1, Math.ceil(wins.length * 0.1));

  return {
    bins,
    binSize,
    count: rs.length,
    medianR: quantile(sorted, 0.5),
    meanR: rs.reduce((a, b) => a + b, 0) / rs.length,
    topWinShare: grossWin > 0 ? wins[0] / grossWin : 0,
    top10PctShare:
      grossWin > 0 ? wins.slice(0, topN).reduce((a, b) => a + b, 0) / grossWin : 0,
    bestR: hi,
    worstR: lo,
  };
}

/** "−1R to −0.5R" reads worse than "−1 to −0.5R"; keep one unit per label. */
function fmtBin(from: number, to: number): string {
  const n = (v: number) => {
    const s = Math.abs(v) % 1 === 0 ? v.toFixed(0) : v.toFixed(2).replace(/0$/, "");
    return s.replace("-", "−");
  };
  return `${n(from)} to ${n(to)}R`;
}

/**
 * One sentence about the shape, or null when the sample is too small to say
 * anything honest. Tail-dependence is the finding worth surfacing: an edge
 * that lives in one trade is an edge you can miss by being on lunch.
 */
export function describeShape(d: RDistribution): string | null {
  if (d.count < 12) return null;
  if (d.topWinShare >= 0.4) {
    return `One trade is ${Math.round(d.topWinShare * 100)}% of everything you won. This edge lives in its tail — miss the outlier and the record looks completely different.`;
  }
  if (d.top10PctShare >= 0.6) {
    return `The best 10% of winners carry ${Math.round(d.top10PctShare * 100)}% of the winnings. Cutting runners early is the most expensive habit available to you.`;
  }
  if (d.medianR > 0 && d.meanR > 0) {
    return `Both the median and the mean are positive — the edge is in the body of the distribution, not one lucky trade. That is the durable kind.`;
  }
  if (d.medianR <= 0 && d.meanR > 0) {
    return `The typical trade loses; the average one wins. You are paid by the right tail, so protect the runners and keep the losers at 1R.`;
  }
  return null;
}
