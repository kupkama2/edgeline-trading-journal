import { describe, expect, it } from "vitest";
import {
  exclusiveVerdict,
  isWellTraded,
  judgedCloses,
  milestonesEarned,
  wellTradedStreak,
} from "../shared/well-traded";
import { tradeXp } from "../shared/xp";
import { localIso, trade } from "./helpers";

/**
 * The run of trades executed well. It is about the execution and never the
 * result, it is made only of trades you have actually written up, and a tilt
 * trade can never be part of it.
 */
const at = (day: number, over = {}) =>
  trade({
    id: day,
    entryTime: localIso(2026, 9, day, 9),
    exitTime: localIso(2026, 9, day, 10),
    exitReason: "target",
    ...over,
  });
const good = (day: number, over = {}) => at(day, { wellTraded: true, ...over });

describe("what counts as traded well", () => {
  it("is the mark, whatever the trade did", () => {
    expect(isWellTraded(trade({ wellTraded: true, exitPrice: 80 }))).toBe(true);
    expect(isWellTraded(trade({ wellTraded: false, exitPrice: 200 }))).toBe(false);
  });

  it("is never a tilt trade, even one carrying both flags", () => {
    expect(isWellTraded(trade({ wellTraded: true, tilt: true }))).toBe(false);
  });

  it("clears the other verdict when either is set", () => {
    expect(exclusiveVerdict({ wellTraded: true })).toEqual({ wellTraded: true, tilt: false });
    expect(exclusiveVerdict({ tilt: true })).toEqual({ tilt: true, wellTraded: false });
    // Turning one OFF says nothing about the other, and a patch about
    // something else entirely is left alone.
    expect(exclusiveVerdict({ tilt: false })).toEqual({ tilt: false });
    expect(exclusiveVerdict({ fees: 3 } as any)).toEqual({ fees: 3 });
  });
});

describe("the run", () => {
  it("counts consecutive written-up trades, newest run standing", () => {
    const s = wellTradedStreak([good(1), good(2), good(3)]);
    expect(s).toMatchObject({ current: 3, best: 3, total: 3, judged: 3 });
  });

  it("is broken by a written-up trade that was not marked", () => {
    const s = wellTradedStreak([good(1), good(2), at(3), good(4)]);
    expect(s).toMatchObject({ current: 1, best: 2, total: 3 });
  });

  it("is broken by a tilt trade", () => {
    const s = wellTradedStreak([good(1), good(2), at(3, { tilt: true }), good(4)]);
    expect(s).toMatchObject({ current: 1, best: 2 });
  });

  it("passes over a trade closed but not yet written up, and names it as the one at risk", () => {
    const unwritten = at(3, { exitReason: null });
    const s = wellTradedStreak([good(1), good(2), unwritten]);
    expect(s.current).toBe(2);
    expect(s.judged).toBe(2);
    expect(s.atRisk?.id).toBe(unwritten.id);
  });

  it("has nothing at risk when there is no run to lose", () => {
    expect(wellTradedStreak([at(1), at(2, { exitReason: null })]).atRisk).toBeNull();
  });

  it("ignores open trades and reads closes in the order they closed", () => {
    const open = trade({ id: 9, status: "open", exitPrice: null, exitTime: null, exitReason: null, wellTraded: true });
    expect(judgedCloses([good(2), open, good(1)]).map((t) => t.id)).toEqual([1, 2]);
    expect(wellTradedStreak([good(2), open, good(1)]).current).toBe(2);
  });

  it("says what the next run worth naming is, and stops past the last", () => {
    expect(wellTradedStreak([good(1)]).next).toEqual({ at: 3, name: "Three in a row", toGo: 2 });
    expect(wellTradedStreak(Array.from({ length: 21 }, (_, i) => good(i + 1))).next).toBeNull();
    expect(milestonesEarned(6)).toEqual([3, 5]);
  });
});

describe("what it is worth", () => {
  it("pays the same on a loser as on a winner, and nothing on a tilt trade", () => {
    const paid = (t: ReturnType<typeof trade>) =>
      tradeXp(t).some((e) => e.id.endsWith(":well-traded"));
    expect(paid(trade({ wellTraded: true, exitPrice: 80 }))).toBe(true);
    expect(paid(trade({ wellTraded: true, exitPrice: 200 }))).toBe(true);
    expect(paid(trade({ wellTraded: true, tilt: true }))).toBe(false);
    expect(paid(trade({ wellTraded: false }))).toBe(false);
  });
});
