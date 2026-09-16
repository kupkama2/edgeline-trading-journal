import { describe, expect, it } from "vitest";
import { EMPTY_CLOSE_READ, closeReadEmpty, closeReadSummary, normalizeCloseRead } from "../shared/close-read";

/**
 * The model reads the note; this decides what may be written from it.
 * Every value is filtered to what the journal actually has, so a confident
 * reading of a demon the trader never listed writes nothing.
 */
const demons = [
  { id: 1, name: "Moved Stop Early" },
  { id: 2, name: "Bet Too Large" },
  { id: 3, name: "Revenge Trade" },
];

describe("reading a close note", () => {
  it("takes the fields as the pickers would have written them", () => {
    const r = normalizeCloseRead(
      {
        exitReason: "discretion",
        entryGrade: "perfect",
        stopGrade: "tight",
        exitGrade: "early",
        demons: ["moved stop early", "Bet Too Large"],
        highlights: ["cut it fast", "Let It Run"],
        noManagementOutcome: "target_first",
      },
      demons,
    );
    expect(r).toEqual({
      exitReason: "discretion",
      entryGrade: "perfect",
      stopGrade: "tight",
      exitGrade: "early",
      demonIds: [1, 2],
      highlights: ["Cut It Fast", "Let It Run"],
      noManagementOutcome: "target_first",
    });
  });

  it("drops what the journal does not have, rather than inventing it", () => {
    const r = normalizeCloseRead(
      {
        exitReason: "vibes",
        entryGrade: "brilliant",
        stopGrade: "GOOD",
        demons: ["FOMO Entry", "Moved Stop Early", "Moved Stop Early"],
        highlights: ["Nailed It", "perfect entry"],
        noManagementOutcome: "who knows",
      },
      demons,
    );
    expect(r.exitReason).toBeNull();
    expect(r.entryGrade).toBeNull();
    expect(r.stopGrade).toBe("good");
    expect(r.demonIds).toEqual([1]);
    expect(r.highlights).toEqual(["Perfect Entry"]);
    expect(r.noManagementOutcome).toBeNull();
  });

  it("knows the other words for the same exit", () => {
    for (const [said, meant] of [
      ["manual", "discretion"],
      ["closed by hand", "discretion"],
      ["stopped out", "stop"],
      ["trailing stop", "trailed"],
      ["take profit", "target"],
      ["break-even", "breakeven"],
    ]) {
      expect(normalizeCloseRead({ exitReason: said }, demons).exitReason).toBe(meant);
    }
  });

  it("never grades the exit of a trade stopped at its original stop", () => {
    const r = normalizeCloseRead({ exitReason: "stop", exitGrade: "late" }, demons);
    expect(r.exitGrade).toBeNull();
    expect(normalizeCloseRead({ exitReason: "trailed", exitGrade: "late" }, demons).exitGrade).toBe("late");
  });

  it("accepts the journal's own extra green flags by their spelling", () => {
    const r = normalizeCloseRead({ highlights: ["scaled out well"] }, demons, ["Scaled Out Well"]);
    expect(r.highlights).toEqual(["Scaled Out Well"]);
  });

  it("reads garbage as nothing", () => {
    expect(normalizeCloseRead(null, demons)).toEqual(EMPTY_CLOSE_READ);
    expect(normalizeCloseRead("stop", demons)).toEqual(EMPTY_CLOSE_READ);
    expect(normalizeCloseRead({ demons: "Moved Stop Early" }, demons)).toEqual(EMPTY_CLOSE_READ);
    expect(closeReadEmpty(normalizeCloseRead({}, demons))).toBe(true);
  });
});

describe("saying what was read", () => {
  it("uses the pickers' own words, in the trade's order", () => {
    const r = normalizeCloseRead(
      {
        exitReason: "stop",
        entryGrade: "late",
        stopGrade: "tight",
        demons: ["Revenge Trade"],
        highlights: ["Cut It Fast"],
        noManagementOutcome: "stop_first",
      },
      demons,
    );
    expect(closeReadSummary(r, demons)).toBe(
      "Stopped out · entry late · stop too tight · Revenge Trade · Cut It Fast · stop first, left alone",
    );
    expect(closeReadSummary(EMPTY_CLOSE_READ, demons)).toBe("");
  });
});
