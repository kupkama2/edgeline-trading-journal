import { describe, expect, it } from "vitest";
import { cohort, cohortSentence, handOn, managementCohorts } from "../shared/cohorts";
import { computeMetrics } from "../shared/metrics";
import { buildInsightsBundle, startOfWeek } from "../shared/weekly-insights";
import { trade } from "./helpers";

/**
 * Won-and-managed, lost-and-managed, and the counterfactual for each.
 *
 * Two things here are worth more than the arithmetic. "Managed" has to mean
 * what you DID rather than how it came out, or the cohorts become a
 * restatement of the result. And the plan total has to be summed over exactly
 * the trades the realised total is summed over, or the card compares twenty
 * trades against twelve and reports the difference as a finding.
 */

/** Long from 100, stop 90, target 130 — 1R is 10 points and the plan is +3R. */
const t = (over: Record<string, unknown>) =>
  trade({
    status: "closed",
    entryPrice: 100,
    initialStop: 90,
    initialTarget: 130,
    size: 1,
    direction: "long",
    ...over,
  } as any);

const hand = (over: Record<string, unknown>) => {
  const tr = t(over);
  return handOn(tr as any, computeMetrics(tr as any));
};

describe("what counts as having managed a trade", () => {
  it("calls the plan finishing 'left alone', either way", () => {
    expect(hand({ id: 1, exitPrice: 130, exitReason: "target" })).toBe("left-alone");
    expect(hand({ id: 2, exitPrice: 90, exitReason: "stop" })).toBe("left-alone");
  });

  it("calls every other named exit management", () => {
    for (const reason of ["trailed", "breakeven", "discretion", "invalidated", "time"]) {
      expect(hand({ id: 1, exitPrice: 112, exitReason: reason })).toBe("managed");
    }
  });

  it("counts a partial as management whatever the exit says", () => {
    // Ended at the target, so the reason alone would read "left alone" — but
    // half the position came off on the way there, which is a decision.
    expect(
      hand({
        id: 1,
        exitPrice: 130,
        exitReason: "target",
        fills: [{ id: 1, tradeId: 1, kind: "partial", size: 0.5, price: 120, time: "2026-01-01T00:00:00Z", fee: null }],
      }),
    ).toBe("managed");
  });

  it("infers management from an outcome the plan could not have produced", () => {
    // Nothing said how it ended, but the untouched plan lost a full R and
    // this finished at −0.4R. That cannot happen by leaving it alone.
    expect(hand({ id: 1, exitPrice: 96, exitReason: null, noManagementOutcome: "stop_first" })).toBe(
      "managed",
    );
  });

  it("refuses to infer the other way", () => {
    // Matching the plan is what leaving it alone looks like AND what a
    // hand-close at the target looks like. Unknown is the honest answer.
    expect(
      hand({ id: 1, exitPrice: 130, exitReason: null, noManagementOutcome: "target_first" }),
    ).toBe("unknown");
    expect(hand({ id: 2, exitPrice: 112, exitReason: null })).toBe("unknown");
  });
});

describe("sorting trades into the four cohorts", () => {
  it("splits managed trades by how they finished", () => {
    const r = managementCohorts([
      t({ id: 1, exitPrice: 120, exitReason: "discretion", noManagementOutcome: "target_first" }),
      t({ id: 2, exitPrice: 94, exitReason: "trailed", noManagementOutcome: "stop_first" }),
    ]);
    expect(cohort(r, "wonManaged").tradeIds).toEqual([1]);
    expect(cohort(r, "lostManaged").tradeIds).toEqual([2]);
    expect(cohort(r, "wonAlone").trades).toBe(0);
    expect(cohort(r, "lostAlone").trades).toBe(0);
  });

  it("keeps the untouched ones as their own control group", () => {
    const r = managementCohorts([
      t({ id: 1, exitPrice: 130, exitReason: "target" }),
      t({ id: 2, exitPrice: 90, exitReason: "stop" }),
    ]);
    expect(cohort(r, "wonAlone").tradeIds).toEqual([1]);
    expect(cohort(r, "lostAlone").tradeIds).toEqual([2]);
    expect(cohort(r, "wonAlone").totalR).toBeCloseTo(3);
    expect(cohort(r, "lostAlone").totalR).toBeCloseTo(-1);
  });

  it("counts a trade it cannot classify rather than picking a side", () => {
    const r = managementCohorts([t({ id: 1, exitPrice: 112, exitReason: null })]);
    expect(r.unclassified).toBe(1);
    expect(r.cohorts.every((c) => c.trades === 0)).toBe(true);
  });

  it("keeps a scratch out of both winners and losers", () => {
    const r = managementCohorts([t({ id: 1, exitPrice: 100, exitReason: "breakeven" })]);
    expect(r.scratched).toBe(1);
    expect(cohort(r, "wonManaged").trades).toBe(0);
    expect(cohort(r, "lostManaged").trades).toBe(0);
  });

  it("ignores a trade with no stop, which has no R to be in a cohort with", () => {
    const r = managementCohorts([
      t({ id: 1, initialStop: null, exitPrice: 130, exitReason: "discretion" }),
    ]);
    expect(r.closed).toBe(0);
    expect(r.unclassified).toBe(0);
  });

  it("ignores anything not closed", () => {
    const r = managementCohorts([
      t({ id: 1, status: "open", exitPrice: null, exitReason: null }),
      t({ id: 2, status: "pending", exitPrice: null, exitReason: null }),
    ]);
    expect(r.closed).toBe(0);
  });
});

