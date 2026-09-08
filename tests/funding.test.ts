import { describe, expect, it } from "vitest";
import { estimateFunding, fundingMonths, parseBinanceFundingCsv } from "../shared/funding";

/**
 * Funding over a hold.
 *
 * The arithmetic is small; the edges are what matter. Which settlements a
 * hold spans is decided at the boundaries — open strictly before, still
 * open at — and the sign flips twice: once for the side, once for the rate.
 */
const HOUR = 3_600_000;
const hourly = (from: number, n: number, rate: number) =>
  Array.from({ length: n }, (_, i) => ({ time: from + (i + 1) * HOUR, rate }));

describe("estimating funding", () => {
  it("charges a long the rate on its notional at every settlement it spans", () => {
    // Entered just before the first settlement, out just after the fifth.
    const r = estimateFunding(
      { direction: "long", notional: 10_000, entryMs: 0.5 * HOUR, exitMs: 5.5 * HOUR },
      hourly(0, 8, 0.0001),
    );
    expect(r.events).toBe(5);
    expect(r.funding).toBeCloseTo(-5);
  });

  it("pays a short the same amount", () => {
    const r = estimateFunding(
      { direction: "short", notional: 10_000, entryMs: 0.5 * HOUR, exitMs: 5.5 * HOUR },
      hourly(0, 8, 0.0001),
    );
    expect(r.funding).toBeCloseTo(5);
  });

  it("flips with a negative rate", () => {
    const r = estimateFunding(
      { direction: "long", notional: 10_000, entryMs: 0.5 * HOUR, exitMs: 2.5 * HOUR },
      hourly(0, 3, -0.0002),
    );
    expect(r.funding).toBeCloseTo(4);
  });

  it("excludes a settlement at the entry and includes one at the exit", () => {
    const events = hourly(0, 3, 0.001); // at 1h, 2h, 3h
    const atEntry = estimateFunding(
      { direction: "long", notional: 1000, entryMs: 1 * HOUR, exitMs: 2.5 * HOUR },
      events,
    );
    expect(atEntry.events).toBe(1); // only 2h
    const atExit = estimateFunding(
      { direction: "long", notional: 1000, entryMs: 0.5 * HOUR, exitMs: 2 * HOUR },
      events,
    );
    expect(atExit.events).toBe(2); // 1h and 2h
  });

  it("rests on nothing when no settlement falls inside the hold", () => {
    const r = estimateFunding(
      { direction: "long", notional: 1000, entryMs: 1.2 * HOUR, exitMs: 1.8 * HOUR },
      hourly(0, 3, 0.001),
    );
    expect(r).toEqual({ funding: 0, events: 0 });
  });
});

describe("Binance's funding files", () => {
  it("reads rows with or without the header", () => {
    const withHeader = "calc_time,funding_interval_hours,last_funding_rate\n1700000000000,8,0.0001\n1700028800000,8,-0.00005\n";
    expect(parseBinanceFundingCsv(withHeader)).toEqual([
      { time: 1700000000000, rate: 0.0001 },
      { time: 1700028800000, rate: -0.00005 },
    ]);
    const bare = "1700028800000,8,-0.00005\n1700000000000,8,0.0001\n\nnot,a,row\n";
    expect(parseBinanceFundingCsv(bare).map((e) => e.time)).toEqual([1700000000000, 1700028800000]);
  });

  it("names the month files a hold spans", () => {
    expect(fundingMonths(Date.UTC(2026, 7, 27), Date.UTC(2026, 8, 2))).toEqual(["2026-08", "2026-09"]);
    expect(fundingMonths(Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 30))).toEqual(["2026-08"]);
    expect(fundingMonths(Date.UTC(2025, 11, 20), Date.UTC(2026, 0, 3))).toEqual(["2025-12", "2026-01"]);
  });
});
