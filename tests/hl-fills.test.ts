import { describe, expect, it } from "vitest";
import {
  hlCoinFor,
  isWalletAddress,
  levelsFromOrders,
  parseAllMids,
  parseCandleSnapshot,
  parseFundingHistory,
  parseHistoricalOrders,
  parseUserFills,
  tradesFromFills,
  type HlFill,
} from "../shared/hyperliquid";

/**
 * Fills into trades.
 *
 * The cases that matter are the ones where a fill is not simply "a trade":
 * an add that moves the average, a partial that does not close, a flip
 * that closes one side and opens the other in a single print, a position
 * that was already open before the record begins, and a record with a
 * hole in it. Each has one honest answer, and one tempting wrong one.
 */

let tid = 0;
const fill = (
  coin: string,
  side: "B" | "A",
  sz: number,
  px: number,
  startPosition: number,
  time: number,
  extra: Partial<HlFill> = {},
): HlFill => ({
  coin,
  side,
  sz,
  px,
  startPosition,
  time,
  dir: "",
  closedPnl: 0,
  fee: 0,
  tid: ++tid,
  oid: 0,
  ...extra,
});

describe("reading fills", () => {
  it("reads the venue's strings as numbers and orders by time", () => {
    const fills = parseUserFills([
      { coin: "ETH", px: "2000.5", sz: "1.5", side: "B", time: 200, startPosition: "0.0", dir: "Open Long", closedPnl: "0.0", fee: "1.2", tid: 7, oid: 3 },
      { coin: "ETH", px: "2100", sz: "1.5", side: "A", time: 100, startPosition: "1.5", closedPnl: "150", fee: "1.3", tid: 8, oid: 4 },
    ]);
    expect(fills.map((f) => f.tid)).toEqual([8, 7]);
    expect(fills[1]).toMatchObject({ px: 2000.5, sz: 1.5, side: "B", fee: 1.2, startPosition: 0 });
  });

  it("skips what it cannot read and keeps the rest", () => {
    const fills = parseUserFills([
      { coin: "ETH", px: "x", sz: "1", side: "B", time: 1, startPosition: "0", tid: 1 },
      { coin: "", px: "1", sz: "1", side: "B", time: 1, startPosition: "0", tid: 2 },
      { coin: "ETH", px: "1", sz: "1", side: "buy", time: 1, startPosition: "0", tid: 3 },
      { coin: "ETH", px: "1", sz: "1", side: "B", time: 1, startPosition: "0", tid: 4 },
    ]);
    expect(fills.map((f) => f.tid)).toEqual([4]);
    expect(parseUserFills(null)).toEqual([]);
    expect(parseUserFills({ fills: [] })).toEqual([]);
  });
});

