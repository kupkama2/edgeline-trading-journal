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
/** The "xyz" builder book (HIP-3): asked for by name, or the venue answers for its own book only. */
let xyzPositions: any[] = [];
let xyzOrders: any[] = [];

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
            if (q.user !== WALLET) return json({ assetPositions: [] });
            if (q.dex === "xyz") return json({ assetPositions: xyzPositions, marginSummary: {} });
            return json({ assetPositions: q.dex ? [] : hlPositions, marginSummary: {} });
          case "frontendOpenOrders":
            if (q.user !== WALLET) return json([]);
            if (q.dex === "xyz") return json(xyzOrders);
            return json(q.dex ? [] : hlOrders);
          case "userFillsByTime":
            return json(q.user === WALLET ? hlFills.filter((f) => f.time >= Number(q.startTime ?? 0)) : []);
          case "userFills":
            return json(q.user === WALLET ? hlFills : []);
          case "allMids":
            if (q.dex === "xyz") return json({ "xyz:XYZ100": "28400" });
            return json(q.dex ? {} : { BTC: hlMid, ETH: "3000" });
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

  it("follows the wallet onto a builder book: a round trip there is written, and a position there is tracked with its stop", async () => {
    const t0 = Date.now() - 90_000;
    // Opened and closed between passes on xyz, as in the report: a short in and out.
    hlFills.push(
      { coin: "xyz:XYZ100", px: "28354", sz: "0.5134", side: "A", time: t0, startPosition: "0", dir: "Open Short", closedPnl: "0", fee: "0.42", tid: 9301, oid: 1301, crossed: true },
      { coin: "xyz:XYZ100", px: "28420", sz: "0.5134", side: "B", time: t0 + 20_000, startPosition: "-0.5134", dir: "Close Short", closedPnl: "-33.9", fee: "0.4", tid: 9302, oid: 1302, crossed: true },
    );
    const out = await run();
    const hl = out.accounts.find((a) => a.account === HL);
    expect(hl.error).toBeUndefined();
    expect(hl.caughtUp).toHaveLength(1);
    // Written under the coin's own name, with the book it trades on, as the sync writes it.
    const [round] = await tradesOf("XYZ100", HL);
    expect(round).toMatchObject({ direction: "short", status: "closed", entryPrice: 28354, exitPrice: 28420, externalId: "hl:xyz:XYZ100:9301", pricePair: "hyperliquid:xyz:XYZ100" });

    // Now one held there, with a stop resting on the same book.
    hlFills.push({ coin: "xyz:XYZ100", px: "28300", sz: "0.4", side: "A", time: Date.now() - 30_000, startPosition: "0", dir: "Open Short", closedPnl: "0", fee: "0.3", tid: 9303, oid: 1303, crossed: false });
    xyzPositions = [{ position: { coin: "xyz:XYZ100", szi: "-0.4", entryPx: "28300", liquidationPx: "40000", unrealizedPnl: "-40", leverage: { type: "isolated", value: 10 } } }];
    xyzOrders = [{ coin: "xyz:XYZ100", oid: 1304, side: "B", limitPx: "28800", sz: "0.4", isTrigger: true, triggerPx: "28800", orderType: "Stop Market", reduceOnly: true, isPositionTpsl: true, timestamp: Date.now() - 20_000 }];
    const out2 = await run();
    const hl2 = out2.accounts.find((a) => a.account === HL);
    expect(hl2.error).toBeUndefined();
    const open = (await tradesOf("XYZ100", HL)).find((t: any) => t.status === "open");
    expect(open).toMatchObject({ direction: "short", size: 0.4, entryPrice: 28300, initialStop: 28800, externalId: "hl:xyz:XYZ100:9303", pricePair: "hyperliquid:xyz:XYZ100", entryType: "limit" });
    expect(ref(open)).toMatchObject({ venue: "hyperliquid", symbol: "xyz:XYZ100", positionSide: "SHORT", stopOrderId: 1304, tracked: true });
    // The main book's positions are not read twice for asking the builder book too.
    expect((await tradesOf("BTC", HL)).filter((t: any) => t.status === "open").length).toBeLessThanOrEqual(1);

    // Flat again on xyz: the trade closes on the next pass, at the closing fill.
    hlFills.push({ coin: "xyz:XYZ100", px: "28800", sz: "0.4", side: "B", time: Date.now() - 5_000, startPosition: "-0.4", dir: "Close Short", closedPnl: "-200", fee: "0.3", tid: 9304, oid: 1304, crossed: true });
    xyzPositions = [];
    xyzOrders = [];
    await run();
    const closed = (await tradesOf("XYZ100", HL)).find((t: any) => t.externalId === "hl:xyz:XYZ100:9303");
    expect(closed).toMatchObject({ status: "closed", exitPrice: 28800 });
  });

  it("splits round trips on one coin into separate trades, whether or not a pass saw each one go flat", async () => {
    const F = "FARTCOIN";
    const T0 = Date.now() - 100 * MIN;
    const fill = (tid: number, oid: number, side: "B" | "A", px: string, sz: string, start: string, at: number, dir: string) =>
      ({ coin: F, px, sz, side, time: at, startPosition: start, dir, closedPnl: "0", fee: "1", tid, oid, crossed: true });
    const pos = (szi: string) => [{ position: { coin: F, szi, entryPx: "0.09", liquidationPx: "0.05", unrealizedPnl: "0", leverage: { type: "cross", value: 10 } } }];
    const stopAt = (oid: number, px: string, sz: string) => [{ coin: F, oid, side: "A", limitPx: px, sz, isTrigger: true, triggerPx: px, orderType: "Stop Market", reduceOnly: true, isPositionTpsl: true, timestamp: T0 }];
    const keepMain = hlPositions.filter((p) => p.position.coin !== F);
    const keepOrders = hlOrders.filter((o) => o.coin !== F);

    // The first trade, watched all the way: an entry, two adds, a take.
    hlFills.push(fill(9601, 1601, "B", "0.094", "60000.3", "0", T0, "Open Long"));
    hlPositions = [...keepMain, ...pos("60000.3")];
    hlOrders = [...keepOrders, ...stopAt(1690, "0.085", "60000.3")];
    await run();
    hlFills.push(fill(9602, 1602, "B", "0.0905", "50000.7", "60000.3", T0 + 5 * MIN, "Open Long"), fill(9603, 1603, "B", "0.0885", "79999.9", "110001", T0 + 8 * MIN, "Open Long"));
    hlPositions = [...keepMain, ...pos("190000.9")];
    await run();
    hlFills.push(fill(9604, 1604, "A", "0.0915", "27663.3", "190000.9", T0 + 12 * MIN, "Close Long"));
    hlPositions = [...keepMain, ...pos("162337.6")];
    await run();
    const first = (await tradesOf(F, HL)).find((t: any) => t.externalId === "hl:FARTCOIN:9601");
    expect(first).toMatchObject({ status: "open" });

    // Then nothing watches for an hour and a half: flat, a round trip in three opens and one close, and a new position on.
    hlFills.push(
      fill(9605, 1605, "A", "0.08784", "162337.6", "162337.6", T0 + 20 * MIN, "Close Long"),
      fill(9606, 1606, "B", "0.08803", "56837.5", "0", T0 + 62 * MIN, "Open Long"),
      fill(9607, 1607, "B", "0.0891", "58966.9", "56837.5", T0 + 68 * MIN, "Open Long"),
      fill(9608, 1607, "B", "0.0891", "53266.5", "115804.4", T0 + 68 * MIN, "Open Long"),
      fill(9609, 1609, "A", "0.08867", "169070.9", "169070.9", T0 + 69 * MIN, "Close Long"),
      fill(9610, 1610, "B", "0.08852", "105810.9", "0", T0 + 83 * MIN, "Open Long"),
      fill(9611, 1610, "B", "0.08854", "7696.4", "105810.9", T0 + 83 * MIN, "Open Long"),
    );
    hlPositions = [...keepMain, ...pos("113507.3")];
    hlOrders = [...keepOrders, ...stopAt(1691, "0.0877", "113507.3")];
    await run();
    await run();

    const all = await tradesOf(F, HL);
    const by = (id: string) => all.find((t: any) => t.externalId === id);
    // The first closes where it went flat, with its own adds and take and nothing after.
    expect(by("hl:FARTCOIN:9601")).toMatchObject({ status: "closed", exitPrice: 0.08784 });
    expect(by("hl:FARTCOIN:9601").fills.map((f: any) => f.kind).sort()).toEqual(["add", "add", "partial"]);
    // The round trip no pass saw is its own trade.
    expect(by("hl:FARTCOIN:9606")).toMatchObject({ status: "closed", exitPrice: 0.08867 });
    expect(by("hl:FARTCOIN:9606").size).toBeCloseTo(169070.9, 6);
    // And the position on now is a third.
    expect(by("hl:FARTCOIN:9610")).toMatchObject({ status: "open" });
    expect(by("hl:FARTCOIN:9610").size).toBeCloseTo(113507.3, 6);
    expect(all.filter((t: any) => t.status === "open")).toHaveLength(1);

    hlPositions = keepMain;
    hlOrders = keepOrders;
  });

  it("closes a trade it met already open where that position went flat, though its opening is older than the fills it reads", async () => {
    const P = "PUMP";
    const fill = (tid: number, oid: number, side: "B" | "A", px: string, sz: string, start: string, at: number, dir: string) =>
      ({ coin: P, px, sz, side, time: at, startPosition: start, dir, closedPnl: "0", fee: "1", tid, oid, crossed: true });
    const pos = (szi: string, entryPx: string) => [{ position: { coin: P, szi, entryPx, liquidationPx: "0.001", unrealizedPnl: "0", leverage: { type: "cross", value: 5 } } }];
    const keepMain = hlPositions.filter((p) => p.position.coin !== P);

    // Bought eight days ago, beyond the week of fills a pass reads: the tracker meets it with no opening to read.
    hlFills.push(fill(9701, 1701, "B", "0.0924", "108225.1", "0", Date.now() - 8 * 24 * 60 * MIN, "Open Long"));
    hlPositions = [...keepMain, ...pos("108225.1", "0.092416")];
    await run();
    const [met] = await tradesOf(P, HL);
    expect(met).toMatchObject({ status: "open", entryPrice: 0.092416 });
    expect(met.size).toBeCloseTo(108225.1, 6);

    // A take while watched; then, unwatched, flat, a round trip, and a new position. All after it was met.
    const T0 = Date.now() + 1_000;
    const S = 1_000;
    hlFills.push(fill(9702, 1702, "A", "0.0915", "20000", "108225.1", T0, "Close Long"));
    hlPositions = [...keepMain, ...pos("88225.1", "0.092416")];
    await run();
    hlFills.push(
      fill(9703, 1703, "A", "0.08784", "88225.1", "88225.1", T0 + 20 * S, "Close Long"),
      fill(9704, 1704, "B", "0.08803", "56837.5", "0", T0 + 62 * S, "Open Long"),
      fill(9705, 1705, "A", "0.08867", "56837.5", "56837.5", T0 + 69 * S, "Close Long"),
      fill(9706, 1706, "B", "0.08852", "105810.9", "0", T0 + 83 * S, "Open Long"),
    );
    hlPositions = [...keepMain, ...pos("105810.9", "0.08852")];
    // What the old read wrote into it, never having seen the flat: the later round trips as its takes and adds.
    await store.addFill(met.id, { kind: "add", price: 0.08803, size: 56837.5, time: new Date(T0 + 62 * S).toISOString(), note: "terminal · add 9704" });
    await store.addFill(met.id, { kind: "partial", price: 0.08867, size: 56837.5, time: new Date(T0 + 69 * S).toISOString(), note: "terminal · fill 9705" });
    await run();
    await run();

    const all = await tradesOf(P, HL);
    const first = all.find((t: any) => t.id === met.id);
    expect(first).toMatchObject({ status: "closed", exitPrice: 0.08784 });
    expect(first.fills.map((f: any) => f.kind)).toEqual(["partial"]);
    expect(all.find((t: any) => t.externalId === "hl:PUMP:9704")).toMatchObject({ status: "closed", exitPrice: 0.08867 });
    expect(all.find((t: any) => t.externalId === "hl:PUMP:9706")).toMatchObject({ status: "open", entryPrice: 0.08852 });
    expect(all.filter((t: any) => t.status === "open")).toHaveLength(1);
    hlPositions = keepMain;
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

  it("NVDA-style: a market entry in pieces, an add, closed by a market order in pieces — closes once, at the right size", async () => {
    const C = "xyz:NVDA";
    const T = Date.now() - 40 * MIN;
    const f = (tid: number, oid: number, side: "B" | "A", px: string, sz: string, start: string, at: number, pnl = "0") =>
      ({ coin: C, px, sz, side, time: at, startPosition: start, dir: side === "B" ? "Open Long" : "Close Long", closedPnl: pnl, fee: "0.05", tid, oid, crossed: true });
    const keepX = xyzPositions.filter((p) => p.position.coin !== C);
    // Entry: one market order, two fills on one stamp. Then an add, one fill.
    hlFills.push(f(9801, 1801, "B", "180.00", "1", "0", T), f(9802, 1801, "B", "180.10", "2", "1", T));
    xyzPositions = [...keepX, { position: { coin: C, szi: "3", entryPx: "180.07", liquidationPx: "100", unrealizedPnl: "0", leverage: { type: "cross", value: 5 } } }];
    xyzOrders = [{ coin: C, oid: 1890, side: "A", limitPx: "178", sz: "3", isTrigger: true, triggerPx: "178", orderType: "Stop Market", reduceOnly: true, isPositionTpsl: true, timestamp: T }];
    await run();
    hlFills.push(f(9803, 1802, "B", "181.00", "2", "3", T + 5 * MIN));
    xyzPositions = [...keepX, { position: { coin: C, szi: "5", entryPx: "180.44", liquidationPx: "100", unrealizedPnl: "0", leverage: { type: "cross", value: 5 } } }];
    await run();
    let t = (await tradesOf("NVDA", HL)).find((x: any) => x.externalId === "hl:xyz:NVDA:9801");
    // Closed by one market order: three fills on one stamp, ids against their order.
    hlFills.push(
      f(9806, 1803, "A", "179.90", "1.5", "5", T + 10 * MIN, "-0.8"),
      f(9805, 1803, "A", "179.85", "2", "3.5", T + 10 * MIN, "-1.2"),
      f(9804, 1803, "A", "179.80", "1.5", "1.5", T + 10 * MIN, "-1.0"),
    );
    xyzPositions = keepX;
    xyzOrders = [];
    await run();
    t = await get(`/api/trades/${t.id}`);
    const { computeMetrics } = await import("../shared/metrics");
    const m = computeMetrics(t);
    expect(t.status).toBe("closed");
    // Entered 1 @ 180 + 2 @ 180.10, added 2 @ 181, out 1.5 @ 179.90, 2 @ 179.85, 1.5 @ 179.80.
    expect(m.grossPnL).toBeCloseTo(-2.95, 6);
  });

  it("claims a trade logged by hand on the entry card for the position, rather than writing a second one beside it", async () => {
    const C = "xyz:AMD";
    const T = Date.now() - 30 * MIN;
    const keepX = xyzPositions.filter((p) => p.position.coin !== C);
    // Logged by hand a minute after the fill, with no account picked, the stop and target typed in.
    const hand = await store.createTrade({ symbol: "AMD", direction: "long", size: 4, sizeUnit: "base", pointValue: 1, entryPrice: 150, initialStop: 148, initialTarget: 155, entryTime: new Date(T + 60_000).toISOString(), status: "open", account: "" });
    hlFills.push({ coin: C, px: "150.02", sz: "4", side: "B", time: T, startPosition: "0", dir: "Open Long", closedPnl: "0", fee: "0.05", tid: 9901, oid: 1901, crossed: true });
    xyzPositions = [...keepX, { position: { coin: C, szi: "4", entryPx: "150.02", liquidationPx: "100", unrealizedPnl: "0", leverage: { type: "cross", value: 5 } } }];
    await run();
    const amd = (await get("/api/trades")).filter((t: any) => t.symbol === "AMD");
    expect(amd).toHaveLength(1);
    expect(amd[0]).toMatchObject({ id: hand.id, account: HL, externalId: "hl:xyz:AMD:9901", initialStop: 148, initialTarget: 155, pricePair: "hyperliquid:xyz:AMD" });
    expect(ref(amd[0])).toMatchObject({ tracked: true, symbol: C });
    // And it closes with the venue, so nothing is left open to count twice.
    hlFills.push({ coin: C, px: "149", sz: "4", side: "A", time: T + 10 * MIN, startPosition: "4", dir: "Close Long", closedPnl: "-4.08", fee: "0.05", tid: 9902, oid: 1902, crossed: true });
    xyzPositions = keepX;
    await run();
    const after = (await get("/api/trades")).filter((t: any) => t.symbol === "AMD");
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: "closed", exitPrice: 149 });
  });

  it("the sync leaves a tracked trade to the tracker: an add is counted once, and the trade still closes", async () => {
    const C = "xyz:TSLA";
    const T = Date.now() - 30 * MIN;
    const f = (tid: number, oid: number, side: "B" | "A", px: string, sz: string, start: string, at: number, pnl = "0") =>
      ({ coin: C, px, sz, side, time: at, startPosition: start, dir: "x", closedPnl: pnl, fee: "0.05", tid, oid, crossed: true });
    const keepX = xyzPositions.filter((p) => p.position.coin !== C);
    hlFills.push(f(9911, 1911, "B", "400", "1", "0", T));
    xyzPositions = [...keepX, { position: { coin: C, szi: "1", entryPx: "400", liquidationPx: "100", unrealizedPnl: "0", leverage: { type: "cross", value: 5 } } }];
    xyzOrders = [{ coin: C, oid: 1990, side: "A", limitPx: "390", sz: "1", isTrigger: true, triggerPx: "390", orderType: "Stop Market", reduceOnly: true, isPositionTpsl: true, timestamp: T }];
    await run();
    hlFills.push(f(9912, 1912, "B", "402", "1", "1", T + 2 * MIN));
    xyzPositions = [...keepX, { position: { coin: C, szi: "2", entryPx: "401", liquidationPx: "100", unrealizedPnl: "0", leverage: { type: "cross", value: 5 } } }];
    await run();
    expect((await send("POST", "/api/hyperliquid/sync", { account: HL })).status).toBe(200);
    let t = (await get("/api/trades")).find((x: any) => x.externalId === "hl:xyz:TSLA:9911");
    t = await get(`/api/trades/${t.id}`);
    // The entry stays the entry; the add is the one row in the ledger, not folded into the size as well.
    expect(t.size).toBe(1);
    expect(t.fills.filter((x: any) => x.kind === "add").map((x: any) => x.size)).toEqual([1]);
    hlFills.push(f(9913, 1913, "A", "395", "2", "2", T + 5 * MIN, "-12"));
    xyzPositions = keepX;
    xyzOrders = [];
    await run();
    t = await get(`/api/trades/${t.id}`);
    const { computeMetrics } = await import("../shared/metrics");
    expect(t.status).toBe("closed");
    expect(computeMetrics(t).grossPnL).toBeCloseTo(-12, 6);
  });

  it("a position met before its fills learns its entry from them once they arrive: right size, and it closes", async () => {
    const { computeMetrics } = await import("../shared/metrics");
    // The fill arriving just after the position is seen, and one dated well before it.
    for (const [C, lag, base] of [["xyz:META", 2_000, 9920], ["xyz:MSFT", 60_000, 9930]] as const) {
      const keepX = xyzPositions.filter((p) => p.position.coin !== C);
      const name = C.split(":")[1];
      xyzPositions = [...keepX, { position: { coin: C, szi: "3", entryPx: "500", liquidationPx: "100", unrealizedPnl: "0", leverage: { type: "cross", value: 5 } } }];
      await run();
      let t = (await get("/api/trades")).find((x: any) => x.symbol === name && x.status === "open");
      expect(ref(t).entryOrderId).toBeNull();
      const T = new Date(t.entryTime).getTime() - lag;
      const f = (tid: number, side: "B" | "A", px: string, start: string, at: number, pnl = "0") =>
        ({ coin: C, px, sz: "3", side, time: at, startPosition: start, dir: "x", closedPnl: pnl, fee: "0.05", tid, oid: tid, crossed: true });
      hlFills.push(f(base + 1, "B", "500", "0", T));
      await run();
      t = await get(`/api/trades/${t.id}`);
      // Not an add on top of the position: the entry.
      expect(t.size).toBe(3);
      expect(t.fills ?? []).toEqual([]);
      expect(ref(t).entryOrderId).toBe(base + 1);
      expect(t.externalId).toBe(`hl:${C}:${base + 1}`);
      hlFills.push(f(base + 2, "A", "498", "3", Date.now() - 1000, "-6"));
      xyzPositions = keepX;
      await run();
      t = await get(`/api/trades/${t.id}`);
      expect(t).toMatchObject({ status: "closed", size: 3, exitPrice: 498 });
      expect(computeMetrics(t).grossPnL).toBeCloseTo(-6, 6);
    }
  });

  it("repairs a trade already stuck that way: the opening fill in the ledger as an add, the close as a take", async () => {
    const C = "xyz:NFLX";
    const T = Date.now() - 20 * MIN;
    const seen = T + 2_000;
    const keepX = xyzPositions.filter((p) => p.position.coin !== C);
    const stuckRef = { venue: "hyperliquid", env: "live", account: HL, symbol: C, positionSide: "LONG", tag: "trk-stuck", leverage: 5, qty: 2, entryOrderId: null, stopOrderId: null, targetOrderIds: [], closeOrderIds: [], addOrderIds: [9941], tracked: true, idea: { entry: 100, stop: null, targets: [], qty: 2, riskDollars: null, at: new Date(seen).toISOString() } };
    const stuck = await store.createTrade({ symbol: "NFLX", pricePair: "hyperliquid:xyz:NFLX", direction: "long", size: 2, sizeUnit: "base", pointValue: 1, entryPrice: 100, entryTime: new Date(seen).toISOString(), status: "open", account: HL, terminal: JSON.stringify(stuckRef) });
    await store.addFill(stuck.id, { kind: "add", price: 100, size: 2, time: new Date(T).toISOString(), note: "terminal · add 9941" });
    await store.addFill(stuck.id, { kind: "partial", price: 99, size: 2, time: new Date(T + 5 * MIN).toISOString(), note: "terminal · fill 9942" });
    hlFills.push(
      { coin: C, px: "100", sz: "2", side: "B", time: T, startPosition: "0", dir: "Open Long", closedPnl: "0", fee: "0.05", tid: 9941, oid: 9941, crossed: true },
      { coin: C, px: "99", sz: "2", side: "A", time: T + 5 * MIN, startPosition: "2", dir: "Close Long", closedPnl: "-2", fee: "0.05", tid: 9942, oid: 9942, crossed: true },
    );
    xyzPositions = keepX;
    await run();
    const t = await get(`/api/trades/${stuck.id}`);
    const { computeMetrics } = await import("../shared/metrics");
    expect(t).toMatchObject({ status: "closed", size: 2, exitPrice: 99 });
    expect(t.fills ?? []).toEqual([]);
    expect(computeMetrics(t).grossPnL).toBeCloseTo(-2, 6);
  });
});
