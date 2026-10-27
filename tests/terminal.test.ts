import { describe, expect, it } from "vitest";
import {
  decimalsOf,
  fmtPrice,
  fmtQty,
  ordersForPlan,
  planProblems,
  reconcilePatch,
  rulesFromExchangeInfo,
  sizePlan,
  tradingKeyRefusal,
  type SymbolRules,
  type TerminalPlan,
  type TerminalRef,
} from "../shared/terminal";
import { parseRestrictions } from "../shared/binance-account";
import { streamUrl, worthAReadBack } from "../server/binance-stream";
import { parseAlgoOrder } from "../server/binance-trade";
import { advancePlanWatch, managementBrief, managementTimeline, parseManagementReview, planTouches, planVerdictOf, rAt } from "../shared/terminal";

/**
 * The terminal, the half that can be wrong without a venue: what a plan
 * becomes on the wire, and what the venue's answer becomes in the journal.
 */

const BTC: SymbolRules = {
  symbol: "BTCUSDT",
  baseAsset: "BTC",
  tickSize: 0.1,
  stepSize: 0.001,
  minQty: 0.001,
  minNotional: 100,
  pricePrecision: 2,
  quantityPrecision: 3,
};

const long: TerminalPlan = {
  symbol: "BTCUSDT",
  side: "long",
  entryType: "limit",
  entryPrice: 80000,
  stop: 79000,
  targets: [82500],
  riskDollars: 50,
  leverage: 5,
};