describe("fills into trades", () => {
  it("weights the entry over adds and the exit over partials", () => {
    const { trades, unreconstructed } = tradesFromFills([
      fill("ETH", "B", 1.0, 2000, 0, 1000, { fee: 0.5, tid: 1 }),
      fill("ETH", "B", 0.5, 2010, 1.0, 2000, { fee: 0.25 }),
      fill("ETH", "A", 0.5, 2050, 1.5, 3000, { fee: 0.3, closedPnl: 25 }),
      fill("ETH", "A", 1.0, 2100, 1.0, 4000, { fee: 0.6, closedPnl: 100 }),
    ]);
    expect(unreconstructed).toEqual([]);
    expect(trades).toHaveLength(1);
    const t = trades[0];
    expect(t.direction).toBe("long");
    expect(t.status).toBe("closed");
    expect(t.size).toBeCloseTo(1.5);
    expect(t.entryPrice).toBeCloseTo((2000 * 1 + 2010 * 0.5) / 1.5);
    expect(t.exitPrice).toBeCloseTo((2050 * 0.5 + 2100 * 1) / 1.5);
    expect(t.entryTime).toBe(1000);
    expect(t.exitTime).toBe(4000);
    expect(t.fees).toBeCloseTo(1.65);
    expect(t.closedPnl).toBe(125);
    expect(t.externalId).toBe("hl:ETH:1");
    expect(t.opens).toHaveLength(2);
    expect(t.closes).toHaveLength(2);
  });

  it("splits a flip into the close of one trade and the open of the next", () => {
    const { trades } = tradesFromFills([
      fill("BTC", "B", 1, 100, 0, 1000, { tid: 10 }),
      fill("BTC", "A", 3, 110, 1, 2000, { tid: 11, fee: 3, closedPnl: 10 }),
      fill("BTC", "B", 2, 105, -2, 3000, { tid: 12, closedPnl: 10 }),
    ]);
    expect(trades).toHaveLength(2);
    const [long, short] = trades;
    expect(long).toMatchObject({ direction: "long", size: 1, entryPrice: 100, exitPrice: 110, status: "closed", externalId: "hl:BTC:10", closedPnl: 10 });
    // The flip's fee is shared pro rata: a third closed the long, two thirds opened the short.
    expect(long.fees).toBeCloseTo(1);
    expect(short).toMatchObject({ direction: "short", size: 2, entryPrice: 110, exitPrice: 105, status: "closed", externalId: "hl:BTC:11", closedPnl: 10 });
    expect(short.fees).toBeCloseTo(2);
    expect(short.entryTime).toBe(2000);
    expect(short.exitTime).toBe(3000);
  });

  it("leaves a position that has not closed open, without an exit", () => {
    const { trades } = tradesFromFills([fill("SOL", "A", 5, 200, 0, 1000)]);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ direction: "short", size: 5, status: "open", exitPrice: null, exitTime: null });
  });

  it("refuses to invent an entry for a position older than the record", () => {
    /*
     * The first fill says the position was already 100 before it. The entry
     * is not in these fills, so nothing honest can be written: the close is
     * reported as unreconstructable, and the fresh position after it is a
     * trade like any other.
     */
    const { trades, unreconstructed } = tradesFromFills([
      fill("DOGE", "A", 100, 0.2, 100, 1000),
      fill("DOGE", "B", 50, 0.19, 0, 2000),
    ]);
    expect(unreconstructed).toEqual([{ coin: "DOGE", fills: 1 }]);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ direction: "long", size: 50, status: "open" });
  });

  it("drops a trade the venue's own ledger says has fills missing", () => {
    // Opened 2, but the next fill says the position was 5 before it.
    const { trades, unreconstructed } = tradesFromFills([
      fill("LINK", "B", 2, 10, 0, 1000),
      fill("LINK", "A", 5, 12, 5, 2000),
    ]);
    expect(trades).toEqual([]);
    expect(unreconstructed).toEqual([{ coin: "LINK", fills: 2 }]);
  });

  it("keeps coins apart and returns trades oldest first", () => {
    const { trades } = tradesFromFills([
      fill("ETH", "B", 1, 2000, 0, 5000),
      fill("BTC", "B", 1, 100, 0, 1000),
      fill("BTC", "A", 1, 110, 1, 2000),
      fill("ETH", "A", 1, 2100, 1, 6000),
    ]);
    expect(trades.map((t) => t.coin)).toEqual(["BTC", "ETH"]);
  });

  it("ignores a fill of nothing", () => {
    expect(tradesFromFills([fill("ETH", "B", 0, 2000, 0, 1000)]).trades).toEqual([]);
  });
});

