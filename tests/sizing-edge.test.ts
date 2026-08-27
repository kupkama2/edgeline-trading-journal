import { describe, expect, it } from "vitest";
import {
  band,
  gapInSigmas,
  quantile,
  sizedTrades,
  sizingReport,
  sizingSentence,
  spearman,
} from "../shared/sizing-edge";
import { trade } from "./helpers";

/**
 * "Do I lose money on my small trades?"
 *
 * The naive answer — bucket by dollars risked, compare the P&L — is arithmetic
 * wearing a finding's clothes: of course the big bets moved more money, that
 * is what big means. So the tests that matter here are the ones that check
 * this refuses to draw a conclusion:
 *
 *   - R and dollars must be reported separately, because a difference in
 *     dollars with no difference in R is not a behaviour
 *   - a gap smaller than the noise on it must be called noise
 *   - a risk that does not vary must be reported as nothing to compare
 */

/** Entry 100, stop 90 → 1R is 10 points. Size scales the dollars risked. */
const t = (id: number, size: number, exit: number) =>
  trade({
    id,
    status: "closed",
    direction: "long",
    entryPrice: 100,
    initialStop: 90,
    initialTarget: 130,
    size,
    sizeUnit: "base",
    pointValue: 1,
    exitPrice: exit,
    exitReason: "target",
  } as any);

/** n trades at one size, all returning the same R. */
const run = (from: number, n: number, size: number, r: number) =>
  Array.from({ length: n }, (_, i) => t(from + i, size, 100 + r * 10));

describe("which trades can be measured at all", () => {
  it("takes closed trades that have a size and an outcome", () => {
    const rows = sizedTrades([t(1, 2, 120)]);
    expect(rows).toEqual([{ id: 1, risk: 20, r: 2, pnl: 40, symbol: "TEST" }]);
  });

  it("drops a trade with no stop, which has no 1R to be a size of", () => {
    expect(sizedTrades([trade({ id: 1, initialStop: null } as any)])).toEqual([]);
  });

  it("drops anything still running", () => {
    expect(sizedTrades([trade({ id: 1, status: "open", exitPrice: null } as any)])).toEqual([]);
  });
});

describe("a mean with the noise on it", () => {
  it("measures the spread with Bessel's correction", () => {
    const b = band([1, 2, 3]);
    expect(b.mean).toBeCloseTo(2);
    // sd = 1, se = 1/sqrt(3)
    expect(b.se!).toBeCloseTo(1 / Math.sqrt(3));
  });

  it("has no standard error on a single sample", () => {
    expect(band([2]).se).toBeNull();
    expect(band([2]).mean).toBe(2);
  });

  it("calls a gap smaller than its own noise nothing", () => {
    // Two noisy samples whose means differ by well under a combined sigma.
    const a = band([0, 2, -1, 3, 1]);
    const c = band([0.5, 1.5, -0.5, 2.5, 1]);
    expect(Math.abs(gapInSigmas(a, c)!)).toBeLessThan(2);
  });

  it("calls a gap that clears the noise a gap", () => {
    const a = band([5, 5.1, 4.9, 5, 5.05]);
    const c = band([0, 0.1, -0.1, 0, 0.05]);
    expect(gapInSigmas(a, c)!).toBeGreaterThan(2);
  });
});

