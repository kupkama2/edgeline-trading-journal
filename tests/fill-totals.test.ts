import { describe, expect, it } from "vitest";
import { addFromTotals, partialFromTotals, positionLedger } from "../shared/fills";
import { trade } from "./helpers";

const open = (over: Parameters<typeof trade>[0] = {}) =>
  trade({ status: "open", exitPrice: null, exitTime: null, exitReason: null, ...over } as any);
const asFill = (r: any, time = "2026-08-03T09:45:00.000Z") =>
  ({ id: 1, tradeId: 1, kind: r.kind, price: r.price, size: r.size, time, note: null }) as any;

describe("an add worked out from the new totals", () => {
  it("finds the size and the price that give the new average", () => {
    // 2 units at 100; now 3 at an average of 102 → 1 added at 106.
    const t = open({ size: 2, entryPrice: 100 });
    const r = addFromTotals(t, { size: 3, avgEntry: 102 }) as any;
    expect(r.ok).toBe(true);
    expect(r.size).toBeCloseTo(1);
    expect(r.price).toBeCloseTo(106);
    // And the ledger lands exactly on the totals given.
    const led = positionLedger({ ...t, fills: [asFill(r)] });
    expect(led.openQty).toBeCloseTo(3);
    expect(led.avgEntry).toBeCloseTo(102);
  });

  it("does the same in dollars, valued at the average entry", () => {
    // $2,000 at 10 is 200 coins; now $5,000 at an average of 10.5 → 476.19 coins.
    const t = open({ size: 2000, sizeUnit: "quote", entryPrice: 10 });
    const r = addFromTotals(t, { size: 5000, avgEntry: 10.5 }) as any;
    const led = positionLedger({ ...t, fills: [asFill(r)] });
    expect(led.openQty * led.avgEntry).toBeCloseTo(5000);
    expect(led.avgEntry).toBeCloseTo(10.5);
  });

  it("refuses totals that cannot happen", () => {
    const t = open({ size: 2, entryPrice: 100 });
    expect(addFromTotals(t, { size: 2, avgEntry: 101 }).ok).toBe(false);
    // Adding 1 to 2@100 cannot pull the average to 10.
    expect(addFromTotals(t, { size: 3, avgEntry: 10 }).ok).toBe(false);
  });
});

describe("profit taken, worked out from what is left", () => {
  it("finds what came off and where", () => {
    // 3 units at 100, 1 left, $40 booked → 2 off at 120.
    const t = open({ size: 3, entryPrice: 100 });
    const r = partialFromTotals(t, { size: 1, booked: 40 }) as any;
    expect(r.size).toBeCloseTo(2);
    expect(r.price).toBeCloseTo(120);
    const led = positionLedger({ ...t, fills: [asFill(r)] });
    expect(led.openQty).toBeCloseTo(1);
    expect(led.realizedPnL).toBeCloseTo(40);
  });

  it("reads a short the other way round", () => {
    const t = open({ direction: "short", size: 3, entryPrice: 100, initialStop: 110 });
    const r = partialFromTotals(t, { size: 1, booked: 40 }) as any;
    expect(r.price).toBeCloseTo(80);
  });

  it("books a loss when a loss is given", () => {
    const t = open({ size: 2, entryPrice: 100 });
    const r = partialFromTotals(t, { size: 1, booked: -5 }) as any;
    expect(r.price).toBeCloseTo(95);
  });

  it("works in dollars and in contracts", () => {
    const usd = open({ size: 3000, sizeUnit: "quote", entryPrice: 10 });
    const r = partialFromTotals(usd, { size: 1000, booked: 100 }) as any;
    const led = positionLedger({ ...usd, fills: [asFill(r)] });
    expect(led.openQty * led.avgEntry).toBeCloseTo(1000);
    expect(led.realizedPnL).toBeCloseTo(100);

    const fut = open({ size: 4, entryPrice: 20000, initialStop: 19900, pointValue: 2 });
    const f = partialFromTotals(fut, { size: 1, booked: 300 }) as any;
    // 3 contracts at $2 a point: $300 is 50 points.
    expect(f.size).toBeCloseTo(3);
    expect(f.price).toBeCloseTo(20050);
  });

  it("leaves the last piece to the close, and refuses nothing taken", () => {
    const t = open({ size: 2, entryPrice: 100 });
    expect(partialFromTotals(t, { size: 0, booked: 10 }).ok).toBe(false);
    expect(partialFromTotals(t, { size: 2, booked: 10 }).ok).toBe(false);
  });
});