describe("what they would have done left alone", () => {
  it("prices the winners you touched against their own plan", () => {
    // Both were on their way to +3R; both got closed by hand at +2R.
    const r = managementCohorts([
      t({ id: 1, exitPrice: 120, exitReason: "discretion", noManagementOutcome: "target_first" }),
      t({ id: 2, exitPrice: 120, exitReason: "discretion", noManagementOutcome: "target_first" }),
    ]);
    const c = cohort(r, "wonManaged");
    expect(c.measured).toBe(2);
    expect(c.actualOnMeasuredR).toBeCloseTo(4);
    expect(c.planR).toBeCloseTo(6);
    expect(c.deltaR).toBeCloseTo(-2);
  });

  it("prices the losers you cut against the full stop they avoided", () => {
    const r = managementCohorts([
      t({ id: 1, exitPrice: 96, exitReason: "discretion", noManagementOutcome: "stop_first" }),
      t({ id: 2, exitPrice: 95, exitReason: "discretion", noManagementOutcome: "stop_first" }),
    ]);
    const c = cohort(r, "lostManaged");
    expect(c.actualOnMeasuredR).toBeCloseTo(-0.9);
    expect(c.planR).toBeCloseTo(-2);
    expect(c.deltaR).toBeCloseTo(1.1);
  });

  it("sums the realised side over the SAME trades as the plan side", () => {
    /*
     * The heart of it. Three managed winners, only one of which has an
     * answer to "what would it have done?". The cohort's own total is all
     * three; the comparison is one against one. Summing +9R of realised
     * against +3R of plan would report a 6R edge that is entirely an artefact
     * of two trades having no counterfactual.
     */
    const r = managementCohorts([
      t({ id: 1, exitPrice: 130, exitReason: "discretion", noManagementOutcome: "target_first" }),
      t({ id: 2, exitPrice: 130, exitReason: "discretion", noManagementOutcome: null }),
      t({ id: 3, exitPrice: 130, exitReason: "discretion", noManagementOutcome: null }),
    ]);
    const c = cohort(r, "wonManaged");
    expect(c.trades).toBe(3);
    expect(c.totalR).toBeCloseTo(9);
    expect(c.measured).toBe(1);
    expect(c.actualOnMeasuredR).toBeCloseTo(3);
    expect(c.planR).toBeCloseTo(3);
    expect(c.deltaR).toBeCloseTo(0);
  });

  it("stays null rather than reporting a confident zero", () => {
    const r = managementCohorts([
      t({ id: 1, exitPrice: 120, exitReason: "discretion", noManagementOutcome: null }),
    ]);
    const c = cohort(r, "wonManaged");
    expect(c.trades).toBe(1);
    expect(c.measured).toBe(0);
    expect(c.planR).toBeNull();
    expect(c.deltaR).toBeNull();
    expect(c.actualOnMeasuredR).toBeNull();
  });

  it("carries the same comparison in dollars", () => {
    // 1 contract, 1R = 10 points = $10. Closed at +2R instead of +3R.
    const r = managementCohorts([
      t({ id: 1, exitPrice: 120, exitReason: "discretion", noManagementOutcome: "target_first" }),
    ]);
    const c = cohort(r, "wonManaged");
    expect(c.actualOnMeasuredPnL).toBeCloseTo(20);
    expect(c.planPnL).toBeCloseTo(30);
    expect(c.deltaPnL).toBeCloseTo(-10);
  });
});

