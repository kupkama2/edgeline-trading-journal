import { describe, expect, it } from "vitest";
import { equityAt, fmtPercent, latestEquity, parseRiskBudget, riskPercent } from "../shared/equity";

/**
 * Equity behind a trade.
 *
 * The lookup is strict about time on purpose: a balance logged after a
 * trade says nothing about what was at risk then, and a blank is the
 * honest answer for a trade older than the first snapshot.
 */
const rows = [
  { account: "Binance Futures", at: "2026-08-01T00:00:00.000Z", balance: 5000 },
  { account: "Binance Futures", at: "2026-09-01T00:00:00.000Z", balance: 6000 },
  { account: "Hyperliquid", at: "2026-08-15T00:00:00.000Z", balance: 2000 },
];

describe("the balance behind a moment", () => {
  it("is the latest snapshot at or before it", () => {
    expect(equityAt(rows, "Binance Futures", "2026-08-15T12:00:00.000Z")).toBe(5000);
    expect(equityAt(rows, "Binance Futures", "2026-09-01T00:00:00.000Z")).toBe(6000);
    expect(equityAt(rows, "Binance Futures", "2026-09-02T00:00:00.000Z")).toBe(6000);
  });

  it("is unknown before the first snapshot, not borrowed from later", () => {
    expect(equityAt(rows, "Binance Futures", "2026-07-01T00:00:00.000Z")).toBeNull();
  });

  it("is per account, spelled however it was", () => {
    expect(equityAt(rows, "hyperliquid ", "2026-09-01T00:00:00.000Z")).toBe(2000);
    expect(equityAt(rows, "Apex eval", "2026-09-01T00:00:00.000Z")).toBeNull();
    expect(equityAt(rows, null, "2026-09-01T00:00:00.000Z")).toBeNull();
    expect(equityAt(rows, "", "2026-09-01T00:00:00.000Z")).toBeNull();
  });

  it("answers for now without a date", () => {
    expect(latestEquity(rows, "Binance Futures")).toBe(6000);
    expect(equityAt(rows, "Binance Futures", "not a date")).toBeNull();
  });
});

describe("risk as a share of the account", () => {
  it("divides, and says nothing when it cannot", () => {
    expect(riskPercent(103, 10_000)).toBeCloseTo(1.03);
    expect(riskPercent(103, null)).toBeNull();
    expect(riskPercent(null, 10_000)).toBeNull();
    expect(riskPercent(103, 0)).toBeNull();
  });

  it("reads a budget typed as dollars or as a percent", () => {
    expect(parseRiskBudget("103", 10_000)).toEqual({ dollars: 103, percent: null });
    expect(parseRiskBudget("$50", 10_000)).toEqual({ dollars: 50, percent: null });
    expect(parseRiskBudget("1%", 10_000)).toEqual({ dollars: 100, percent: 1 });
    expect(parseRiskBudget("0.5 %", 10_000)).toEqual({ dollars: 50, percent: 0.5 });
    // A percent of an unknown balance keeps the percent and owns up to the rest.
    expect(parseRiskBudget("1%", null)).toEqual({ dollars: null, percent: 1 });
    expect(parseRiskBudget("", 10_000)).toEqual({ dollars: null, percent: null });
    expect(parseRiskBudget("lots", 10_000)).toEqual({ dollars: null, percent: null });
  });

  it("prints a percent legibly", () => {
    expect(fmtPercent(0.93)).toBe("0.9%");
    expect(fmtPercent(1.03)).toBe("1.0%");
    expect(fmtPercent(0.05)).toBe("0.05%");
    expect(fmtPercent(null)).toBe("—");
  });
});
