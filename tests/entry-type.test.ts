import { describe, expect, it } from "vitest";
import { entryTypeOf } from "../shared/entry-type";
import { entryEdge, MIN_PER_SIDE } from "../shared/entry-edge";
import { byEntryType } from "../shared/breakdowns";
import { parseUserFills, tradesFromFills } from "../shared/hyperliquid";
import { fillsFromUserTrades, parseUserTrades } from "../shared/binance-account";
import { asInsert, claimPatch, closingPatch } from "../server/venue-sync";
import { trade } from "./helpers";

/**
 * How a trade was entered: a limit that rested, or a market entry that took
 * liquidity. Read from the venue's maker/taker flag on the entry order's
 * fills, and compared head to head with the noise a sample that size has.
 */
describe("the entry type from the fills", () => {
  it("is the entry order's: the side of the book most of its size filled on", () => {
    expect(entryTypeOf([{ sz: 1, maker: true, oid: 7 }])).toBe("limit");
    expect(entryTypeOf([{ sz: 1, maker: false, oid: 7 }])).toBe("market");
    // A limit that crossed for a sliver and rested for the rest is a limit entry.
    expect(entryTypeOf([{ sz: 0.2, maker: false, oid: 7 }, { sz: 0.8, maker: true, oid: 7 }])).toBe("limit");
    // A market order sweeping two levels is two taker fills under one id.
    expect(entryTypeOf([{ sz: 0.5, maker: false, oid: 7 }, { sz: 0.5, maker: false, oid: 7 }])).toBe("market");
  });

  it("leaves the adds out: a market scale-in onto a limit entry is still a limit entry", () => {
    expect(entryTypeOf([{ sz: 1, maker: true, oid: 7 }, { sz: 5, maker: false, oid: 8 }])).toBe("limit");
    // No order ids: the first fill alone decides.
    expect(entryTypeOf([{ sz: 1, maker: false }, { sz: 5, maker: true }])).toBe("market");
  });

  it("says nothing when the fills do not", () => {
    expect(entryTypeOf([])).toBeNull();
    expect(entryTypeOf([{ sz: 1, maker: null, oid: 7 }, { sz: 1, oid: 7 }])).toBeNull();
  });

  it("reads Hyperliquid's `crossed` and Binance's `maker`", () => {
    const hl = parseUserFills([
      { coin: "BTC", px: "80000", sz: "0.5", side: "B", time: 1, startPosition: "0", dir: "Open Long", closedPnl: "0", fee: "0.1", tid: 1, oid: 10, crossed: false },
      { coin: "BTC", px: "81000", sz: "0.5", side: "A", time: 2, startPosition: "0.5", dir: "Close Long", closedPnl: "500", fee: "0.1", tid: 2, oid: 11, crossed: true },
      { coin: "ETH", px: "3000", sz: "1", side: "B", time: 3, startPosition: "0", dir: "Open Long", closedPnl: "0", fee: "0.1", tid: 3, oid: 12 },
    ]);
    expect(hl.map((f) => f.maker)).toEqual([true, false, null]);
    const bn = parseUserTrades([
      { symbol: "ETHUSDT", id: 1, orderId: 5, side: "SELL", price: "3000", qty: "2", realizedPnl: "0", commission: "1", commissionAsset: "USDT", time: 1, maker: false },
      { symbol: "ETHUSDT", id: 2, orderId: 6, side: "BUY", price: "2900", qty: "2", realizedPnl: "200", commission: "1", commissionAsset: "USDT", time: 2, maker: true },
      { symbol: "ETHUSDT", id: 3, orderId: 7, side: "SELL", price: "2950", qty: "1", realizedPnl: "0", commission: "1", commissionAsset: "USDT", time: 3 },
    ]);
    expect(bn.map((r) => r.maker)).toEqual([false, true, null]);
    // Carried into the fills the position reader builds from.
    const { fills } = fillsFromUserTrades(bn.slice(0, 2), new Map());
    expect(fills.map((f) => f.maker)).toEqual([false, true]);
  });

  it("is written by the venue sync, and fills a blank on a trade written before, never over one", () => {
    const fills = parseUserFills([
      { coin: "SOL", px: "150", sz: "10", side: "B", time: 1000, startPosition: "0", dir: "Open Long", closedPnl: "0", fee: "0.1", tid: 41, oid: 9, crossed: false },
      { coin: "SOL", px: "160", sz: "10", side: "A", time: 2000, startPosition: "10", dir: "Close Long", closedPnl: "100", fee: "0.1", tid: 42, oid: 10, crossed: true },
    ]);
    const [t] = tradesFromFills(fills, "hl").trades;
    expect(asInsert(t, "Main", { initialStop: null, initialTarget: null }).entryType).toBe("limit");

    const levels = { initialStop: null, initialTarget: null };
    const blank = trade({ status: "closed", entryType: null, externalId: t.externalId });
    expect(closingPatch(blank, t, levels)).toMatchObject({ entryType: "limit" });
    const set = trade({ status: "closed", entryType: "market", externalId: t.externalId });
    expect(closingPatch(set, t, levels)?.entryType).toBeUndefined();
    // A hand-logged trade the sync claims gets it too, where the person said nothing.
    expect(claimPatch(trade({ status: "closed", entryType: null }), t, levels).entryType).toBe("limit");
    expect(claimPatch(trade({ status: "closed", entryType: "market" }), t, levels).entryType).toBeUndefined();
  });
});