describe("the stop and target, read off the order history", () => {
  const HOUR = 3_600_000;
  const long = { coin: "ETH", direction: "long" as const, entryPrice: 2000, entryTime: 10 * HOUR, exitTime: 50 * HOUR };
  const order = (over: Record<string, unknown>) => ({
    order: {
      coin: "ETH",
      oid: 1,
      side: "A",
      isTrigger: true,
      triggerPx: "1950",
      orderType: "Stop Market",
      reduceOnly: true,
      timestamp: 12 * HOUR,
      ...over,
    },
    status: "open",
    statusTimestamp: 12 * HOUR,
  });

  it("takes the earliest reduce-only stop below and take-profit above a long", () => {
    const orders = parseHistoricalOrders([
      order({ oid: 1, triggerPx: "1950", orderType: "Stop Market", timestamp: 12 * HOUR }),
      order({ oid: 2, triggerPx: "2200", orderType: "Take Profit Market", isPositionTpsl: true, reduceOnly: false, timestamp: 13 * HOUR }),
      // Moved later: management, not the plan.
      order({ oid: 3, triggerPx: "1990", orderType: "Stop Market", timestamp: 30 * HOUR }),
    ]);
    expect(levelsFromOrders(long, orders)).toEqual({ initialStop: 1950, initialTarget: 2200 });
  });

  it("ignores what cannot be this trade's stop", () => {
    const orders = parseHistoricalOrders([
      // Wrong side of the entry for a long's stop.
      order({ oid: 1, triggerPx: "2100", orderType: "Stop Market" }),
      // Placed long before the entry.
      order({ oid: 2, triggerPx: "1900", orderType: "Stop Market", timestamp: 1 * HOUR }),
      // Placed after the exit.
      order({ oid: 3, triggerPx: "1900", orderType: "Stop Market", timestamp: 60 * HOUR }),
      // Another coin.
      order({ oid: 4, coin: "BTC", triggerPx: "1900", orderType: "Stop Market" }),
      // Not a trigger at all.
      order({ oid: 5, isTrigger: false, triggerPx: null, orderType: "Limit" }),
      // Would ADD to the position, not reduce it.
      order({ oid: 6, side: "B", reduceOnly: false, triggerPx: "1900", orderType: "Stop Market" }),
    ]);
    expect(levelsFromOrders(long, orders)).toEqual({ initialStop: null, initialTarget: null });
  });

  it("mirrors the sides for a short, and reads while the trade is still open", () => {
    const short = { ...long, direction: "short" as const, exitTime: null };
    const orders = parseHistoricalOrders([
      order({ oid: 1, side: "B", triggerPx: "2050", orderType: "Stop Limit", timestamp: 12 * HOUR }),
      order({ oid: 2, side: "B", triggerPx: "1800", orderType: "Take Profit Limit", timestamp: 90 * HOUR }),
    ]);
    expect(levelsFromOrders(short, orders)).toEqual({ initialStop: 2050, initialTarget: 1800 });
  });
});

describe("the rest of the venue's answers", () => {
  it("reads a candle snapshot in time order", () => {
    const bars = parseCandleSnapshot([
      { t: 2000, T: 2999, s: "ETH", i: "1m", o: "10", c: "11", h: "12", l: "9", v: "1", n: 1 },
      { t: 1000, T: 1999, s: "ETH", i: "1m", o: "9", c: "10", h: "10.5", l: "8.5", v: "1", n: 1 },
      { t: 3000, o: "bad" },
    ]);
    expect(bars).toEqual([
      { t: 1000, o: 9, h: 10.5, l: 8.5, c: 10 },
      { t: 2000, o: 10, h: 12, l: 9, c: 11 },
    ]);
  });

  it("reads funding history and the mids", () => {
    expect(parseFundingHistory([{ coin: "ETH", fundingRate: "0.0000125", premium: "0", time: 5 }, { time: 1, fundingRate: "-0.00001" }])).toEqual([
      { time: 1, rate: -0.00001 },
      { time: 5, rate: 0.0000125 },
    ]);
    expect(parseAllMids({ BTC: "110000.5", ETH: "4300", BAD: "x", ZERO: "0" })).toEqual({ BTC: 110000.5, ETH: 4300 });
    expect(parseAllMids([1, 2])).toEqual({});
  });

  it("finds the venue's spelling of a journal symbol", () => {
    const names = ["BTC", "kPEPE", "HYPE"];
    expect(hlCoinFor("BTC", names)).toBe("BTC");
    expect(hlCoinFor("btc", names)).toBe("BTC");
    expect(hlCoinFor("KPEPE", names)).toBe("kPEPE");
    expect(hlCoinFor("1000PEPE", names)).toBe("kPEPE");
    expect(hlCoinFor("PEPE", names)).toBeNull();
    expect(hlCoinFor("", names)).toBeNull();
  });

  it("knows what a wallet address looks like", () => {
    expect(isWalletAddress("0x" + "ab".repeat(20))).toBe(true);
    expect(isWalletAddress("0x" + "ab".repeat(19))).toBe(false);
    expect(isWalletAddress("ab".repeat(21))).toBe(false);
    expect(isWalletAddress(null)).toBe(false);
  });
});
