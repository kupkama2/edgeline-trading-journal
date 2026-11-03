import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";

/**
 * The journal following an account on its venue.
 *
 * Nobody sends an order from here. A stub Hyperliquid and a stub Binance
 * say what a wallet and a key would be told — the positions held, the
 * orders resting against them, the fills that made them — and the tracker
 * reads them the way the server does every few seconds. What is checked is
 * the record: a position becomes one open trade with the stop and target
 * resting against it; a stop at a new price is a move with the mark and the
 * R at the time; a closing fill is a partial; an opening fill an add; a
 * position gone closes the trade and names how; a trade the sync had
 * already written is taken under watch rather than written twice; and a
 * position older than the fills on record is written from the position
 * itself, said so, rather than invented.
 */
const DB = process.env.DATABASE_URL;
if (process.env.CI && !DB) throw new Error("DATABASE_URL is required in CI — the tracker tests must run");

const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const WALLET = "0x" + "cd".repeat(20);
const KEY = "trackerkey0123456789abcdef";
const SECRET = "trackersecret0123456789abcdef";
const HL = "HL Main";
const BN = "Binance Main";
const MIN = 60_000;
const now = Date.now();

/* ------------------------------- Hyperliquid ------------------------------- */

/** What the wallet holds, as clearinghouseState reports it. */
let hlPositions: any[] = [{ position: { coin: "BTC", szi: "0.5", entryPx: "80000", liquidationPx: "60000", unrealizedPnl: "250", leverage: { type: "cross", value: 5 } } }];
/** What rests, as frontendOpenOrders reports it. */
let hlOrders: any[] = [
  { coin: "BTC", oid: 901, side: "A", limitPx: "79000", sz: "0.5", isTrigger: true, triggerPx: "79000", orderType: "Stop Market", reduceOnly: true, isPositionTpsl: true, timestamp: now - 9 * MIN },
  { coin: "BTC", oid: 902, side: "A", limitPx: "82000", sz: "0.5", isTrigger: true, triggerPx: "82000", orderType: "Take Profit Market", reduceOnly: true, isPositionTpsl: true, timestamp: now - 9 * MIN },
];
const hlFills: any[] = [
  { coin: "BTC", px: "80000", sz: "0.5", side: "B", time: now - 10 * MIN, startPosition: "0", dir: "Open Long", closedPnl: "0", fee: "0.4", tid: 7001, oid: 700 },
];
let hlMid = "80500";

/* --------------------------------- Binance --------------------------------- */

/** One row per side, as positionRisk reports it in hedge mode. */
let bnPositions: any[] = [
  { symbol: "ETHUSDT", positionSide: "SHORT", positionAmt: "-2", entryPrice: "3000", markPrice: "2950", unRealizedProfit: "100", leverage: "10", liquidationPrice: "3300" },
  // A position whose opening is older than the fills on record.
  { symbol: "XRPUSDT", positionSide: "LONG", positionAmt: "100", entryPrice: "0.5", markPrice: "0.52", unRealizedProfit: "2", leverage: "3", liquidationPrice: "0" },
];
const bnFills: any[] = [
  { symbol: "ETHUSDT", id: 9001, orderId: 5000, side: "SELL", positionSide: "SHORT", price: "3000", qty: "2", realizedPnl: "0", commission: "1.2", commissionAsset: "USDT", time: now - 20 * MIN, buyer: false, maker: false },
];
const bnOrders: any[] = [{ orderId: 5000, clientOrderId: "web_1", symbol: "ETHUSDT", side: "SELL", positionSide: "SHORT", type: "MARKET", status: "FILLED", price: "0", stopPrice: "0", origQty: "2", executedQty: "2", avgPrice: "3000", closePosition: false, reduceOnly: false, time: now - 20 * MIN, updateTime: now - 20 * MIN }];
let bnAlgos: any[] = [
  { algoId: 6001, clientAlgoId: "web_sl", symbol: "ETHUSDT", side: "BUY", positionSide: "SHORT", orderType: "STOP_MARKET", algoType: "CONDITIONAL", algoStatus: "NEW", quantity: "0", triggerPrice: "3100", closePosition: true, createTime: now - 19 * MIN, updateTime: now - 19 * MIN, triggerTime: 0, actualOrderId: "" },
  { algoId: 6002, clientAlgoId: "web_tp", symbol: "ETHUSDT", side: "BUY", positionSide: "SHORT", orderType: "TAKE_PROFIT_MARKET", algoType: "CONDITIONAL", algoStatus: "NEW", quantity: "0", triggerPrice: "2800", closePosition: true, createTime: now - 19 * MIN, updateTime: now - 19 * MIN, triggerTime: 0, actualOrderId: "" },
];

