import { describe, expect, it } from "vitest";
import { openRisk, riskOnTrade } from "../shared/exposure";
import { trade } from "./helpers";

/** Open, 1 unit, entry 100, stop 90 — $10 at risk, 1R. */
const live = (over: Record<string, unknown> = {}) =>
  trade({
    status: "open",
    exitPrice: null,
    exitTime: null,
    exitReason: null,
    entryPrice: 100,
    initialStop: 90,
    initialTarget: 130,
    size: 1,
    ...over,
  } as any);

const fill = (id: number, kind: "add" | "partial", price: number, size: number, hh: string) =>
  ({ id, tradeId: 1, kind, price, size, time: `2026-08-03T${hh}:00:00Z`, note: null }) as any;

describe("what one open trade has at risk", () => {
  it("is the stop distance across the position", () => {
    expect(riskOnTrade(live({ size: 3 }))).toBeCloseTo(30);
  });

  it("uses the contract multiplier", () => {
    // 2 MNQ at $2 a point, 10 points to the stop: $40, not $20.
    expect(riskOnTrade(live({ size: 2, pointValue: 2, entryPrice: 100, initialStop: 90 }))).toBeCloseTo(40);
  });

  it("falls with a partial, because half the position is half the risk", () => {
    const scaled = live({ size: 4, fills: [fill(1, "partial", 120, 2, "10")] });
    expect(riskOnTrade(scaled)).toBeCloseTo(20); // 2 units left, not 4
  });

  it("rises when you add, measured against the new average entry", () => {
    // 1 unit at 100 plus 1 at 110 -> 2 units averaging 105, stop 90: 15 points
    // across 2 units. Exposure grew; the trade's R denominator deliberately
    // did not, and this is the number that tells you so.
    const added = live({ size: 1, fills: [fill(1, "add", 110, 1, "10")] });
    expect(riskOnTrade(added)).toBeCloseTo(30);
  });

  it("works the same for a short", () => {
    expect(riskOnTrade(live({ direction: "short", entryPrice: 100, initialStop: 110 }))).toBeCloseTo(10);
  });

  it("cannot price a position with no stop", () => {
    expect(riskOnTrade(live({ initialStop: null }))).toBeNull();
  });
});

describe("everything on the table at once", () => {
  it("adds up the dollars and counts the trades", () => {
    const out = openRisk([live({ id: 1, size: 3 }), live({ id: 2, size: 2, pointValue: 2 })]);
    expect(out.trades).toBe(2);
    expect(out.dollars).toBeCloseTo(30 + 40);
  });

  it("counts an untouched trade as exactly 1R", () => {
    // The claim the whole R figure rests on: four normal trades open is a 4R
    // day if the market moves as one thing, however differently they are sized.
    const out = openRisk([
      live({ id: 1, size: 1 }),
      live({ id: 2, size: 7, pointValue: 20 }),
      live({ id: 3, direction: "short", entryPrice: 50, initialStop: 55 }),
      live({ id: 4, size: 0.4 }),
    ]);
    expect(out.r).toBeCloseTo(4);
  });

  it("counts a half-closed trade as half an R", () => {
    const out = openRisk([live({ id: 1, size: 4, fills: [fill(1, "partial", 120, 2, "10")] })]);
    expect(out.r).toBeCloseTo(0.5);
    expect(out.dollars).toBeCloseTo(20);
  });

  it("ignores everything that is not a live position", () => {
    // A resting order has no position. Counting it would inflate the number
    // every time a plan was queued, and teach you to stop reading it.
    const out = openRisk([
      trade({ id: 1, status: "pending", exitPrice: null, initialStop: null } as any),
      trade({ id: 2, status: "closed" } as any),
      trade({ id: 3, status: "cancelled", exitPrice: null } as any),
      live({ id: 4 }),
    ]);
    expect(out.trades).toBe(1);
    expect(out.dollars).toBeCloseTo(10);
  });

  it("reports a stopless open position rather than pricing it at zero", () => {
    // The most exposed a trade can be is the one case a risk figure must not
    // silently read as nothing.
    const out = openRisk([live({ id: 1 }), live({ id: 2, initialStop: null })]);
    expect(out.trades).toBe(2);
    expect(out.unpriced).toBe(1);
    expect(out.dollars).toBeCloseTo(10);
    expect(out.r).toBeCloseTo(1);
  });

  it("is all zeroes on an empty book", () => {
    expect(openRisk([])).toEqual({ trades: 0, dollars: 0, r: 0, unpriced: 0 });
  });
});
