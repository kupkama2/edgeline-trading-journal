import { describe, expect, it } from "vitest";
import { trade } from "./helpers";
import { marketOf, mergePositions, positionsFromFills, readHistory, reconcile, type VenuePosition } from "../shared/reconcile";

/**
 * The venue's week against the journal's, on the screenshots that prompted it.
 *
 * Hyperliquid's Trade History is fills with their own direction words; the
 * WTIOIL rows below are the ones the person found missing from the journal.
 * Binance's Position History is one card per position; the four below were
 * logged by hand and left open.
 */
const local = (s: string) => new Date(s).toISOString();

describe("what a printed symbol names", () => {
  it("is the base, however the venue spells it", () => {
    expect(marketOf("STRKUSDT Perp")).toBe("STRK");
    expect(marketOf("WTIOIL xyz")).toBe("WTIOIL");
    expect(marketOf("xyz:WTIOIL")).toBe("WTIOIL");
    expect(marketOf("BTC-PERP")).toBe("BTC");
    expect(marketOf("USELESSUSDT")).toBe("USELESS");
    expect(marketOf("W")).toBe("W");
  });
});

describe("Hyperliquid fills, walked into positions", () => {
  // Newest first, as the venue prints them.
  const rows = [
    { symbol: "WTIOIL xyz", dir: "Close Long", price: 91.648, size: 219.211, time: local("2026-10-12T00:05:00"), closedPnl: 87.04 },
    { symbol: "WTIOIL xyz", dir: "Open Long", price: 91.244, size: 219.211, time: local("2026-10-11T21:41:30"), closedPnl: -1.73 },
    { symbol: "CASHCAT", dir: "Close Long", price: 0.10933, size: 6384, time: local("2026-10-11T02:29:54"), closedPnl: -2.26 },
    { symbol: "WTIOIL xyz", dir: "Close Long", price: 91.046, size: 550.414, time: local("2026-10-09T22:37:24"), closedPnl: 93.64 },
    { symbol: "WTIOIL xyz", dir: "Open Long", price: 90.875, size: 275.127, time: local("2026-10-09T22:13:19"), closedPnl: -2.16 },
    { symbol: "WTIOIL xyz", dir: "Open Long", price: 90.862, size: 275.287, time: local("2026-10-09T22:12:35"), closedPnl: -2.16 },
    { symbol: "WTIOIL xyz", dir: "Close Long", price: 90.763, size: 461.834, time: local("2026-10-09T21:41:57"), closedPnl: 176.31 },
  ];
  const ps = positionsFromFills(rows);

  it("finds the two WTIOIL longs, and leaves out closes whose opens are off the page", () => {
    expect(ps).toHaveLength(2);
    expect(ps.every((p) => marketOf(p.symbol) === "WTIOIL" && p.direction === "long" && p.closed)).toBe(true);
  });

  it("averages a position added to before it closed", () => {
    const [first] = ps;
    expect(first.size).toBeCloseTo(550.414);
    expect(first.entryPrice).toBeCloseTo((90.862 * 275.287 + 90.875 * 275.127) / 550.414, 6);
    expect(first.exitPrice).toBe(91.046);
    expect(first.entryTime).toBe(local("2026-10-09T22:12:35"));
    expect(first.realizedPnl).toBeCloseTo(93.64);
  });
});

