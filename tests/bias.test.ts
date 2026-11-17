import { describe, expect, it } from "vitest";
import { dailyBias } from "../shared/bias";
import { assetClassOf, benchmarkKindOf, benchmarkLabel, isMetal, pickIndexBenchmarks } from "../shared/sectors";
import type { ScreenerCandle } from "../shared/screener";

const DAY = 86400_000;
/** Monday 2 November 2026, 00:00 UTC. */
const MON = Date.UTC(2026, 10, 2);
/** Days from a list of [open, high, low, close], the first on a Monday; the last is the day still forming. */
const days = (rows: [number, number, number, number][], start = MON): ScreenerCandle[] => rows.map(([o, h, l, c], i) => ({ t: start + i * DAY, o, h, l, c, v: 1 }));
/** A steady climb of `n` days ending near `to`, each closing near its high. */
const climb = (n: number, to: number, step = 1): [number, number, number, number][] => Array.from({ length: n }, (_, i) => {
  const c = to - (n - 1 - i) * step;
  return [c - step * 0.8, c + step * 0.1, c - step * 0.9, c];
});
const vote = (b: NonNullable<ReturnType<typeof dailyBias>>, id: string) => b.votes.find((v) => v.id === id)!;

describe("the day's bias", () => {
  it("needs a yesterday and a day before it", () => {
    expect(dailyBias(days(climb(5, 100)))).toBeNull();
    expect(dailyBias(days(climb(6, 100)))).not.toBeNull();
  });

  it("is bullish on a climb that closes at its highs, and says what it rests on", () => {
    // Sixty rising days, then today trading above yesterday's high.
    const b = dailyBias(days([...climb(60, 200), [200.2, 202, 200.1, 201.8]], MON - 56 * DAY))!;
    expect(b.side).toBe("bullish");
    expect(vote(b, "trend")).toMatchObject({ vote: 1, text: expect.stringMatching(/above the 20-day average, which is above the 50-day/) });
    expect(vote(b, "yesterday")).toMatchObject({ vote: 1, text: expect.stringMatching(/above the previous day's high/) });
    expect(vote(b, "close").vote).toBe(1);
    expect(vote(b, "structure").vote).toBe(1);
    expect(b.today).toEqual({ text: "Now above yesterday's high", agrees: true });
    expect(b.levels.prevHigh).toBeCloseTo(200.1);
    expect(b.asOf).toBe(new Date(MON - 56 * DAY + 59 * DAY).toISOString().slice(0, 10));
  });

  it("is bearish on the mirror of it, and flags a day that is going the other way", () => {
    const fall: [number, number, number, number][] = climb(60, 200).map(([o, h, l, c]) => [400 - o, 400 - l, 400 - h, 400 - c]);
    // Today has bounced into the upper half of yesterday's range.
    const y = fall[fall.length - 1];
    const b = dailyBias(days([...fall, [y[3], y[1], y[3], (y[1] + y[2]) / 2 + 0.3]], MON - 56 * DAY))!;
    expect(b.side).toBe("bearish");
    expect(b.score).toBeLessThanOrEqual(-3);
    expect(b.today).toEqual({ text: "Now in the upper half of yesterday's range", agrees: false });
  });

  it("has no bias on an inside day in the middle of a range, and does not pretend to", () => {
    const flat: [number, number, number, number][] = Array.from({ length: 60 }, (_, i) => (i % 2 ? [100, 102, 98, 101] : [101, 102, 98, 99]));
    // The day before: a wide day. Yesterday: inside it, closing mid-range.
    const b = dailyBias(days([...flat, [100, 105, 95, 100], [100, 102, 98, 100], [100, 100.5, 99.5, 100]], MON - 56 * DAY))!;
    expect(b.side).toBe("neutral");
    expect(vote(b, "yesterday").text).toMatch(/inside day/);
    expect(vote(b, "close").vote).toBe(0);
    expect(b.today.agrees).toBeNull();
  });

  it("reads a sweep of the previous high that closes back under it as a failure", () => {
    const flat: [number, number, number, number][] = Array.from({ length: 30 }, () => [100, 101, 99, 100]);
    const b = dailyBias(days([...flat, [100, 103, 99, 102], [102, 104, 100, 100.5], [100.5, 101, 100, 100.6]]))!;
    expect(vote(b, "yesterday")).toMatchObject({ vote: -1, text: expect.stringMatching(/took the previous high and closed back under it/) });
  });

  it("measures the week from Monday's open, and gives no week vote on a Monday", () => {
    // Twelve days from a Monday: the last (day 11) is a Friday; the week opened on day 7.
    const rows = climb(12, 120, 2);
    const fri = dailyBias(days(rows))!;
    expect(fri.levels.weekOpen).toBeCloseTo(rows[7][0]);
    expect(vote(fri, "week").vote).toBe(1);
    // Eight days from a Monday: the last is the next Monday itself.
    expect(vote(dailyBias(days(climb(8, 120, 2)))!, "week")).toMatchObject({ vote: 0, text: "The week has just opened" });
  });
});

describe("what a market is measured against", () => {
  it("is BTC for crypto, metals, oil and currencies, and the stock index for stocks and indices", () => {
    for (const c of ["SOL", "xyz:GOLD", "xyz:CL", "xyz:EUR", "xyz:BTC"]) expect([c, benchmarkKindOf(c)]).toEqual([c, "btc"]);
    for (const c of ["xyz:NVDA", "xyz:SP500", "xyz:EWY", "io:ANTH", "xyz:SHEIN"]) expect([c, benchmarkKindOf(c)]).toEqual([c, "index"]);
    expect(assetClassOf("io:ANTH")).toBe("pre-ipo");
    expect(assetClassOf("xyz:SPCX")).toBe("pre-ipo");
  });

  it("picks the S&P 500 where it is listed, the most traded listing of it, with the Nasdaq-100 as its own yardstick", () => {
    const m = [
      { coin: "xyz:XYZ100", volume: 533e6 },
      { coin: "xyz:SP500", volume: 385e6 },
      { coin: "flx:SP500", volume: 2e6 },
      { coin: "xyz:NVDA", volume: 500e6 },
      { coin: "SPX", volume: 9e9 }, // a memecoin on the venue's own book, not the index
    ];
    expect(pickIndexBenchmarks(m)).toEqual({ main: "xyz:SP500", other: "xyz:XYZ100" });
    expect(pickIndexBenchmarks(m.filter((x) => !x.coin.endsWith("SP500")))).toEqual({ main: "xyz:XYZ100", other: null });
    expect(pickIndexBenchmarks([{ coin: "SOL", volume: 1 }])).toEqual({ main: null, other: null });
    expect([benchmarkLabel("xyz:SP500"), benchmarkLabel("xyz:XYZ100"), benchmarkLabel(undefined), benchmarkLabel("BTC")]).toEqual(["S&P 500", "Nasdaq-100", "BTC", "BTC"]);
  });

  it("knows the metals among the commodities", () => {
    expect(["xyz:GOLD", "xyz:SILVER", "xyz:COPPER", "xyz:CL", "xyz:NATGAS", "GOLD"].map(isMetal)).toEqual([true, true, true, false, false, false]);
  });
});
