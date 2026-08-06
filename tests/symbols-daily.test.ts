import { describe, expect, it } from "vitest";
import { normalizeSymbol, pointValueFor } from "../shared/symbols";
import { dayKeyOfIso, summarizeDays } from "../shared/daily";
import { startOfWeek, weekStartKey } from "../shared/weekly-insights";
import { localIso, trade } from "./helpers";

describe("symbols", () => {
  it("rolls contracts up to one instrument for grouping", () => {
    expect(normalizeSymbol("MNQU6")).toBe("NQ");
    expect(normalizeSymbol("NQZ5")).toBe("NQ");
    expect(normalizeSymbol("MESH6")).toBe("ES");
    expect(normalizeSymbol("AAPL")).toBe("AAPL");
    expect(normalizeSymbol("BTCUSDT")).toBe("BTCUSDT");
  });

  /**
   * The other half of the micro-contract regression: grouping folds MNQ into
   * NQ, but the point value must come from the contract AS WRITTEN — they
   * differ tenfold in dollars per point.
   */
  it("prices the point off the contract as written", () => {
    expect(pointValueFor("MNQU6")).toBe(2);
    expect(pointValueFor("NQU6")).toBe(20);
    expect(pointValueFor("MNQ")).toBe(2);
    expect(pointValueFor("NQ")).toBe(20);
    expect(pointValueFor("BTCUSDT")).toBe(1); // crypto is already in quote currency
  });
});

describe("daily attribution", () => {
  it("gives a swing to one day's 'entered' and another day's result", () => {
    const swing = trade({
      entryTime: localIso(2026, 8, 3, 15),
      exitTime: localIso(2026, 8, 5, 10),
    });
    const days = summarizeDays([swing]);
    expect(days.get(dayKeyOfIso(swing.entryTime)!)!.entered).toBe(1);
    const exitDay = days.get(dayKeyOfIso(swing.exitTime!)!)!;
    expect(exitDay.closed).toBe(1);
    expect(exitDay.totalR).toBe(2);
  });

  it("keeps cancelled orders off every day's ledger", () => {
    const gone = trade({ status: "cancelled", cancelReason: "pulled", exitPrice: null });
    expect(summarizeDays([gone]).size).toBe(0);
  });
});

describe("week boundaries", () => {
  it("starts the week on Monday, local time", () => {
    // 2026-08-06 is a Thursday; its week starts Monday the 3rd.
    expect(weekStartKey(startOfWeek(new Date(2026, 7, 6, 15, 0)))).toBe("2026-08-03");
    // A Monday is its own week start.
    expect(weekStartKey(startOfWeek(new Date(2026, 7, 3, 0, 5)))).toBe("2026-08-03");
  });
});
