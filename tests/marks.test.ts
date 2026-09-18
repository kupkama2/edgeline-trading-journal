import { describe, expect, it } from "vitest";
import { markNote, standingOf } from "../shared/marks";

/**
 * An open trade against one price.
 *
 * The number a person glances at is the current R; the one that matters
 * most is the flag — price already through the stop on a trade still
 * marked open. Crossing is inclusive, which is the same reading the candle
 * scan uses, and it is judged on the price given, never a wick it did not
 * see.
 */
const long = { direction: "long", entryPrice: 100, initialStop: 90, initialTarget: 130, size: 1, sizeUnit: "base", pointValue: 1 };
const short = { ...long, direction: "short", initialStop: 110, initialTarget: 70 };

describe("where a long stands", () => {
  it("measures the move in R and in money", () => {
    const s = standingOf(long, 110);
    expect(s.currentR).toBeCloseTo(1);
    expect(s.pnl).toBeCloseTo(10);
    expect(s.toStopR).toBeCloseTo(2);
    expect(s.toTargetR).toBeCloseTo(2);
    expect(s.crossedStop).toBe(false);
    expect(s.crossedTarget).toBe(false);
  });

  it("calls the stop crossed at the stop, and says how far through", () => {
    expect(standingOf(long, 90)).toMatchObject({ crossedStop: true, toStopR: 0 });
    const through = standingOf(long, 85);
    expect(through.crossedStop).toBe(true);
    expect(through.toStopR).toBeCloseTo(-0.5);
    expect(through.currentR).toBeCloseTo(-1.5);
  });

  it("calls the target crossed at the target", () => {
    expect(standingOf(long, 130)).toMatchObject({ crossedTarget: true, toTargetR: 0 });
    expect(standingOf(long, 129.99).crossedTarget).toBe(false);
  });
});

describe("where a short stands", () => {
  it("mirrors every sign", () => {
    const s = standingOf(short, 90);
    expect(s.currentR).toBeCloseTo(1);
    expect(s.pnl).toBeCloseTo(10);
    expect(s.toStopR).toBeCloseTo(2);
    expect(s.toTargetR).toBeCloseTo(2);
    expect(standingOf(short, 110).crossedStop).toBe(true);
    expect(standingOf(short, 115).toStopR).toBeCloseTo(-0.5);
    expect(standingOf(short, 70).crossedTarget).toBe(true);
  });
});

describe("what it will not say", () => {
  it("gives no R and no crossing without a stop", () => {
    const s = standingOf({ ...long, initialStop: null }, 80);
    expect(s.currentR).toBeNull();
    expect(s.toStopR).toBeNull();
    expect(s.crossedStop).toBe(false);
    // The target is its own level and can still be crossed.
    expect(standingOf({ ...long, initialStop: null }, 131).crossedTarget).toBe(true);
    // Money needs no stop.
    expect(s.pnl).toBeCloseTo(-20);
  });

  it("sizes the money off the quote amount and the contract multiplier", () => {
    // 20000 USD of BTC short from 80988.7, priced 417.4 lower: the $103 case.
    const s = standingOf(
      { direction: "short", entryPrice: 80988.7, initialStop: 81406.1, initialTarget: 80455.52, size: 20000, sizeUnit: "quote", pointValue: 1 },
      80988.7 - 417.4,
    );
    expect(s.pnl).toBeCloseTo(103.08, 1);
    expect(s.currentR).toBeCloseTo(1);
    expect(standingOf({ ...long, pointValue: 2 }, 110).pnl).toBeCloseTo(20);
  });
});

/**
 * What the journal says about a price it is not sure of.
 *
 * Three surfaces show an open trade's mark and all three used to say "open"
 * with a number beside it, whatever the number was. Two of them are not the
 * price right now: a perp quoted off spot is within basis, and a perp read
 * off the candle archive is yesterday. Both beat a dash — and both said
 * silently are the one thing this journal must not do.
 */
describe("how a mark is labelled", () => {
  it("says nothing when the price came live from the trade's own book", () => {
    // A badge on every row is a badge nobody reads.
    expect(markNote({ book: "perp" }, "Sep 18, 14:00").badge).toBeNull();
  });

  it("marks a perp priced off spot", () => {
    const note = markNote({ book: "spot" }, "Sep 18, 14:00");
    expect(note.badge).toBe("spot");
    expect(note.title).toMatch(/basis/);
  });

  it("marks a price read from the archive, and dates it", () => {
    const note = markNote({ book: "perp", stale: true }, "Sep 17, 23:00");
    expect(note.badge).toBe("last read");
    expect(note.title).toContain("Sep 17, 23:00");
  });

  it("puts stale ahead of which book it was: the age is the bigger caveat", () => {
    expect(markNote({ book: "spot", stale: true }, "x").badge).toBe("last read");
  });
});
