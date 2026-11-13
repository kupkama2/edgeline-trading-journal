import { describe, expect, it } from "vitest";
import { edgeSentence, managementCurve, managementEdge } from "../shared/management";
import { trade } from "./helpers";
import { aggregate } from "../shared/metrics";

/**
 * Where the management edge comes from, and where it leaks.
 *
 * The net figure is the one that hides the problem: gaining 14R by cutting
 * losers and giving 9R back by cutting winners is not "up 5R on management",
 * it is two habits, one of which is worth fixing. So the test that matters
 * most here is that the two sides are reported separately and that a trade
 * lands in the row named for what actually happened to it.
 */

/** Long from 100, stop 90, target 130 — so 1R is 10 points and the plan is +3R. */
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

const bucket = (e: ReturnType<typeof managementEdge>, id: string) =>
  [...e.edges, ...e.leaks, ...e.neutral].find((b) => b.id === id);

describe("filing a managed trade", () => {
  it("credits getting out of a loser above the stop", () => {
    // The plan lost a full R; the exit lost 0.4R. That 0.6R is the edge.
    const e = managementEdge([t({ id: 1, noManagementOutcome: "stop_first", exitPrice: 96 })]);
    expect(bucket(e, "savedOnLosers")?.r).toBeCloseTo(0.6);
    expect(e.totalR).toBeCloseTo(0.6);
  });

  it("charges sitting through a stop", () => {
    const e = managementEdge([t({ id: 1, noManagementOutcome: "stop_first", exitPrice: 82 })]);
    expect(bucket(e, "heldPastStop")?.r).toBeCloseTo(-0.8);
  });

  it("charges taking less than a target the trade reached", () => {
    // The plan was +3R; you took +1R. Two R left on the table.
    const e = managementEdge([t({ id: 1, noManagementOutcome: "target_first", exitPrice: 110 })]);
    expect(bucket(e, "cutWinnersEarly")?.r).toBeCloseTo(-2);
  });

  it("gives a winner closed at a loss its own row", () => {
    /*
     * Same arithmetic as taking less than the target and a completely
     * different mistake: the trade was going to pay and you finished red.
     * Averaged in with the others it is invisible; named, it is the first
     * thing you would fix.
     */
    const e = managementEdge([t({ id: 1, noManagementOutcome: "target_first", exitPrice: 97 })]);
    expect(bucket(e, "winnerToLoser")?.trades).toBe(1);
    expect(bucket(e, "cutWinnersEarly")).toBeUndefined();
  });

  it("credits riding past the target", () => {
    const e = managementEdge([t({ id: 1, noManagementOutcome: "target_first", exitPrice: 150 })]);
    expect(bucket(e, "rodePastTarget")?.r).toBeCloseTo(2);
  });

  it("counts going exactly as planned as neither", () => {
    const e = managementEdge([
      t({ id: 1, noManagementOutcome: "target_first", exitPrice: 130 }),
      t({ id: 2, noManagementOutcome: "stop_first", exitPrice: 90 }),
    ]);
    expect(bucket(e, "fullTarget")?.trades).toBe(1);
    expect(bucket(e, "tookTheStop")?.trades).toBe(1);
    expect(e.edges).toEqual([]);
    expect(e.leaks).toEqual([]);
    expect(e.totalR).toBeCloseTo(0);
  });
});

