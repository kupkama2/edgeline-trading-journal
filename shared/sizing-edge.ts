/**
 * Does the size you bet change how well you trade?
 *
 * The question a trader actually asks is "do I lose money on my small ones?",
 * and the naive way to answer it — bucket by dollars risked, compare the P&L —
 * answers a different question. Of course the big bets moved more money; that
 * is what "big" means. A comparison of dollar totals across size buckets is
 * arithmetic dressed up as a finding.
 *
 * R is what makes it answerable, because R has the size divided out. So every
 * bucket carries both, and the gap between them IS the subject:
 *
 *   R differs across buckets   → you trade differently at different sizes.
 *                                A behaviour. Fixable.
 *   R is flat, dollars differ  → you bet different amounts. Arithmetic.
 *                                Nothing to fix, and nothing was found.
 *
 * Two further guards, because this is the kind of question that most easily
 * produces a confident wrong answer:
 *
 *   1. Every bucket average is reported with the noise around it. Ten trades
 *      with a 1.5R spread put ±0.9R of uncertainty on their own mean, which
 *      is wider than most gaps anyone gets excited about. A card that shows
 *      "+0.8R vs +0.2R" and not the band is inviting a conclusion the sample
 *      cannot support.
 *
 *   2. The buckets are quantiles of your OWN risk distribution, not fixed
 *      dollar thresholds. Fixed thresholds put nineteen trades in one bucket
 *      and one in another and then compare their means.
 */
import type { Trade, TradeFill } from "./schema";
import { computeMetrics } from "./metrics";

/** Fewer than this in a bucket and its mean is not worth printing. */
export const MIN_PER_BUCKET = 3;

/** Risk within this fraction of the median counts as "the same size". */
const FLAT_SPREAD = 0.15;

/*
 * "Does the risk vary?" is measured across the WHOLE range, and — once there
 * are buckets — between the two the card actually compares.
 *
 * Measuring it on the interquartile spread was wrong in a way that only
 * showed up on real data: a trader whose middle half all risk exactly $200
 * has an IQR of zero, so the card announced "there are no sizes here to
 * compare" directly above four buckets ranging from $40 to $900 and a
 * counterfactual worth tens of thousands. The tails were carrying the entire
 * effect and the flat test could not see them.
 */

export interface Sized {
  id: number;
  /** What one R cost on this trade, in dollars. The size decision. */
  risk: number;
  /** Realised R. Size divided out. */
  r: number;
  /** Realised dollars, from R and the risk actually taken. */
  pnl: number;
  symbol: string;
  /** When it happened, so "big" can be told apart from "recent". */
  at: string;
}

/**
 * Closed trades that have both a size and an outcome.
 *
 * P&L is recomputed as R × risk rather than read off actualPnL. The two are
 * the same figure, but the counterfactual below re-sizes these trades — and
 * mixing a measured dollar total with a derived one makes the difference
 * between them look like a finding when it is a rounding artefact.
 */
