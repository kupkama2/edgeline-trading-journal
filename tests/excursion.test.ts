import { describe, expect, it } from "vitest";
import { excursions, summariseExcursions } from "../shared/excursion";
import { trade } from "./helpers";

/**
 * Helper: a closed long, entry 100, stop 90 (1R = 10 points), with a chosen
 * exit, worst price (mae) and best price (mfe).
 */
function t(over: {
  id?: number;
  exit: number;
  mae?: number;
  mfe?: number;
  postExitPeak?: number;
}) {
  return trade({
    id: over.id ?? 1,
    entryPrice: 100,
    initialStop: 90,
    initialTarget: 130,
    exitPrice: over.exit,
    mae: over.mae ?? null,
    mfe: over.mfe ?? null,
    postExitPeak: over.postExitPeak ?? null,
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

/**
 * The third band: what the trade did after you were out.
 *
 * The chart's whole reason for splitting green from grey is that "it went
 * higher" is two different events with opposite lessons — green above the
 * exit is give-back (a management problem), grey is a run you weren't in (an
 * exit-timing one). If both came off one field the HYPE trade — closed early,
 * ran on for days — reads as "held too long", which is the exact opposite of
 * what happened.
 */
describe("the post-exit run", () => {
  it("puts the post-exit peak on the same axis as the in-trade legs", () => {
    // Exited +1.8R, then it ran to 136 — another +1.8R past the exit.
    const [e] = excursions([t({ exit: 118, mae: 96, mfe: 124, postExitPeak: 136 })]);
    expect(e.leftBehindR).toBeCloseTo(1.8);
    expect(e.postPeakR).toBeCloseTo(3.6); // the exit's R plus the run
    expect(e.postPeakR!).toBeGreaterThan(e.mfeR); // new ground -> the band draws
  });

  it("is null, not zero, when the aftermath was never recorded", () => {
    // Zero would claim the trade died the moment you left. It says nothing.
    const [e] = excursions([t({ exit: 118, mae: 96, mfe: 124 })]);
    expect(e.leftBehindR).toBeNull();
    expect(e.postPeakR).toBeNull();
  });

  it("charts a trade whose only recorded path is what happened after the exit", () => {
    // The trades this band exists for are exactly the ones where nobody wrote
    // down MAE or MFE but did note that it kept going. Requiring an in-trade
    // leg too would filter out the evidence.
    const rows = excursions([t({ exit: 118, postExitPeak: 136 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].leftBehindR).toBeCloseTo(1.8);
  });

  it("reports no run when the move died the moment you left", () => {
    // Post-exit peak below the exit is clamped to zero by computeMetrics:
    // leaving before a collapse is not a cost.
    const [e] = excursions([t({ exit: 118, mae: 96, mfe: 124, postExitPeak: 110 })]);
    expect(e.leftBehindR).toBe(0);
    expect(e.postPeakR).toBeCloseTo(e.actualR);
  });

  it("keeps give-back and run-on separable on the same trade", () => {
    // Peaked at 124 while held, closed 112, then rallied back to 121. Gave
    // back 1.2R AND ran 0.9R without you — but that 0.9R covered ground the
    // trade had already seen, so the chart has no new band to draw.
    const [e] = excursions([t({ exit: 112, mae: 96, mfe: 124, postExitPeak: 121 })]);
    expect(e.mfeR - e.actualR).toBeCloseTo(1.2); // give-back, the green above the tick
    expect(e.leftBehindR).toBeCloseTo(0.9); // the run, reported in the tooltip
    expect(e.postPeakR!).toBeLessThan(e.mfeR); // no new ground -> no grey band
  });

  it("measures the run for a short in the short's favour", () => {
    // Short from 100, stop 110. Covered at 88 (+1.2R), then it kept falling
    // to 82 — a further 0.6R the position would have made.
    const short = trade({
      id: 9,
      direction: "short",
      entryPrice: 100,
      initialStop: 110,
      exitPrice: 88,
      mfe: 86,
      mae: 104,
      postExitPeak: 82,
      status: "closed",
    });
    const [e] = excursions([short]);
    expect(e.actualR).toBeCloseTo(1.2);
    expect(e.leftBehindR).toBeCloseTo(0.6);
    expect(e.postPeakR).toBeCloseTo(1.8);
  });
});

describe("summariseExcursions", () => {
  it("averages the post-exit run over only the trades that measured one", () => {
    const s = summariseExcursions(
      excursions([
        t({ id: 1, exit: 118, mae: 96, mfe: 124, postExitPeak: 136 }), // ran +1.8R
        t({ id: 2, exit: 118, mae: 96, mfe: 124, postExitPeak: 124 }), // ran +0.6R
        t({ id: 3, exit: 118, mae: 96, mfe: 124 }), // never looked
      ]),
    )!;
    expect(s.leftBehindCount).toBe(2);
    expect(s.avgLeftBehindR).toBeCloseTo(1.2); // (1.8 + 0.6) / 2, not / 3
  });

  it("says nothing about the aftermath when nothing was recorded", () => {
    const s = summariseExcursions(excursions([t({ exit: 118, mae: 96, mfe: 124 })]))!;
    expect(s.avgLeftBehindR).toBeNull();
    expect(s.leftBehindCount).toBe(0);
  });

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
