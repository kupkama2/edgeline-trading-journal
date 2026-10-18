import { afterEach, describe, expect, it } from "vitest";
import {
  baseAssetOf,
  fillsFromUserTrades,
  keyRefusal,
  levelsFromOpenOrders,
  parseOpenOrders,
  parsePositions,
  parseRestrictions,
  parseUserTrades,
  signedQuery,
} from "../shared/binance-account";
import { tradesFromFills } from "../shared/hyperliquid";
import { _resetKeyForTests, open, seal } from "../server/secrets";

/**
 * Reading a Binance Futures account, the half that can be wrong on its own.
 *
 * Which keys are let in, how a row of userTrades becomes a fill, when a
 * symbol's fills are set aside unread, which open order is the stop, and
 * what the journal calls a market the venue calls BTCUSDT.
 */
describe("which keys are let in", () => {
  // A real read-only key: Enable Reading on, everything else off.
  const ok = parseRestrictions({ enableReading: true });

  it("keeps a key that can only read", () => {
    expect(keyRefusal(ok)).toBeNull();
  });

  it("does not demand Enable Futures, which is futures trading, not reading", () => {
    // The old rule refused exactly the key the settings page asked for.
    expect(keyRefusal({ ...ok, enableFutures: false })).toBeNull();
    expect(keyRefusal({ ...ok, enableFutures: true })).toBeNull();
  });

  it("refuses anything a stolen key could spend", () => {
    expect(keyRefusal({ ...ok, enableWithdrawals: true })).toMatch(/withdraw/);
    expect(keyRefusal({ ...ok, enableInternalTransfer: true })).toMatch(/transfer/);
    expect(keyRefusal({ ...ok, enableSpotAndMarginTrading: true })).toMatch(/spot or margin/);
    expect(keyRefusal({ ...ok, enableMargin: true })).toMatch(/spot or margin/);
    expect(keyRefusal({ ...ok, permitsUniversalTransfer: true })).toMatch(/transfer/);
    expect(keyRefusal({ ...ok, enableVanillaOptions: true })).toMatch(/options/);
    expect(keyRefusal({ ...ok, enablePortfolioMarginTrading: true })).toMatch(/portfolio margin/);
  });

  it("refuses a key that cannot read, which would be stored only to fail", () => {
    expect(keyRefusal({ ...ok, enableReading: false })).toMatch(/Enable Reading/);
  });

  it("reads anything missing from the venue's answer as off", () => {
    // The venue's shape is not under this journal's control; a field it stops
    // sending must not read as a permission granted.
    expect(parseRestrictions({})).toMatchObject({ enableReading: false, enableWithdrawals: false });
    expect(keyRefusal(parseRestrictions(null))).toMatch(/Enable Reading/);
  });
});

describe("the signed query", () => {
  it("is built once, in a fixed order, with the timestamp last", () => {
    expect(signedQuery({ symbol: "BTCUSDT", limit: 1000 }, 1700000000000)).toBe(
      "symbol=BTCUSDT&limit=1000&recvWindow=10000&timestamp=1700000000000",
    );
  });

  it("leaves out what was not given, rather than sending the word undefined", () => {
    expect(signedQuery({ symbol: "ETHUSDT", fromId: undefined, startTime: "" }, 1)).toBe(
      "symbol=ETHUSDT&recvWindow=10000&timestamp=1",
    );
  });
});

const T0 = 1_760_000_000_000;
const H = 3_600_000;
const row = (over: Record<string, unknown>) => ({
  symbol: "ETHUSDT",
  id: 1,
  orderId: 10,
  side: "BUY",
  price: "2000",
  qty: "1",
  realizedPnl: "0",
  commission: "0.4",
  time: T0,
  ...over,
});

