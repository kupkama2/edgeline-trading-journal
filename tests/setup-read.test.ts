import { describe, expect, it } from "vitest";
import { impliedFees, normalizeSetupRead } from "../shared/setup-read";
import { SETUP_PROMPT } from "../server/prompts";

/**
 * The screenshot reader's answer, made safe to apply.
 *
 * The three venue views a trader actually screenshots — a positions tab, an
 * open-orders tab, a position-history card — each carry something the form
 * did not have a slot for: a size in USDT, a ladder of limit closes, an order
 * that has not filled, a net P&L with no fees beside it. The cases below are
 * those three screenshots, as the model should read them, and the ways it
 * can get them slightly wrong.
 */
describe("a positions-tab read", () => {
  // STRKUSDT 20x: size in USDT, "-- / 0.1016300", four limit closes.
  const strk = normalizeSetupRead({
    symbol: "STRKUSDT",
    direction: "long",
    entryPrice: 0.10518,
    initialStop: 0.10163,
    initialTarget: null,
    extraTargets: [0.11064, 0.10957, 0.11241, 0.11146],
    size: 5093.13,
    sizeUnit: "quote",
    isResting: false,
    isClosed: false,
  });

  it("keeps the size's unit, so 5,093 USDT is not 5,093 coins", () => {
    expect(strk.size).toBe(5093.13);
    expect(strk.sizeUnit).toBe("quote");
  });

  it("makes the nearest limit close the target and the rest the ladder, nearest first", () => {
    expect(strk.initialTarget).toBe(0.10957);
    expect(strk.extraTargets).toEqual([0.11064, 0.11146, 0.11241]);
  });

  it("drops a scale-out on the wrong side of the entry, and the first target again", () => {
    const r = normalizeSetupRead({
      direction: "short",
      entryPrice: 100,
      initialTarget: 90,
      extraTargets: [90, 95, 105, 80, 85],
    });
    expect(r.initialTarget).toBe(90);
    expect(r.extraTargets).toEqual([95, 85, 80]);
  });

  it("holds the ladder to what the form can take", () => {
    const r = normalizeSetupRead({ direction: "long", entryPrice: 1, initialTarget: 2, extraTargets: [3, 4, 5, 6, 7] });
    expect(r.extraTargets).toEqual([3, 4, 5]);
  });

  it("gives null, not an empty list, when there is no ladder", () => {
    expect(normalizeSetupRead({ extraTargets: [] }).extraTargets).toBeNull();
    expect(normalizeSetupRead({ extraTargets: "lots" }).extraTargets).toBeNull();
  });
});

describe("an open-orders read", () => {
  // SUIUSDT limit, 4,999.99 USDT, TP/SL 1.1415 / 0.9927, filled 0.00.
  const sui = normalizeSetupRead({
    symbol: "SUIUSDT",
    direction: "long",
    entryPrice: 1.0222,
    initialStop: 0.9927,
    initialTarget: 1.1415,
    entryTime: "2026-10-13T22:23:08",
    size: 4999.99,
    sizeUnit: "quote",
    isResting: true,
    isClosed: true, // a model slip: a resting order cannot also be finished
    exitPrice: 1.1,
  });

  it("is a pending trade, and a pending trade is never closed", () => {
    expect(sui.isResting).toBe(true);
    expect(sui.isClosed).toBe(false);
    expect(sui.exitPrice).toBeNull();
    expect(sui.exitReason).toBeNull();
  });

  it("keeps the levels the order was placed with", () => {
    expect(sui).toMatchObject({ entryPrice: 1.0222, initialStop: 0.9927, initialTarget: 1.1415, entryTime: "2026-10-13T22:23:08" });
  });
});

describe("a position-history read", () => {
  // BTCUSDT 150x long, closed vol 1.159, entry 81,381.35, avg close 83,012.12, PnL +1,755.6921.
  const btc = normalizeSetupRead({
    symbol: "BTCUSDT",
    direction: "long",
    entryPrice: 81381.35,
    entryTime: "2026-09-16T23:07:59",
    size: 1.159,
    sizeUnit: "base",
    isClosed: true,
    exitPrice: 83012.12,
    exitTime: "2026-10-09T20:57:52",
    exitReason: "other",
    realizedPnl: 1755.6921,
  });

  it("is closed, with the venue's net figure kept for the fees", () => {
    expect(btc.isClosed).toBe(true);
    expect(btc.realizedPnl).toBe(1755.6921);
    expect(btc.exitReason).toBe("other");
  });

  it("works the fees back from the net P&L, funding included", () => {
    expect(impliedFees({ direction: "long", entryPrice: 81381.35, exitPrice: 83012.12, size: 1.159, realizedPnl: 1755.6921 })).toBeCloseTo(134.37, 2);
    // WUSDT: 90,326.2 coins, 0.0276541 → 0.0264431, net −111.8323.
    expect(impliedFees({ direction: "long", entryPrice: 0.0276541, exitPrice: 0.0264431, size: 90326.2, realizedPnl: -111.8323 })).toBeCloseTo(2.45, 2);
    // A short, the same arithmetic mirrored.
    expect(impliedFees({ direction: "short", entryPrice: 100, exitPrice: 90, size: 2, realizedPnl: 19 })).toBe(1);
  });

  it("offers no fee when the arithmetic says the venue paid the trader, or took more than the move", () => {
    // Net larger than gross: the size or a price was misread.
    expect(impliedFees({ direction: "long", entryPrice: 100, exitPrice: 110, size: 1, realizedPnl: 12 })).toBeNull();
    // Fees larger than the whole move: a size read in the wrong unit.
    expect(impliedFees({ direction: "long", entryPrice: 100, exitPrice: 110, size: 5000, realizedPnl: 10 })).toBeNull();
  });

  it("forgets the net figure on anything that is not closed", () => {
    expect(normalizeSetupRead({ isClosed: false, realizedPnl: 50 }).realizedPnl).toBeNull();
    expect(normalizeSetupRead({ isClosed: true, exitPrice: null, realizedPnl: 50 }).isClosed).toBe(false);
  });
});

describe("the rest of the answer", () => {
  it("drops a target on the wrong side of the entry rather than booking a negative reward", () => {
    expect(normalizeSetupRead({ direction: "long", entryPrice: 100, initialTarget: 95 }).initialTarget).toBeNull();
    expect(normalizeSetupRead({ direction: "short", entryPrice: 100, initialTarget: 95 }).initialTarget).toBe(95);
  });

  it("reads only the two units the journal has, and nothing from junk", () => {
    expect(normalizeSetupRead({ sizeUnit: "quote" }).sizeUnit).toBe("quote");
    expect(normalizeSetupRead({ sizeUnit: "USDT" }).sizeUnit).toBeNull();
    expect(normalizeSetupRead(null).symbol).toBeNull();
    expect(normalizeSetupRead({ symbol: "  " }).symbol).toBeNull();
  });

  it("asks the model for exactly the fields it hands on", () => {
    // The JSON template in the prompt and the normaliser's output must name
    // the same keys, or a field is read and silently dropped on the way.
    const template = SETUP_PROMPT.match(/\{"symbol": string\|null[^\n]*\}/)?.[0] ?? "";
    const asked = Array.from(template.matchAll(/"([a-zA-Z]+)":/g)).map((m) => m[1]).sort();
    const given = Object.keys(normalizeSetupRead({})).sort();
    expect(asked).toEqual(given);
  });
});