describe("the symbol's rules", () => {
  it("reads tick, step and minimums off exchangeInfo, perpetuals only", () => {
    const rules = rulesFromExchangeInfo({
      symbols: [
        {
          symbol: "BTCUSDT", baseAsset: "BTC", status: "TRADING", contractType: "PERPETUAL", pricePrecision: 2, quantityPrecision: 3,
          filters: [
            { filterType: "PRICE_FILTER", tickSize: "0.10" },
            { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
            { filterType: "MIN_NOTIONAL", notional: "100" },
          ],
        },
        { symbol: "BTCUSDT_250926", status: "TRADING", contractType: "CURRENT_QUARTER", filters: [] },
        { symbol: "OLDUSDT", status: "SETTLING", contractType: "PERPETUAL", filters: [] },
      ],
    });
    expect(rules.map((r) => r.symbol)).toEqual(["BTCUSDT"]);
    expect(rules[0]).toMatchObject({ tickSize: 0.1, stepSize: 0.001, minQty: 0.001, minNotional: 100 });
  });

  it("writes prices on the tick and quantities down to the step", () => {
    expect(decimalsOf(0.001)).toBe(3);
    expect(decimalsOf(1)).toBe(0);
    expect(decimalsOf(0.00001)).toBe(5);
    expect(fmtPrice(80000.04, BTC)).toBe("80000.0");
    expect(fmtPrice(80000.06, BTC)).toBe("80000.1");
    // Down, never up: a rounded-up size risks more than was asked.
    expect(fmtQty(0.0519, BTC)).toBe("0.051");
    expect(fmtQty(0.05, BTC)).toBe("0.050");
  });
});

describe("sizing a plan", () => {
  it("turns dollars at risk into a quantity on the step, and reports what that risks", () => {
    const s = sizePlan(long, BTC);
    // $50 over a $1000 stop is 0.05 BTC exactly.
    expect(s.qty).toBe("0.050");
    expect(s.riskDollars).toBeCloseTo(50);
    expect(s.notional).toBeCloseTo(4000);
    expect(s.margin).toBeCloseTo(800);
    expect(s.problems).toEqual([]);
  });

  it("takes a quantity as given when one is typed", () => {
    const s = sizePlan({ ...long, riskDollars: null, qty: 0.0123 }, BTC);
    expect(s.qty).toBe("0.012");
    expect(s.riskDollars).toBeCloseTo(12);
  });

  it("refuses a size under the venue's minimums rather than sending it", () => {
    expect(sizePlan({ ...long, riskDollars: 0.5 }, BTC).problems[0]).toMatch(/smallest size/);
    expect(sizePlan({ ...long, riskDollars: null, qty: 0.001 }, BTC).problems[0]).toMatch(/notional/);
  });

  it("knows which side of the entry a stop and a target belong on", () => {
    expect(planProblems({ ...long, stop: 81000 })[0]).toMatch(/stop has to be below/);
    expect(planProblems({ ...long, targets: [79500] })[0]).toMatch(/targets have to be above/);
    expect(planProblems({ ...long, side: "short", stop: 79000, targets: [78000] })[0]).toMatch(/stop has to be above/);
    expect(planProblems({ ...long, leverage: 0 })[0]).toMatch(/Leverage/);
    expect(planProblems({ ...long, riskDollars: null, qty: null })[0]).toMatch(/how big/);
    expect(planProblems(long)).toEqual([]);
  });
});

describe("what a plan becomes on the wire", () => {
  it("is a stop, an entry and a target, each on the position side, the stop closing the whole side", () => {
    const o = ordersForPlan(long, BTC, "0.050", "edg-1");
    expect(o.positionSide).toBe("LONG");
    expect(o.stop).toEqual({
      symbol: "BTCUSDT", positionSide: "LONG", side: "SELL", type: "STOP_MARKET", stopPrice: "79000.0",
      closePosition: "true", workingType: "MARK_PRICE", priceProtect: "TRUE", newClientOrderId: "edg-1-s",
    });
    expect(o.entry).toEqual({
      symbol: "BTCUSDT", positionSide: "LONG", side: "BUY", type: "LIMIT", timeInForce: "GTC", quantity: "0.050", price: "80000.0", newClientOrderId: "edg-1-e",
    });
    expect(o.targets).toEqual([
      {
        symbol: "BTCUSDT", positionSide: "LONG", side: "SELL", type: "TAKE_PROFIT_MARKET", stopPrice: "82500.0",
        workingType: "MARK_PRICE", priceProtect: "TRUE", newClientOrderId: "edg-1-t1", closePosition: "true",
      },
    ]);
  });

  it("sends a market entry without a price, and a short with the sides swapped", () => {
    const o = ordersForPlan({ ...long, side: "short", entryType: "market", stop: 81000, targets: [78000] }, BTC, "0.050", "edg-2");
    expect(o.entry).toMatchObject({ side: "SELL", type: "MARKET", positionSide: "SHORT", quantity: "0.050" });
    expect(o.entry.price).toBeUndefined();
    expect(o.stop).toMatchObject({ side: "BUY", positionSide: "SHORT", stopPrice: "81000.0" });
    expect(o.targets[0]).toMatchObject({ side: "BUY", stopPrice: "78000.0" });
  });

  it("splits several targets by quantity and lets the last one close what is left", () => {
    const o = ordersForPlan({ ...long, targets: [81000, 82000, 83000] }, BTC, "0.050", "edg-3");
    // No reduceOnly anywhere: hedge mode refuses it on an order that names its side.
    expect(o.targets.map((t) => [t.stopPrice, t.quantity ?? null, t.closePosition ?? null, t.reduceOnly ?? null])).toEqual([
      ["81000.0", "0.016", null, null],
      ["82000.0", "0.016", null, null],
      ["83000.0", null, "true", null],
    ]);
  });
});

describe("which keys may trade", () => {
  const base = parseRestrictions({ enableReading: true, enableFutures: true, ipRestrict: true });
  it("wants futures on, money movement off, and an IP lock", () => {
    expect(tradingKeyRefusal(base)).toBeNull();
    expect(tradingKeyRefusal({ ...base, enableWithdrawals: true })).toMatch(/withdraw/);
    expect(tradingKeyRefusal({ ...base, enableInternalTransfer: true })).toMatch(/transfer/);
    expect(tradingKeyRefusal({ ...base, enableFutures: false })).toMatch(/cannot trade futures/);
    expect(tradingKeyRefusal({ ...base, ipRestrict: false })).toMatch(/any IP/);
  });

  it("lets an unlocked key through only when the server was told to", () => {
    expect(tradingKeyRefusal({ ...base, ipRestrict: false }, true)).toBeNull();
    // The other rules still hold with the override.
    expect(tradingKeyRefusal({ ...base, ipRestrict: false, enableWithdrawals: true }, true)).toMatch(/withdraw/);
  });
});

describe("what the venue's answer does to the trade", () => {
  const ref: TerminalRef = {
    venue: "binance", env: "testnet", account: "T", symbol: "BTCUSDT", positionSide: "LONG", tag: "edg-9",
    leverage: 5, qty: 0.05, entryOrderId: 1, stopOrderId: 2, targetOrderIds: [3, 4], closeOrderIds: [9],
  };
  let tid = 1;
  const fill = (orderId: number, price: number, qty: number, time: number) => ({
    tid: tid++, orderId, price, qty, time, commission: 0.1, commissionUsd: true, realizedPnl: 0,
  });
  const filled = { status: "FILLED", avgPrice: 79990, executedQty: 0.05, updateTime: 1 };
  const open = { status: "open", entryPrice: 79990, size: 0.05, fees: 0.1, direction: "long" };

  it("leaves a resting limit alone until it fills, then opens the trade at the fill", () => {
    const pending = { status: "pending", entryPrice: 80000, size: 0.05, fees: null };
    expect(reconcilePatch(pending, ref, { entry: { status: "NEW", avgPrice: 0, executedQty: 0, updateTime: 0 }, fills: [], positionAmt: 0, openOrderIds: [1, 2, 3] }).patch).toBeNull();
    const { patch } = reconcilePatch(pending, ref, {
      entry: { status: "FILLED", avgPrice: 79990, executedQty: 0.05, updateTime: 1_700_000_000_000 },
      fills: [fill(1, 79990, 0.05, 1_700_000_000_000)],
      positionAmt: 0.05,
      openOrderIds: [2, 3],
    });
    expect(patch).toMatchObject({ status: "open", entryPrice: 79990, size: 0.05, entryTime: new Date(1_700_000_000_000).toISOString(), fees: 0.1 });
    expect(patch?.exitPrice).toBeUndefined();
  });

  it("cancels the trade when the venue cancelled the resting entry unfilled", () => {
    expect(
      reconcilePatch({ status: "pending", entryPrice: 80000, size: 0.05, fees: null }, ref, {
        entry: { status: "CANCELED", avgPrice: 0, executedQty: 0, updateTime: 0 }, fills: [], positionAmt: 0, openOrderIds: [],
      }).patch,
    ).toEqual({ status: "cancelled", cancelReason: "not_filled" });
  });

  it("closes an open trade at the closing fills once the position side is flat, and says the stop did it", () => {
    const { patch, partials } = reconcilePatch(open, ref, {
      entry: filled, fills: [fill(1, 79990, 0.05, 1), fill(2, 79000, 0.05, 5_000)], positionAmt: 0, openOrderIds: [],
    });
    expect(patch).toMatchObject({ status: "closed", exitPrice: 79000, exitTime: new Date(5_000).toISOString(), fees: 0.2, exitReason: "stop" });
    expect(partials).toEqual([]);
  });

  it("does not close a trade whose position is still on, whatever fills exist elsewhere", () => {
    const { patch } = reconcilePatch(open, ref, { entry: filled, fills: [fill(1, 79990, 0.05, 1)], positionAmt: 0.05, openOrderIds: [2, 3] });
    expect(patch).toBeNull();
  });

  it("logs a target that took its share as a partial, and closes at the fills that took the rest", () => {
    const first = reconcilePatch(open, ref, {
      entry: filled, fills: [fill(1, 79990, 0.05, 1), fill(3, 81000, 0.025, 3_000)], positionAmt: 0.025, openOrderIds: [2, 4],
    });
    expect(first.patch?.status).toBeUndefined();
    expect(first.partials).toMatchObject([{ orderId: 3, price: 81000, qty: 0.025, time: 3_000 }]);
    const then = reconcilePatch(open, ref, {
      entry: filled, fills: [fill(1, 79990, 0.05, 1), fill(3, 81000, 0.025, 3_000), fill(4, 82000, 0.025, 6_000)], positionAmt: 0, openOrderIds: [],
    });
    expect(then.partials).toHaveLength(1);
    // The exit is the second target alone; the first is in the ledger.
    expect(then.patch).toMatchObject({ status: "closed", exitPrice: 82000, exitReason: "target" });
  });

  it("names a close from the terminal, a breakeven and a trail for what they were", () => {
    const by = (orderId: number, price: number, stopMoves: string | null) =>
      reconcilePatch({ ...open, stopMoves }, ref, { entry: filled, fills: [fill(1, 79990, 0.05, 1), fill(orderId, price, 0.05, 9)], positionAmt: 0, openOrderIds: [] }).patch?.exitReason;
    expect(by(9, 80500, null)).toBe("discretion");
    expect(by(2, 79992, '[{"at":"x","price":79992}]')).toBe("breakeven");
    expect(by(2, 80600, '[{"at":"x","price":80600}]')).toBe("trailed");
    expect(by(2, 79500, '[{"at":"x","price":79500}]')).toBe("stop");
  });

  it("counts an add as more on, logs it, and closes only once the whole of it is gone", () => {
    const withAdd = { ...ref, addOrderIds: [7] };
    const more = [fill(1, 79990, 0.05, 1), fill(7, 80100, 0.05, 2_000)];
    const grown = reconcilePatch(open, withAdd, { entry: filled, fills: more, positionAmt: 0.1, openOrderIds: [2, 3] });
    expect(grown.patch?.status).toBeUndefined();
    expect(grown.adds).toMatchObject([{ orderId: 7, price: 80100, qty: 0.05 }]);
    // Half off at the first target is a partial against the grown size, not an exit.
    const half = reconcilePatch(open, withAdd, { entry: filled, fills: [...more, fill(3, 81000, 0.05, 3_000)], positionAmt: 0.05, openOrderIds: [2, 4] });
    expect(half.patch?.status).toBeUndefined();
    expect(half.partials).toMatchObject([{ orderId: 3, qty: 0.05 }]);
    const done = reconcilePatch(open, withAdd, { entry: filled, fills: [...more, fill(3, 81000, 0.05, 3_000), fill(4, 82000, 0.05, 4_000)], positionAmt: 0, openOrderIds: [] });
    expect(done.patch).toMatchObject({ status: "closed", exitPrice: 82000, exitReason: "target" });
  });

  it("closes a trade flattened from the venue's own app at those fills, as a close by hand", () => {
    const outside = { ...fill(77, 80300, 0.05, 8_000), foreign: true as const };
    const { patch, partials } = reconcilePatch(open, ref, { entry: filled, fills: [fill(1, 79990, 0.05, 1), outside], positionAmt: 0, openOrderIds: [] });
    expect(patch).toMatchObject({ status: "closed", exitPrice: 80300, exitReason: "discretion" });
    expect(partials).toEqual([]);
    // Foreign fills on a position still standing are nobody's business.
    expect(reconcilePatch(open, ref, { entry: filled, fills: [fill(1, 79990, 0.05, 1), outside], positionAmt: 0.05, openOrderIds: [2, 3] }).patch).toBeNull();
  });

  it("never overrides an exit reason somebody already gave", () => {
    const { patch } = reconcilePatch({ ...open, exitReason: "time" }, ref, { entry: filled, fills: [fill(1, 79990, 0.05, 1), fill(2, 79000, 0.05, 5)], positionAmt: 0, openOrderIds: [] });
    expect(patch?.status).toBe("closed");
    expect(patch?.exitReason).toBeUndefined();
  });
});

describe("the user-data stream", () => {
  it("joins the venue's private stream with the listen key, on the host the key belongs to", () => {
    expect(streamUrl("live", "abc")).toBe("wss://fstream.binance.com/private/ws?listenKey=abc");
    expect(streamUrl("testnet", "abc")).toBe("wss://fstream.binancefuture.com/private/ws?listenKey=abc");
  });

  it("reads back on a fill, a cancel or a fired bracket, and on nothing else", () => {
    expect(worthAReadBack({ e: "ORDER_TRADE_UPDATE", o: { x: "TRADE", X: "PARTIALLY_FILLED" } })).toBe(true);
    expect(worthAReadBack({ e: "ORDER_TRADE_UPDATE", o: { x: "NEW", X: "NEW" } })).toBe(false);
    expect(worthAReadBack({ e: "ORDER_TRADE_UPDATE", o: { x: "CANCELED", X: "CANCELED" } })).toBe(true);
    expect(worthAReadBack({ e: "ALGO_UPDATE", o: { X: "TRIGGERING" } })).toBe(false);
    expect(worthAReadBack({ e: "ALGO_UPDATE", o: { X: "FINISHED" } })).toBe(true);
    expect(worthAReadBack({ data: { e: "ALGO_UPDATE", o: { X: "TRIGGERED" } } })).toBe(true);
    expect(worthAReadBack({ e: "ACCOUNT_UPDATE" })).toBe(false);
    expect(worthAReadBack("nonsense")).toBe(false);
  });
});

describe("the venue's algo-order answers", () => {
  it("reads a new-order answer that names no symbol, with the symbol the caller sent", () => {
    const o = parseAlgoOrder({ algoId: 55, clientAlgoId: "edg-1-s", side: "SELL", positionSide: "LONG", orderType: "STOP_MARKET", algoStatus: "NEW", triggerPrice: "79500.0", closePosition: true, createTime: 10, actualOrderId: "" }, "btcusdt");
    expect(o).toMatchObject({ symbol: "BTCUSDT", orderId: 55, clientOrderId: "edg-1-s", type: "STOP_MARKET", status: "NEW", stopPrice: 79500, closePosition: true, triggeredOrderId: null });
    expect(parseAlgoOrder({ algoId: 55 })).toBeNull();
  });

  it("names the plain order a fired bracket became", () => {
    expect(parseAlgoOrder({ algoId: 56, symbol: "BTCUSDT", orderType: "TAKE_PROFIT_MARKET", algoStatus: "FINISHED", actualOrderId: "9001", triggerTime: 20 })).toMatchObject({ triggeredOrderId: 9001, status: "FINISHED", updateTime: 20 });
  });
});

describe("the idea, watched on the tape", () => {
  const bar = (t: number, h: number, l: number) => ({ t, o: (h + l) / 2, h, l, c: (h + l) / 2 });
  const long = { direction: "long", stop: 79000, target: 81000 };

  it("names the first minute to reach the stop and the first to reach the target, by the wick", () => {
    const touches = planTouches([bar(0, 80100, 79900), bar(60_000, 81050, 80000), bar(120_000, 80500, 78900)], long);
    expect(touches).toEqual({ target: { at: 60_000, price: 81000 }, stop: { at: 120_000, price: 79000 } });
    expect(planTouches([bar(0, 80100, 79900)], long)).toEqual({});
    // A short is the mirror.
    expect(planTouches([bar(0, 80100, 78900)], { direction: "short", stop: 81000, target: 79000 })).toMatchObject({ target: { at: 0 } });
  });

  it("calls both levels inside one minute ambiguous rather than picking one", () => {
    const touches = planTouches([bar(0, 81100, 78900)], long);
    expect(touches.sameBar).toBe(true);
    const { next } = advancePlanWatch(undefined, touches, 0, "2026-10-27T10:00:00.000Z");
    expect(next.first).toBe("ambiguous");
  });

  it("settles the first level as soon as one is reached without the other, and never un-settles it", () => {
    const first = advancePlanWatch(undefined, planTouches([bar(0, 81050, 80000)], long), 0, "2026-10-27T10:01:00.000Z");
    expect(first.news).toEqual(["target"]);
    expect(first.next).toMatchObject({ first: "target", firstAt: new Date(0).toISOString(), targetHitPrice: 81000 });
    // The stop reached later changes nothing about which came first.
    const later = advancePlanWatch(first.next, planTouches([bar(120_000, 80500, 78900)], long), 120_000, "2026-10-27T10:03:00.000Z");
    expect(later.news).toEqual(["stop"]);
    expect(later.next.first).toBe("target");
    expect(later.next.coveredTo).toBe(120_000);
    // Read again with nothing new: no news.
    expect(advancePlanWatch(later.next, {}, 180_000, "x").news).toEqual([]);
  });

  it("reads the plan's verdict off the watch first, then the trade's own answer, and prices it in R", () => {
    const ref: TerminalRef = { venue: "binance", env: "testnet", account: "T", symbol: "BTCUSDT", positionSide: "LONG", tag: "e", leverage: 1, qty: 1, entryOrderId: 1, stopOrderId: null, targetOrderIds: [],
      idea: { entry: 80000, stop: 79000, targets: [82000], qty: 1, riskDollars: 1000, at: "2026-10-27T09:00:00.000Z" } };
    const t = { direction: "long", entryPrice: 80000, noManagementOutcome: null } as any;
    expect(planVerdictOf(t, ref)).toEqual({ verdict: null, source: null, at: null, planR: null });
    expect(planVerdictOf({ ...t, noManagementOutcome: "stop_first", outcomeHitAt: "2026-10-27T09:30:00.000Z" }, ref)).toMatchObject({ verdict: "stop_first", source: "trade", planR: -1 });
    expect(planVerdictOf(t, { ...ref, planWatch: { coveredTo: 0, checkedAt: "x", first: "target", firstAt: "2026-10-27T09:20:00.000Z" } })).toMatchObject({ verdict: "target_first", source: "watch", planR: 2 });
    expect(rAt(80500, 80000, 79000, "long")).toBe(0.5);
    expect(rAt(80500, 80000, 79000, "short")).toBe(-0.5);
    expect(rAt(80500, 80000, null, "long")).toBeNull();
  });

  it("tells the trade's life as one timeline, and the brief says what management was worth", () => {
    const ref: TerminalRef = { venue: "binance", env: "testnet", account: "T", symbol: "BTCUSDT", positionSide: "LONG", tag: "e", leverage: 1, qty: 1, entryOrderId: 1, stopOrderId: null, targetOrderIds: [],
      idea: { entry: 80000, stop: 79000, targets: [82000], qty: 1, riskDollars: 1000, at: "2026-10-27T09:00:00.000Z" },
      moves: [{ at: "2026-10-27T09:30:00.000Z", kind: "stop", from: 79000, to: 80000, mark: 80700, r: 0.7 }, { at: "2026-10-27T09:40:00.000Z", kind: "reduce", qty: 0.5, mark: 80900, r: 0.9 }],
      planWatch: { coveredTo: 0, checkedAt: "x", first: "target", firstAt: "2026-10-27T10:10:00.000Z", targetHitAt: "2026-10-27T10:10:00.000Z", targetHitPrice: 82000 } };
    const t = {
      direction: "long", status: "closed", entryPrice: 80000, entryTime: "2026-10-27T09:00:00.000Z", size: 1, exitPrice: 80000, exitTime: "2026-10-27T09:55:00.000Z", exitReason: "breakeven",
      fills: [{ kind: "partial", price: 80900, size: 0.5, time: "2026-10-27T09:40:01.000Z", note: "terminal · fill 1" }],
    } as any;
    const rows = managementTimeline(t, ref);
    expect(rows.map((r) => r.kind)).toEqual(["entry-fill", "stop", "reduce", "reduce", "exit", "plan-hit"]);
    expect(rows[1].text).toContain("(breakeven)");
    expect(rows[1].text).toContain("+0.70R");
    expect(rows[3].text).toContain("Partial filled: 0.5 at 80900 (+0.90R)");
    const brief = managementBrief(t, ref, 0.45);
    expect(brief).toContain("would have hit the target first");
    expect(brief).toContain("+2.00R");
    expect(brief).toContain("As managed, the trade made +0.45R");
    expect(brief).toContain("Management cost 1.55R");
  });

  it("takes a model's verdict only as far as it fits", () => {
    const basis = { actualR: 0.45, planR: 2, planVerdict: "target_first" };
    expect(parseManagementReview({ verdict: "HURT", summary: "You moved the stop to breakeven at +0.7R and were taken out on the pullback that then ran to target.", lesson: "Give it the room the plan drew." }, basis, "now"))
      .toMatchObject({ verdict: "hurt", lesson: "Give it the room the plan drew.", basis });
    expect(parseManagementReview({ verdict: "brilliant" }, basis, "now").verdict).toBe("unknown");
    expect(parseManagementReview(null, basis, "now")).toMatchObject({ verdict: "unknown", summary: "", lesson: null });
  });
});
