import { describe, expect, it } from "vitest";
import { SETUP_TAGS, isKnownSetup, normalizeSetupTag, normalizeSetupTags } from "../shared/setups";

/**
 * The whole reason the chips exist is sample size.
 *
 * "61.8", "0.618" and "cc" are one setup spelled three ways, and the Setup
 * breakdown splits them into three rows that each look too small to draw a
 * conclusion from — which is the only thing that table is for. Normalising is
 * what makes the chips worth more than a typing shortcut.
 */
describe("normalising a setup tag", () => {
  it("folds every spelling of the same fib onto one tag", () => {
    for (const spelling of ["cc", "CC", "61.8", "618", "0.618", ".618", "61.8%", "CC retest"]) {
      expect(normalizeSetupTag(spelling)).toBe("61.8 Fib");
    }
  });

  it("recognises the golden pocket however it is written", () => {
    for (const spelling of ["gp", "GP", "golden pocket", "Golden Pocket", "goldenpocket"]) {
      expect(normalizeSetupTag(spelling)).toBe("Golden Pocket");
    }
  });

  it("leaves a setup it has never heard of exactly as typed", () => {
    // A normaliser for the common few, not a whitelist — an unknown tag is
    // still the user's tag, and silently dropping it would lose data.
    expect(normalizeSetupTag("VAH Rejection")).toBe("VAH Rejection");
    expect(normalizeSetupTag("  Opening Drive  ")).toBe("Opening Drive");
  });

  it("returns empty for blank input rather than a stray tag", () => {
    expect(normalizeSetupTag("   ")).toBe("");
    expect(normalizeSetupTag("")).toBe("");
  });
});

describe("normalising a whole list", () => {
  it("collapses two spellings of one setup into a single tag", () => {
    // The exact case the entry card creates: a chip tapped ("61.8 Fib") and
    // the same setup pulled out of the sentence ("cc").
    expect(normalizeSetupTags(["61.8 Fib", "cc"])).toEqual(["61.8 Fib"]);
  });

  it("keeps the first mention first", () => {
    // A list that reshuffles itself on save reads as data loss even when
    // nothing was lost.
    expect(normalizeSetupTags(["Reclaim", "gp", "VAH"])).toEqual([
      "Reclaim",
      "Golden Pocket",
      "VAH",
    ]);
  });

  it("drops blanks left by a trailing comma", () => {
    // "Reclaim, " is what a half-typed comma-separated field actually holds.
    expect(normalizeSetupTags("Reclaim, ".split(","))).toEqual(["Reclaim"]);
    expect(normalizeSetupTags([" ", "", "Reclaim"])).toEqual(["Reclaim"]);
  });

  it("is idempotent", () => {
    // Saving a trade twice must not change its tags the second time.
    const once = normalizeSetupTags(["cc", "gp", "76.2", "custom thing"]);
    expect(normalizeSetupTags(once)).toEqual(once);
  });
});

describe("the taxonomy itself", () => {
  it("has no alias claimed by two setups", () => {
    // A duplicated alias would make normalisation depend on array order —
    // silently, and differently after any edit to the list.
    const seen = new Map<string, string>();
    for (const s of SETUP_TAGS) {
      for (const a of [s.name.toLowerCase(), ...s.aliases]) {
        expect(seen.has(a)).toBe(false);
        seen.set(a, s.name);
      }
    }
  });

  it("knows its own names", () => {
    for (const s of SETUP_TAGS) expect(isKnownSetup(s.name)).toBe(true);
    expect(isKnownSetup("VAH Rejection")).toBe(false);
  });
});
