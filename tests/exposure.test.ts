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
    const out = openRisk([]);
    expect(out).toMatchObject({ trades: 0, dollars: 0, r: 0, unpriced: 0 });
    expect(out.long).toEqual({ trades: 0, dollars: 0, r: 0, unpriced: 0 });
    expect(out.short).toEqual({ trades: 0, dollars: 0, r: 0, unpriced: 0 });
    // No side is worse when there are no sides. Naming one here would put a
    // direction on an empty book.
    expect(out.oneWay).toEqual({ side: null, dollars: 0, r: 0 });
  });
});

describe("which way the book is leaning", () => {
  /*
   * The point of the split. Five longs and three-and-three can add to the same
   * headline number and be completely different positions: the first is one
   * bet in five pieces, and the move that stops one stops all five.
   */
  it("separates the two sides", () => {
    const out = openRisk([
      live({ id: 1 }),
      live({ id: 2 }),
      live({ id: 3, direction: "short", entryPrice: 100, initialStop: 110, initialTarget: 70 }),
    ]);
    expect(out.trades).toBe(3);
    expect(out.long.trades).toBe(2);
    expect(out.short.trades).toBe(1);
    expect(out.long.dollars).toBeCloseTo(20);
    expect(out.short.dollars).toBeCloseTo(10);
    // The sides are a partition of the book, not a sample of it.
    expect(out.long.dollars + out.short.dollars).toBeCloseTo(out.dollars);
    expect(out.long.r + out.short.r).toBeCloseTo(out.r);
    expect(out.long.trades + out.short.trades).toBe(out.trades);
  });

  it("prices one directional move as the worse side alone", () => {
    // Three long, three short. Every stop hit is 6R — a whipsaw. A trend is
    // 3R, because the move stopping one side is paying the other.
    const shortSide = { direction: "short", entryPrice: 100, initialStop: 110, initialTarget: 70 };
    const out = openRisk([
      live({ id: 1 }),
      live({ id: 2 }),
      live({ id: 3 }),
      live({ id: 4, ...shortSide }),
      live({ id: 5, ...shortSide }),
      live({ id: 6, ...shortSide }),
    ]);
    expect(out.r).toBeCloseTo(6);
    expect(out.oneWay.r).toBeCloseTo(3);
    expect(out.oneWay.dollars).toBeCloseTo(30);
  });

  it("says a one-way book costs the whole thing in a single move", () => {
    // Five longs: nothing to offset, so the directional number IS the gross
    // one. This is the case the split exists to make visible.
    const out = openRisk([1, 2, 3, 4, 5].map((id) => live({ id })));
    expect(out.short.trades).toBe(0);
    expect(out.oneWay.side).toBe("long");
    expect(out.oneWay.r).toBeCloseTo(out.r);
    expect(out.oneWay.dollars).toBeCloseTo(out.dollars);
  });

  it("names the bigger side even when it holds fewer trades", () => {
    // One short risking $50 against three longs risking $10 each: the count
    // says longs, the money says shorts, and the money is what leaves the
    // account.
    const out = openRisk([
      live({ id: 1 }),
      live({ id: 2 }),
      live({ id: 3 }),
      live({ id: 4, direction: "short", entryPrice: 100, initialStop: 150, initialTarget: 20 }),
    ]);
    expect(out.long.trades).toBe(3);
    expect(out.oneWay.side).toBe("short");
    expect(out.oneWay.dollars).toBeCloseTo(50);
    // R comes from the SAME side that dollars chose, not from whichever side
    // happens to be larger in R — mixing the two would describe a book that
    // does not exist.
    expect(out.oneWay.r).toBeCloseTo(1);
  });

  it("counts a stopless position on its own side", () => {
    // An unpriced short is exposure on the short side. Filing it only in the
    // total would make the split look complete when a whole position is
    // missing from it.
    const out = openRisk([
      live({ id: 1 }),
      live({ id: 2, direction: "short", initialStop: null }),
    ]);
    expect(out.unpriced).toBe(1);
    expect(out.short.unpriced).toBe(1);
    expect(out.short.trades).toBe(1);
    expect(out.long.unpriced).toBe(0);
  });
});