describe("splitting by what was risked", () => {
  it("makes equal-count buckets from the trader's own distribution", () => {
    // 16 trades across four sizes: $10, $20, $30, $40 of risk.
    const rows = [
      ...run(1, 4, 1, 1),
      ...run(5, 4, 2, 1),
      ...run(9, 4, 3, 1),
      ...run(13, 4, 4, 1),
    ];
    const rep = sizingReport(rows);
    expect(rep.buckets.map((b) => b.trades)).toEqual([4, 4, 4, 4]);
    expect(rep.buckets[0].riskLo).toBeCloseTo(10);
    expect(rep.buckets[3].riskHi).toBeCloseTo(40);
  });

  it("refuses to bucket a sample too small to bucket", () => {
    const rep = sizingReport(run(1, 8, 1, 1));
    expect(rep.buckets).toEqual([]);
    expect(rep.measured).toBe(8);
  });

  it("does not call the risk flat when only the middle is flat", () => {
    /*
     * The bug this replaced. Twelve trades all risking exactly $20 and eight
     * spread from $10 to $80: the interquartile spread is zero, so the old
     * rule announced "there are no sizes here to compare" directly above four
     * buckets that plainly differed. The tails carried the whole effect and
     * the flat test could not see them.
     */
    const rows = [
      ...run(1, 4, 1, 1),
      ...run(5, 12, 2, 1),
      ...run(17, 4, 8, 1),
    ];
    const rep = sizingReport(rows);
    expect(rep.buckets[0].medianRisk).toBeLessThan(rep.buckets[3].medianRisk);
    expect(rep.flatRisk).toBe(false);
  });

  it("says so when the risk does not really vary", () => {
    // Everything within a few percent of $20 — there are no sizes to compare.
    const rows = [
      ...run(1, 5, 2, 1),
      ...run(6, 5, 2.02, 1),
      ...run(11, 5, 1.98, -1),
      ...run(16, 5, 2.01, -1),
    ];
    const rep = sizingReport(rows);
    expect(rep.flatRisk).toBe(true);
    expect(sizingSentence(rep)).toContain("no sizes here to compare");
  });
});

describe("R and dollars are not the same question", () => {
  it("reports identical R across buckets when only the bet size changed", () => {
    /*
     * The case the whole module exists to get right. Every trade returns
     * exactly +1R; the only thing that differs is how much was on. The dollar
     * totals then differ by a factor of four — and that is arithmetic, not a
     * finding about the trader.
     */
    const rows = [
      ...run(1, 4, 1, 1),
      ...run(5, 4, 2, 1),
      ...run(9, 4, 3, 1),
      ...run(13, 4, 4, 1),
    ];
    const rep = sizingReport(rows);
    for (const b of rep.buckets) expect(b.expectancy.mean).toBeCloseTo(1);
    expect(rep.buckets[0].totalPnL).toBeCloseTo(40);
    expect(rep.buckets[3].totalPnL).toBeCloseTo(160);
    // And it must not claim to have found a habit.
    expect(sizingSentence(rep)).toContain("inside the noise");
  });

  it("finds a real difference when the R itself differs by more than the noise", () => {
    /*
     * Small trades lose, large ones win, and each bucket has the ordinary
     * amount of scatter inside it — deliberately, because a bucket with NO
     * scatter would be a sample that happened to show none rather than proof
     * of anything, and gapInSigmas is right to decline on it.
     */
    const at = (from: number, size: number, rs: number[]) =>
      rs.map((r, i) => t(from + i, size, 100 + r * 10));
    const rep = sizingReport([
      ...at(1, 1, [-1, -1.2, -0.6, -0.8]),
      ...at(5, 2, [-0.4, -0.1, -0.5, -0.2]),
      ...at(9, 3, [0.8, 1.2, 0.9, 1.1]),
      ...at(13, 4, [1.6, 2.0, 1.8, 2.2]),
    ]);
    expect(rep.buckets[0].expectancy.mean).toBeCloseTo(-0.9);
    expect(rep.buckets[3].expectancy.mean).toBeCloseTo(1.9);
    expect(sizingSentence(rep)).toContain("worse when you are small");
  });

  it("declines when a bucket shows no scatter at all", () => {
    /*
     * Four trades that all returned exactly the same R have not proved the
     * variance is zero — they are four samples that happened to agree. An
     * infinite t-statistic out of a sample this size would be the most
     * confident wrong answer this module could give, so it gives none.
     */
    const rows = [
      ...run(1, 4, 1, -1),
      ...run(5, 4, 2, -1),
      ...run(9, 4, 3, 2),
      ...run(13, 4, 4, 2),
    ];
    expect(gapInSigmas(sizingReport(rows).buckets[3].expectancy, sizingReport(rows).buckets[0].expectancy)).toBeNull();
  });
});

