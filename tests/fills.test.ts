import { describe, expect, it } from "vitest";
import { positionLedger, totalPnLWithFills, validateFill } from "../shared/fills";
import { computeMetrics } from "../shared/metrics";
import { trade } from "./helpers";
import { parseExtraTargets, type TradeFill } from "../shared/schema";

let fid = 0;
const fill = (kind: "add" | "partial", price: number, size: number, time: string): TradeFill => ({
  id: ++fid,
  tradeId: 1,
  kind,
  price,
  size,
  time,
  note: null,
});

describe("positionLedger", () => {
  it("banks a partial against the entry and leaves the rest running", () => {
    // Long 4 @100, stop 90. Take 2 off at 115 → banked 2×15 = $30.
    const led = positionLedger(
      trade({ size: 4, fills: [fill("partial", 115, 2, "2026-08-03T10:00:00Z")] }),
    );
    expect(led.realizedPnL).toBe(30);
    expect(led.openQty).toBe(2);
    expect(led.avgEntry).toBe(100); // no adds — entry unchanged
    expect(led.partials).toBe(1);
  });

  it("moves the weighted average entry on an add", () => {
    // Long 2 @100, add 2 @110 → avg 105 on 4.
    const led = positionLedger(
      trade({ size: 2, fills: [fill("add", 110, 2, "2026-08-03T10:00:00Z")] }),
    );
    expect(led.avgEntry).toBe(105);
    expect(led.openQty).toBe(4);
    expect(led.realizedPnL).toBe(0);
  });

  it("orders fills by time, not insertion", () => {
    // Add FIRST (avg 105), then partial at 115 realises against 105, not 100.
    const led = positionLedger(
      trade({
        size: 2,
        fills: [
          fill("partial", 115, 2, "2026-08-03T11:00:00Z"),
          fill("add", 110, 2, "2026-08-03T10:00:00Z"),
        ],
      }),
    );
    expect(led.avgEntry).toBe(105);
    expect(led.realizedPnL).toBe(20); // 2 × (115 − 105)
    expect(led.openQty).toBe(2);
  });

  it("scales futures dollars by point value", () => {
    // 2 MNQ ($2/pt) @100, one off at 115 → 15 pts × 1 ct × $2 = $30.
    const led = positionLedger(
      trade({ pointValue: 2, size: 2, fills: [fill("partial", 115, 1, "2026-08-03T10:00:00Z")] }),
    );
    expect(led.realizedPnL).toBe(30);
  });

  it("converts quote-sized fills at their own price", () => {
    // $5,000 notional @50 = 100 coins. Take $2,750 off at 55 = 50 coins,
    // banking 50 × 5 = $250.
    const led = positionLedger(
      trade({
        sizeUnit: "quote",
        size: 5000,
        entryPrice: 50,
        initialStop: 45,
        fills: [fill("partial", 55, 2750, "2026-08-03T10:00:00Z")],
      }),
    );
    expect(led.realizedPnL).toBeCloseTo(250);
    expect(led.openQty).toBeCloseTo(50);
  });

  it("mirrors for shorts", () => {
    // Short 4 @100, cover 2 at 90 → banked 2×10 = $20.
    const led = positionLedger(
      trade({
        direction: "short",
        size: 4,
        initialStop: 110,
        fills: [fill("partial", 90, 2, "2026-08-03T10:00:00Z")],
      }),
    );
    expect(led.realizedPnL).toBe(20);
  });
});

describe("computeMetrics with fills", () => {
  it("settles total P&L from partials plus the close, R against ORIGINAL risk", () => {
    // Long 4 @100, stop 90 → planned risk $40 (1R). Take 2 off at 115 (+$30),
    // close 2 at 120 (+$40). Total $70 → 1.75R against the original $40.
    const t = trade({
      size: 4,
      exitPrice: 120,
      fills: [fill("partial", 115, 2, "2026-08-03T09:45:00Z")],
    });
    const m = computeMetrics(t);
    expect(m.riskDollars).toBe(40);
    expect(m.actualPnL).toBe(70);
    expect(m.actualR).toBeCloseTo(1.75);
  });

  it("changes NOTHING for a trade without fills", () => {
    const a = computeMetrics(trade());
    const b = computeMetrics(trade({ fills: [] }));
    expect(a).toEqual(b);
  });

  it("an add that loses still nets against the moved average", () => {
    // Long 2 @100, add 2 @110 (avg 105 on 4), close all at 102:
    // 4 × (102 − 105) = −$12; planned risk was $20 → −0.6R.
    const t = trade({
      size: 2,
      exitPrice: 102,
      fills: [fill("add", 110, 2, "2026-08-03T09:40:00Z")],
    });
    const m = computeMetrics(t);
    expect(m.actualPnL).toBeCloseTo(-12);
    expect(m.actualR).toBeCloseTo(-0.6);
  });
});

describe("validateFill", () => {
  const open = trade({ size: 4, status: "open", exitPrice: null, exitTime: null });

  it("accepts a sane partial", () => {
    expect(validateFill(open, { kind: "partial", price: 110, size: 2 })).toBeNull();
  });

  it("refuses to flatten the position with a partial", () => {
    expect(validateFill(open, { kind: "partial", price: 110, size: 4 })).toMatch(/use Close/i);
    // …and refuses past the remainder after an earlier partial.
    const scaled = trade({
      size: 4,
      status: "open",
      exitPrice: null,
      exitTime: null,
      fills: [fill("partial", 110, 2, "2026-08-03T10:00:00Z")],
    });
    expect(validateFill(scaled, { kind: "partial", price: 112, size: 2 })).toMatch(/use Close/i);
  });

  it("refuses fills on anything not open", () => {
    expect(validateFill(trade(), { kind: "add", price: 101, size: 1 })).toMatch(/open/i);
  });
});

describe("parseExtraTargets", () => {
  it("reads planned levels back in order", () => {
    expect(parseExtraTargets(JSON.stringify([115, 120, 130]))).toEqual([115, 120, 130]);
  });

  it("is defensive about garbage", () => {
    expect(parseExtraTargets(null)).toEqual([]);
    expect(parseExtraTargets("")).toEqual([]);
    expect(parseExtraTargets("not json")).toEqual([]);
    expect(parseExtraTargets('{"a":1}')).toEqual([]);
    // Non-numbers, negatives and NaN are dropped, survivors keep their order.
    expect(parseExtraTargets('[115,"x",-3,null,120]')).toEqual([115, 120]);
  });
});
