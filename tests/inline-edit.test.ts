import { describe, expect, it } from "vitest";
import { readEdit } from "../client/src/pages/trade-view";

/**
 * Finishing an inline edit on the trade page.
 *
 * Clicking away has to commit — abandoning a field by looking at something
 * else is the commonest way to finish an edit, and losing the number to it is
 * indistinguishable from the edit never having worked at all.
 *
 * Which makes the empty box the case worth testing hardest. "I opened it, saw
 * what was there, and clicked away" and "I want this number gone" produce the
 * same empty string, and the first is far more common — so the way OUT decides
 * what it means: leaving keeps the value, Enter clears it.
 */
const on = (current: number | null, required = false) => ({ current, required });

describe("clicking away", () => {
  it("saves what was typed, the same as Enter", () => {
    expect(readEdit("1.35", "blur", on(1.2))).toEqual({ save: true, value: 1.35 });
    expect(readEdit("1.35", "enter", on(1.2))).toEqual({ save: true, value: 1.35 });
  });

  it("keeps the old value when the box was left empty", () => {
    expect(readEdit("", "blur", on(1.2))).toEqual({ save: false });
    expect(readEdit("   ", "blur", on(1.2))).toEqual({ save: false });
  });

  it("still clears on Enter, because that is somebody saying so", () => {
    expect(readEdit("", "enter", on(1.2))).toEqual({ save: true, value: null });
  });

  it("refuses to empty a column the trade cannot exist without", () => {
    expect(readEdit("", "enter", on(100, true))).toEqual({ save: false });
    expect(readEdit("", "blur", on(100, true))).toEqual({ save: false });
  });
});

describe("what never reaches the server", () => {
  it("nonsense", () => {
    expect(readEdit("abc", "enter", on(1.2))).toEqual({ save: false });
    expect(readEdit("1.2.3", "blur", on(1.2))).toEqual({ save: false });
  });

  it("the value it already had", () => {
    expect(readEdit("1.2", "enter", on(1.2))).toEqual({ save: false });
    // Written differently, but the same number — no write, and no phantom
    // "saved" flash on a figure nothing happened to.
    expect(readEdit("1.20", "enter", on(1.2))).toEqual({ save: false });
  });

  it("clearing something that was already empty", () => {
    expect(readEdit("", "enter", on(null))).toEqual({ save: false });
  });
});

describe("what does reach it", () => {
  it("a first value on a figure that had none — the case this exists for", () => {
    // Best reach on a running trade: nothing logged, and now there is.
    expect(readEdit("0.0081", "blur", on(null))).toEqual({ save: true, value: 0.0081 });
    expect(readEdit("0.0081", "enter", on(null))).toEqual({ save: true, value: 0.0081 });
  });

  it("zero, which is a price and not an absence", () => {
    expect(readEdit("0", "enter", on(1.2))).toEqual({ save: true, value: 0 });
  });

  it("a negative, which a spread or a loss column can legitimately hold", () => {
    expect(readEdit("-3.5", "blur", on(null))).toEqual({ save: true, value: -3.5 });
  });
});
