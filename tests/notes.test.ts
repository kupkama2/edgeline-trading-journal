import { describe, expect, it } from "vitest";
import { joinNote, noteFields, whyOf } from "../shared/notes";

describe("the one note", () => {
  it("takes the why from its first paragraph", () => {
    expect(whyOf("vah, 786 retest\n\nmoved stop to BE at 1R\n\nclosed at target")).toBe("vah, 786 retest");
    expect(whyOf("  one line only ")).toBe("one line only");
    expect(whyOf("")).toBeNull();
    expect(whyOf(null)).toBeNull();
  });

  it("joins pieces without repeating one already there", () => {
    expect(joinNote("why", null, "  ", "later")).toBe("why\n\nlater");
    expect(joinNote("why\n\nlater", "later")).toBe("why\n\nlater");
    expect(joinNote(null, "")).toBeNull();
  });

  it("derives the why on every write of the note", () => {
    expect(noteFields({ notes: "long the reclaim\n\nscaled at 2R" })).toEqual({
      notes: "long the reclaim\n\nscaled at 2R",
      rationale: "long the reclaim",
    });
    expect(noteFields({ notes: "  " })).toEqual({ notes: null, rationale: null });
  });

  it("opens the note with a why sent on its own", () => {
    expect(noteFields({ rationale: "bullish crypto" })).toEqual({ notes: "bullish crypto", rationale: "bullish crypto" });
    // An existing note is not replaced by it.
    expect(noteFields({ rationale: "x" }, { notes: "already written" })).toEqual({});
  });

  it("folds a separate review note into the one note", () => {
    expect(noteFields({ reviewNote: "UPDATE: good SL" }, { notes: "why\n\nclosed by hand" })).toEqual({
      notes: "why\n\nclosed by hand\n\nUPDATE: good SL",
      rationale: "why",
      reviewNote: null,
    });
  });

  it("leaves every other write alone", () => {
    expect(noteFields({})).toEqual({});
  });
});
