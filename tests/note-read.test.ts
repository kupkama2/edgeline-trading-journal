import { describe, expect, it } from "vitest";
import { applyNoteRead, noteHash, noteNeedsRead } from "../shared/note-read";

const read = (over: Record<string, unknown> = {}) =>
  ({ entryGrade: null, stopGrade: null, exitGrade: null, exitReason: null, demonIds: [], ...over }) as any;
const AT = "2026-10-22T10:00:00.000Z";
const closed = { status: "closed" };

describe("reading a note into the trade", () => {
  it("fills what is empty and records what it set", () => {
    const t = { notes: "stop was too tight", mistakeTagIds: [] };
    const r = applyNoteRead(t, read({ stopGrade: "tight", demonIds: [7] }), AT);
    expect(r.patch.stopGrade).toBe("tight");
    expect(r.mistakeTagIds).toEqual([7]);
    expect(r.record.set).toEqual({ stopGrade: "tight", demonIds: [7] });
    expect(r.record.hash).toBe(noteHash("stop was too tight"));
  });

  it("never overwrites what you set by hand", () => {
    const t = { notes: "x", stopGrade: "wide", mistakeTagIds: [3] };
    const r = applyNoteRead(t, read({ stopGrade: "tight" }), AT);
    expect("stopGrade" in r.patch).toBe(false);
    expect(r.mistakeTagIds).toBeUndefined();
  });

  it("takes back what the last read said when the note changes its mind", () => {
    // First version: the stop was tight, and the read filed a demon for it.
    const first = applyNoteRead({ notes: "stop too tight", mistakeTagIds: [] }, read({ stopGrade: "tight", demonIds: [7] }), AT);
    const after = {
      notes: "UPDATE: actually gold went lower, so a good SL",
      stopGrade: "tight",
      mistakeTagIds: [7],
      noteRead: first.patch.noteRead,
    };
    expect(noteNeedsRead({ ...after, ...closed })).toBe(true);
    const second = applyNoteRead(after, read({ stopGrade: "good" }), AT);
    expect(second.patch.stopGrade).toBe("good");
    expect(second.mistakeTagIds).toEqual([]);
  });

  it("clears a field only the last read had set, when the new note says nothing of it", () => {
    const first = applyNoteRead({ notes: "late entry", mistakeTagIds: [] }, read({ entryGrade: "late" }), AT);
    const second = applyNoteRead(
      { notes: "fine trade", entryGrade: "late", mistakeTagIds: [], noteRead: first.patch.noteRead },
      read(),
      AT,
    );
    expect(second.patch.entryGrade).toBeNull();
  });

  it("leaves a field alone once you changed what the read set", () => {
    const first = applyNoteRead({ notes: "late entry", mistakeTagIds: [] }, read({ entryGrade: "late" }), AT);
    // You corrected it to perfect afterwards.
    const second = applyNoteRead(
      { notes: "late entry, really", entryGrade: "perfect", mistakeTagIds: [], noteRead: first.patch.noteRead },
      read({ entryGrade: "late" }),
      AT,
    );
    expect("entryGrade" in second.patch).toBe(false);
  });

  it("keeps a demon you added yourself when the read drops its own", () => {
    const first = applyNoteRead({ notes: "fomo", mistakeTagIds: [] }, read({ demonIds: [7] }), AT);
    const second = applyNoteRead(
      { notes: "fine", mistakeTagIds: [7, 9], noteRead: first.patch.noteRead },
      read(),
      AT,
    );
    expect(second.mistakeTagIds).toEqual([9]);
  });

  it("knows when a note has nothing new to read", () => {
    const first = applyNoteRead({ notes: "same words", mistakeTagIds: [] }, read(), AT);
    expect(noteNeedsRead({ ...closed, notes: " same words ", mistakeTagIds: [], noteRead: first.patch.noteRead })).toBe(false);
    expect(noteNeedsRead({ ...closed, notes: "", mistakeTagIds: [] })).toBe(false);
    expect(noteNeedsRead({ ...closed, notes: "never read", mistakeTagIds: [] })).toBe(true);
    // Still being written while the trade is open.
    expect(noteNeedsRead({ status: "open", notes: "never read", mistakeTagIds: [] })).toBe(false);
  });

  it("reads highlights and the verdict the same way", () => {
    const first = applyNoteRead(
      { notes: "waited for it, let it run", mistakeTagIds: [], highlights: JSON.stringify(["Patient Entry"]) },
      read({ highlights: ["Let It Run"], verdict: "well" }),
      AT,
    );
    expect(JSON.parse(first.patch.highlights as string).sort()).toEqual(["Let It Run", "Patient Entry"]);
    expect(first.patch.wellTraded).toBe(true);
    // The note changes its mind: the read's highlight and verdict go, yours stays.
    const second = applyNoteRead(
      { notes: "actually chased it", mistakeTagIds: [], highlights: first.patch.highlights, wellTraded: true, noteRead: first.patch.noteRead },
      read({ verdict: "tilt" }),
      AT,
    );
    expect(JSON.parse(second.patch.highlights as string)).toEqual(["Patient Entry"]);
    expect(second.patch).toMatchObject({ wellTraded: false, tilt: true });
  });

  it("never undoes a verdict you gave yourself", () => {
    const r = applyNoteRead({ notes: "fine trade", tilt: true, mistakeTagIds: [] }, read({ verdict: "well" }), AT);
    expect("wellTraded" in r.patch).toBe(false);
    expect("tilt" in r.patch).toBe(false);
  });
});
