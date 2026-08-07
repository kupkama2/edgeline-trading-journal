import { describe, expect, it } from "vitest";
import { excursions, summariseExcursions } from "../shared/excursion";
import { trade } from "./helpers";

/**
 * Helper: a closed long, entry 100, stop 90 (1R = 10 points), with a chosen
 * exit, worst price (mae) and best price (mfe).
 */
function t(over: { id?: number; exit: number; mae?: number; mfe?: number }) {
  return trade({
    id: over.id ?? 1,
    entryPrice: 100,
    initialStop: 90,
    initialTarget: 130,
    exitPrice: over.exit,
    mae: over.mae ?? null,
    mfe: over.mfe ?? null,
    status: "closed",
    exitReason: over.exit >= 100 ? "target" : "stop",
  });
}

describe("excursions", () => {
  it("reports MFE up, MAE down, and the actual exit in R", () => {
    // Went to 124 (+2.4R) in favour, dipped to 96 (−0.4R) against, closed 118 (+1.8R).
    const [e] = excursions([t({ exit: 118, mae: 96, mfe: 124 })]);
    expect(e.mfeR).toBeCloseTo(2.4);
    expect(e.maeR).toBeCloseTo(-0.4);
    expect(e.actualR).toBeCloseTo(1.8);
    expect(e.win).toBe(true);
    expect(e.capture).toBeCloseTo(1.8 / 2.4, 5);
  });

  it("skips trades that recorded no path at all", () => {
    expect(excursions([t({ exit: 118 })])).toHaveLength(0);
  });

  it("clamps a positive adverse reading to zero", () => {
    // mae above entry is noise; the bar must not cross the baseline upward.
    const [e] = excursions([t({ exit: 118, mae: 101, mfe: 124 })]);
    expect(e.maeR).toBe(0);
  });

  it("falls back to the exit for a leg that wasn't recorded", () => {
    // Only MAE logged; MFE unknown → at least the exit's +1.8R.
    const [e] = excursions([t({ exit: 118, mae: 96 })]);
    expect(e.mfeR).toBeCloseTo(1.8);
    expect(e.maeR).toBeCloseTo(-0.4);
  });

  it("orders most-recent-first", () => {
    const older = trade({ id: 1, exitTime: "2026-08-01T10:00:00Z", exitPrice: 118, mae: 96, mfe: 124, initialStop: 90 });
    const newer = trade({ id: 2, exitTime: "2026-08-05T10:00:00Z", exitPrice: 118, mae: 96, mfe: 124, initialStop: 90 });
    expect(excursions([older, newer]).map((e) => e.tradeId)).toEqual([2, 1]);
  });
});

describe("summariseExcursions", () => {
  it("averages the legs and finds the deepest heat a winner took", () => {
    const s = summariseExcursions(
      excursions([
        t({ id: 1, exit: 110, mae: 92, mfe: 130 }), // win, MAE −0.8R
        t({ id: 2, exit: 90, mae: 90, mfe: 105 }), // loss, MAE −1R
      ]),
    )!;
    expect(s.count).toBe(2);
    expect(s.avgMfeR).toBeCloseTo((3 + 0.5) / 2);
    expect(s.deepestWinnerMaeR).toBeCloseTo(-0.8); // only the winner counts here
  });

  it("is null with nothing to summarise", () => {
    expect(summariseExcursions([])).toBeNull();
  });
});