describe("the sentence at the top", () => {
  it("reports the two habits separately instead of netting them", () => {
    const s = cohortSentence(
      managementCohorts([
        // Gave up 1R on a winner...
        t({ id: 1, exitPrice: 120, exitReason: "discretion", noManagementOutcome: "target_first" }),
        // ...and saved 0.6R on a loser. A net figure would say "+" and hide
        // the winner habit; this has to say both.
        t({ id: 2, exitPrice: 96, exitReason: "discretion", noManagementOutcome: "stop_first" }),
      ]),
    );
    expect(s).toContain("cost you 1.0R");
    expect(s).toContain("earned you 0.6R");
    expect(s).toContain("1 managed winner");
    expect(s).toContain("1 managed loser");
  });

  it("says nothing when nothing can be compared", () => {
    expect(cohortSentence(managementCohorts([]))).toBeNull();
    expect(
      cohortSentence(
        managementCohorts([t({ id: 1, exitPrice: 130, exitReason: "target" })]),
      ),
    ).toBeNull();
  });

  it("says so when your hand made no difference", () => {
    const s = cohortSentence(
      managementCohorts([
        t({ id: 1, exitPrice: 130, exitReason: "discretion", noManagementOutcome: "target_first" }),
      ]),
    );
    expect(s).toContain("changed nothing");
  });
});

describe("what the weekly review is handed", () => {
  /*
   * The bundle used to carry one netted management figure, which is the exact
   * summary that hides the shape this data most often has: a week that cuts
   * its losers well and dumps its winners nets out to something that looks
   * fine. The model cannot report a habit it was only shown the net of.
   */
  const monday = startOfWeek(new Date(2026, 7, 10));
  const inWeek = (over: Record<string, unknown>) =>
    t({
      entryTime: "2026-08-11T10:00:00.000Z",
      exitTime: "2026-08-11T12:00:00.000Z",
      ...over,
    });

  it("carries the four cohorts, not just the net", () => {
    const b = buildInsightsBundle(
      [
        // Dumped a winner: +2R where the plan paid +3R.
        inWeek({ id: 1, exitPrice: 120, exitReason: "discretion", noManagementOutcome: "target_first" }),
        // Cut a loser: −0.4R where the plan lost the full 1R.
        inWeek({ id: 2, exitPrice: 96, exitReason: "discretion", noManagementOutcome: "stop_first" }),
        // Left one alone, for the control group.
        inWeek({ id: 3, exitPrice: 130, exitReason: "target", noManagementOutcome: "target_first" }),
      ] as any,
      [],
      monday,
    );

    expect(b.managed.won.deltaR).toBeCloseTo(-1);
    expect(b.managed.lost.deltaR).toBeCloseTo(0.6);
    expect(b.managed.wonLeftAlone.trades).toBe(1);
    expect(b.managed.lostLeftAlone.trades).toBe(0);
    expect(b.managed.classified).toBe(3);

    // The netted figure the bundle already had reads as almost nothing, which
    // is the whole reason the split has to travel beside it.
    expect(b.stats.totalDeltaR).toBeCloseTo(-0.4);
  });

  it("sends null rather than a counterfactual it does not have", () => {
    const b = buildInsightsBundle(
      [inWeek({ id: 1, exitPrice: 120, exitReason: "discretion", noManagementOutcome: null })] as any,
      [],
      monday,
    );
    expect(b.managed.won.trades).toBe(1);
    expect(b.managed.won.measured).toBe(0);
    expect(b.managed.won.planR).toBeNull();
    expect(b.managed.won.deltaR).toBeNull();
  });

  it("reports trades it could not classify instead of filing them somewhere", () => {
    const b = buildInsightsBundle(
      [inWeek({ id: 1, exitPrice: 112, exitReason: null })] as any,
      [],
      monday,
    );
    expect(b.managed.unclassified).toBe(1);
    expect(b.managed.classified).toBe(0);
  });
});
