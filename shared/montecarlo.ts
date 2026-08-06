/**
 * Monte Carlo — what your edge could plausibly do next.
 *
 * A single equity curve is one draw from a distribution. The run you actually
 * lived is not the only one your edge could have produced, and judging a system
 * by it is how a good process gets abandoned in a bad month.
 *
 * This resamples your OWN closed trades — no assumed normal distribution, no
 * fitted parameters. Bootstrap keeps the fat tails your record already has: if
 * you have taken a -3R, the simulation can take one too, which a win-rate model
 * would never produce.
 *
 * The honest reading of the output is the drawdown percentiles, not the median
 * outcome. "Half the time I end up above X" is comforting and nearly useless;
 * "one run in twenty draws down 14R" is what decides your size.
 */
import type { TradeWithTags } from "./schema";
import { computeMetrics } from "./metrics";
import { closedTrades } from "./breakdowns";

/**
 * Deterministic PRNG (mulberry32).
 *
 * Seeded on purpose: the same trade history must produce the same simulation
 * every render. A figure that shifts each time you open the page reads as noise
 * and teaches you to ignore it — and "is this different because my trading
 * changed, or because it re-rolled?" is not a question worth having.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimulationInput {
  /** How many trades forward to simulate. */
  horizon: number;
  /** How many independent runs. More is smoother; 2000 is plenty. */
  runs: number;
  /** Risk per trade in dollars, used only to translate R into money. */
  riskPerTrade?: number;
}

export interface SimulationResult {
  /** Trades the simulation drew from — below ~30 the output is barely worth reading. */
  sampleSize: number;
  horizon: number;
  runs: number;
  expectancyR: number;
  /** Final R at the 5th/25th/50th/75th/95th percentile of runs. */
  finalR: { p5: number; p25: number; p50: number; p75: number; p95: number };
  /** Worst peak-to-trough decline within a run, at the same percentiles. */
  maxDrawdownR: { p50: number; p75: number; p90: number; p95: number };
  /** Share of runs finishing below break-even. */
  probLosing: number;
  /** Share of runs that at some point sit 10R or more below their peak. */
  probDrawdown10R: number;
  riskPerTrade: number | null;
}

/** The R outcomes to resample from: one per closed trade, in no order. */
export function rSample(trades: TradeWithTags[]): number[] {
  return closedTrades(trades)
    .map((t) => computeMetrics(t).actualR)
    .filter((r): r is number => r != null && isFinite(r));
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Not enough history to say anything — reported rather than faked. */
export const MIN_SAMPLE = 20;

export function simulate(
  trades: TradeWithTags[],
  { horizon, runs, riskPerTrade }: SimulationInput,
): SimulationResult | null {
  const sample = rSample(trades);
  if (sample.length < MIN_SAMPLE) return null;

  // Seeded from the sample itself, so the simulation only changes when the
  // record does — logging a trade re-rolls it, opening the page does not.
  const seed = sample.length * 2654435761 + Math.round(sample.reduce((a, b) => a + b, 0) * 1000);
  const rand = mulberry32(seed);

  const finals: number[] = [];
  const drawdowns: number[] = [];
  let losing = 0;
  let deep = 0;

  for (let run = 0; run < runs; run++) {
    let equity = 0;
    let peak = 0;
    let worst = 0;

    for (let i = 0; i < horizon; i++) {
      // Sampling WITH replacement: each trade is an independent draw from the
      // same edge, which is the assumption being tested. It deliberately does
      // not model streakiness — if your losses cluster, real drawdowns will be
      // worse than this, and that is the direction you want to be wrong in.
      equity += sample[Math.floor(rand() * sample.length)];
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > worst) worst = dd;
    }

    finals.push(equity);
    drawdowns.push(worst);
    if (equity < 0) losing += 1;
    if (worst >= 10) deep += 1;
  }

  finals.sort((a, b) => a - b);
  drawdowns.sort((a, b) => a - b);

  return {
    sampleSize: sample.length,
    horizon,
    runs,
    expectancyR: sample.reduce((a, b) => a + b, 0) / sample.length,
    finalR: {
      p5: percentile(finals, 0.05),
      p25: percentile(finals, 0.25),
      p50: percentile(finals, 0.5),
      p75: percentile(finals, 0.75),
      p95: percentile(finals, 0.95),
    },
    maxDrawdownR: {
      p50: percentile(drawdowns, 0.5),
      p75: percentile(drawdowns, 0.75),
      p90: percentile(drawdowns, 0.9),
      p95: percentile(drawdowns, 0.95),
    },
    probLosing: losing / runs,
    probDrawdown10R: deep / runs,
    riskPerTrade: riskPerTrade ?? null,
  };
}
