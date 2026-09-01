import { describe, expect, it } from "vitest";
import { conflictWarning, directionWarning, readDirection } from "../shared/direction";

/**
 * Which way the trade goes, read off the levels.
 *
 * Getting this wrong is silent and expensive — direction flips the sign of
 * every R in the trade, so a short logged as a long turns a −1R into a +1R and
 * does not look wrong on the row. Which makes the tests that matter the ones
 * where it must NOT answer: levels that contradict each other, levels sitting
 * exactly on the entry, and a direction a person actually chose.
 */

describe("reading the direction off entry, stop and target", () => {
  it("calls a stop below and a target above a long", () => {
    const r = readDirection(100, 90, 130);
    expect(r.implied).toBe("long");
    expect(r.conflict).toBe(false);
    expect(r.from).toEqual(["stop", "target"]);
  });

  it("calls a stop above and a target below a short", () => {
    const r = readDirection(100, 110, 70);
    expect(r.implied).toBe("short");
    expect(r.conflict).toBe(false);
  });

  it("reads a stop on its own", () => {
    expect(readDirection(100, 90, null)).toMatchObject({ implied: "long", from: ["stop"] });
    expect(readDirection(100, 110, null)).toMatchObject({ implied: "short", from: ["stop"] });
  });

  it("reads a target on its own", () => {
    expect(readDirection(100, null, 130)).toMatchObject({ implied: "long", from: ["target"] });
    expect(readDirection(100, null, 70)).toMatchObject({ implied: "short", from: ["target"] });
  });

  it("works on prices that are fractions of a cent", () => {
    // PENGU: entry 0.0064875, stop 0.006212. Nothing here may round.
    expect(readDirection(0.0064875, 0.006212, 0.0089).implied).toBe("long");
  });
});

describe("when it must not answer", () => {
  it("says nothing without an entry to measure from", () => {
    expect(readDirection(null, 90, 130).implied).toBeNull();
    expect(readDirection(undefined, 90, 130).implied).toBeNull();
  });

  it("says nothing when neither level is given", () => {
    expect(readDirection(100, null, null)).toEqual({ implied: null, conflict: false, from: [] });
  });

  it("treats a level sitting exactly on the entry as no information", () => {
    // A stop at the entry is a breakeven order, not a side of the market.
    expect(readDirection(100, 100, null).implied).toBeNull();
    expect(readDirection(100, null, 100).implied).toBeNull();
  });

  it("refuses to pick when the stop and target contradict each other", () => {
    /*
     * The case worth the whole module. Both levels below the entry: the stop
     * says long, the target says short, and both readings are confident.
     * Preferring one silently would write a direction that is wrong half the
     * time it comes up.
     */
    const r = readDirection(100, 90, 80);
    expect(r.implied).toBeNull();
    expect(r.conflict).toBe(true);
    expect(conflictWarning(r)).toContain("same side of the entry");
  });

  it("refuses the mirror of that too", () => {
    const r = readDirection(100, 110, 120);
    expect(r.implied).toBeNull();
    expect(r.conflict).toBe(true);
  });

  it("has no conflict to report when the levels agree", () => {
    expect(conflictWarning(readDirection(100, 90, 130))).toBeNull();
    expect(conflictWarning(readDirection(100, null, null))).toBeNull();
  });
});

describe("warning a person their levels disagree with them", () => {
  it("says nothing when the choice matches the levels", () => {
    expect(directionWarning("long", readDirection(100, 90, 130))).toBeNull();
    expect(directionWarning("short", readDirection(100, 110, 70))).toBeNull();
  });

  it("says nothing when the levels say nothing", () => {
    expect(directionWarning("long", readDirection(100, null, null))).toBeNull();
  });

  it("names both levels when both disagree", () => {
    const w = directionWarning("long", readDirection(100, 110, 70))!;
    expect(w).toContain("the other way round");
    expect(w).toContain("stop below");
  });

  it("names the stop when only the stop is known", () => {
    const w = directionWarning("long", readDirection(100, 110, null))!;
    expect(w).toContain("stop is on the wrong side");
  });

  it("names the target when only the target is known", () => {
    const w = directionWarning("short", readDirection(100, null, 130))!;
    expect(w).toContain("target is on the wrong side");
  });

  it("stays quiet on a contradiction, which is a different message", () => {
    /*
     * "Your stop is on the wrong side" is bad advice when the target is the
     * price that is actually wrong, and nothing here can tell which. The
     * conflict gets its own sentence instead.
     */
    const r = readDirection(100, 90, 80);
    expect(directionWarning("long", r)).toBeNull();
    expect(directionWarning("short", r)).toBeNull();
    expect(conflictWarning(r)).not.toBeNull();
  });
});