describe("what the whole book says", () => {
  it("keeps the gain and the leak apart", () => {
    // The case the net figure hides: both habits are real and only one is
    // worth doing something about.
    const e = managementEdge([
      t({ id: 1, noManagementOutcome: "stop_first", exitPrice: 95 }),
      t({ id: 2, noManagementOutcome: "stop_first", exitPrice: 95 }),
      t({ id: 3, noManagementOutcome: "target_first", exitPrice: 105 }),
    ]);
    expect(e.edges[0].id).toBe("savedOnLosers");
    expect(e.edges[0].r).toBeCloseTo(1);
    expect(e.leaks[0].id).toBe("cutWinnersEarly");
    expect(e.leaks[0].r).toBeCloseTo(-2.5);
    // Net says "down 1.5R", which is true and tells you nothing.
    expect(e.totalR).toBeCloseTo(-1.5);
    expect(edgeSentence(e)).toMatch(/comes from cutting losers early.*leaks to cutting winners early/i);
  });

  it("prices management in money as well as R, which differ when the trades were sized differently", () => {
    // The same decision twice — out at half the stop — on a small trade and a ten-times bigger one.
    // In R the two are equal (+0.5R each); in money the big one is ten times the small one.
    const e = managementEdge([
      t({ id: 1, noManagementOutcome: "stop_first", exitPrice: 95, size: 1 }),
      t({ id: 2, noManagementOutcome: "stop_first", exitPrice: 95, size: 10 }),
    ]);
    const saved = bucket(e, "savedOnLosers")!;
    expect(saved.r).toBeCloseTo(1);
    // 1R is $10 on the first and $100 on the second: +$5 and +$50.
    expect(saved.dollars).toBeCloseTo(55);
    expect(e.totalDollars).toBeCloseTo(55);
    expect(edgeSentence(e)).toContain("+1.0R, +$55.00");
    // The book's own total says the same.
    const agg = aggregate([
      t({ id: 1, noManagementOutcome: "stop_first", exitPrice: 95, size: 1 }),
      t({ id: 2, noManagementOutcome: "stop_first", exitPrice: 95, size: 10 }),
    ]);
    expect(agg.totalDeltaR).toBeCloseTo(1);
    expect(agg.totalDeltaDollars).toBeCloseTo(55);
  });

  it("counts what it cannot measure rather than averaging over it", () => {
    // A trade still owing its plan outcome is not evidence of anything, and
    // silently dropping it would let a card claim a sample it does not have.
    const e = managementEdge([
      t({ id: 1, noManagementOutcome: "stop_first", exitPrice: 95 }),
      t({ id: 2, noManagementOutcome: null, exitPrice: 105 }),
      t({ id: 3, noManagementOutcome: "undetermined", exitPrice: 105 }),
    ]);
    expect(e.measured).toBe(1);
    expect(e.unmeasured).toBe(2);
  });

  it("ignores a trade with no 1R to measure in", () => {
    // Unmeasurable, not unanswered — counting it as owed would send you
    // looking for an answer that does not exist.
    const e = managementEdge([
      t({ id: 1, initialStop: null, noManagementOutcome: "stop_first", exitPrice: 95 }),
    ]);
    expect(e.measured).toBe(0);
    expect(e.unmeasured).toBe(0);
    expect(edgeSentence(e)).toBeNull();
  });

  it("leaves open trades out entirely", () => {
    const e = managementEdge([
      t({ id: 1, status: "open", exitPrice: null, noManagementOutcome: "target_first" }),
    ]);
    expect(e.measured).toBe(0);
  });
});

describe("the actual vs no-management curve", () => {
  it("adds up: actual minus no-management is the management total, in R and in money", () => {
    const curve = managementCurve([
      // Measured: out at half the stop on a plan that lost 1R (+0.5R), on a ten-unit trade (1R = $100).
      t({ id: 1, noManagementOutcome: "stop_first", exitPrice: 95, size: 10 }),
      // Not measured yet: no plan outcome. It counts the same on both lines.
      t({ id: 2, noManagementOutcome: null, exitPrice: 80, size: 1 }),
      // Measured: took less than a target that was reached (+1R against a +3R plan).
      t({ id: 3, noManagementOutcome: "target_first", exitPrice: 110, size: 1 }),
    ] as any);
    const last = curve[curve.length - 1];
    expect(last.actual).toBeCloseTo(-0.5 - 2 + 1, 9);
    expect(last.delta).toBeCloseTo(0.5 - 2, 9);
    expect(last.actual - last.potential).toBeCloseTo(last.delta, 9);
    // In money: -$50, -$20, +$10 actual; delta +$50 and -$20.
    expect(last.dollars).toBeCloseTo(-60, 6);
    expect(last.deltaUsd).toBeCloseTo(30, 6);
    expect(last.dollars - last.potentialUsd).toBeCloseTo(last.deltaUsd, 6);
    // The unmeasured trade moves both lines by its own result.
    expect(curve[1].actual - curve[0].actual).toBeCloseTo(curve[1].potential - curve[0].potential, 9);
  });
});
