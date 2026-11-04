import { describe, expect, it } from "vitest";
import { cutAtFlat, reconcilePatch, type TerminalRef, type VenueSnapshot } from "../shared/terminal";

/** The venue's word applied to the trade, at the edges the review found. */
const ref: TerminalRef = {
  venue: "binance", env: "live", account: "A", symbol: "BTCUSDT", positionSide: "LONG", tag: "edg-1", leverage: 2, qty: 1,
  entryOrderId: 10, stopOrderId: 20, targetOrderIds: [30], closeOrderIds: [], addOrderIds: [40],
};
const fill = (tid: number, orderId: number, side: "BUY" | "SELL", qty: number, price: number, time: number, foreign = false) => ({
  tid, orderId, side, qty, price, time, commission: 0.1, commissionUsd: true, realizedPnl: 0, foreign,
});

describe("reconcilePatch at the edges", () => {
  it("opens a resting entry that filled in part before it was pulled, for the part that filled", () => {
    const snap: VenueSnapshot = { entry: { status: "CANCELED", avgPrice: 100, executedQty: 0.4, updateTime: 1_000 }, fills: [fill(1, 10, "BUY", 0.4, 100, 1_000)], positionAmt: 0.4, openOrderIds: [] };
    const r = reconcilePatch({ status: "pending", entryPrice: 100, size: 1, fees: null }, ref, snap);
    expect(r.patch).toMatchObject({ status: "open", size: 0.4, entryPrice: 100 });
    // Pulled with nothing filled: cancelled, as before.
    const none = reconcilePatch({ status: "pending", entryPrice: 100, size: 1, fees: null }, ref, { ...snap, fills: [], positionAmt: 0 });
    expect(none.patch).toMatchObject({ status: "cancelled" });
  });

  it("never lowers fees when the window no longer shows the entry, and counts fills the ledger remembers", () => {
    // The entry and an add have aged out of the week; the ledger holds the add (1.0). A take of 1.0 today is a partial, not the exit.
    const snap: VenueSnapshot = { entry: null, fills: [fill(5, 50, "SELL", 1, 110, 9_000)], positionAmt: 1, openOrderIds: [] };
    const r = reconcilePatch({ status: "open", entryPrice: 100, size: 1, fees: 1.23 }, ref, snap, { adds: [{ tid: 2, qty: 1 }], partials: [] });
    expect(r.patch?.fees).toBeUndefined();
    expect(r.partials).toHaveLength(1);
    expect(r.patch?.status).toBeUndefined();
    // Without the ledger the same take would have read as the exit of a 1.0 position.
    const bare = reconcilePatch({ status: "open", entryPrice: 100, size: 1, fees: 1.23 }, ref, { ...snap, positionAmt: 0 });
    expect(bare.patch?.status).toBe("closed");
    // And a window with no own fills at all touches nothing.
    const empty = reconcilePatch({ status: "open", entryPrice: 100, size: 1, fees: 1.23 }, ref, { entry: null, fills: [], positionAmt: 1, openOrderIds: [] });
    expect(empty.patch).toBeNull();
  });

  it("leaves a tracked trade's exit reason to the prices, not to order ids it cannot know", () => {
    const tracked: TerminalRef = { ...ref, tracked: true, moves: [{ at: "2026-01-01T00:00:00Z", kind: "stop", from: 90, to: 100 }] };
    const snap: VenueSnapshot = { entry: null, fills: [fill(1, 10, "BUY", 1, 100, 1_000), fill(2, 77, "SELL", 1, 115, 2_000)], positionAmt: 0, openOrderIds: [] };
    const r = reconcilePatch({ status: "open", entryPrice: 100, size: 1, fees: null, direction: "long", stopMoves: JSON.stringify([{ at: "x", price: 100 }]) }, tracked, snap);
    expect(r.patch?.status).toBe("closed");
    expect(r.patch?.exitPrice).toBe(115);
    expect(r.patch?.exitReason).toBeUndefined();
  });
});

describe("a position cut where it first went flat", () => {
  it("keeps the fills up to the flat and says a cut was made, so a reopen is the next trade's", () => {
    const fills = [
      { tid: 1, time: 1, qty: 1, side: "BUY" },
      { tid: 2, time: 2, qty: 0.5, side: "SELL" },
      { tid: 3, time: 3, qty: 0.5, side: "SELL" },
      { tid: 4, time: 4, qty: 1, side: "BUY" },
      { tid: 5, time: 5, qty: 1, side: "SELL" },
    ];
    const r = cutAtFlat(fills, "BUY");
    expect(r.fills.map((f) => f.tid)).toEqual([1, 2, 3]);
    expect(r.cut).toBe(true);
    const still = cutAtFlat(fills.slice(0, 2), "BUY");
    expect(still.cut).toBe(false);
    expect(still.fills).toHaveLength(2);
  });
});