describe("Binance cards against trades left open", () => {
  const cards: VenuePosition[] = readHistory({
    positions: [
      { symbol: "STRKUSDT", direction: "Cross Long", entryPrice: 0.1035246, exitPrice: 0.101646, size: 145876.9, sizeUnit: "base", entryTime: "2026-10-12T11:05:50", exitTime: "2026-10-12T15:12:15", realizedPnl: -284.7854 },
      { symbol: "WUSDT", direction: "Cross Long", entryPrice: 0.0276541, exitPrice: 0.0264431, size: 90326.2, sizeUnit: "base", entryTime: "2026-10-12T13:28:49", exitTime: "2026-10-12T13:51:58", realizedPnl: -111.8323 },
      { symbol: "BTCUSDT", direction: "Cross Long", entryPrice: 81381.35, exitPrice: 83012.12, size: 1.159, sizeUnit: "base", entryTime: "2026-09-16T23:07:59", exitTime: "2026-10-09T20:57:52", realizedPnl: 1755.6921 },
      { symbol: "ETHUSDT", direction: "Short", entryPrice: 2500, exitPrice: 2400, size: 1, entryTime: "2026-10-10T10:00:00", exitTime: "2026-10-10T12:00:00", realizedPnl: 100 },
    ],
  });
  const journal = [
    // STRK logged on the way in at the first fill, ten minutes off, still open.
    trade({ id: 1, symbol: "STRK", account: "Binance", entryPrice: 0.10518, entryTime: local("2026-10-12T11:15:00"), status: "open", exitPrice: null, exitTime: null }),
    // W logged, and closed — at a different exit.
    trade({ id: 2, symbol: "W", account: "Binance", entryPrice: 0.02765, entryTime: local("2026-10-12T13:29:00"), exitPrice: 0.0270, exitTime: local("2026-10-12T13:50:00") }),
    // BTC logged and closed at the venue's exit, give or take rounding.
    trade({ id: 3, symbol: "BTC", account: "Binance", entryPrice: 81381, entryTime: local("2026-09-16T23:10:00"), exitPrice: 83012, exitTime: local("2026-10-09T20:58:00") }),
    // A SOL trade the venue has no record of in this stretch.
    trade({ id: 4, symbol: "SOL", account: "Binance", entryPrice: 150, entryTime: local("2026-10-11T09:00:00"), exitPrice: 155 }),
    // The same market on another account is not this screenshot's.
    trade({ id: 5, symbol: "ETH", account: "Hyperliquid", direction: "short", entryPrice: 2500, entryTime: local("2026-10-10T10:00:00"), exitPrice: 2400 }),
  ];
  const { rows, journalOnly } = reconcile(cards, journal, { account: "Binance" });
  const verdictOf = (sym: string) => rows.find((r) => marketOf(r.venue.symbol) === sym);

  it("finds the open one to close, the one whose exit differs, and the one that matches", () => {
    expect(verdictOf("STRK")).toMatchObject({ verdict: "close-it", trade: expect.objectContaining({ id: 1 }) });
    expect(verdictOf("W")).toMatchObject({ verdict: "exit-differs", trade: expect.objectContaining({ id: 2 }) });
    expect(verdictOf("W")!.exitDrift).toBeGreaterThan(0.002);
    expect(verdictOf("BTC")).toMatchObject({ verdict: "matches", trade: expect.objectContaining({ id: 3 }) });
  });

  it("says what the venue has that the account's journal does not", () => {
    expect(verdictOf("ETH")).toMatchObject({ verdict: "not-logged", trade: null });
  });

  it("says what the account's journal has that the venue does not", () => {
    expect(journalOnly.map((t) => t.id)).toEqual([4]);
  });

  it("never matches across sides, or two venue positions to one trade", () => {
    const twice = reconcile([cards[2], { ...cards[2], entryTime: local("2026-09-16T23:30:00") }], journal, { account: "Binance" });
    expect(twice.rows.filter((r) => r.trade?.id === 3)).toHaveLength(1);
    const flipped = reconcile([{ ...cards[2], direction: "short" }], journal, { account: "Binance" });
    expect(flipped.rows[0].verdict).toBe("not-logged");
  });

  it("matches on the entry price when the screenshot shows no times", () => {
    const noTime = reconcile([{ ...cards[2], entryTime: null, exitTime: null }], journal, { account: "Binance" });
    expect(noTime.rows[0]).toMatchObject({ verdict: "matches", trade: expect.objectContaining({ id: 3 }) });
  });

  it("reads one position from two overlapping screenshots once", () => {
    expect(mergePositions(cards, cards.slice(1))).toHaveLength(cards.length);
  });
});
