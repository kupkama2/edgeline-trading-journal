import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

/**
 * The venue writing the journal.
 *
 * A stub Hyperliquid answers every /info question the server asks — the
 * universe, a wallet's fills and orders, candles, funding, mids — and the
 * real routes, storage and database do the rest. What is checked is what
 * lands in the journal: a trade with the venue's entry, exit, fees and the
 * stop its order history reveals; an open position that a later sync
 * closes; a mark for the open one; a Hyperliquid chart; and funding on the
 * closed one, from the venue's own rate history.
 */

const DB = process.env.DATABASE_URL;
if (process.env.CI && !DB) {
  throw new Error("DATABASE_URL is required in CI — the Hyperliquid sync tests must run");
}
const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const HOUR = 3_600_000;
const WALLET = "0x" + "ab".repeat(20);

const now = Date.now();
// Entered and left half an hour past the hour, so exactly three hourly
// settlements (-4h, -3h, -2h) fall inside the hold.
const ethIn = now - 5 * HOUR + 30 * 60_000;
const ethOut = now - 2 * HOUR + 30 * 60_000;
const btcIn = now - 1 * HOUR;

let fills: unknown[] = [
  { coin: "ETH", px: "2000", sz: "1", side: "B", time: ethIn, startPosition: "0", dir: "Open Long", closedPnl: "0", fee: "0.4", tid: 1, oid: 11 },
  { coin: "ETH", px: "2100", sz: "1", side: "A", time: ethOut, startPosition: "1", dir: "Close Long", closedPnl: "100", fee: "0.6", tid: 2, oid: 12 },
  { coin: "BTC", px: "100", sz: "2", side: "A", time: btcIn, startPosition: "0", dir: "Open Short", closedPnl: "0", fee: "0.2", tid: 3, oid: 13 },
];
const orders = [
  { order: { coin: "ETH", oid: 21, side: "A", isTrigger: true, triggerPx: "1950", orderType: "Stop Market", reduceOnly: true, timestamp: ethIn + 60_000 }, status: "canceled", statusTimestamp: ethOut },
  { order: { coin: "ETH", oid: 22, side: "A", isTrigger: true, triggerPx: "2200", orderType: "Take Profit Market", reduceOnly: false, isPositionTpsl: true, timestamp: ethIn + 120_000 }, status: "canceled", statusTimestamp: ethOut },
];

let venue: Server;
let app: Server;
let base: string;
const asked: string[] = [];

