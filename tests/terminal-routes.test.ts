import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";

/**
 * The terminal against a stub Binance: a plan sent, the orders that leave
 * the server, the journal trade that appears, and the trade following the
 * venue through a fill, a moved stop and a stop-out.
 *
 * The venue is a toy with a book: it hands out order ids, remembers what
 * rests, and lets the test fill an order by hand. Every signed call is
 * checked the way the real one would be.
 */
const DB = process.env.DATABASE_URL;
if (process.env.CI && !DB) throw new Error("DATABASE_URL is required in CI — the terminal tests must run");

const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const KEY = "terminalkey0123456789abcdef";
const SECRET = "terminalsecret0123456789abcdef";
const EMAIL = `term-${stamp}@x.test`;
const ACCOUNT = "Binance Testnet";

let venue: Server;
let app: Server;
let base = "";

/* ------------------------------ the stub venue ------------------------------ */

interface StubOrder {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  side: string;
  positionSide: string;
  type: string;
  status: string;
  price: string;
  stopPrice: string;
  origQty: string;
  executedQty: string;
  avgPrice: string;
  closePosition: boolean;
  reduceOnly: boolean;
  time: number;
  updateTime: number;
}
const orders: StubOrder[] = [];
/** Conditional orders live on the venue's algo endpoints, in their own words. */
const algos: any[] = [];
const ALGO = new Set(["STOP_MARKET", "TAKE_PROFIT_MARKET"]);
/** Everything resting under a tag, plain and conditional. */
const restingFor = (tag: string) => [
  ...orders.filter((o) => o.status === "NEW" && o.clientOrderId.startsWith(tag)),
  ...algos.filter((a) => a.algoStatus === "NEW" && String(a.clientAlgoId).startsWith(tag)),
];
const fills: any[] = [];
const position = { amt: 0, entryPrice: 0 };
let dual = true;
let nextId = 100;
let nextTid = 5000;
/** Every signed call, in order: method, path, params. */
const calls: { method: string; path: string; params: Record<string, string> }[] = [];

/** The test's hand on the venue: fill an order, and move the position accordingly. */
function fillOrder(orderId: number, price: number, qty?: number) {
  // A conditional order that fires places a plain order of its own; the
  // fills carry that order's id and the algo record points at it.
  const a = algos.find((x) => x.algoId === orderId);
  if (a) {
    const spawned: StubOrder = {
      orderId: nextId++, clientOrderId: "", symbol: a.symbol, side: a.side, positionSide: a.positionSide, type: "MARKET", status: "NEW",
      price: "0", stopPrice: "0", origQty: a.quantity, executedQty: "0", avgPrice: "0", closePosition: a.closePosition, reduceOnly: false,
      time: Date.now(), updateTime: Date.now(),
    };
    orders.push(spawned);
    a.orderId = spawned.orderId;
    a.algoStatus = "FILLED";
    a.updateTime = Date.now();
    return fillOrder(spawned.orderId, price, qty);
  }
  const o = orders.find((x) => x.orderId === orderId)!;
  const q = qty ?? (o.closePosition ? Math.abs(position.amt) : Number(o.origQty));
  o.status = "FILLED";
  o.executedQty = String(q);
  o.avgPrice = String(price);
  o.updateTime = Date.now();
  const sign = o.side === "BUY" ? 1 : -1;
  const before = position.amt;
  position.amt = Number((before + sign * q).toFixed(6));
  if (before === 0) position.entryPrice = price;
  fills.push({
    symbol: o.symbol, id: nextTid++, orderId, side: o.side, positionSide: o.positionSide, price: String(price), qty: String(q),
    realizedPnl: before !== 0 ? String(sign * -1 * (price - position.entryPrice) * q) : "0",
    commission: "0.02", commissionAsset: "USDT", time: Date.now(), buyer: o.side === "BUY", maker: false,
  });
}