describe("what the sizing itself was worth", () => {
  it("is zero when every trade risked the same", () => {
    const rep = sizingReport([
      ...run(1, 6, 2, 1),
      ...run(7, 6, 2, -1),
    ]);
    expect(rep.flatSized!.delta).toBeCloseTo(0);
  });

  it("is negative when you were small on the winners and large on the losers", () => {
    /*
     * The shape a trader means by "I lose money on my small trades": the R is
     * not the problem, the dollars behind each R are. Six +1R at $10 and six
     * −1R at $40 nets −$180 while the R nets zero — so flat sizing would have
     * broken even and the sizing decisions cost the whole amount.
     */
    const rep = sizingReport([
      ...run(1, 6, 1, 1),
      ...run(7, 6, 4, -1),
    ]);
    expect(rep.flatSized!.actual).toBeCloseTo(-180);
    expect(rep.flatSized!.flat).toBeCloseTo(0);
    expect(rep.flatSized!.delta).toBeCloseTo(-180);
  });

  it("is positive when the size lined up with the outcome", () => {
    const rep = sizingReport([
      ...run(1, 6, 4, 1),
      ...run(7, 6, 1, -1),
    ]);
    expect(rep.flatSized!.delta).toBeCloseTo(180);
  });
});

describe("the correlation between size and outcome", () => {
  it("is +1 when bigger always did better", () => {
    const rows = [t(1, 1, 90), t(2, 2, 100), t(3, 3, 110), t(4, 4, 120), t(5, 5, 130)];
    expect(spearman(rows.map((_, i) => i + 1), [-1, 0, 1, 2, 3])!).toBeCloseTo(1);
  });

  it("is −1 when bigger always did worse", () => {
    expect(spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])!).toBeCloseTo(-1);
  });

  it("shares ranks across ties rather than inventing an order", () => {
    // Two pairs of identical x. Averaged ranks keep the correlation honest.
    expect(spearman([1, 1, 2, 2], [1, 2, 3, 4])!).toBeCloseTo(0.894, 2);
  });

  it("declines to answer under a workable sample", () => {
    expect(spearman([1, 2, 3], [1, 2, 3])).toBeNull();
  });

  it("prints the threshold below which it means nothing", () => {
    const rep = sizingReport([
      ...run(1, 4, 1, 1),
      ...run(5, 4, 2, 1),
      ...run(9, 4, 3, 1),
      ...run(13, 4, 4, 1),
    ]);
    // 16 trades: anything under about 0.52 is chance.
    expect(rep.rhoNoise!).toBeCloseTo(2 / Math.sqrt(15), 3);
  });
});

describe("quantiles", () => {
  it("interpolates rather than snapping to a member", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5);
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75);
  });

  it("survives one value and none", () => {
    expect(quantile([7], 0.5)).toBe(7);
    expect(quantile([], 0.5)).toBe(0);
  });
});

describe("how concentrated the sizing edge is", () => {
  /*
   * The guard that keeps the counterfactual honest. One oversized winner on a
   * record that sizes at random produces a large, real, and completely
   * unrepeatable "sizing edge", and a card that reported only the total would
   * be making a claim about a habit out of a claim about one bet.
   */
  it("names the trade when one bet carries the number", () => {
    const rep = sizingReport([
      ...run(1, 11, 2, 1), // eleven ordinary +1R trades, all at $20
      t(99, 40, 130), // one at $400 that made +3R
    ]);
    const top = rep.flatSized!.topContributor!;
    expect(top.id).toBe(99);
    expect(top.share).toBeGreaterThan(0.9);
  });

  it("spreads the share when no single trade dominates", () => {
    const rep = sizingReport([
      ...run(1, 3, 1, 1),
      ...run(4, 3, 2, 1),
      ...run(7, 3, 3, 1),
      ...run(10, 3, 4, 1),
    ]);
    expect(rep.flatSized!.topContributor!.share).toBeLessThan(0.4);
  });

  it("has nothing to name when every trade risked the median", () => {
    // Every contribution is R × 0, so there is no movement to attribute.
    const rep = sizingReport([...run(1, 6, 2, 1), ...run(7, 6, 2, -1)]);
    expect(rep.flatSized!.topContributor).toBeNull();
  });
});