describe("rows of userTrades into fills", () => {
  it("maps the venue's names onto the shared fill, in time order", () => {
    const rows = parseUserTrades([
      row({ id: 2, side: "SELL", price: "2100", realizedPnl: "100", commission: "0.6", time: T0 + 3 * H }),
      row({ id: 1 }),
    ]);
    const { fills } = fillsFromUserTrades(rows, new Map());
    expect(fills.map((f) => [f.coin, f.side, f.px, f.sz, f.startPosition, f.closedPnl, f.fee, f.tid])).toEqual([
      ["ETHUSDT", "B", 2000, 1, 0, 0, 0.4, 1],
      ["ETHUSDT", "A", 2100, 1, 1, 100, 0.6, 2],
    ]);
  });

  it("gives the position reader what it needs to make a trade of them", () => {
    const rows = parseUserTrades([
      row({ id: 1 }),
      row({ id: 2, side: "SELL", price: "2100", realizedPnl: "100", commission: "0.6", time: T0 + 3 * H }),
    ]);
    const read = tradesFromFills(fillsFromUserTrades(rows, new Map()).fills, "binance");
    expect(read.trades).toHaveLength(1);
    expect(read.trades[0]).toMatchObject({
      coin: "ETHUSDT",
      direction: "long",
      entryPrice: 2000,
      exitPrice: 2100,
      status: "closed",
      closedPnl: 100,
      externalId: "binance:ETHUSDT:1",
    });
    expect(read.trades[0].fees).toBeCloseTo(1.0);
  });

  it("sets a symbol aside when its fills do not add up to what the venue says is open", () => {
    /*
     * The record begins with a SELL, and the venue says nothing is open now.
     * So that sell closed a position whose entry this window never saw. Read
     * from flat it would be written as a fresh short — a trade with the wrong
     * direction, the wrong entry and a P&L the venue never paid.
     */
    const rows = parseUserTrades([
      row({ symbol: "DOGEUSDT", id: 1, side: "SELL", price: "0.2", qty: "5", realizedPnl: "12" }),
    ]);
    const out = fillsFromUserTrades(rows, parsePositions([{ symbol: "DOGEUSDT", positionAmt: "0" }]));
    expect(out.fills).toEqual([]);
    expect(out.unreconstructable).toEqual([{ symbol: "DOGEUSDT", fills: 1, reason: "before-window" }]);
  });

  it("keeps a symbol whose fills land exactly on the venue's open position", () => {
    const rows = parseUserTrades([
      row({ symbol: "BTCUSDT", id: 5, side: "SELL", price: "100", qty: "2" }),
    ]);
    const out = fillsFromUserTrades(rows, parsePositions([{ symbol: "BTCUSDT", positionAmt: "-2", entryPrice: "100" }]));
    expect(out.unreconstructable).toEqual([]);
    expect(out.fills).toHaveLength(1);
  });

  it("nets hedge-mode rows into one position to reconcile against", () => {
    const pos = parsePositions([
      { symbol: "BTCUSDT", positionSide: "LONG", positionAmt: "3" },
      { symbol: "BTCUSDT", positionSide: "SHORT", positionAmt: "-1" },
    ]);
    expect(pos.get("BTCUSDT")?.amt).toBe(2);
  });

  it("skips rows it cannot read rather than guessing at them", () => {
    expect(parseUserTrades([row({ side: "HOLD" }), row({ price: "abc" }), "junk", null])).toEqual([]);
  });
});

describe("the stop and target resting on an open position", () => {
  const short = { coin: "BTCUSDT", direction: "short" as const, entryPrice: 100 };
  const orders = parseOpenOrders([
    { symbol: "BTCUSDT", orderId: 1, side: "BUY", type: "STOP_MARKET", stopPrice: "110", reduceOnly: true, time: T0 },
    { symbol: "BTCUSDT", orderId: 2, side: "BUY", type: "TAKE_PROFIT_MARKET", stopPrice: "80", closePosition: true, time: T0 + 1 },
    // A stop on another coin, and a non-reducing order on this one: neither counts.
    { symbol: "ETHUSDT", orderId: 3, side: "SELL", type: "STOP_MARKET", stopPrice: "1900", reduceOnly: true, time: T0 },
    { symbol: "BTCUSDT", orderId: 4, side: "BUY", type: "LIMIT", price: "95", time: T0 },
  ]);

  it("reads the stop above a short's entry and the target below it", () => {
    expect(levelsFromOpenOrders(short, orders)).toEqual({ initialStop: 110, initialTarget: 80 });
  });

  it("does not take a stop already moved past the entry as the ORIGINAL one", () => {
    // That is the current stop, not the plan, and initialStop is the R
    // denominator. Blank, for the person to fill in, is the honest reading.
    const moved = parseOpenOrders([
      { symbol: "BTCUSDT", orderId: 1, side: "BUY", type: "STOP_MARKET", stopPrice: "95", reduceOnly: true, time: T0 },
    ]);
    expect(levelsFromOpenOrders(short, moved).initialStop).toBeNull();
  });

  it("finds nothing for a position with no orders resting", () => {
    expect(levelsFromOpenOrders({ coin: "SOLUSDT", direction: "long", entryPrice: 150 }, orders)).toEqual({
      initialStop: null,
      initialTarget: null,
    });
  });
});

