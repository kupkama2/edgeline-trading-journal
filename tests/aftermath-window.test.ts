import { describe, expect, it } from "vitest";
import {
  AFTERMATH_MAX_MS,
  AFTERMATH_MIN_MS,
  aftermathPending,
  aftermathReady,
  aftermathReadyAt,
  aftermathWindowMs,
  pathIncomplete,
} from "../shared/aftermath";
import { pathExtremes } from "../shared/binance";
import { trade } from "./helpers";

/**
 * What happened after you were out is a question about a window, and the
 * window is the trade's own: a scalp is answered by the next hour, a swing
 * is not. Nothing is written until that window has run, because nothing
 * rewrites it afterwards.
 */
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 8, 14, 12);
const iso = (ms: number) => new Date(ms).toISOString();
/** Held `heldMs`, closed at T0. */
const held = (heldMs: number, over = {}) =>
  trade({ entryTime: iso(T0 - heldMs), exitTime: iso(T0), ...over });

describe("the window after the exit", () => {
  it("is one and a half times the hold", () => {
    expect(aftermathWindowMs(held(2 * DAY))).toBe(3 * DAY);
    expect(aftermathWindowMs(held(8 * HOUR))).toBe(12 * HOUR);
  });

  it("is never less than a couple of hours, however short the trade", () => {
    expect(aftermathWindowMs(held(20 * MIN))).toBe(AFTERMATH_MIN_MS);
    expect(aftermathWindowMs(held(0))).toBe(AFTERMATH_MIN_MS);
  });

  it("is never more than a week, however long the trade", () => {
    expect(aftermathWindowMs(held(30 * DAY))).toBe(AFTERMATH_MAX_MS);
  });

  it("ends one window past the exit, and not before", () => {
    const t = held(8 * HOUR);
    expect(aftermathReadyAt(t)).toBe(T0 + 12 * HOUR);
    expect(aftermathReady(t, T0 + 12 * HOUR - 1)).toBe(false);
    expect(aftermathReady(t, T0 + 12 * HOUR)).toBe(true);
    expect(aftermathReadyAt(trade({ exitTime: null }))).toBeNull();
  });
});

describe("what the reader is still owed", () => {
  const closed = (over = {}) =>
    held(8 * HOUR, { mae: 95, mfe: 130, postExitPeak: null, postExitAdverse: null, ...over });

  it("asks for the held path straight away, while the aftermath still waits", () => {
    const fresh = closed({ mae: null, mfe: null });
    expect(pathIncomplete(fresh, T0 + MIN)).toBe(true);
  });

  it("does not ask for the aftermath until the window has run", () => {
    expect(pathIncomplete(closed(), T0 + HOUR)).toBe(false);
    expect(pathIncomplete(closed(), T0 + 12 * HOUR)).toBe(true);
  });

  it("stops asking once both after-exit prices are in", () => {
    expect(pathIncomplete(closed({ postExitPeak: 140, postExitAdverse: 90 }), T0 + 12 * HOUR)).toBe(false);
  });

  it("stops asking at all once the trade is too old to learn from", () => {
    expect(pathIncomplete(closed(), T0 + 40 * DAY)).toBe(false);
  });

  it("says the aftermath is coming rather than missing, while it waits", () => {
    expect(aftermathPending(closed(), T0 + HOUR)).toBe(true);
    expect(aftermathPending(closed(), T0 + 12 * HOUR)).toBe(false);
    expect(aftermathPending(closed({ postExitPeak: 140, postExitAdverse: 90 }), T0 + HOUR)).toBe(false);
    expect(aftermathPending(trade({ status: "open", exitPrice: null, exitTime: null }), T0)).toBe(false);
  });
});

describe("measuring over that window and no further", () => {
  const bar = (t: number, h: number, l: number) => ({ t, o: 100, h, c: 100, l, v: 0 });
  // Entry at 0, exit at 1h. Inside the window price reaches 120; a day later
  // it reaches 200 — a different move, and not this trade's aftermath.
  const bars = [
    bar(0, 105, 95),
    bar(HOUR, 106, 99),
    bar(HOUR + 30 * MIN, 120, 101),
    bar(HOUR + 3 * HOUR, 200, 60),
  ];
  const t = { direction: "long", entryMs: 0, exitMs: HOUR, stop: null };

  it("keeps the later move out of both after-exit figures", () => {
    const p = pathExtremes(bars, t, 2 * HOUR);
    expect(p.postExitPeak).toBe(120);
    expect(p.postExitAdverse).toBe(101);
  });

  it("takes it in when the window is wide enough to contain it", () => {
    const p = pathExtremes(bars, t, 6 * HOUR);
    expect(p.postExitPeak).toBe(200);
    expect(p.postExitAdverse).toBe(60);
  });

  it("leaves the held path alone either way", () => {
    expect(pathExtremes(bars, t, 2 * HOUR).mfe).toBe(106);
    expect(pathExtremes(bars, t, 2 * HOUR).mae).toBe(95);
  });
});