export function sizedTrades(trades: (Trade & { fills?: TradeFill[] })[]): Sized[] {
  const out: Sized[] = [];
  for (const t of trades) {
    if (t.status !== "closed") continue;
    const m = computeMetrics(t);
    if (m.actualR == null || !(m.riskDollars > 0)) continue;
    out.push({
      id: t.id,
      risk: m.riskDollars,
      r: m.actualR,
      pnl: m.actualR * m.riskDollars,
      symbol: t.symbol,
      at: t.exitTime ?? t.entryTime,
    });
  }
  // Chronological, because the confound checks below are about order and the
  // caller's array is in whatever order the query returned.
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** A mean with the uncertainty on it — the only honest way to print one. */
export interface Band {
  mean: number;
  /** Standard error. Null on a single sample, which has no spread to measure. */
  se: number | null;
  n: number;
}

export function band(xs: number[]): Band {
  const n = xs.length;
  if (n === 0) return { mean: 0, se: null, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, se: null, n };
  // Sample variance, Bessel-corrected: with n small — which it always is here
  // — dividing by n understates the spread exactly where it matters most.
  const varr = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return { mean, se: Math.sqrt(varr / n), n };
}

/**
 * Do two means differ by more than the noise on them?
 *
 * Welch, in the only form worth having on a card: the gap measured in units
 * of its own standard error. Under 2 is "this sample cannot tell", which is
 * the answer far more often than anyone expects at these sample sizes.
 */
export function gapInSigmas(a: Band, b: Band): number | null {
  if (a.se == null || b.se == null) return null;
  const se = Math.sqrt(a.se ** 2 + b.se ** 2);
  if (!(se > 0)) return null;
  return (a.mean - b.mean) / se;
}

export interface SizeBucket {
  /** 0 is the smallest risk. */
  index: number;
  label: string;
  trades: number;
  tradeIds: number[];
  /** The risk range this bucket covers, in dollars. */
  riskLo: number;
  riskHi: number;
  medianRisk: number;
  winRate: number;
  /** Expectancy per trade in R, with the noise on it. */
  expectancy: Band;
  totalR: number;
  totalPnL: number;
  /** Expectancy per trade in dollars, with the noise on it. */
  expectancyPnL: Band;
}

export interface SizingReport {
  /** Closed trades that could be measured at all. */
  measured: number;
  /** How much the risk varies: the spread of the middle, over the median. */
  spread: number;
  medianRisk: number;
  minRisk: number;
  maxRisk: number;
  /**
   * The risk is effectively constant, so there are no sizes to compare.
   * Reported rather than silently producing four identical buckets.
   */
  flatRisk: boolean;
  buckets: SizeBucket[];
  /**
   * Rank correlation between what a trade risked and what it returned in R.
   * Null under a workable sample. Ranks rather than raw values so one huge
   * outlier cannot carry the whole number.
   */
  rho: number | null;
  /** |rho| under this is indistinguishable from chance at this sample size. */
  rhoNoise: number | null;
  /** What varying the size actually did to the money. */
  flatSized: FlatSized | null;
  /**
   * The other things that could be producing the difference.
   *
   * A size split is only about size if size is the only thing that changes
   * across it, and on a real journal it usually is not. Two confounds are
   * common enough to be worth testing rather than mentioning:
   *
   *   Time. Traders size up as an account grows, so the "smallest quarter"
   *   quietly becomes last year and the "largest" becomes this month — and
   *   the card would be comparing early-you against recent-you and calling
   *   it a size effect.
   *
   *   Instrument. If the small trades are one symbol and the big ones
   *   another, the finding is about what you trade rather than how much.
   *
   * Neither is fatal. Both change what the number means, and a card that
   * cannot see them will state a conclusion it has not earned.
   */
  confounds: Confounds | null;
}

export interface Confounds {
  /** Rank correlation between when a trade happened and how big it was. */
  timeRho: number | null;
  /** Size and time move together enough that the bands are really eras. */
  driftsWithTime: boolean;
  /**
   * MEAN risk over the older half of the record and over the newer half.
   *
   * The mean rather than the median, because on real data the drift lives in
   * the tails: a record whose typical trade is $200 throughout can still have
   * every one of its big trades in the last month, and a median summary
   * reports "$200 against $200" underneath a warning it cannot justify.
   */
  earlyRisk: number;
  lateRisk: number;
  /** The typical trade in each half, which often has not moved at all. */
  earlyTypical: number;
  lateTypical: number;
  /** The symbol that dominates each bucket, when one does. */
  dominant: { index: number; symbol: string; share: number }[];
  /** The two end buckets are mostly different instruments. */
  differentInstruments: boolean;
}

export interface FlatSized {
  /** Dollars made, sized as you actually sized. */
  actual: number;
  /** Dollars made, had every trade risked the same. */
  flat: number;
  /** actual − flat. Negative means the sizing decisions cost money. */
  delta: number;
  /** The one size the counterfactual uses. */
  at: number;
  /**
   * The single trade that moved the delta most, and its share of all the
   * movement.
   *
   * Without this the figure is quietly dishonest. Each trade contributes
   * R × (its risk − the median risk), so ONE oversized winner can produce a
   * five-figure "sizing edge" on a record that otherwise sizes at random —
   * and "your sizing earned you $44,000" is then a claim about one bet
   * wearing the clothes of a claim about a habit. Share is of the total
   * absolute movement, so offsetting contributions cannot hide it.
   */
  topContributor: { id: number; delta: number; share: number } | null;
}

const LABELS = ["Smallest quarter", "Second quarter", "Third quarter", "Largest quarter"];

/**
 * Split by risk into equal-count buckets and score each.
 *
 * Quantiles of the trader's own distribution, so the buckets always hold
 * roughly the same number of trades. Fixed dollar thresholds would compare a
 * bucket of nineteen against a bucket of one and print both means the same
 * size.
 */
export function sizingReport(
  trades: (Trade & { fills?: TradeFill[] })[],
  bucketCount = 4,
): SizingReport {
  const rows = sizedTrades(trades);
  const risks = rows.map((x) => x.risk).sort((a, b) => a - b);
  const measured = rows.length;
  const medianRisk = quantile(risks, 0.5);
  const minRisk = risks[0] ?? 0;
  const maxRisk = risks[risks.length - 1] ?? 0;
  const spread = medianRisk > 0 ? (maxRisk - minRisk) / medianRisk : 0;

  const empty: SizingReport = {
    measured,
    spread,
    medianRisk,
    minRisk,
    maxRisk,
    flatRisk: measured > 0 && spread < FLAT_SPREAD,
    buckets: [],
    rho: null,
    rhoNoise: null,
    flatSized: null,
    confounds: null,
  };
  // One bucket per MIN_PER_BUCKET at least, or the quantiles are decoration.
  if (measured < bucketCount * MIN_PER_BUCKET) return empty;

  const ordered = [...rows].sort((a, b) => a.risk - b.risk);
  const buckets: SizeBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const from = Math.floor((i * ordered.length) / bucketCount);
    const to = Math.floor(((i + 1) * ordered.length) / bucketCount);
    const slice = ordered.slice(from, to);
    if (slice.length === 0) continue;
    const rs = slice.map((x) => x.r);
    const ps = slice.map((x) => x.pnl);
    const sortedRisk = slice.map((x) => x.risk).sort((a, b) => a - b);
    buckets.push({
      index: i,
      label: bucketCount === 4 ? LABELS[i] : `Band ${i + 1}`,
      trades: slice.length,
      tradeIds: slice.map((x) => x.id),
      riskLo: sortedRisk[0],
      riskHi: sortedRisk[sortedRisk.length - 1],
      medianRisk: quantile(sortedRisk, 0.5),
      winRate: rs.filter((r) => r > 0).length / slice.length,
      expectancy: band(rs),
      totalR: rs.reduce((a, b) => a + b, 0),
      totalPnL: ps.reduce((a, b) => a + b, 0),
      expectancyPnL: band(ps),
    });
  }

  const totalR = rows.reduce((a, x) => a + x.r, 0);
  const actual = rows.reduce((a, x) => a + x.pnl, 0);
  /*
   * Now that the buckets exist, the flat test becomes the one the card
   * actually makes: are the two ends the same size? That is a stricter and
   * more useful question than "is the whole range narrow", and it is the
   * only one whose answer licenses the comparison below it.
   */
  const ends = buckets[buckets.length - 1].medianRisk - buckets[0].medianRisk;
  const flatRisk = medianRisk > 0 && ends / medianRisk < FLAT_SPREAD;

  return {
    ...empty,
    flatRisk,
    buckets,
    rho: spearman(rows.map((x) => x.risk), rows.map((x) => x.r)),
    // Roughly the 5% two-sided threshold for a null correlation. Printed so a
    // rho of 0.2 over 30 trades reads as "nothing", which is what it is.
    rhoNoise: measured > 3 ? 2 / Math.sqrt(measured - 1) : null,
    /*
     * What the sizing itself was worth.
     *
     * Both sides are R × dollars, so the only thing that differs between them
     * is which dollars. Negative means you were small on the trades that
     * worked and large on the ones that did not — which is the shape a trader
     * means when they say "I lose money on my small ones", and it is not the
     * same claim as "my small trades have a worse expectancy".
     */
    flatSized: {
      actual,
      flat: medianRisk * totalR,
      delta: actual - medianRisk * totalR,
      at: medianRisk,
      topContributor: topContributor(rows, medianRisk),
    },
    confounds: confoundsFor(rows, buckets),
  };
}

