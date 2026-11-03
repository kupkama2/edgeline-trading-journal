import { describe, expect, it } from "vitest";
import { eventsInBar, levelsAt, replayEvents } from "../shared/replay";
import type { TerminalRef } from "../shared/terminal";

/**
 * The replay's record: what happened on the trade, in order, with the stop
 * and the target as they stood after each thing. Read from the terminal's
 * own moves where there are any, and from the stop log, the fills and the
 * exit for a trade logged by hand — so every trade can be replayed.
 */
const T0 = Date.parse("2026-11-03T18:00:00Z");
const iso = (m: number) => new Date(T0 + m * 60_000).toISOString();

const tracked = {
  direction: "long",
  status: "closed",
  entryPrice: 3000,
  entryTime: iso(0),
  size: 1.5,
  initialStop: 2900,
  initialTarget: 3200,
  stopMoves: JSON.stringify([{ at: iso(10), price: 3000, note: "venue" }]),
  exitPrice: 3000,
  exitTime: iso(30),
  exitReason: "breakeven",
  fills: [{ kind: "partial", price: 3100, size: 0.5, time: iso(20), note: "terminal · partial 7002" }],
};
const ref: TerminalRef = {
  venue: "hyperliquid",
  env: "live",
  account: "HL",
  symbol: "ETH",
  positionSide: "LONG",
  tag: "trk-1",
  leverage: 5,
  qty: 1.5,
  entryOrderId: 700,
  stopOrderId: 903,
  targetOrderIds: [902],
  closeOrderIds: [],
  tracked: true,
  idea: { entry: 3000, stop: 2900, targets: [3200], qty: 1.5, riskDollars: 150, at: iso(0) },
  moves: [{ at: iso(10), kind: "stop", from: 2900, to: 3000, mark: 3050, r: 0.5 }],
  planWatch: { coveredTo: T0, checkedAt: iso(31), targetHitAt: iso(25), targetHitPrice: 3200 },
};

describe("the replay record", () => {
  it("reads a tracked trade: entry, the stop to breakeven with its mark and R, a partial, the tape at the target, the exit", () => {
    const ev = replayEvents(tracked, ref);
    expect(ev.map((e) => e.kind)).toEqual(["entry", "stop", "partial", "plan-hit", "exit"]);
    expect(ev[0]).toMatchObject({ at: T0, stop: 2900, targets: [3200], price: 3000 });
    expect(ev[0].text).toMatch(/In: long 1.5 at 3000 — stop 2900, target 3200 \(2.0R\)/);
    expect(ev[1]).toMatchObject({ at: T0 + 10 * 60_000, stop: 3000, targets: [3200], price: 3050, r: 0.5 });
    expect(ev[1].text).toMatch(/Stop 2900 → 3000 \(breakeven\) · mark 3050 \(\+0.50R\)/);
    expect(ev[2]).toMatchObject({ kind: "partial", price: 3100, r: 1, stop: 3000 });
    expect(ev[2].text).toMatch(/Took off 0.5 at 3100 \(\+1.00R\)/);
    expect(ev[3].text).toMatch(/original target 3200/);
    expect(ev[4]).toMatchObject({ kind: "exit", price: 3000, r: 0, stop: 3000 });
    expect(ev[4].text).toMatch(/Out at 3000 — breakeven \(\+0.00R\)/);
  });

  it("reads a hand-logged trade from the stop log, the fills and the exit", () => {
    const ev = replayEvents({ ...tracked, fills: [], stopMoves: JSON.stringify([{ at: iso(5), price: 2950 }, { at: iso(12), price: 3000, note: "breakeven" }]) }, null);
    expect(ev.map((e) => e.kind)).toEqual(["entry", "stop", "stop", "exit"]);
    expect(ev[1]).toMatchObject({ stop: 2950, price: null, r: null });
    expect(ev[1].text).toBe("Stop 2900 → 2950");
    expect(ev[2].text).toBe("Stop 2950 → 3000 (breakeven)");
    // Extra targets ride along as the plan's later targets.
    const two = replayEvents({ ...tracked, status: "open", exitPrice: null, exitTime: null, fills: [], stopMoves: null, extraTargets: "[3400]" }, null);
    expect(two).toHaveLength(1);
    expect(two[0].targets).toEqual([3200, 3400]);
  });

  it("says what the levels were at any instant, and which events a bar holds", () => {
    const ev = replayEvents(tracked, ref);
    expect(levelsAt(ev, T0 - 60_000)).toEqual({ stop: 2900, targets: [3200], inTrade: false, done: false });
    expect(levelsAt(ev, T0 + 9 * 60_000)).toMatchObject({ stop: 2900, inTrade: true });
    expect(levelsAt(ev, T0 + 10 * 60_000)).toMatchObject({ stop: 3000, inTrade: true });
    expect(levelsAt(ev, T0 + 40 * 60_000)).toMatchObject({ stop: 3000, inTrade: false, done: true });
    // A 15m bar closing at +15 holds the stop move at +10 and nothing else.
    expect(eventsInBar(ev, T0, T0 + 15 * 60_000).map((e) => e.kind)).toEqual(["stop"]);
    expect(eventsInBar(ev, T0 + 15 * 60_000, T0 + 30 * 60_000).map((e) => e.kind)).toEqual(["partial", "plan-hit", "exit"]);
  });
});