describe("what the journal calls a Binance market", () => {
  const cat = [{ symbol: "1000PEPEUSDT", baseAsset: "1000PEPE" }, { symbol: "BTCUSDT", baseAsset: "BTC" }];

  it("takes the catalogue's base asset when it has the pair", () => {
    expect(baseAssetOf("BTCUSDT", cat)).toBe("BTC");
    // A thousand-PEPE contract is not PEPE; the venue's spelling stands.
    expect(baseAssetOf("1000PEPEUSDT", cat)).toBe("1000PEPE");
  });

  it("strips a known quote otherwise, longest first", () => {
    expect(baseAssetOf("SOLUSDT")).toBe("SOL");
    expect(baseAssetOf("ETHBTC")).toBe("ETH");
    expect(baseAssetOf("solfdusd")).toBe("SOL");
  });

  it("leaves a bare base asset alone — the claim runs journal symbols through it too", () => {
    expect(baseAssetOf("BTC")).toBe("BTC");
    expect(baseAssetOf("ETH")).toBe("ETH");
    expect(baseAssetOf("BNB")).toBe("BNB");
    // Wormhole's W is a real token; wrapped BTC must not become it.
    expect(baseAssetOf("WBTC")).toBe("WBTC");
  });
});

describe("the secret at rest", () => {
  const SECRET = "test-session-secret-that-is-long-enough-to-matter";
  afterEach(() => {
    delete process.env.SESSION_SECRET;
    _resetKeyForTests();
  });

  it("seals and opens, and the ciphertext says nothing", () => {
    process.env.SESSION_SECRET = SECRET;
    _resetKeyForTests();
    const sealed = seal("api-secret-123456789");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("api-secret");
    expect(open(sealed)).toBe("api-secret-123456789");
    // A fresh nonce each time: the same secret never seals to the same bytes.
    expect(seal("api-secret-123456789")).not.toBe(sealed);
  });

  it("will not open what another SESSION_SECRET sealed", () => {
    process.env.SESSION_SECRET = SECRET;
    _resetKeyForTests();
    const sealed = seal("api-secret-123456789");
    process.env.SESSION_SECRET = "a-different-secret-entirely-after-a-rotation";
    _resetKeyForTests();
    expect(open(sealed)).toBeNull();
  });

  it("returns null for anything that is not a sealed value", () => {
    process.env.SESSION_SECRET = SECRET;
    _resetKeyForTests();
    expect(open(null)).toBeNull();
    expect(open("")).toBeNull();
    expect(open("plaintext-secret")).toBeNull();
    expect(open("v1.not-base64-at-all!!")).toBeNull();
    expect(open("v2.AAAA")).toBeNull();
  });
});

describe("what a fill's fee and side mean", () => {
  it("leaves a fee paid in a coin unknown, rather than booking it as dollars", () => {
    const rows = parseUserTrades([
      row({ id: 1, commission: "0.0021", commissionAsset: "BNB" }),
      row({ id: 2, side: "SELL", price: "2100", commission: "0.6", commissionAsset: "USDT", time: T0 + H }),
    ]);
    const read = tradesFromFills(fillsFromUserTrades(rows, new Map()).fills, "binance");
    expect(Number.isFinite(read.trades[0].fees)).toBe(false);
  });

  it("takes Binance's dollar fee credit as dollars", () => {
    const rows = parseUserTrades([row({ id: 1, commission: "0.4", commissionAsset: "BNFCR" })]);
    expect(fillsFromUserTrades(rows, new Map([["ETHUSDT", { amt: 1, entryPrice: 2000 }]])).fills[0].fee).toBe(0.4);
  });

  it("sets a hedge-mode symbol aside, even when its net adds up", () => {
    const rows = parseUserTrades([
      row({ symbol: "BTCUSDT", id: 1, positionSide: "LONG", price: "100", qty: "1" }),
      row({ symbol: "BTCUSDT", id: 2, positionSide: "SHORT", side: "SELL", price: "105", qty: "1", time: T0 + H }),
    ]);
    const out = fillsFromUserTrades(rows, parsePositions([{ symbol: "BTCUSDT", positionAmt: "0" }]));
    expect(out.fills).toEqual([]);
    expect(out.unreconstructable).toEqual([{ symbol: "BTCUSDT", fills: 2, reason: "hedge-mode" }]);
  });
});