function startVenue(): Promise<string> {
  return new Promise((resolve) => {
    venue = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const json = (x: unknown) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(x));
        };
        if (req.method !== "POST" || req.url !== "/info") {
          res.statusCode = 404;
          return res.end("{}");
        }
        const q = JSON.parse(body || "{}");
        asked.push(q.type);
        switch (q.type) {
          case "meta":
            return json({ universe: [{ name: "BTC", maxLeverage: 40 }, { name: "ETH", maxLeverage: 25 }, { name: "kPEPE", maxLeverage: 10 }] });
          case "userFills":
            return json(q.user === WALLET ? fills : []);
          case "historicalOrders":
            return json(orders);
          case "allMids":
            return json({ BTC: "95", ETH: "2050" });
          case "candleSnapshot": {
            const { startTime, endTime } = q.req;
            const out = [];
            for (let t = Math.ceil(startTime / HOUR) * HOUR; t <= endTime && out.length < 5000; t += HOUR) {
              out.push({ t, T: t + HOUR - 1, s: q.req.coin, i: q.req.interval, o: "2000", h: "2001", l: "1999", c: "2000", v: "1", n: 1 });
            }
            return json(out);
          }
          case "fundingHistory": {
            const out = [];
            for (let t = Math.ceil(q.startTime / HOUR) * HOUR; t <= q.endTime; t += HOUR) {
              out.push({ coin: q.coin, fundingRate: "0.0001", premium: "0", time: t });
            }
            return json(out);
          }
          default:
            res.statusCode = 400;
            return res.end("{}");
        }
      });
    });
    venue.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(venue.address() as any).port}`));
  });
}

const get = (path: string) => fetch(`${base}${path}`).then((x) => x.json());
const send = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe.skipIf(!DB)("a Hyperliquid account, synced", () => {
  beforeAll(async () => {
    const stub = await startVenue();
    process.env.HYPERLIQUID_BASE = stub;
    // Binance pointed at the same stub, which 404s it: no test reaches a
    // real venue, whatever the network here allows.
    process.env.BINANCE_BASE = stub;
    process.env.BINANCE_FUTURES_BASE = stub;
    process.env.BINANCE_ARCHIVE_BASE = stub;
    process.env.BINANCE_LISTING_BASE = stub;

    const { initSchema, accounts } = await import("../server/storage");
    await initSchema();
    const acct = await accounts.create({ googleSub: `hls-${stamp}`, email: `hls-${stamp}@x.test` });

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
    const shut = (x: Server | undefined) =>
      new Promise<void>((r) => (x ? x.close(() => r()) : r()));
    await shut(venue);
    await shut(app);
  });

  it("says so when no account names a wallet", async () => {
    const r = await send("POST", "/api/hyperliquid/sync", {}).then((x) => x.json());
    expect(r.accounts).toEqual([]);
    expect(r.message).toMatch(/wallet/);
  });

  it("takes a wallet on the account, and refuses one that is not an address", async () => {
    const bad = await send("PUT", "/api/account-settings", { name: "Hyperliquid", feeMode: "percent", makerFee: 0, takerFee: 0, wallet: "0x123" });
    expect(bad.status).toBe(400);
    const ok = await send("PUT", "/api/account-settings", { name: "Hyperliquid", feeMode: "percent", makerFee: 0, takerFee: 0, wallet: WALLET });
    expect(ok.status).toBe(200);
    expect((await ok.json()).wallet).toBe(WALLET);
    // Saving the fees again without mentioning the wallet leaves it alone.
    await send("PUT", "/api/account-settings", { name: "Hyperliquid", feeMode: "percent", makerFee: 0.02, takerFee: 0.05 });
    const list = await get("/api/account-settings");
    expect(list.find((a: any) => a.name === "Hyperliquid").wallet).toBe(WALLET);
  });

  it("writes the venue's trades, stop and target included", async () => {
    const r = await send("POST", "/api/hyperliquid/sync", {}).then((x) => x.json());
    expect(r.accounts).toHaveLength(1);
    expect(r.accounts[0]).toMatchObject({ account: "Hyperliquid", fills: 3, created: 2, updated: 0, unchanged: 0, unreconstructed: 0 });

    const trades = await get("/api/trades");
    const eth = trades.find((t: any) => t.externalId === "hl:ETH:1");
    expect(eth).toMatchObject({
      symbol: "ETH",
      direction: "long",
      status: "closed",
      size: 1,
      sizeUnit: "base",
      entryPrice: 2000,
      exitPrice: 2100,
      initialStop: 1950,
      initialTarget: 2200,
      exitReason: "other",
      account: "Hyperliquid",
    });
    expect(eth.fees).toBeCloseTo(1);
    expect(new Date(eth.entryTime).getTime()).toBe(ethIn);
    expect(new Date(eth.exitTime).getTime()).toBe(ethOut);

    const btc = trades.find((t: any) => t.externalId === "hl:BTC:3");
    expect(btc).toMatchObject({ symbol: "BTC", direction: "short", status: "open", size: 2, entryPrice: 100, initialStop: null, exitPrice: null });
  });

  it("does not write the same trade twice", async () => {
    const r = await send("POST", "/api/hyperliquid/sync", { account: "Hyperliquid" }).then((x) => x.json());
    expect(r.accounts[0]).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    const trades = await get("/api/trades");
    expect(trades.filter((t: any) => t.externalId?.startsWith("hl:")).length).toBe(2);
  });

  it("marks the open trade with the venue's mid", async () => {
    const trades = await get("/api/trades");
    const btc = trades.find((t: any) => t.externalId === "hl:BTC:3");
    const marks = await get("/api/marks");
    expect(marks[btc.id]).toMatchObject({ price: 95, venue: "hyperliquid", book: "perp" });
    // The closed one is nobody's business here.
    const eth = trades.find((t: any) => t.externalId === "hl:ETH:1");
    expect(marks[eth.id]).toBeUndefined();
  });

  it("draws the Hyperliquid chart from the venue's own candles", async () => {
    const trades = await get("/api/trades");
    const eth = trades.find((t: any) => t.externalId === "hl:ETH:1");
    const r = await get(`/api/trades/${eth.id}/candles?interval=1h`);
    expect(r.venue).toBe("hyperliquid");
    expect(r.pair).toBe("ETH");
    expect(r.market).toBe("futures");
    expect(r.source).toBe("api");
    expect(r.tail).toBeNull();
    expect(r.candles.length).toBeGreaterThan(0);
    expect(r.candles.every((c: any) => c.c === 2000)).toBe(true);
  });

  it("estimates the funding a closed hold paid, from the venue's rates", async () => {
    const trades = await get("/api/trades");
    const eth = trades.find((t: any) => t.externalId === "hl:ETH:1");
    const r = await send("POST", `/api/trades/${eth.id}/check`, {}).then((x) => x.json());
    expect(r.error).toBeUndefined();
    const f = r.funded.find((x: any) => x.tradeId === eth.id);
    // Three settlements at a basis point on $2,000 notional, paid by the long.
    expect(f.events).toBe(3);
    expect(f.funding).toBeCloseTo(-0.6, 6);
    const after = (await get("/api/trades")).find((t: any) => t.id === eth.id);
    expect(after.funding).toBeCloseTo(-0.6, 6);
    expect(after.fundingCheckedAt).toBeTruthy();
  });

  it("fills in the exit when a later sync finds the position closed", async () => {
    fills = [
      ...fills,
      { coin: "BTC", px: "90", sz: "2", side: "B", time: now - 10 * 60_000, startPosition: "-2", dir: "Close Short", closedPnl: "20", fee: "0.3", tid: 4, oid: 14 },
    ];
    const r = await send("POST", "/api/hyperliquid/sync", {}).then((x) => x.json());
    expect(r.accounts[0]).toMatchObject({ created: 0, updated: 1, unchanged: 1 });
    const btc = (await get("/api/trades")).find((t: any) => t.externalId === "hl:BTC:3");
    expect(btc).toMatchObject({ status: "closed", exitPrice: 90, exitReason: "other" });
    expect(btc.fees).toBeCloseTo(0.5);
  });

  it("reports a position older than the record rather than inventing its entry", async () => {
    fills = [
      { coin: "kPEPE", px: "0.01", sz: "1000", side: "A", time: now - 3 * HOUR, startPosition: "1000", dir: "Close Long", closedPnl: "5", fee: "0.1", tid: 5, oid: 15 },
    ];
    const r = await send("POST", "/api/hyperliquid/sync", {}).then((x) => x.json());
    expect(r.accounts[0]).toMatchObject({ fills: 1, created: 0, unreconstructed: 1 });
  });

  it("keeps balance snapshots per account", async () => {
    const bad = await send("POST", "/api/account-balances", { account: "Hyperliquid", balance: 5000, at: "yesterday-ish" });
    expect(bad.status).toBe(400);
    const made = await send("POST", "/api/account-balances", { account: "Hyperliquid", balance: 5000, at: "2026-08-01T00:00:00.000Z", note: "deposit" });
    expect(made.status).toBe(201);
    const row = await made.json();
    const list = await get("/api/account-balances");
    expect(list.map((b: any) => b.id)).toContain(row.id);
    expect(list.find((b: any) => b.id === row.id)).toMatchObject({ account: "Hyperliquid", balance: 5000, note: "deposit" });
    const gone = await send("DELETE", `/api/account-balances/${row.id}`);
    expect(gone.status).toBe(204);
    expect((await get("/api/account-balances")).some((b: any) => b.id === row.id)).toBe(false);
  });
});