describe("limit against market", () => {
  // Exit 120 on entry 100 with stop 90 is +2R; exit 85 is −1.5R; exit 100 is 0R.
  const at = (r: "win" | "loss" | "flat", entryType: "limit" | "market" | null) =>
    trade({ entryType, exitPrice: r === "win" ? 120 : r === "loss" ? 85 : 100 });

  it("splits the closed trades three ways, the unknown row last", () => {
    const rows = byEntryType([at("win", "market"), at("win", "limit"), at("loss", null), trade({ status: "open", exitPrice: null, entryType: "limit" })]);
    expect(rows.map((r) => [r.key, r.label, r.count])).toEqual([
      ["limit", "Limit", 1],
      ["market", "Market", 1],
      ["", "Not recorded", 1],
    ]);
  });

  it("will not call it on a handful of trades", () => {
    const e = entryEdge([at("win", "limit"), at("win", "limit"), at("loss", "market")]);
    expect(e.verdict).toBe("too-few");
    expect(e.better).toBe("limit");
    expect(e.limit.expectancyR).toBeCloseTo(2, 9);
    expect(e.market.expectancyR).toBeCloseTo(-1.5, 9);
  });

  it("calls a gap clear when it is more than twice the noise, and not when it is inside it", () => {
    const n = MIN_PER_SIDE + 4;
    // Limits win three in four, markets one in four: a wide gap with modest spread.
    const limits = Array.from({ length: n }, (_, i) => at(i % 4 === 0 ? "loss" : "win", "limit"));
    const markets = Array.from({ length: n }, (_, i) => at(i % 4 === 0 ? "win" : "loss", "market"));
    const clear = entryEdge([...limits, ...markets]);
    expect(clear.verdict).toBe("clear");
    expect(clear.better).toBe("limit");
    expect(clear.diffR).toBeGreaterThan(2 * clear.seDiffR);

    // The same mix on both sides, one trade apart: within the noise.
    const mixed = (t: "limit" | "market", extraWin: boolean) => [
      ...Array.from({ length: n }, (_, i) => at(i % 2 ? "win" : "loss", t)),
      ...(extraWin ? [at("win", t)] : [at("loss", t)]),
    ];
    const close = entryEdge([...mixed("limit", true), ...mixed("market", false)]);
    expect(close.verdict).toBe("no-difference");
    expect(close.unknown).toBe(0);
  });

  it("counts the limit orders that never filled, and which of them would have won", () => {
    const e = entryEdge([
      at("win", "limit"),
      trade({ status: "cancelled", cancelReason: "not_filled", exitPrice: null, wouldHaveHitTarget: true }),
      trade({ status: "cancelled", cancelReason: "not_filled", exitPrice: null, wouldHaveHitTarget: false, entryType: "limit" }),
      trade({ status: "cancelled", cancelReason: "not_filled", exitPrice: null }),
      // Pulled by hand is not a missed fill; a market order fills.
      trade({ status: "cancelled", cancelReason: "pulled", exitPrice: null }),
      trade({ status: "cancelled", cancelReason: "not_filled", exitPrice: null, entryType: "market" }),
    ]);
    expect(e).toMatchObject({ unfilled: 3, unfilledResolved: 2, unfilledWouldHaveWon: 1 });
  });
});
