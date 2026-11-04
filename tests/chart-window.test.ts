import { describe, expect, it } from "vitest";
import { chartWindow } from "../server/chart-window";

/** The chart's window: the same bars for the same trade however often it is asked. */
const H = 3_600_000;
const now = Date.parse("2026-11-04T12:00:30Z");

describe("the chart window", () => {
  it("begins on a bar boundary, so an open trade asked twice in a minute is one key", () => {
    const t = { entryTime: new Date(now - 5 * H).toISOString(), exitTime: null };
    const a = chartWindow(t, undefined, undefined, now);
    const b = chartWindow(t, undefined, undefined, now + 20_000);
    expect(a.interval).toBe(b.interval);
    expect(a.from).toBe(b.from);
    expect(a.from % (a.interval === "1m" ? 60_000 : 1)).toBe(0);
    expect(a.paging).toBe(false);
  });

  it("keeps a closed trade's window fixed, with the trade whole and aftermath after it", () => {
    const entry = Date.parse("2026-10-01T10:00:00Z");
    const exit = Date.parse("2026-10-01T14:00:00Z");
    const t = { entryTime: new Date(entry).toISOString(), exitTime: new Date(exit).toISOString() };
    const w = chartWindow(t, undefined, undefined, now);
    expect(w.from).toBeLessThanOrEqual(entry - 2 * H);
    expect(w.to).toBeGreaterThan(exit + 2 * H);
    // Asked hours later: the same window, so the same cache key.
    expect(chartWindow(t, undefined, undefined, now + 3 * H)).toEqual(w);
  });

  it("zooms in for a fine timeframe, out for a coarse one, and pages history on request", () => {
    const entry = Date.parse("2026-10-01T10:00:00Z");
    const exit = Date.parse("2026-10-20T14:00:00Z");
    const t = { entryTime: new Date(entry).toISOString(), exitTime: new Date(exit).toISOString() };
    const fine = chartWindow(t, "1m", undefined, now);
    expect(fine.interval).toBe("1m");
    expect(fine.to - fine.from).toBeLessThanOrEqual(700 * 60_000);
    const coarse = chartWindow({ entryTime: new Date(entry).toISOString(), exitTime: new Date(entry + 6 * H).toISOString() }, "1d", undefined, now);
    expect(coarse.interval).toBe("1d");
    expect(coarse.to - coarse.from).toBeGreaterThanOrEqual(40 * 24 * H);
    const before = Date.parse("2026-10-01T00:00:00Z");
    const page = chartWindow(t, "1h", before, now);
    expect(page.paging).toBe(true);
    expect(page.to).toBe(before);
    expect(page.from).toBe(before - 600 * H);
  });
});