/**
 * What else, besides size, differs across these buckets.
 *
 * rows arrives chronological, so the time test is a rank correlation between
 * position in the record and risk — no dates, no bucketing by month, and
 * immune to a long gap between trades.
 */
function confoundsFor(rows: Sized[], buckets: SizeBucket[]): Confounds {
  const order = rows.map((_, i) => i);
  const timeRho = spearman(order, rows.map((x) => x.risk));
  const noise = rows.length > 3 ? 2 / Math.sqrt(rows.length - 1) : null;

  const half = Math.floor(rows.length / 2);
  const med = (xs: number[]) => quantile([...xs].sort((a, b) => a - b), 0.5);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const early = rows.slice(0, half).map((x) => x.risk);
  const late = rows.slice(half).map((x) => x.risk);
  const earlyRisk = mean(early);
  const lateRisk = mean(late);
  /*
   * A rank correlation alone is not enough to fire on. It can clear its
   * threshold on a pattern too subtle to describe, and a warning whose own
   * evidence line reads "$200 against $200" is worse than no warning. So the
   * average size has to have actually moved as well — then there is always
   * something concrete to point at.
   */
  const moved =
    Math.min(earlyRisk, lateRisk) > 0 &&
    Math.abs(lateRisk - earlyRisk) / Math.min(earlyRisk, lateRisk) >= 0.25;

  const dominant = buckets.map((b) => {
    const syms = new Map<string, number>();
    for (const id of b.tradeIds) {
      const sym = rows.find((x) => x.id === id)?.symbol;
      if (sym) syms.set(sym, (syms.get(sym) ?? 0) + 1);
    }
    let top = { symbol: "", n: 0 };
    syms.forEach((n, symbol) => {
      if (n > top.n) top = { symbol, n };
    });
    return { index: b.index, symbol: top.symbol, share: b.trades ? top.n / b.trades : 0 };
  });

  const first = dominant[0];
  const last = dominant[dominant.length - 1];

  return {
    timeRho,
    driftsWithTime: timeRho != null && noise != null && Math.abs(timeRho) >= noise && moved,
    earlyRisk,
    lateRisk,
    earlyTypical: med(early),
    lateTypical: med(late),
    dominant,
    /* Both ends have to be concentrated AND on different names. One bucket
       being 90% NQ says nothing on its own if the other one is too. */
    differentInstruments:
      first != null &&
      last != null &&
      first.symbol !== last.symbol &&
      first.share > 0.5 &&
      last.share > 0.5,
  };
}