let venue: Server;
let app: Server;
let base = "";

function startVenue(): Promise<string> {
  return new Promise((resolve) => {
    venue = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => handle(req, res, body));
    });
    const handle = (req: any, res: any, body: string) => {
      const u = new URL(req.url ?? "/", "http://x");
      const json = (x: unknown, status = 200) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(x));
      };
      // ---- Hyperliquid: everything is POST /info by type.
      if (req.method === "POST" && u.pathname === "/info") {
        const q = JSON.parse(body || "{}");
        switch (q.type) {
          case "meta":
            return json({ universe: [{ name: "BTC", maxLeverage: 40 }, { name: "ETH", maxLeverage: 25 }] });
          case "clearinghouseState":
            return json(q.user === WALLET ? { assetPositions: hlPositions, marginSummary: {} } : { assetPositions: [] });
          case "frontendOpenOrders":
            return json(q.user === WALLET ? hlOrders : []);
          case "userFillsByTime":
            return json(q.user === WALLET ? hlFills.filter((f) => f.time >= Number(q.startTime ?? 0)) : []);
          case "userFills":
            return json(q.user === WALLET ? hlFills : []);
          case "allMids":
            return json({ BTC: hlMid, ETH: "3000" });
          case "candleSnapshot":
            return json([]);
          case "historicalOrders":
            return json([]);
          default:
            return json({});
        }
      }
      // ---- Binance public.
      if (u.pathname === "/fapi/v1/exchangeInfo") {
        const sym = (symbol: string, baseAsset: string) => ({
          symbol, baseAsset, quoteAsset: "USDT", status: "TRADING", contractType: "PERPETUAL", pricePrecision: 2, quantityPrecision: 3,
          filters: [{ filterType: "PRICE_FILTER", tickSize: "0.01" }, { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" }, { filterType: "MIN_NOTIONAL", notional: "5" }],
        });
        return json({ symbols: [sym("ETHUSDT", "ETH"), sym("XRPUSDT", "XRP"), sym("BTCUSDT", "BTC")] });
      }
      if (u.pathname === "/api/v3/exchangeInfo") return json({ symbols: [] });
      if (u.pathname === "/fapi/v1/klines") return json([]);
      if (u.pathname === "/fapi/v1/premiumIndex") return json({ symbol: u.searchParams.get("symbol"), markPrice: "2950" });
      // ---- Binance signed.
      const key = req.headers["x-mbx-apikey"] as string | undefined;
      const raw = req.method === "POST" || req.method === "PUT" ? body : u.search.slice(1);
      const sp = new URLSearchParams(raw);
      const sig = sp.get("signature") ?? "";
      const query = raw.replace(/&signature=[0-9a-f]*$/, "");
      const expected = key === KEY ? createHmac("sha256", SECRET).update(query).digest("hex") : "";
      if (!(key === KEY && sig === expected)) return json({ code: -2015, msg: "Invalid API-key, IP, or permissions for action." }, 401);
      sp.delete("signature");
      const params = Object.fromEntries(sp.entries());
      switch (`${req.method} ${u.pathname}`) {
        case "GET /sapi/v1/account/apiRestrictions":
          return json({ enableReading: true, enableFutures: true, enableWithdrawals: false, enableInternalTransfer: false, ipRestrict: true });
        case "GET /fapi/v2/positionRisk":
          return json(bnPositions);
        case "GET /fapi/v1/userTrades":
          return json(bnFills.filter((f) => f.symbol === params.symbol && f.time >= Number(params.startTime ?? 0)));
        case "GET /fapi/v1/openOrders":
          return json(bnOrders.filter((o) => o.status === "NEW" && (!params.symbol || o.symbol === params.symbol)));
        case "GET /fapi/v1/openAlgoOrders":
          return json(bnAlgos.filter((a) => a.algoStatus === "NEW" && (!params.symbol || a.symbol === params.symbol)));
        case "GET /fapi/v1/order": {
          const o = bnOrders.find((x) => x.orderId === Number(params.orderId));
          return o ? json(o) : json({ code: -2013, msg: "Order does not exist." }, 400);
        }
        case "GET /fapi/v1/algoOrder": {
          const a = bnAlgos.find((x) => x.algoId === Number(params.algoId));
          return a ? json(a) : json({ code: -2013, msg: "Order does not exist." }, 400);
        }
        default:
          return json({ code: -1121, msg: "Invalid symbol." }, 400);
      }
    };
    venue.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(venue.address() as any).port}`));
  });
}

const send = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (path: string) => send("GET", path).then((x) => x.json());
const run = () => send("POST", "/api/tracking/run").then((x) => x.json()) as Promise<{ accounts: any[] }>;
const ref = (t: any) => JSON.parse(t.terminal);
const tradesOf = async (symbol: string, account: string) => (await get("/api/trades")).filter((t: any) => t.symbol === symbol && t.account === account);

let store: any;
let userId: number;

describe.skipIf(!DB)("the journal following an account on its venue", () => {
  beforeAll(async () => {
    const stub = await startVenue();
    process.env.HYPERLIQUID_BASE = stub;
    process.env.BINANCE_BASE = stub;
    process.env.BINANCE_SAPI_BASE = stub;
    process.env.BINANCE_FUTURES_BASE = stub;
    process.env.BINANCE_TESTNET_FUTURES_BASE = stub;
    process.env.BINANCE_ARCHIVE_BASE = stub;
    process.env.BINANCE_LISTING_BASE = stub;
    process.env.SESSION_SECRET = `test-${stamp}-session-secret-long-enough`;
    process.env.TERMINAL_PLAN_WATCH_GAP_MS = "0";
    delete process.env.ANTHROPIC_API_KEY;

    const { initSchema, accounts, storageFor } = await import("../server/storage");
    await initSchema();
    const acct = await accounts.create({ googleSub: `trk-${stamp}`, email: `trk-${stamp}@x.test` });
    userId = acct.id;
    store = storageFor(userId);

    const express = (await import("express")).default;
    const { registerRoutes } = await import("../server/routes");
    const server = express();
    server.use(express.json({ limit: "25mb" }));
    server.use((req, _res, next) => {
      (req as any).userId = acct.id;
      next();
    });
    app = createServer(server);
    await registerRoutes(app, server);
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as any).port}`;
  });

  afterAll(async () => {
    const shut = (x: Server | undefined) => new Promise<void>((r) => (x ? x.close(() => r()) : r()));
    await shut(venue);
    await shut(app);
  });

  it("does nothing until an account is asked to be watched", async () => {
    await send("PUT", "/api/account-settings", { name: HL, feeMode: "percent", makerFee: 0, takerFee: 0, wallet: WALLET });
    expect((await run()).accounts).toEqual([]);
    const r = await send("PUT", "/api/account-settings", { name: HL, feeMode: "percent", makerFee: 0, takerFee: 0, track: true });
    expect(r.status).toBe(200);
    expect((await r.json()).track).toBe(true);
  });

  it("takes a trade the sync had already written under watch, rather than writing it twice", async () => {
    // The person ran the sync before turning tracking on: the trade is there, without a stop.
    await store.createTrade({
      symbol: "BTC", direction: "long", size: 0.5, sizeUnit: "base", pointValue: 1, entryPrice: 80000,
      entryTime: new Date(now - 10 * MIN).toISOString(), status: "open", account: HL, externalId: "hl:BTC:7001",
    });
    const r = await run();
    expect(r.accounts).toMatchObject([{ account: HL, venue: "hyperliquid", read: 1 }]);
    expect(r.accounts[0].error).toBeUndefined();
    const btc = await tradesOf("BTC", HL);
    expect(btc).toHaveLength(1);
    const t = btc[0];
    expect(t.status).toBe("open");
    expect(t.initialStop).toBe(79000);
    expect(t.initialTarget).toBe(82000);
    expect(t.riskAmount).toBeCloseTo(500);
    expect(t.paper).toBe(false);
    const x = ref(t);
    expect(x).toMatchObject({ venue: "hyperliquid", tracked: true, symbol: "BTC", positionSide: "LONG", entryOrderId: 700, stopOrderId: 901, targetOrderIds: [902] });
    expect(x.seen).toEqual({ stop: 79000, targets: [82000] });
    expect(x.idea).toMatchObject({ entry: 80000, stop: 79000, targets: [82000] });
  });

  it("reads the same position again without writing anything new", async () => {
    const r = await run();
    expect(r.accounts[0]).toMatchObject({ opened: [], read: 1 });
    expect(await tradesOf("BTC", HL)).toHaveLength(1);
  });

  it("writes a stop at a new price as a move, with the mark and the R at the time", async () => {
    hlOrders = hlOrders.filter((o) => o.oid !== 901).concat({ coin: "BTC", oid: 903, side: "A", limitPx: "80000", sz: "0.5", isTrigger: true, triggerPx: "80000", orderType: "Stop Market", reduceOnly: true, isPositionTpsl: true, timestamp: now - 5 * MIN });
    hlMid = "81000";
    await run();
    const [t] = await tradesOf("BTC", HL);
    const x = ref(t);
    expect(x.stopOrderId).toBe(903);
    expect(x.seen.stop).toBe(80000);
    const move = x.moves.find((m: any) => m.kind === "stop");
    expect(move).toMatchObject({ from: 79000, to: 80000, mark: 81000 });
    expect(move.r).toBeCloseTo(1);
    expect(t.initialStop).toBe(79000);
    expect(JSON.parse(t.stopMoves)).toHaveLength(1);
  });

  it("writes a closing fill as a partial, and an opening one as an add", async () => {
    hlFills.push({ coin: "BTC", px: "81000", sz: "0.25", side: "A", time: now - 4 * MIN, startPosition: "0.5", dir: "Close Long", closedPnl: "250", fee: "0.2", tid: 7002, oid: 800 });
    hlPositions = [{ position: { coin: "BTC", szi: "0.25", entryPx: "80000", liquidationPx: "60000", unrealizedPnl: "250", leverage: { type: "cross", value: 5 } } }];
    await run();
    let [t] = await tradesOf("BTC", HL);
    expect(t.status).toBe("open");
    expect(t.fills).toMatchObject([{ kind: "partial", price: 81000, size: 0.25 }]);

    hlFills.push({ coin: "BTC", px: "80800", sz: "0.25", side: "B", time: now - 3 * MIN, startPosition: "0.25", dir: "Open Long", closedPnl: "0", fee: "0.2", tid: 7003, oid: 801 });
    hlPositions = [{ position: { coin: "BTC", szi: "0.5", entryPx: "80400", liquidationPx: "60000", unrealizedPnl: "250", leverage: { type: "cross", value: 5 } } }];
    await run();
    [t] = await tradesOf("BTC", HL);
    expect(t.fills.map((f: any) => f.kind).sort()).toEqual(["add", "partial"]);
    expect(ref(t).addOrderIds).toEqual([801]);
  });

  it("closes the trade when the position is gone, and says how", async () => {
    hlFills.push({ coin: "BTC", px: "80000", sz: "0.5", side: "A", time: now - 2 * MIN, startPosition: "0.5", dir: "Close Long", closedPnl: "-100", fee: "0.4", tid: 7004, oid: 904 });
    hlPositions = [];
    hlOrders = [];
    await run();
    const [t] = await tradesOf("BTC", HL);
    expect(t.status).toBe("closed");
    expect(t.exitPrice).toBe(80000);
    expect(t.exitReason).toBe("breakeven");
    expect(ref(t).closedAt ?? t.exitTime).toBeTruthy();
    // Nothing more to read: the trade is off the watch.
    expect((await run()).accounts[0]).toMatchObject({ opened: [], read: 0 });
  });

  it("follows a Binance account with a read-only key, hedge mode included", async () => {
    const r = await send("PUT", "/api/account-settings", { name: BN, feeMode: "percent", makerFee: 0, takerFee: 0, binanceKey: KEY, binanceSecret: SECRET, track: true });
    expect(r.status).toBe(200);
    const saved = await r.json();
    expect(saved).toMatchObject({ binanceKeyHint: "…cdef", binanceTrade: false, track: true });

    const out = await run();
    const mine = out.accounts.find((a) => a.account === BN);
    expect(mine.error).toBeUndefined();
    expect(mine.opened).toHaveLength(2);

    const [eth] = await tradesOf("ETH", BN);
    expect(eth).toMatchObject({ direction: "short", size: 2, entryPrice: 3000, initialStop: 3100, initialTarget: 2800, status: "open", externalId: "binance:ETHUSDT:9001", paper: false });
    expect(ref(eth)).toMatchObject({ venue: "binance", env: "live", tracked: true, symbol: "ETHUSDT", positionSide: "SHORT", entryOrderId: 5000, stopOrderId: 6001, targetOrderIds: [6002], leverage: 10 });

    // The position older than the record: written from the position itself, with no entry order to point at.
    const [xrp] = await tradesOf("XRP", BN);
    expect(xrp).toMatchObject({ direction: "long", size: 100, entryPrice: 0.5, status: "open", initialStop: null, externalId: null });
    expect(ref(xrp)).toMatchObject({ tracked: true, entryOrderId: null, unprotected: true });
    expect(new Date(xrp.entryTime).getTime()).toBeGreaterThan(now - MIN);
  });

  it("writes an add on the short, then a stop-out through the venue's own bracket", async () => {
    bnFills.push({ symbol: "ETHUSDT", id: 9002, orderId: 5001, side: "SELL", positionSide: "SHORT", price: "3050", qty: "1", realizedPnl: "0", commission: "0.6", commissionAsset: "USDT", time: now - 10 * MIN, buyer: false, maker: false });
    bnOrders.push({ orderId: 5001, clientOrderId: "web_2", symbol: "ETHUSDT", side: "SELL", positionSide: "SHORT", type: "MARKET", status: "FILLED", price: "0", stopPrice: "0", origQty: "1", executedQty: "1", avgPrice: "3050", closePosition: false, reduceOnly: false, time: now - 10 * MIN, updateTime: now - 10 * MIN });
    bnPositions[0] = { ...bnPositions[0], positionAmt: "-3", entryPrice: "3016.67" };
    await run();
    let [eth] = await tradesOf("ETH", BN);
    expect(eth.fills).toMatchObject([{ kind: "add", price: 3050, size: 1 }]);
    expect(ref(eth).addOrderIds).toEqual([5001]);

    // The stop fires: the algo names the order it became, and the fills carry that id.
    bnAlgos[0] = { ...bnAlgos[0], algoStatus: "FINISHED", actualOrderId: "5002", triggerTime: now - 1 * MIN, updateTime: now - 1 * MIN };
    bnAlgos[1] = { ...bnAlgos[1], algoStatus: "CANCELED" };
    bnOrders.push({ orderId: 5002, clientOrderId: "web_sl_fired", symbol: "ETHUSDT", side: "BUY", positionSide: "SHORT", type: "MARKET", status: "FILLED", price: "0", stopPrice: "0", origQty: "3", executedQty: "3", avgPrice: "3101", closePosition: true, reduceOnly: false, time: now - 1 * MIN, updateTime: now - 1 * MIN });
    bnFills.push({ symbol: "ETHUSDT", id: 9003, orderId: 5002, side: "BUY", positionSide: "SHORT", price: "3101", qty: "3", realizedPnl: "-253", commission: "1.9", commissionAsset: "USDT", time: now - 1 * MIN, buyer: true, maker: false });
    bnPositions = bnPositions.filter((p) => p.symbol !== "ETHUSDT");
    await run();
    [eth] = await tradesOf("ETH", BN);
    expect(eth.status).toBe("closed");
    expect(eth.exitPrice).toBe(3101);
    expect(eth.exitReason).toBe("stop");
  });

  it("stops following an account when asked, and leaves what it wrote", async () => {
    await send("PUT", "/api/account-settings", { name: BN, feeMode: "percent", makerFee: 0, takerFee: 0, track: false });
    const out = await run();
    expect(out.accounts.map((a) => a.account)).toEqual([HL]);
    expect(await tradesOf("XRP", BN)).toHaveLength(1);
  });
});
