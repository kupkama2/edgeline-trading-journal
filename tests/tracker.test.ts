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
  // `crossed: false`: the fill rested on the book — a limit entry.
  { coin: "BTC", px: "80000", sz: "0.5", side: "B", time: now - 10 * MIN, startPosition: "0", dir: "Open Long", closedPnl: "0", fee: "0.4", tid: 7001, oid: 700, crossed: false },
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
/** Realised P&L rows, by which the tracker learns a symbol closed something. */
const bnIncome: { symbol: string; incomeType: string; income: string; time: number }[] = [];
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
        return json({ symbols: [sym("ETHUSDT", "ETH"), sym("XRPUSDT", "XRP"), sym("BTCUSDT", "BTC"), sym("SOLUSDT", "SOL")] });
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
        case "GET /fapi/v1/income":
          return json(bnIncome.filter((r) => r.time >= Number(params.startTime ?? 0) && r.time <= Number(params.endTime ?? Infinity)));
        case "GET /fapi/v1/userTrades": {
          // By order, by trade id onward, or by time — the three ways the venue can be asked.
          const mine = bnFills.filter((f) => f.symbol === params.symbol);
          if (params.orderId) return json(mine.filter((f) => f.orderId === Number(params.orderId)));
          if (params.fromId) return json(mine.filter((f) => f.id >= Number(params.fromId)).slice(0, Number(params.limit ?? 500)));
          return json(mine.filter((f) => f.time >= Number(params.startTime ?? 0)));
        }
        case "GET /fapi/v1/openOrders":
          return json(bnOrders.filter((o) => o.status === "NEW" && (!params.symbol || o.symbol === params.symbol)));
        case "GET /fapi/v1/openAlgoOrders":
          return json(bnAlgos.filter((a) => a.algoStatus === "NEW" && (!params.symbol || a.symbol === params.symbol)));
        case "GET /fapi/v1/allOrders":
          return json(bnOrders.filter((o) => o.symbol === params.symbol && o.time >= Number(params.startTime ?? 0)));
        case "GET /fapi/v1/allAlgoOrders":
          return json(bnAlgos.filter((a) => a.symbol === params.symbol && a.createTime >= Number(params.startTime ?? 0)));
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
    // The entry fill took liquidity (`maker: false`): a market entry.
    expect(eth.entryType).toBe("market");
    // Written from the position alone, there is no fill to say.
    expect((await tradesOf("XRP", BN))[0].entryType ?? null).toBeNull();

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

  it("takes the first stop and target a bare position gets as its idea, not as moves", async () => {
    // XRP went on with nothing resting. The brackets placed later are the plan, however late.
    bnAlgos.push(
      { algoId: 6101, clientAlgoId: "web_xrp_sl", symbol: "XRPUSDT", side: "SELL", positionSide: "LONG", orderType: "STOP_MARKET", algoType: "CONDITIONAL", algoStatus: "NEW", quantity: "0", triggerPrice: "0.48", closePosition: true, createTime: now, updateTime: now, triggerTime: 0, actualOrderId: "" },
      { algoId: 6102, clientAlgoId: "web_xrp_tp", symbol: "XRPUSDT", side: "SELL", positionSide: "LONG", orderType: "TAKE_PROFIT_MARKET", algoType: "CONDITIONAL", algoStatus: "NEW", quantity: "0", triggerPrice: "0.6", closePosition: true, createTime: now, updateTime: now, triggerTime: 0, actualOrderId: "" },
    );
    await run();
    let [xrp] = await tradesOf("XRP", BN);
    expect(xrp.initialStop).toBe(0.48);
    expect(xrp.initialTarget).toBe(0.6);
    expect(xrp.riskAmount).toBeCloseTo(2);
    let x = ref(xrp);
    expect(x.idea).toMatchObject({ stop: 0.48, targets: [0.6] });
    expect(x.moves ?? []).toEqual([]);
    expect(x.unprotected).toBe(false);
    // Now a change to a level it has: that is a move.
    bnAlgos.find((a) => a.algoId === 6101)!.triggerPrice = "0.49";
    await run();
    [xrp] = await tradesOf("XRP", BN);
    x = ref(xrp);
    expect(x.moves).toMatchObject([{ kind: "stop", from: 0.48, to: 0.49 }]);
    expect(xrp.initialStop).toBe(0.48);
  });

  it("reads the stop a position had first off the order history, when it meets the position after the stop was moved", async () => {
    // LINK went long 30 minutes ago with a stop at 140 and a target at 170; the stop was pulled up to 150
    // ten minutes later, and the target replaced at 175. Only then does the tracker meet it.
    bnPositions.push({ symbol: "LINKUSDT", positionSide: "LONG", positionAmt: "10", entryPrice: "155", markPrice: "158", unRealizedProfit: "30", leverage: "5", liquidationPrice: "100" });
    bnFills.push({ symbol: "LINKUSDT", id: 9301, orderId: 5300, side: "BUY", positionSide: "LONG", price: "155", qty: "10", realizedPnl: "0", commission: "0.8", commissionAsset: "USDT", time: now - 30 * MIN, buyer: true, maker: false });
    bnOrders.push({ orderId: 5300, clientOrderId: "web_link", symbol: "LINKUSDT", side: "BUY", positionSide: "LONG", type: "MARKET", status: "FILLED", price: "0", stopPrice: "0", origQty: "10", executedQty: "10", avgPrice: "155", closePosition: false, reduceOnly: false, time: now - 30 * MIN, updateTime: now - 30 * MIN });
    const sol = (algoId: number, orderType: string, triggerPrice: string, algoStatus: string, at: number) => ({ algoId, clientAlgoId: `web_${algoId}`, symbol: "LINKUSDT", side: "SELL", positionSide: "LONG", orderType, algoType: "CONDITIONAL", algoStatus, quantity: "0", triggerPrice, closePosition: true, createTime: at, updateTime: at, triggerTime: 0, actualOrderId: "" });
    bnAlgos.push(
      sol(6301, "STOP_MARKET", "140", "CANCELED", now - 30 * MIN + 5000),
      sol(6302, "TAKE_PROFIT_MARKET", "170", "CANCELED", now - 30 * MIN + 5000),
      sol(6303, "STOP_MARKET", "150", "NEW", now - 20 * MIN),
      sol(6304, "TAKE_PROFIT_MARKET", "175", "NEW", now - 19 * MIN),
    );
    // The same resting stop listed by the plain endpoint too, under an order id: still one stop.
    bnOrders.push({ orderId: 7303, clientOrderId: "web_6303", symbol: "LINKUSDT", side: "SELL", positionSide: "LONG", type: "STOP_MARKET", status: "NEW", price: "0", stopPrice: "150", origQty: "0", executedQty: "0", avgPrice: "0", closePosition: true, reduceOnly: false, time: now - 20 * MIN, updateTime: now - 20 * MIN });
    await run();
    const [t] = await tradesOf("LINK", BN);
    expect(t).toMatchObject({ direction: "long", size: 10, entryPrice: 155, initialStop: 140, initialTarget: 170, status: "open" });
    expect(t.riskAmount).toBeCloseTo(150);
    const x = ref(t);
    expect(x.idea).toMatchObject({ stop: 140, targets: [170] });
    expect(x.seen).toMatchObject({ stop: 150, targets: [175] });
    expect(x.stopOrderId).toBe(6303);
    expect(x.targetOrderIds).toEqual([6304]);
    expect(x.moves).toMatchObject([
      { kind: "stop", from: 140, to: 150, at: new Date(now - 20 * MIN).toISOString() },
      { kind: "target", from: 170, to: 175, at: new Date(now - 19 * MIN).toISOString() },
    ]);
    // The next pass sees nothing new.
    await run();
    expect(ref((await tradesOf("LINK", BN))[0]).moves).toHaveLength(2);
    // XRP's record already says its stop moved 0.48 → 0.49: the history read leaves it alone.
    const [xrp] = await tradesOf("XRP", BN);
    expect(ref(xrp).historyChecked).toBe(true);
    expect(ref(xrp).idea).toMatchObject({ stop: 0.48 });
    expect(ref(xrp).moves).toHaveLength(1);
  });

  it("repairs, once, a trade tracked before the history was read", async () => {
    // AVAX as a trade tracked by the earlier code: met after its stop was moved, idea = the stop seen, no moves.
    bnPositions.push({ symbol: "AVAXUSDT", positionSide: "LONG", positionAmt: "20", entryPrice: "40", markPrice: "41", unRealizedProfit: "20", leverage: "5", liquidationPrice: "20" });
    bnFills.push({ symbol: "AVAXUSDT", id: 9401, orderId: 5400, side: "BUY", positionSide: "LONG", price: "40", qty: "20", realizedPnl: "0", commission: "0.8", commissionAsset: "USDT", time: now - 40 * MIN, buyer: true, maker: false });
    const avax = (algoId: number, orderType: string, triggerPrice: string, algoStatus: string, at: number) => ({ algoId, clientAlgoId: `web_${algoId}`, symbol: "AVAXUSDT", side: "SELL", positionSide: "LONG", orderType, algoType: "CONDITIONAL", algoStatus, quantity: "0", triggerPrice, closePosition: true, createTime: at, updateTime: at, triggerTime: 0, actualOrderId: "" });
    bnAlgos.push(avax(6401, "STOP_MARKET", "36", "CANCELED", now - 40 * MIN + 3000), avax(6402, "STOP_MARKET", "39", "NEW", now - 25 * MIN));
    const old = await store.createTrade({
      symbol: "AVAX", direction: "long", size: 20, sizeUnit: "base", pointValue: 1, entryPrice: 40, initialStop: 39, initialTarget: null, riskAmount: 20,
      entryTime: new Date(now - 40 * MIN).toISOString(), status: "open", account: BN, externalId: "binance:AVAXUSDT:9401",
      terminal: JSON.stringify({ venue: "binance", env: "live", account: BN, symbol: "AVAXUSDT", positionSide: "LONG", tag: "trk-old", leverage: 5, qty: 20, entryOrderId: 5400, stopOrderId: 6402, targetOrderIds: [], closeOrderIds: [], addOrderIds: [], tracked: true, unprotected: false, idea: { entry: 40, stop: 39, targets: [], qty: 20, riskDollars: 20, at: new Date(now - 40 * MIN).toISOString() }, seen: { stop: 39, targets: [] } }),
    } as any);
    await run();
    const t = (await tradesOf("AVAX", BN)).find((x: any) => x.id === old.id);
    expect(t).toMatchObject({ initialStop: 36, riskAmount: 80 });
    const x = ref(t);
    expect(x.historyChecked).toBe(true);
    expect(x.idea).toMatchObject({ stop: 36 });
    expect(x.seen).toMatchObject({ stop: 39 });
    expect(x.moves).toMatchObject([{ kind: "stop", from: 36, to: 39, at: new Date(now - 25 * MIN).toISOString() }]);
    await run();
    expect(ref((await tradesOf("AVAX", BN)).find((y: any) => y.id === old.id)).moves).toHaveLength(1);
  });

  it("sums a multi-leg entry under one order, and starts a new trade when a position reopens between passes", async () => {
    // ETH on Hyperliquid: a market entry swept two levels — two fills, one order. One trade of 0.5, no add.
    hlFills.push(
      { coin: "ETH", px: "3000", sz: "0.3", side: "B", time: now - 8 * MIN, startPosition: "0", dir: "Open Long", closedPnl: "0", fee: "0.3", tid: 8001, oid: 900 },
      { coin: "ETH", px: "3002", sz: "0.2", side: "B", time: now - 8 * MIN + 10, startPosition: "0.3", dir: "Open Long", closedPnl: "0", fee: "0.2", tid: 8002, oid: 900 },
    );
    hlPositions = [{ position: { coin: "ETH", szi: "0.5", entryPx: "3000.8", liquidationPx: "2500", unrealizedPnl: "0", leverage: { type: "cross", value: 5 } } }];
    await run();
    let [eth] = await tradesOf("ETH", HL);
    expect(eth).toMatchObject({ size: 0.5, status: "open", externalId: "hl:ETH:8001" });
    expect(eth.entryPrice).toBeCloseTo(3000.8, 1);
    expect(ref(eth).addOrderIds).toEqual([]);
    expect(eth.fills).toEqual([]);

    // Closed in full, then bought again, both before the next pass: the first trade closes, a second begins.
    hlFills.push(
      { coin: "ETH", px: "3010", sz: "0.5", side: "A", time: now - 6 * MIN, startPosition: "0.5", dir: "Close Long", closedPnl: "4.6", fee: "0.5", tid: 8003, oid: 901 },
      { coin: "ETH", px: "3005", sz: "0.4", side: "B", time: now - 5 * MIN, startPosition: "0", dir: "Open Long", closedPnl: "0", fee: "0.4", tid: 8004, oid: 902 },
    );
    hlPositions = [{ position: { coin: "ETH", szi: "0.4", entryPx: "3005", liquidationPx: "2500", unrealizedPnl: "0", leverage: { type: "cross", value: 5 } } }];
    await run();
    const first = (await tradesOf("ETH", HL)).find((t: any) => t.externalId === "hl:ETH:8001");
    expect(first.status).toBe("closed");
    expect(first.exitPrice).toBe(3010);
    expect(first.fills).toEqual([]);
    await run();
    const second = (await tradesOf("ETH", HL)).find((t: any) => t.externalId === "hl:ETH:8004");
    expect(second).toMatchObject({ status: "open", size: 0.4, entryPrice: 3005 });
  });

  it("writes a round trip that opened and closed while nothing was watching, once, from where the last pass left off", async () => {
    // Both accounts have been read at least once: the next pass knows where it left off.
    const settings = await get("/api/account-settings");
    expect(settings.find((a: any) => a.name === BN).trackedThrough).toBeTruthy();
    expect(settings.find((a: any) => a.name === HL).trackedThrough).toBeTruthy();

    // Binance: SOL went long and flat again between passes, in hedge mode, with a take on the way. No position now.
    const t0 = Date.now() - 90_000;
    bnFills.push(
      { symbol: "SOLUSDT", id: 9101, orderId: 5101, side: "BUY", positionSide: "LONG", price: "150", qty: "4", realizedPnl: "0", commission: "0.2", commissionAsset: "USDT", time: t0, buyer: true, maker: false },
      { symbol: "SOLUSDT", id: 9102, orderId: 5102, side: "SELL", positionSide: "LONG", price: "155", qty: "2", realizedPnl: "10", commission: "0.1", commissionAsset: "USDT", time: t0 + 20_000, buyer: false, maker: false },
      { symbol: "SOLUSDT", id: 9103, orderId: 5103, side: "SELL", positionSide: "LONG", price: "152", qty: "2", realizedPnl: "4", commission: "0.1", commissionAsset: "USDT", time: t0 + 40_000, buyer: false, maker: false },
    );
    bnIncome.push({ symbol: "SOLUSDT", incomeType: "REALIZED_PNL", income: "14", time: t0 + 40_000 });
    // Hyperliquid: DOGE in and out between passes.
    hlFills.push(
      { coin: "DOGE", px: "0.2", sz: "1000", side: "B", time: t0, startPosition: "0", dir: "Open Long", closedPnl: "0", fee: "0.1", tid: 9201, oid: 1201 },
      { coin: "DOGE", px: "0.21", sz: "1000", side: "A", time: t0 + 30_000, startPosition: "1000", dir: "Close Long", closedPnl: "10", fee: "0.1", tid: 9202, oid: 1202 },
    );
    await send("PUT", "/api/account-settings", { name: BN, feeMode: "percent", makerFee: 0, takerFee: 0, track: true });
    const out = await run();
    const bn = out.accounts.find((a) => a.account === BN);
    const hl = out.accounts.find((a) => a.account === HL);
    expect(bn.caughtUp).toHaveLength(1);
    expect(hl.caughtUp).toHaveLength(1);

    const [sol] = await tradesOf("SOL", BN);
    expect(sol).toMatchObject({ direction: "long", size: 4, entryPrice: 150, status: "closed", exitPrice: 152, externalId: "binance:SOLUSDT:9101" });
    expect(ref(sol).tracked).toBe(true);
    expect(sol.fills).toMatchObject([{ kind: "partial", price: 155, size: 2 }]);
    const [doge] = await tradesOf("DOGE", HL);
    expect(doge).toMatchObject({ direction: "long", size: 1000, status: "closed", exitPrice: 0.21, externalId: "hl:DOGE:9201" });

    // The same fills again: nothing written twice.
    const again = await run();
    expect(again.accounts.find((a) => a.account === BN).caughtUp).toEqual([]);
    expect(again.accounts.find((a) => a.account === HL).caughtUp).toEqual([]);
    expect(await tradesOf("SOL", BN)).toHaveLength(1);
    expect(await tradesOf("DOGE", HL)).toHaveLength(1);
  });

  it("reads how past trades were entered from the venues, and fills only the blanks", async () => {
    // A synced Binance trade from before entry types: the external id names its first fill, which leads to its order.
    // The order rested for most of its size and crossed for a sliver: a limit entry.
    bnFills.push(
      { symbol: "LINKUSDT", id: 9500, orderId: 5500, side: "BUY", positionSide: "BOTH", price: "150", qty: "9", realizedPnl: "0", commission: "0.1", commissionAsset: "USDT", time: now - 3 * 86400_000, buyer: true, maker: true },
      { symbol: "LINKUSDT", id: 9501, orderId: 5500, side: "BUY", positionSide: "BOTH", price: "150.1", qty: "1", realizedPnl: "0", commission: "0.1", commissionAsset: "USDT", time: now - 3 * 86400_000 + 1, buyer: true, maker: false },
    );
    const sol = await store.createTrade({
      symbol: "LINK", direction: "long", size: 10, sizeUnit: "base", pointValue: 1, entryPrice: 150, initialStop: 145, initialTarget: 160,
      entryTime: new Date(now - 3 * 86400_000).toISOString(), status: "closed", exitPrice: 158, exitTime: new Date(now - 2 * 86400_000).toISOString(),
      account: BN, externalId: "binance:LINKUSDT:9500",
    });
    // The tracked ETH short as it was before entry types: its ref keeps the entry order.
    const [eth] = await tradesOf("ETH", BN);
    await store.updateTrade(eth.id, { entryType: null });
    // A trade a person marked keeps the mark, whatever the venue would say.
    const marked = await store.createTrade({
      symbol: "LINK", direction: "long", size: 10, sizeUnit: "base", pointValue: 1, entryPrice: 150, initialStop: 145, initialTarget: 160,
      entryTime: new Date(now - 3 * 86400_000).toISOString(), status: "closed", exitPrice: 158, exitTime: new Date(now - 2 * 86400_000).toISOString(),
      account: BN, entryType: "market",
    });
    // Logged by hand on an account with no venue: nothing to ask.
    await store.createTrade({
      symbol: "NQ", direction: "long", size: 1, sizeUnit: "base", pointValue: 20, entryPrice: 100, initialStop: 90, initialTarget: 130,
      entryTime: new Date(now - 86400_000).toISOString(), status: "closed", exitPrice: 120, exitTime: new Date(now - 86000_000).toISOString(), account: "Futures",
    });

    const r = await send("POST", "/api/trades/entry-types");
    expect(r.status).toBe(200);
    const out = await r.json();
    expect(out.errors).toEqual([]);
    expect(out.filled).toBeGreaterThanOrEqual(3);
    expect(out.noVenue).toBeGreaterThanOrEqual(1);

    expect((await store.getTrade(sol.id)).entryType).toBe("limit");
    expect((await store.getTrade(eth.id)).entryType).toBe("market");
    expect((await store.getTrade(marked.id)).entryType).toBe("market");
    // The Hyperliquid BTC long the sync wrote and the tracker took under watch: its first fill rested.
    const [btc] = await tradesOf("BTC", HL);
    expect(btc.entryType).toBe("limit");

    // Asked again, nothing is left to fill.
    const again = await (await send("POST", "/api/trades/entry-types")).json();
    expect(again.filled).toBe(0);
  });

  it("stops following an account when asked, and leaves what it wrote", async () => {
    await send("PUT", "/api/account-settings", { name: BN, feeMode: "percent", makerFee: 0, takerFee: 0, track: false });
    const out = await run();
    expect(out.accounts.map((a) => a.account)).toEqual([HL]);
    expect(await tradesOf("XRP", BN)).toHaveLength(1);
  });
});
