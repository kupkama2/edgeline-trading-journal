import { afterEach, describe, expect, it } from "vitest";
import { trade } from "./helpers";

/**
 * Days and weeks on the trader's own clock, wherever it is.
 *
 * Each case here was right in UTC and wrong somewhere else: a week that
 * lost an hour to the clocks going back, a Monday that came out a Sunday in
 * Auckland, a CSV date filed the evening before in New York. Node reads TZ
 * on every Date call, so each test sets it and puts it back.
 */
const original = process.env.TZ;
afterEach(() => {
  process.env.TZ = original;
});

describe("a week across the clocks going back", () => {
  it("still holds the trade closed late on its Sunday", async () => {
    process.env.TZ = "Europe/Berlin";
    const { tradesInWeek, tradesOnDay } = await import("../shared/review");
    // Sunday 25 Oct 2026, 23:30 local: the last hour of the 25-hour day.
    const late = trade({ id: 1, exitTime: new Date(2026, 9, 25, 23, 30).toISOString() });
    expect(tradesInWeek([late], new Date(2026, 9, 21))).toHaveLength(1);
    expect(tradesOnDay([late], new Date(2026, 9, 25))).toHaveLength(1);
  });

  it("does not put a Monday-morning trade after the clocks go forward in two weeks", async () => {
    process.env.TZ = "Europe/Berlin";
    const { tradesInWeek } = await import("../shared/review");
    const monday = trade({ id: 2, exitTime: new Date(2027, 2, 29, 0, 30).toISOString() });
    expect(tradesInWeek([monday], new Date(2027, 2, 24))).toHaveLength(0);
    expect(tradesInWeek([monday], new Date(2027, 2, 30))).toHaveLength(1);
  });

  it("steps to the week after, not back to the same Monday", async () => {
    process.env.TZ = "Europe/Prague";
    const { weekBefore, weekKey } = await import("../shared/review");
    expect(weekKey(weekBefore(new Date(2026, 9, 19), -1))).toBe("2026-10-26");
    expect(weekKey(weekBefore(new Date(2026, 9, 21), -1))).toBe("2026-10-26");
  });
});

describe("a Monday far from Greenwich", () => {
  it("is a Monday in Auckland", async () => {
    process.env.TZ = "Pacific/Auckland";
    const { mondayOf } = await import("../shared/periods");
    expect(mondayOf("2026-10-21")).toBe("2026-10-19");
  });
});

describe("a CSV date with no time", () => {
  it("is that day in New York, not the evening before", async () => {
    process.env.TZ = "America/New_York";
    const { parseTradeCsv } = await import("../shared/csv");
    const csv = "symbol,direction,size,entry price,date\nES,long,1,5000,2026-08-05";
    const [row] = parseTradeCsv(csv).rows;
    const d = new Date(row.entryTime as string);
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 8, 5]);
  });

  it("does not read a Slippage column as the stop", async () => {
    const { parseTradeCsv } = await import("../shared/csv");
    const csv = "symbol,direction,size,entry price,slippage,stop loss\nES,long,1,5000,0.5,4990";
    const [row] = parseTradeCsv(csv).rows;
    expect(row.initialStop).toBe(4990);
  });
});

describe("the AI week", () => {
  it("is the window the browser sent, not the server's UTC week", async () => {
    const { buildInsightsBundle } = await import("../shared/weekly-insights");
    // New York: Monday 19 Oct 00:00 EDT is 04:00Z. A close on Sunday 25 Oct at
    // 21:00 EDT (Monday 01:00Z) is in this week on the trader's clock.
    const sundayNight = trade({ id: 3, exitTime: "2026-10-26T01:00:00.000Z", reviewNote: "note" });
    const window = { from: "2026-10-19T04:00:00.000Z", to: "2026-10-26T04:00:00.000Z", key: "2026-10-19" };
    const b = buildInsightsBundle([sundayNight], [], new Date("2026-10-19T00:00:00Z"), [], window);
    expect(b.weekStart).toBe("2026-10-19");
    expect(b.weekEnd).toBe("2026-10-25");
    // Entry 100 → exit 120 against a stop at 90: the trade is in, at +2R.
    expect(b.stats.totalR).toBeCloseTo(2);
  });
});
