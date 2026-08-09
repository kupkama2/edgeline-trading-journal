import { describe, expect, it } from "vitest";
import { suggestFees } from "../shared/fees";
import { convertFillSize } from "../shared/fills";
import { computeMetrics, fmtMoney } from "../shared/metrics";
import { parseHighlights, serializeHighlights } from "../shared/highlights";
import { byHighlight } from "../shared/breakdowns";
import { trade } from "./helpers";
import type { AccountSettings } from "../shared/schema";

const cfg = (over: Partial<AccountSettings> = {}): AccountSettings => ({
  id: 1,
  name: "Test",
  feeMode: "percent",
  makerFee: 0.02,
  takerFee: 0.05,
  ...over,
});

describe("convertFillSize", () => {
  it("passes same-unit sizes through untouched, no price needed", () => {
    expect(convertFillSize(2, "base", "base", 0)).toBe(2);
  });

  it("crosses units at the fill price", () => {
    expect(convertFillSize(2750, "quote", "base", 55)).toBe(50); // USD → coins
    expect(convertFillSize(50, "base", "quote", 55)).toBe(2750); // coins → USD
  });

  it("refuses to cross units without a price", () => {
    expect(convertFillSize(2750, "quote", "base", 0)).toBeNull();
    expect(convertFillSize(NaN, "base", "base", 1)).toBeNull();
  });
});

describe("suggestFees", () => {
  it("prices the three order-type combos as % of both sides' notional", () => {
    // 1 unit: in 100, out 120 → notionals 100 + 120 = 220.
    const t = trade();
    const s = suggestFees(t, cfg(), 120);
    const by = Object.fromEntries(s.map((x) => [x.key, x.dollars]));
    expect(by.mm).toBeCloseTo((100 * 0.05 + 120 * 0.05) / 100); // 0.11
    expect(by.lm).toBeCloseTo((100 * 0.02 + 120 * 0.05) / 100); // 0.08
    expect(by.ll).toBeCloseTo((100 * 0.02 + 120 * 0.02) / 100); // 0.044 → 0.04
  });

  it("prices per-contract schedules per side", () => {
    // 2 contracts, $1.20 market / $0.80 limit per contract per side.
    const t = trade({ size: 2, pointValue: 20 });
    const s = suggestFees(t, cfg({ feeMode: "perContract", makerFee: 0.8, takerFee: 1.2 }), 120);
    const by = Object.fromEntries(s.map((x) => [x.key, x.dollars]));
    expect(by.mm).toBeCloseTo(2 * 1.2 + 2 * 1.2); // 4.8
    expect(by.lm).toBeCloseTo(2 * 0.8 + 2 * 1.2); // 4
    expect(by.ll).toBeCloseTo(2 * 0.8 + 2 * 0.8); // 3.2
  });

  it("collapses a flat schedule to one chip", () => {
    const s = suggestFees(trade(), cfg({ makerFee: 0.05, takerFee: 0.05 }), 120);
    expect(s).toHaveLength(1);
    expect(s[0].label).toMatch(/entry \+ exit/);
  });

  it("stays quiet with no schedule, no exit, or zero rates", () => {
    expect(suggestFees(trade(), null, 120)).toEqual([]);
    expect(suggestFees(trade(), cfg(), null)).toEqual([]);
    expect(suggestFees(trade(), cfg({ makerFee: 0, takerFee: 0 }), 120)).toEqual([]);
  });
});

describe("highlights", () => {
  it("round-trips through the column and drops junk", () => {
    expect(serializeHighlights(["Perfect Entry", " Let It Run ", ""])).toBe(
      JSON.stringify(["Perfect Entry", "Let It Run"]),
    );
    expect(serializeHighlights([])).toBeNull();
    expect(parseHighlights('["Perfect Entry",3,null,"Let It Run"]')).toEqual([
      "Perfect Entry",
      "Let It Run",
    ]);
    expect(parseHighlights("nonsense")).toEqual([]);
    expect(parseHighlights(null)).toEqual([]);
  });

  it("dedupes so a double-tap can't double-count in the breakdown", () => {
    expect(serializeHighlights(["Perfect Entry", "Perfect Entry"])).toBe(
      JSON.stringify(["Perfect Entry"]),
    );
  });

  it("slices trades by flag, best first, overlapping by design", () => {
    const rows = byHighlight([
      trade({ highlights: JSON.stringify(["Perfect Entry", "Let It Run"]) }), // +2R
      trade({ exitPrice: 90, highlights: JSON.stringify(["Perfect Entry"]) }), // −1R
      trade(), // unflagged: no bucket
    ]);
    expect(rows.map((r) => r.label)).toEqual(["Let It Run", "Perfect Entry"]);
    expect(rows[0].totalR).toBe(2);
    expect(rows[1].count).toBe(2);
    expect(rows[1].totalR).toBe(1); // +2 and −1
  });
});

describe("fees in metrics", () => {
  it("nets fees out of P&L and R, keeping gross visible", () => {
    // +$20 gross on $10 risk; $5 fees → net +$15 = +1.5R.
    const m = computeMetrics(trade({ fees: 5 }));
    expect(m.grossPnL).toBe(20);
    expect(m.fees).toBe(5);
    expect(m.actualPnL).toBe(15);
    expect(m.actualR).toBeCloseTo(1.5);
  });

  it("changes nothing when fees are not recorded", () => {
    const m = computeMetrics(trade());
    expect(m.fees).toBe(0);
    expect(m.actualPnL).toBe(20);
    expect(m.grossPnL).toBe(20);
    expect(m.actualR).toBe(2);
  });

  it("nets fees on a scaled trade too", () => {
    // From fills tests: partials+close = $70 gross on $40 risk. $10 fees →
    // $60 net = 1.5R against the ORIGINAL risk.
    const t = trade({
      size: 4,
      exitPrice: 120,
      fees: 10,
      fills: [
        { id: 991, tradeId: 1, kind: "partial", price: 115, size: 2, time: "2026-08-03T09:45:00Z", note: null },
      ],
    });
    const m = computeMetrics(t);
    expect(m.grossPnL).toBe(70);
    expect(m.actualPnL).toBe(60);
    expect(m.actualR).toBeCloseTo(1.5);
  });
});

describe("formatting small numbers", () => {
  it("keeps cents on figures a sub-penny position actually produces", () => {
    // 3,000 units of a $0.0065 token moving 0.0011 settles for ~$3.30, and
    // whole-dollar rounding threw most of that away.
    expect(fmtMoney(3.3)).toBe("+$3.30");
    expect(fmtMoney(-0.42)).toBe("-$0.42");
    // Above the noise floor the cents stop earning their space.
    expect(fmtMoney(12000)).toBe("+$12,000");
    expect(fmtMoney(0)).toBe("$0.00");
  });
});