function startVenue(): Promise<string> {
  return new Promise((resolve) => {
    venue = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      const json = (x: unknown, status = 200) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(x));
      };
      if (u.pathname === "/fapi/v1/exchangeInfo") {
        return json({
          symbols: [
            {
              symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "TRADING", contractType: "PERPETUAL", pricePrecision: 1, quantityPrecision: 3,
              filters: [
                { filterType: "PRICE_FILTER", tickSize: "0.10" },
                { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
                { filterType: "MIN_NOTIONAL", notional: "100" },
              ],
            },
          ],
        });
      }
      if (u.pathname === "/api/v3/exchangeInfo") return json({ symbols: [] });

      const key = req.headers["x-mbx-apikey"] as string | undefined;
      const sig = u.searchParams.get("signature") ?? "";
      u.searchParams.delete("signature");
      const query = u.search.slice(1);
      const expected = key === KEY ? createHmac("sha256", SECRET).update(query).digest("hex") : "";
      const signed = key === KEY && sig === expected && Math.abs(Number(u.searchParams.get("timestamp")) - Date.now()) < 60_000;
      if (!signed) return json({ code: -2015, msg: "Invalid API-key, IP, or permissions for action." }, 401);
      const params = Object.fromEntries(u.searchParams.entries());
      calls.push({ method: req.method ?? "GET", path: u.pathname, params });

      switch (`${req.method} ${u.pathname}`) {
        case "GET /fapi/v2/balance":
          return json([{ asset: "USDT", balance: "10000", availableBalance: "9800" }]);
        case "GET /fapi/v1/positionSide/dual":
          return json({ dualSidePosition: dual });
        case "POST /fapi/v1/positionSide/dual":
          dual = params.dualSidePosition === "true";
          return json({ code: 200, msg: "success" });
        case "POST /fapi/v1/leverage":
          return json({ symbol: params.symbol, leverage: Number(params.leverage), maxNotionalValue: "1000000" });
        case "POST /fapi/v1/order": {
          if (!params.positionSide) return json({ code: -4061, msg: "Order's position side does not match user's setting." }, 400);
          // As the real testnet answers since conditional orders moved.
          if (ALGO.has(params.type)) return json({ code: -4120, msg: "Order type not supported for this endpoint. Please use the Algo Order API endpoints instead." }, 400);
          const o: StubOrder = {
            orderId: nextId++, clientOrderId: params.newClientOrderId ?? `auto${nextId}`, symbol: params.symbol, side: params.side,
            positionSide: params.positionSide, type: params.type, status: "NEW", price: params.price ?? "0", stopPrice: params.stopPrice ?? "0",
            origQty: params.quantity ?? "0", executedQty: "0", avgPrice: "0", closePosition: params.closePosition === "true",
            reduceOnly: params.reduceOnly === "true", time: Date.now(), updateTime: Date.now(),
          };
          orders.push(o);
          // A market order fills on the spot, at the tape.
          if (o.type === "MARKET") fillOrder(o.orderId, 80010);
          return json(o);
        }
        case "GET /fapi/v1/order": {
          const o = orders.find((x) => x.orderId === Number(params.orderId));
          return o ? json(o) : json({ code: -2013, msg: "Order does not exist." }, 400);
        }
        case "DELETE /fapi/v1/order": {
          const o = orders.find((x) => x.orderId === Number(params.orderId));
          if (!o) return json({ code: -2011, msg: "Unknown order sent." }, 400);
          o.status = "CANCELED";
          return json(o);
        }
        case "GET /fapi/v1/openOrders":
          return json(orders.filter((o) => o.status === "NEW" && (!params.symbol || o.symbol === params.symbol)));
        case "POST /fapi/v1/algoOrder": {
          if (!ALGO.has(params.type)) return json({ code: -1116, msg: "Invalid orderType." }, 400);
          if (params.stopPrice || params.newClientOrderId) return json({ code: -1104, msg: "Not all sent parameters were read." }, 400);
          const a = {
            algoId: nextId++, clientAlgoId: params.clientAlgoId ?? `algo${nextId}`, symbol: params.symbol, side: params.side, positionSide: params.positionSide,
            type: params.type, algoType: "CONDITIONAL", algoStatus: "NEW", quantity: params.quantity ?? "0", triggerPrice: params.triggerPrice,
            closePosition: params.closePosition === "true", workingType: params.workingType, bookTime: Date.now(), updateTime: Date.now(), orderId: null as number | null,
          };
          algos.push(a);
          return json(a);
        }
        case "GET /fapi/v1/algoOrder": {
          const a = algos.find((x) => x.algoId === Number(params.algoId));
          return a ? json(a) : json({ code: -2013, msg: "Order does not exist." }, 400);
        }
        case "DELETE /fapi/v1/algoOrder": {
          const a = algos.find((x) => x.algoId === Number(params.algoId));
          if (!a) return json({ code: -2011, msg: "Unknown order sent." }, 400);
          a.algoStatus = "CANCELED";
          return json(a);
        }
        case "GET /fapi/v1/openAlgoOrders":
          return json(algos.filter((a) => a.algoStatus === "NEW" && (!params.symbol || a.symbol === params.symbol)));
        case "GET /fapi/v2/positionRisk":
          return json([
            { symbol: "BTCUSDT", positionSide: "LONG", positionAmt: String(position.amt), entryPrice: String(position.entryPrice), markPrice: "80020", unRealizedProfit: "1.5", leverage: "5", liquidationPrice: "0" },
            { symbol: "BTCUSDT", positionSide: "SHORT", positionAmt: "0", entryPrice: "0", markPrice: "80020", unRealizedProfit: "0", leverage: "5", liquidationPrice: "0" },
          ]);
        case "GET /fapi/v1/userTrades":
          return json(fills.filter((f) => f.symbol === params.symbol && f.time >= Number(params.startTime ?? 0)));
        case "GET /sapi/v1/account/apiRestrictions":
          return json({ enableReading: true, enableFutures: true, ipRestrict: true });
        default:
          return json({ code: -1121, msg: "Invalid symbol." }, 400);
      }
    });
    venue.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(venue.address() as any).port}`));
  });
}

const send = (method: string, path: string, body?: unknown, as?: { userId: number; email: string }) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(as ? { "x-test-user": String(as.userId), "x-test-email": as.email } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = (path: string) => send("GET", path).then((x) => x.json());

let store: any;
let me: { userId: number; email: string };
let stranger: { userId: number; email: string };

describe.skipIf(!DB)("the terminal against a stub venue", () => {
  beforeAll(async () => {
    const stub = await startVenue();
    process.env.BINANCE_BASE = stub;
    process.env.BINANCE_FUTURES_BASE = stub;
    process.env.BINANCE_TESTNET_FUTURES_BASE = stub;
    process.env.BINANCE_ARCHIVE_BASE = stub;
    process.env.BINANCE_LISTING_BASE = stub;
    process.env.HYPERLIQUID_BASE = stub;
    process.env.SESSION_SECRET = `test-${stamp}-session-secret-long-enough`;
    process.env.TERMINAL_EMAILS = ` Other@x.test, ${EMAIL.toUpperCase()} `;

    const { initSchema, accounts, storageFor } = await import("../server/storage");
    await initSchema();
    const acct = await accounts.create({ googleSub: `term-${stamp}`, email: EMAIL });
    const other = await accounts.create({ googleSub: `term-other-${stamp}`, email: `nobody-${stamp}@x.test` });
    store = storageFor(acct.id);
    me = { userId: acct.id, email: EMAIL };
    stranger = { userId: other.id, email: other.email };
    const { forgetRefusals } = await import("../server/binance");
    forgetRefusals();
    const { ensureCatalogue } = await import("../server/outcomes");
    await ensureCatalogue(true);

    const express = (await import("express")).default;
    const { registerRoutes } = await import("../server/routes");
    const server = express();
    server.use(express.json({ limit: "25mb" }));
    server.use((req, _res, next) => {
      const id = Number(req.header("x-test-user") ?? me.userId);
      (req as any).userId = id;
      (req as any).account = { id, email: req.header("x-test-email") ?? me.email };
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

  const fees = { name: ACCOUNT, feeMode: "percent", makerFee: 0.02, takerFee: 0.05 };

  it("does not exist for anyone not on the list", async () => {
    const r = await send("GET", "/api/terminal/status", undefined, stranger);
    expect(r.status).toBe(404);
    const s = await send("POST", "/api/terminal/send", { account: ACCOUNT, plan: {} }, stranger);
    expect(s.status).toBe(404);
  });

  it("keeps a testnet key as a trading key once the testnet has accepted it", async () => {
    const bad = await send("PUT", "/api/account-settings", { ...fees, binanceKey: "wrongkey0123456789abcdef", binanceSecret: SECRET, binanceEnv: "testnet" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).message).toMatch(/testnet did not accept/);

    const ok = await send("PUT", "/api/account-settings", { ...fees, binanceKey: KEY, binanceSecret: SECRET, binanceEnv: "testnet" });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body).toMatchObject({ binanceEnv: "testnet", binanceTrade: true, binanceKeyHint: `…${KEY.slice(-4)}` });
    expect(body.binanceSecret).toBeUndefined();
    expect(body.binanceKey).toBeUndefined();
  });

  it("reports the account, its host, hedge mode and balance", async () => {
    const s = await get("/api/terminal/status");
    expect(s.enabled).toBe(true);
    expect(s.accounts).toHaveLength(1);
    expect(s.accounts[0]).toMatchObject({ name: ACCOUNT, env: "testnet", host: "127.0.0.1", hedgeMode: true, ipLocked: null });
    expect(s.accounts[0].balance).toMatchObject({ asset: "USDT", available: 9800 });
  });

  it("refuses to send into one-way mode, and can switch the account over", async () => {
    dual = false;
    const r = await send("POST", "/api/terminal/send", {
      account: ACCOUNT,
      plan: { symbol: "BTCUSDT", side: "long", entryType: "limit", entryPrice: 80000, stop: 79000, targets: [82500], riskDollars: 50, leverage: 5 },
    });
    expect(r.status).toBe(409);
    expect(calls.some((c) => c.path === "/fapi/v1/order")).toBe(false);
    const sw = await send("POST", "/api/terminal/hedge-mode", { account: ACCOUNT });
    expect((await sw.json()).hedgeMode).toBe(true);
    expect(dual).toBe(true);
  });

  it("refuses a plan the venue's rules would refuse, before anything is sent", async () => {
    const r = await send("POST", "/api/terminal/send", {
      account: ACCOUNT,
      plan: { symbol: "BTCUSDT", side: "long", entryType: "limit", entryPrice: 80000, stop: 81000, targets: [], riskDollars: 50, leverage: 5 },
    });
    expect(r.status).toBe(400);
    expect((await r.json()).message).toMatch(/stop has to be below/);
    expect(calls.some((c) => c.path === "/fapi/v1/order")).toBe(false);
  });

  let tradeId = 0;
  let ref: any;

  it("sends a limit plan: leverage, then the stop, the entry and the target, and logs the trade as resting", async () => {
    calls.length = 0;
    const r = await send("POST", "/api/terminal/send", {
      account: ACCOUNT,
      plan: { symbol: "BTCUSDT", side: "long", entryType: "limit", entryPrice: 80000, stop: 79000, targets: [82500], riskDollars: 50, leverage: 7 },
    });
    expect(r.status).toBe(201);
    const body = await r.json();
    tradeId = body.trade.id;
    ref = body.placed;
    expect(body.refused).toEqual([]);
    expect(body.sized.qty).toBe("0.050");

    const writes = calls.filter((c) => c.method === "POST");
    // Brackets go to the algo endpoint in its words; the entry to the plain one.
    expect(writes.map((c) => c.path)).toEqual(["/fapi/v1/leverage", "/fapi/v1/algoOrder", "/fapi/v1/order", "/fapi/v1/algoOrder"]);
    expect(writes[0].params).toMatchObject({ symbol: "BTCUSDT", leverage: "7" });
    expect(writes[1].params).toMatchObject({ type: "STOP_MARKET", side: "SELL", positionSide: "LONG", triggerPrice: "79000.0", closePosition: "true", clientAlgoId: `${ref.tag}-s` });
    expect(writes[1].params.stopPrice).toBeUndefined();
    expect(writes[2].params).toMatchObject({ type: "LIMIT", side: "BUY", positionSide: "LONG", price: "80000.0", quantity: "0.050", timeInForce: "GTC" });
    expect(writes[3].params).toMatchObject({ type: "TAKE_PROFIT_MARKET", side: "SELL", triggerPrice: "82500.0", closePosition: "true" });
    expect(writes[2].params.newClientOrderId).toBe(`${ref.tag}-e`);

    const t = await store.getTrade(tradeId);
    expect(t).toMatchObject({ symbol: "BTC", direction: "long", size: 0.05, entryPrice: 80000, initialStop: 79000, initialTarget: 82500, status: "pending", account: ACCOUNT });
    expect(ref).toMatchObject({ symbol: "BTCUSDT", positionSide: "LONG", leverage: 7, unprotected: false });
    expect(ref.stopOrderId).toBe(algos.find((a) => a.type === "STOP_MARKET")!.algoId);
    expect(ref.entryOrderId).toBe(orders.find((o) => o.type === "LIMIT")!.orderId);

    const log = await get("/api/terminal/log");
    expect(log.map((l: any) => l.action)).toEqual(expect.arrayContaining(["leverage", "send", "journal"]));
    expect(log.every((l: any) => l.ok)).toBe(true);
  });

  it("leaves a resting trade resting, then opens it at the fill once the entry fills", async () => {
    let r = await send("POST", "/api/terminal/reconcile", {});
    expect((await r.json()).checked).toEqual([{ id: tradeId, status: "pending" }]);

    fillOrder(ref.entryOrderId, 79995);
    r = await send("POST", "/api/terminal/reconcile", {});
    expect((await r.json()).checked).toEqual([{ id: tradeId, status: "open" }]);
    const t = await store.getTrade(tradeId);
    expect(t.status).toBe("open");
    expect(t.entryPrice).toBe(79995);
    expect(t.size).toBe(0.05);
    expect(t.fees).toBeCloseTo(0.02);
    expect(JSON.parse(t.terminal).unprotected).toBe(false);
  });

  it("moves the stop by replacing the resting order, and writes the move to the stop log", async () => {
    calls.length = 0;
    const oldStop = ref.stopOrderId;
    const r = await send("POST", `/api/terminal/trades/${tradeId}/stop`, { price: 79600.04 });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["DELETE /fapi/v1/algoOrder", "POST /fapi/v1/algoOrder"]);
    expect(calls[0].params.algoId).toBe(String(oldStop));
    expect(calls[1].params).toMatchObject({ type: "STOP_MARKET", triggerPrice: "79600.0", closePosition: "true", positionSide: "LONG" });
    expect(algos.find((a) => a.algoId === oldStop)!.algoStatus).toBe("CANCELED");
    const nextRef = JSON.parse(body.trade.terminal);
    expect(nextRef.stopOrderId).toBe(body.order.orderId);
    expect(nextRef.stopOrderId).not.toBe(oldStop);
    expect(JSON.parse(body.trade.stopMoves)).toMatchObject([{ price: 79600, note: "terminal" }]);
    expect(nextRef.moves).toMatchObject([{ kind: "stop", from: 79000, to: 79600 }]);
    ref = nextRef;
  });

  it("moves the target the same way, and remembers what it was", async () => {
    const r = await send("POST", `/api/terminal/trades/${tradeId}/target`, { price: 83000 });
    expect(r.status).toBe(200);
    const body = await r.json();
    const nextRef = JSON.parse(body.trade.terminal);
    expect(nextRef.targetOrderIds).toEqual([body.order.orderId]);
    expect(nextRef.moves.at(-1)).toMatchObject({ kind: "target", from: 82500, to: 83000 });
    // The plan as drawn stays the plan.
    expect(body.trade.initialTarget).toBe(82500);
    ref = nextRef;
  });

  it("flags a trade whose stop stopped resting, without touching the plan", async () => {
    algos.find((a) => a.algoId === ref.stopOrderId)!.algoStatus = "CANCELED";
    await send("POST", "/api/terminal/reconcile", {});
    const t = await store.getTrade(tradeId);
    expect(JSON.parse(t.terminal).unprotected).toBe(true);
    expect(t.initialStop).toBe(79000);
    // Put one back.
    const r = await send("POST", `/api/terminal/trades/${tradeId}/stop`, { price: 79600 });
    ref = JSON.parse((await r.json()).trade.terminal);
    expect(ref.unprotected).toBe(false);
  });

  it("closes the trade at the stop's fill once the position side is flat", async () => {
    fillOrder(ref.stopOrderId, 79598);
    expect(position.amt).toBe(0);
    const r = await send("POST", "/api/terminal/reconcile", {});
    expect((await r.json()).checked).toEqual([{ id: tradeId, status: "closed" }]);
    const t = await store.getTrade(tradeId);
    expect(t).toMatchObject({ status: "closed", exitPrice: 79598, entryPrice: 79995, initialStop: 79000, initialTarget: 82500, exitReason: "stop" });
    expect(t.exitTime).toBeTruthy();
    expect(t.fees).toBeCloseTo(0.04);
  });

  it("sends a market plan as an open trade, and closes it at market on request", async () => {
    calls.length = 0;
    const r = await send("POST", "/api/terminal/send", {
      account: ACCOUNT,
      plan: { symbol: "BTCUSDT", side: "long", entryType: "market", entryPrice: 80010, stop: 79500, targets: [], riskDollars: 51, leverage: 3 },
    });
    expect(r.status).toBe(201);
    const body = await r.json();
    const id = body.trade.id;
    expect(body.trade.status).toBe("open");
    expect(calls.filter((c) => c.method === "POST" && /\/fapi\/v1\/(algo)?[oO]rder$/.test(c.path)).map((c) => c.params.type)).toEqual(["STOP_MARKET", "MARKET"]);
    expect(position.amt).toBeCloseTo(0.1);

    calls.length = 0;
    const c = await send("POST", `/api/terminal/trades/${id}/close`, {});
    expect(c.status).toBe(200);
    const closed = (await c.json()).trade;
    const market = calls.find((x) => x.method === "POST" && x.path === "/fapi/v1/order")!;
    expect(market.params).toMatchObject({ type: "MARKET", side: "SELL", positionSide: "LONG", quantity: "0.100" });
    expect(calls.some((x) => x.method === "DELETE")).toBe(true);
    expect(position.amt).toBe(0);
    expect(closed.status).toBe("closed");
    expect(closed.exitPrice).toBe(80010);
    expect(closed.exitReason).toBe("discretion");
  });

  it("writes a scale-out as a partial in the ledger and closes at the last target, as a target", async () => {
    const r = await send("POST", "/api/terminal/send", {
      account: ACCOUNT,
      plan: { symbol: "BTCUSDT", side: "long", entryType: "market", entryPrice: 80010, stop: 79000, targets: [80500, 81000], qty: 0.02, leverage: 3 },
    });
    expect(r.status).toBe(201);
    const { trade, placed } = await r.json();
    expect(placed.targetOrderIds).toHaveLength(2);
    fillOrder(placed.targetOrderIds[0], 80500);
    expect(position.amt).toBeCloseTo(0.01);
    await send("POST", "/api/terminal/reconcile", {});
    let t = await store.getTrade(trade.id);
    expect(t.status).toBe("open");
    expect(t.fills).toMatchObject([{ kind: "partial", price: 80500, size: 0.01 }]);
    // Read again: the same fill is not logged twice.
    await send("POST", "/api/terminal/reconcile", {});
    t = await store.getTrade(trade.id);
    expect(t.fills).toHaveLength(1);
    fillOrder(placed.targetOrderIds[1], 81000);
    await send("POST", "/api/terminal/reconcile", {});
    t = await store.getTrade(trade.id);
    expect(t).toMatchObject({ status: "closed", exitPrice: 81000, exitReason: "target", size: 0.02 });
    expect(t.fills).toHaveLength(1);
  });

  it("cancels a resting plan: every order off, the trade marked pulled", async () => {
    const r = await send("POST", "/api/terminal/send", {
      account: ACCOUNT,
      plan: { symbol: "BTCUSDT", side: "short", entryType: "limit", entryPrice: 81000, stop: 81500, targets: [79000, 78000], qty: 0.02, leverage: 2 },
    });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.placed.targetOrderIds).toHaveLength(2);
    expect(restingFor(body.placed.tag)).toHaveLength(4);
    const c = await send("POST", `/api/terminal/trades/${body.trade.id}/cancel`, {});
    expect((await c.json()).trade).toMatchObject({ status: "cancelled", cancelReason: "pulled" });
    expect(restingFor(body.placed.tag)).toHaveLength(0);
  });

  it("keeps the venue sync off the terminal's trades, and the terminal's trades out of the claim", async () => {
    // The stub's fills carry a position side, which the read-only sync sets
    // aside as hedge-mode; the terminal's own reconcile is the writer here.
    const r = await send("POST", "/api/binance/sync", { account: ACCOUNT });
    const s = await r.json();
    expect(s.accounts[0].created).toBe(0);
    const all = await store.listTrades();
    expect(all.filter((t: any) => t.account === ACCOUNT && !t.terminal)).toHaveLength(0);
  });
});
