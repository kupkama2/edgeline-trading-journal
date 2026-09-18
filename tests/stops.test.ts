import { describe, expect, it } from "vitest";
import {
  addStopMove,
  currentStop,
  formatStopMoves,
  lockedIn,
  parseStopMoves,
  riskLeft,
  stopWasMoved,
} from "../shared/stops";
import { computeMetrics } from "../shared/metrics";
import { riskOnTrade } from "../shared/exposure";
import { trade } from "./helpers";

/**
 * A stop that has been pulled up. The whole point is that it changes what is
 * still at risk and changes NOTHING about R — a trade that made 2R made 2R of
 * the risk it was taken with, however the stop was managed afterwards.
 */
const long = (over = {}) =>
  trade({ direction: "long", entryPrice: 100, initialStop: 90, size: 10, status: "open",
          exitPrice: null, exitTime: null, ...over });

describe("reading the moves", () => {
  it("is empty for nothing, and for anything malformed", () => {
    for (const bad of [null, undefined, "", "not json", "{}", "[1,2]", '[{"price":5}]', '[{"at":"x"}]']) {
      expect(parseStopMoves(bad as any)).toEqual([]);
    }
  });

  it("drops a move with a price that cannot be one", () => {
    expect(parseStopMoves('[{"at":"2026-09-01T00:00:00Z","price":0}]')).toEqual([]);
    expect(parseStopMoves('[{"at":"2026-09-01T00:00:00Z","price":-3}]')).toEqual([]);
  });

  it("orders oldest first, whatever order it was written in", () => {
    const raw = JSON.stringify([
      { at: "2026-09-03T00:00:00Z", price: 100 },
      { at: "2026-09-01T00:00:00Z", price: 95 },
    ]);
    expect(parseStopMoves(raw).map((m) => m.price)).toEqual([95, 100]);
  });

  it("round-trips, and writes null rather than an empty list", () => {
    const moves = [{ at: "2026-09-01T00:00:00Z", price: 95, note: "breakeven" }];
    expect(parseStopMoves(formatStopMoves(moves))).toEqual(moves);
    expect(formatStopMoves([])).toBeNull();
  });
});

describe("where the stop is now", () => {
  it("is the original until something moves it", () => {
    expect(currentStop(long())).toBe(90);
    expect(stopWasMoved(long())).toBe(false);
  });

  it("is the last move once there is one", () => {
    const moves = formatStopMoves([
      { at: "2026-09-01T00:00:00Z", price: 95 },
      { at: "2026-09-02T00:00:00Z", price: 100 },
    ]);
    expect(currentStop(long({ stopMoves: moves }))).toBe(100);
    expect(stopWasMoved(long({ stopMoves: moves }))).toBe(true);
  });

  it("ignores a move to where the stop already is", () => {
    const once = addStopMove(null, 95, "2026-09-01T00:00:00Z");
    expect(addStopMove(formatStopMoves(once), 95, "2026-09-02T00:00:00Z")).toHaveLength(1);
  });

  it("keeps the note when there is one, and omits it when there is not", () => {
    expect(addStopMove(null, 95, "2026-09-01T00:00:00Z", "  breakeven ")[0]).toEqual({
      at: "2026-09-01T00:00:00Z",
      price: 95,
      note: "breakeven",
    });
    expect(addStopMove(null, 95, "2026-09-01T00:00:00Z", "   ")[0]).toEqual({
      at: "2026-09-01T00:00:00Z",
      price: 95,
    });
  });
});

describe("what a moved stop takes off the table", () => {
  const to = (price: number) =>
    long({ stopMoves: formatStopMoves([{ at: "2026-09-01T00:00:00Z", price }]) });

  it("is the original risk before anything moves", () => {
    // 10 points of stop on 10 units.
    expect(riskLeft(long())).toBe(100);
    expect(lockedIn(long())).toBeNull();
  });

  it("shrinks as the stop comes up", () => {
    expect(riskLeft(to(95))).toBe(50);
    expect(lockedIn(to(95))).toBeNull();
  });

  it("is nothing at breakeven, and says so rather than going negative", () => {
    expect(riskLeft(to(100))).toBe(0);
    expect(lockedIn(to(100))).toBeNull();
  });

  it("locks money in once the stop is through the entry", () => {
    expect(riskLeft(to(110))).toBe(0);
    expect(lockedIn(to(110))).toBe(100);
  });

  it("works the same way on a short, in the other direction", () => {
    const short = (price: number) =>
      trade({ direction: "short", entryPrice: 100, initialStop: 110, size: 10, status: "open",
              exitPrice: null, exitTime: null,
              stopMoves: formatStopMoves([{ at: "2026-09-01T00:00:00Z", price }]) });
    expect(riskLeft(short(105))).toBe(50);
    expect(riskLeft(short(100))).toBe(0);
    expect(lockedIn(short(90))).toBe(100);
  });
});

describe("what a moved stop must NOT change", () => {
  it("leaves R alone — it is the risk the trade was TAKEN with", () => {
    const managed = trade({
      direction: "long", entryPrice: 100, initialStop: 90, size: 10,
      exitPrice: 120, status: "closed",
      stopMoves: formatStopMoves([{ at: "2026-09-01T00:00:00Z", price: 110 }]),
    });
    const plain = trade({ direction: "long", entryPrice: 100, initialStop: 90, size: 10,
                          exitPrice: 120, status: "closed" });
    expect(computeMetrics(managed).actualR).toBe(computeMetrics(plain).actualR);
    expect(computeMetrics(managed).riskDollars).toBe(computeMetrics(plain).riskDollars);
  });

  it("does change what the open book has at risk", () => {
    expect(riskOnTrade(long())).toBe(100);
    expect(
      riskOnTrade(long({ stopMoves: formatStopMoves([{ at: "2026-09-01T00:00:00Z", price: 100 }]) })),
    ).toBe(0);
  });
});
