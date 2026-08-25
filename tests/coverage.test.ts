import { describe, expect, it } from "vitest";
import { exitCoverage, residualFromAverage, totalPnLWithFills } from "../shared/fills";
import { trade } from "./helpers";

/**
 * Logging only the exits that were easy to copy.
 *
 * The exchange's average close is the one number that is always right and
 * always one click away, so it is what gets typed in. The individual exits
 * are not equally easy — a limit clip is one tidy row, a market close is a
 * dozen prints — so a trader logs the tidy ones and stops.
 *
 * That leaves the ledger settling the remainder at the exit price, which is
 * the average over the WHOLE position: it double-counts the clips already
 * logged, and the total drifts away from the figure the exchange printed
 * while still looking exactly like a P&L. Given an average known to be
 * right, there is exactly one price the remainder can have had, so it is
 * solved for rather than guessed at.
 */

/** Long 1000 units from 100, closed at an average of 110. */
const t = (fills: { price: number; size: number }[], over: Record<string, unknown> = {}) =>
  trade({
    status: "closed",
    direction: "long",
    entryPrice: 100,
    initialStop: 90,
    size: 1000,
    sizeUnit: "base",
    exitPrice: 110,
    exitTime: "2026-08-25T12:00:00",
    fills: fills.map((f, i) => ({
      id: i + 1,
      tradeId: 1,
      kind: "partial",
      price: f.price,
      size: f.size,
      time: `2026-08-25T1${i}:00:00`,
      note: null,
    })),
    ...over,
  } as any);

describe("what the partials account for", () => {
  it("says nothing at all when there are no partials", () => {
    expect(exitCoverage(t([]))).toBeNull();
  });

  it("measures how much of the position they cover", () => {
    const c = exitCoverage(t([{ price: 105, size: 400 }, { price: 108, size: 200 }]))!;
    expect(c.covered).toBeCloseTo(0.6);
    expect(c.residualQty).toBeCloseTo(400);
  });

  it("solves the remainder from the average that is known to be right", () => {
    // 1000 @ 110 = 110,000 in total. The 600 logged brought 63,600, so the
    // last 400 must have brought 46,400 — 116 apiece.
    const r = residualFromAverage(t([{ price: 105, size: 400 }, { price: 108, size: 200 }]), 110);
    expect(r.price).toBeCloseTo(116);
    expect(r.problem).toBeNull();
  });

  it("leaves the total exactly where the average put it", () => {
    /*
     * The whole point of the exercise. Logging the two tidy exits and putting
     * the solved price in the exit field must land on the same P&L as never
     * having decomposed the trade at all — the partials add detail, not
     * arithmetic.
     */
    const partials = [{ price: 105, size: 400 }, { price: 108, size: 200 }];
    const solved = residualFromAverage(t(partials), 110).price!;
    const decomposed = t(partials, { exitPrice: solved });
    // (110 - 100) * 1000, the trade read as one exit at the average.
    expect(totalPnLWithFills(t([], { exitPrice: 110 }))).toBeCloseTo(10000);
    expect(totalPnLWithFills(decomposed)).toBeCloseTo(10000);
  });

  it("has nothing to solve once the partials already cover it", () => {
    const c = exitCoverage(t([{ price: 110, size: 1000 }]))!;
    expect(c.residualQty).toBeCloseTo(0);
    expect(residualFromAverage(t([{ price: 110, size: 1000 }]), 110).problem)
      .toMatch(/already cover the position/i);
  });
});

describe("when the numbers cannot be squared", () => {
  it("refuses a price nowhere near the trade rather than writing it in", () => {
    /*
     * A mistyped size solves perfectly cleanly to a nonsense price. This is
     * the case the feature exists to not get wrong: a plausible-looking
     * figure written in as fact is worse than the gap it filled.
     */
    const r = residualFromAverage(t([{ price: 105, size: 990 }]), 110);
    expect(r.price).toBeNull();
    expect(r.problem).toMatch(/nowhere near this trade/i);
  });

  it("does not let a wrong average vouch for the price it produces", () => {
    /*
     * A trade that ran from 100 to 110, told the average was 400. The
     * remainder solves to 841 — absurd for this trade, yet perfectly
     * reasonable next to 400, which is why the believable band is drawn
     * around the prices the trade actually saw rather than around the number
     * just typed in.
     */
    const r = residualFromAverage(t([{ price: 105, size: 400 }, { price: 108, size: 200 }]), 400);
    expect(r.price).toBeNull();
    expect(r.problem).toMatch(/nowhere near this trade/i);
  });

  it("says so when the partials exceed the position", () => {
    const r = residualFromAverage(t([{ price: 105, size: 800 }, { price: 108, size: 400 }]), 110);
    expect(r.price).toBeNull();
    expect(r.problem).toMatch(/more than the position/i);
  });

  it("refuses when the average cannot be reached at any positive price", () => {
    // Every logged exit above the average, so the rest would have to be
    // negative to pull it back down.
    const r = residualFromAverage(t([{ price: 150, size: 900 }]), 110);
    expect(r.price).toBeNull();
    expect(r.problem).toBeTruthy();
  });

  it("refuses an average nobody typed", () => {
    // An empty box is not a claim about anything, and solving from zero would
    // hand back a confident number derived from nothing.
    expect(residualFromAverage(t([{ price: 105, size: 400 }]), 0).price).toBeNull();
    expect(residualFromAverage(t([{ price: 105, size: 400 }]), 0).problem).toBeNull();
  });
});

describe("adds, and positions kept in quote", () => {
  it("counts what the adds put on as part of what has to come off", () => {
    const withAdd = trade({
      status: "closed",
      direction: "long",
      entryPrice: 100,
      initialStop: 90,
      size: 1000,
      sizeUnit: "base",
      exitPrice: 110,
      fills: [
        { id: 1, tradeId: 1, kind: "add", price: 100, size: 1000, time: "2026-08-25T09:00:00", note: null },
        { id: 2, tradeId: 1, kind: "partial", price: 105, size: 1000, time: "2026-08-25T11:00:00", note: null },
      ],
    } as any);
    const c = exitCoverage(withAdd)!;
    // 2000 on, half of it closed.
    expect(c.totalQty).toBeCloseTo(2000);
    expect(c.covered).toBeCloseTo(0.5);
    expect(residualFromAverage(withAdd, 110).price).toBeCloseTo(115);
  });

  it("reads a quote-denominated position in the same units throughout", () => {
    // 1100 USDT of a 1.10 coin is 1000 units; 660 USDT of it is 600.
    const q = t([{ price: 105, size: 42000 }], {
      sizeUnit: "quote",
      size: 100000,
      entryPrice: 100,
      exitPrice: 110,
    });
    const c = exitCoverage(q)!;
    expect(c.totalQty).toBeCloseTo(1000);
    expect(c.coveredQty).toBeCloseTo(400);
    expect(residualFromAverage(q, 110).price).toBeCloseTo(113.333, 2);
  });
});
