import { describe, expect, it } from "vitest";
import {
  collapseFills,
  positionLedger,
  suggestPartialSize,
  totalPnLWithFills,
  validateFill,
} from "../shared/fills";
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

describe("collapseFills", () => {
  /**
   * The invariant that matters: collapsing must not move the money. R is
   * asserted separately, because folding ADDS into the entry legitimately
   * rebases 1R — see the note on collapseFills.
   */
  const settlesTheSame = (t: ReturnType<typeof trade>) => {
    const before = computeMetrics(t);
    const c = collapseFills(t)!;
    const after = computeMetrics(trade({ ...t, ...c, fills: [] }));
    expect(after.actualPnL).toBeCloseTo(before.actualPnL!, 6);
    if (!t.fills.some((f) => f.kind === "add")) {
      expect(after.actualR).toBeCloseTo(before.actualR!, 6);
    }
    return c;
  };

  it("averages the exits and keeps the P&L to the cent", () => {
    // Long 4 @100: take 2 @115, close 2 @120 → avg exit 117.5 on 4.
    const c = settlesTheSame(
      trade({ size: 4, exitPrice: 120, fills: [fill("partial", 115, 2, "2026-08-03T10:00:00Z")] }),
    );
    expect(c.size).toBe(4);
    expect(c.entryPrice).toBe(100);
    expect(c.exitPrice).toBeCloseTo(117.5);
  });

  it("averages the entries when the trade was scaled into", () => {
    // Long 2 @100, add 2 @110 → 4 @105 avg; closed at 102.
    const t = trade({ size: 2, exitPrice: 102, fills: [fill("add", 110, 2, "2026-08-03T09:40:00Z")] });
    const c = settlesTheSame(t);
    expect(c.size).toBe(4);
    expect(c.entryPrice).toBeCloseTo(105);
    expect(c.exitPrice).toBe(102);
    // Same dollars, but 1R is now measured on the position that actually
    // existed (4 @105 against the 90 stop = $60) rather than the planned $20.
    const after = computeMetrics(trade({ ...t, ...c, fills: [] }));
    expect(after.actualPnL).toBeCloseTo(-12);
    expect(after.riskDollars).toBeCloseTo(60);
    expect(after.actualR).toBeCloseTo(-0.2);
  });

  it("holds for a mixed sequence of adds and partials", () => {
    settlesTheSame(
      trade({
        size: 4,
        exitPrice: 121,
        pointValue: 20,
        fills: [
          fill("partial", 115, 2, "2026-08-03T10:00:00Z"),
          fill("add", 112, 3, "2026-08-03T10:30:00Z"),
          fill("partial", 118, 1, "2026-08-03T11:00:00Z"),
        ],
      }),
    );
  });

  it("holds for shorts and for quote-sized positions", () => {
    settlesTheSame(
      trade({
        direction: "short",
        size: 4,
        initialStop: 110,
        exitPrice: 88,
        fills: [fill("partial", 90, 2, "2026-08-03T10:00:00Z")],
      }),
    );
    const c = settlesTheSame(
      trade({
        sizeUnit: "quote",
        size: 5000,
        entryPrice: 50,
        initialStop: 45,
        exitPrice: 60,
        fills: [fill("partial", 55, 2750, "2026-08-03T10:00:00Z")],
      }),
    );
    // Notional must still divide by the new entry into the same 100 coins.
    expect(c.size / c.entryPrice).toBeCloseTo(100);
  });

  it("has nothing to collapse without fills or without an exit", () => {
    expect(collapseFills(trade())).toBeNull();
    expect(
      collapseFills(
        trade({ status: "open", exitPrice: null, fills: [fill("partial", 110, 1, "t")] }),
      ),
    ).toBeNull();
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

describe("suggestPartialSize", () => {
  const live = (over: Parameters<typeof trade>[0] = {}) =>
    trade({ status: "open", exitPrice: null, exitTime: null, ...over });

  it("splits what's on across the remaining TPs, whole contracts for futures", () => {
    // 4 NQ, 3 planned levels → 4/3 rounds to 1 contract.
    const t = live({ size: 4, pointValue: 20, extraTargets: "[140,150]" });
    expect(suggestPartialSize(t)).toBe(1);
  });

  it("recomputes from what actually remains after each partial", () => {
    // Took 1 already: 3 on, 2 levels left → 1.5 → 2.
    const t = live({
      size: 4,
      pointValue: 20,
      extraTargets: "[140,150]",
      fills: [fill("partial", 130, 1, "2026-08-03T10:00:00Z")],
    });
    expect(suggestPartialSize(t)).toBe(2);
  });

  it("goes quiet on the last planned level — that piece exits via Close", () => {
    expect(suggestPartialSize(live({ size: 4 }))).toBeNull(); // one TP only
  });

  it("splits coins fractionally and quote sizes in dollars at the level's price", () => {
    const coins = live({ size: 0.5, extraTargets: "[140]" });
    expect(suggestPartialSize(coins)).toBeCloseTo(0.25);
    // $5,000 @50 = 100 coins on, 2 levels → 50 coins at TP1 55 → $2,750.
    const usd = live({
      sizeUnit: "quote",
      size: 5000,
      entryPrice: 50,
      initialStop: 45,
      initialTarget: 55,
      extraTargets: "[60]",
    });
    expect(suggestPartialSize(usd)).toBe(2750);
  });

  it("won't suggest flattening a 1-lot", () => {
    expect(suggestPartialSize(live({ size: 1, pointValue: 20, extraTargets: "[140]" }))).toBeNull();
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
