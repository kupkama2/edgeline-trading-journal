import { describe, expect, it } from "vitest";
import { IDLE_MS, TOUCH_EVENTS, idleStep, shouldHold } from "../client/src/lib/idle";

/**
 * The entry form folds itself after thirty seconds without a touch. The
 * clock is lazy — a touch moves the deadline and the timer finds out when it
 * fires — so the step function is what decides, and it is what is tested.
 */
describe("the entry form's idle clock", () => {
  it("is thirty seconds", () => {
    expect(IDLE_MS).toBe(30_000);
  });

  it("folds the form once the deadline has passed with nothing holding it", () => {
    expect(idleStep(0, IDLE_MS, false)).toEqual({ collapse: true });
    expect(idleStep(0, IDLE_MS + 5_000, false)).toEqual({ collapse: true });
  });

  it("waits out the rest when a touch moved the deadline since the timer was set", () => {
    // Opened at 0, touched at 20s, the timer fires at 30s: the deadline is 50s now.
    expect(idleStep(20_000, 30_000, false)).toEqual({ collapse: false, waitMs: 20_000 });
    // Touched again at 29.999s: it is not folded a millisecond early.
    expect(idleStep(29_999, 30_000, false)).toEqual({ collapse: false, waitMs: 29_999 });
  });

  it("gives a held form a whole window more, and folds it the first time the hold is gone", () => {
    expect(idleStep(0, IDLE_MS, true)).toEqual({ collapse: false, waitMs: IDLE_MS });
    expect(idleStep(0, 2 * IDLE_MS, false)).toEqual({ collapse: true });
  });

  it("takes a shorter window when given one", () => {
    expect(idleStep(0, 999, false, 1_000)).toEqual({ collapse: false, waitMs: 1 });
    expect(idleStep(0, 1_000, false, 1_000)).toEqual({ collapse: true });
  });
});

describe("what holds the form open without touching it", () => {
  const free = { draft: false, busy: false, focusInside: false, windowFocused: true, menuOpen: false };

  it("anything typed into it, for as long as it is typed in", () => {
    // The fold is for a form left holding nothing. Half a trade in it and
    // thirty seconds on the chart is a form being used, not an abandoned one
    // — and folding it reads as the app throwing the work away.
    expect(shouldHold({ ...free, draft: true })).toBe(true);
    expect(shouldHold({ ...free, draft: true, focusInside: false, windowFocused: false })).toBe(true);
  });

  it("nothing, by default", () => {
    expect(shouldHold(free)).toBe(false);
  });

  it("a read or a save in flight", () => {
    expect(shouldHold({ ...free, busy: true })).toBe(true);
  });

  it("a caret in one of its fields while the window is in front", () => {
    expect(shouldHold({ ...free, focusInside: true })).toBe(true);
    // ...and not one left behind in a window that has gone behind another.
    expect(shouldHold({ ...free, focusInside: true, windowFocused: false })).toBe(false);
  });

  it("a menu opened from the form, whichever window is in front", () => {
    expect(shouldHold({ ...free, menuOpen: true })).toBe(true);
    expect(shouldHold({ ...free, menuOpen: true, windowFocused: false })).toBe(true);
  });
});

describe("what counts as a touch", () => {
  it("is a hand on the card: pointer, key, paste, drop, scroll", () => {
    for (const e of ["pointerdown", "pointermove", "keydown", "input", "paste", "drop", "wheel", "touchstart"]) {
      expect(TOUCH_EVENTS).toContain(e);
    }
  });
});