/**
 * Which single trade did most to make the sizing look good or bad.
 *
 * The counterfactual is a sum of per-trade terms, so this is exact rather
 * than an attribution heuristic: trade i moved the total by its R times how
 * far its risk sat from the median.
 */
function topContributor(rows: Sized[], medianRisk: number): FlatSized["topContributor"] {
  if (rows.length === 0) return null;
  let best: { id: number; delta: number } | null = null;
  let gross = 0;
  for (const x of rows) {
    const d = x.r * (x.risk - medianRisk);
    gross += Math.abs(d);
    if (!best || Math.abs(d) > Math.abs(best.delta)) best = { id: x.id, delta: d };
  }
  if (!best || !(gross > 0)) return null;
  return { ...best, share: Math.abs(best.delta) / gross };
}

/** Linear-interpolated quantile of an already-sorted list. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Spearman's rho — Pearson on the ranks.
 *
 * On ranks rather than values on purpose: one 8R outlier on the largest
 * position would otherwise decide the entire correlation by itself, and the
 * question is about a tendency across trades, not about that trade.
 */
export function spearman(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n !== ys.length || n < 4) return null;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? num / den : null;
}

/** Average ranks, so ties do not invent an ordering that is not there. */
function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k].i] = shared;
    i = j + 1;
  }
  return out;
}

/**
 * The finding, in one sentence, or an admission that there is not one.
 *
 * Written to refuse the conclusion far more often than it draws it. The
 * smallest and largest quarters are compared in R — because that is the only
 * comparison where size has been divided out — and the gap is only called a
 * gap when it clears the noise on both means.
 */
export function sizingSentence(rep: SizingReport): string | null {
  if (rep.measured === 0) return null;
  if (rep.flatRisk) {
    return `Your risk barely varies — every trade risks between $${Math.round(
      rep.minRisk,
    )} and $${Math.round(rep.maxRisk)}, against a median of $${Math.round(
      rep.medianRisk,
    )}. There are no sizes here to compare.`;
  }
  if (rep.buckets.length < 2) {
    return `Not enough closed trades yet to split by size — ${rep.measured} so far, and this needs at least ${MIN_PER_BUCKET * 4}.`;
  }

  const small = rep.buckets[0];
  const large = rep.buckets[rep.buckets.length - 1];
  const sig = gapInSigmas(large.expectancy, small.expectancy);
  const r = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)}R`;
  const money = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n))}`;

  // A quarter whose ends coincide risked one amount, not a range.
  const range = (b: SizeBucket) =>
    Math.round(b.riskLo) === Math.round(b.riskHi)
      ? money(b.riskLo)
      : `${money(b.riskLo)}–${money(b.riskHi)}`;
  const head = `Smallest quarter (risking ${range(small)}) returns ${r(
    small.expectancy.mean,
  )} a trade; largest quarter (${range(large)}) returns ${r(large.expectancy.mean)}.`;

  if (sig == null || Math.abs(sig) < 2) {
    return `${head} That gap is inside the noise on ${rep.measured} trades — it is not yet evidence of anything.`;
  }
  const worseSmall = small.expectancy.mean < large.expectancy.mean;
  return `${head} That gap survives the noise: you genuinely trade ${
    worseSmall ? "worse when you are small" : "worse when you are large"
  }, and it is a habit rather than arithmetic.`;
}
