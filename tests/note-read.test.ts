import { describe, expect, it } from "vitest";
import { applyNoteRead, noteHash, noteNeedsRead } from "../shared/note-read";

const read = (over: Record<string, unknown> = {}) =>
  ({ entryGrade: null, stopGrade: null, exitGrade: null, exitReason: null, demonIds: [], ...over }) as any;
const AT = "2026-10-22T10:00:00.000Z";

describe("reading a note into the trade", () => {
  it("fills what is empty and records what it set", () => {
    const t = { reviewNote: "stop was too tight", mistakeTagIds: [] };
    const r = applyNoteRead(t, read({ stopGrade: "tight", demonIds: [7] }), AT);
    expect(r.patch.stopGrade).toBe("tight");
    expect(r.mistakeTagIds).toEqual([7]);
    expect(r.record.set).toEqual({ stopGrade: "tight", demonIds: [7] });
    expect(r.record.hash).toBe(noteHash("stop was too tight"));
  });

  it("never overwrites what you set by hand", () => {
    const t = { reviewNote: "x", stopGrade: "wide", mistakeTagIds: [3] };
    const r = applyNoteRead(t, read({ stopGrade: "tight" }), AT);
    expect("stopGrade" in r.patch).toBe(false);
    expect(r.mistakeTagIds).toBeUndefined();
  });

  it("takes back what the last read said when the note changes its mind", () => {
    // First version: the stop was tight, and the read filed a demon for it.
    const first = applyNoteRead({ reviewNote: "stop too tight", mistakeTagIds: [] }, read({ stopGrade: "tight", demonIds: [7] }), AT);
    const after = {
      reviewNote: "UPDATE: actually gold went lower, so a good SL",
      stopGrade: "tight",
      mistakeTagIds: [7],
      noteRead: first.patch.noteRead,
    };
    expect(noteNeedsRead(after)).toBe(true);
    const second = applyNoteRead(after, read({ stopGrade: "good" }), AT);
    expect(second.patch.stopGrade).toBe("good");
    expect(second.mistakeTagIds).toEqual([]);
  });

  it("clears a field only the last read had set, when the new note says nothing of it", () => {
    const first = applyNoteRead({ reviewNote: "late entry", mistakeTagIds: [] }, read({ entryGrade: "late" }), AT);
    const second = applyNoteRead(
      { reviewNote: "fine trade", entryGrade: "late", mistakeTagIds: [], noteRead: first.patch.noteRead },
      read(),
      AT,
    );
    expect(second.patch.entryGrade).toBeNull();
  });

  it("leaves a field alone once you changed what the read set", () => {
    const first = applyNoteRead({ reviewNote: "late entry", mistakeTagIds: [] }, read({ entryGrade: "late" }), AT);
    // You corrected it to perfect afterwards.
    const second = applyNoteRead(
      { reviewNote: "late entry, really", entryGrade: "perfect", mistakeTagIds: [], noteRead: first.patch.noteRead },
      read({ entryGrade: "late" }),
      AT,
    );
    expect("entryGrade" in second.patch).toBe(false);
  });

  it("keeps a demon you added yourself when the read drops its own", () => {
    const first = applyNoteRead({ reviewNote: "fomo", mistakeTagIds: [] }, read({ demonIds: [7] }), AT);
    const second = applyNoteRead(
      { reviewNote: "fine", mistakeTagIds: [7, 9], noteRead: first.patch.noteRead },
      read(),
      AT,
    );
    expect(second.mistakeTagIds).toEqual([9]);
  });

  it("knows when a note has nothing new to read", () => {
    const first = applyNoteRead({ reviewNote: "same words", mistakeTagIds: [] }, read(), AT);
    expect(noteNeedsRead({ reviewNote: " same words ", mistakeTagIds: [], noteRead: first.patch.noteRead })).toBe(false);
    expect(noteNeedsRead({ reviewNote: "", mistakeTagIds: [] })).toBe(false);
    expect(noteNeedsRead({ reviewNote: "never read", mistakeTagIds: [] })).toBe(true);
  });
});
