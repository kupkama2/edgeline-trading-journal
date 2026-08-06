import { describe, expect, it } from "vitest";
import { suggestSize } from "../shared/sizing";

describe("suggestSize", () => {
  it("sizes futures in whole contracts, rounding DOWN", () => {
    // 12-point stop on MNQ ($2/pt) risks $24 a contract; $300 buys 12.5 → 12.
    const s = suggestSize({
      symbol: "MNQU6",
      entryPrice: 29700,
      initialStop: 29688,
      riskDollars: 300,
      sizeUnit: "base",
    })!;
    expect(s.size).toBe(12);
    expect(s.actualRiskDollars).toBe(288); // never more than asked
    expect(s.perUnitRisk).toBe(24);
  });

  it("answers zero contracts rather than overexposing", () => {
    // Same stop on full NQ ($20/pt) risks $240 a contract; a $200 budget
    // cannot afford one — and saying 1 would quietly risk 120% of budget.
    const s = suggestSize({
      symbol: "NQU6",
      entryPrice: 29700,
      initialStop: 29688,
      riskDollars: 200,
      sizeUnit: "base",
    })!;
    expect(s.size).toBe(0);
    expect(s.perUnitRisk).toBe(240);
  });

  it("sizes crypto as the notional whose stop distance costs the budget", () => {
    // Entry 50, stop 45: 10% adverse move. Risking $500 → $5,000 notional.
    const s = suggestSize({
      symbol: "BTCUSDT",
      entryPrice: 50,
      initialStop: 45,
      riskDollars: 500,
      sizeUnit: "quote",
    })!;
    expect(s.size).toBe(5000);
    expect(s.actualRiskDollars).toBe(500);
  });

  it("declines to answer without a real stop distance", () => {
    expect(
      suggestSize({
        symbol: "NQ",
        entryPrice: 100,
        initialStop: 100,
        riskDollars: 300,
        sizeUnit: "base",
      }),
    ).toBeNull();
    expect(
      suggestSize({
        symbol: "NQ",
        entryPrice: 100,
        initialStop: 90,
        riskDollars: 0,
        sizeUnit: "base",
      }),
    ).toBeNull();
  });
});
