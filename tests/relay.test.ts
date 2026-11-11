import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";

/**
 * The relay: the trader's own machine asking Binance for the server.
 *
 * A fake relay connects to the app with the account's token and answers
 * every signed call the server sends down the socket from a toy book: one
 * ETH short with a stop and a target. Nothing here reaches a Binance host
 * at all — the server never calls one for a relayed account. What is
 * checked: the token gates the socket, the status row says connected, the
 * tracker writes the position as a trade through the relay, a forwarded
 * stream event brings a read within the second, and a relay that is gone
 * is reported, not waited on.
 */
const DB = process.env.DATABASE_URL;
if (process.env.CI && !DB) throw new Error("DATABASE_URL is required in CI — the relay tests must run");

const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ACCOUNT = "Binance Relayed";
const now = Date.now();
const MIN = 60_000;

let app: Server;
let base = "";
let userId: number;
let store: any;

const send = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (path: string) => send("GET", path).then((x) => x.json());

/** What the relay's Binance would say, by path. */
const positions = [{ symbol: "ETHUSDT", positionSide: "SHORT", positionAmt: "-2", entryPrice: "3000", markPrice: "2950", unRealizedProfit: "100", leverage: "10", liquidationPrice: "3300" }];
const fills = [{ symbol: "ETHUSDT", id: 9001, orderId: 5000, side: "SELL", positionSide: "SHORT", price: "3000", qty: "2", realizedPnl: "0", commission: "1.2", commissionAsset: "USDT", time: now - 20 * MIN, buyer: false, maker: false }];
const orders = [{ orderId: 5000, clientOrderId: "web_1", symbol: "ETHUSDT", side: "SELL", positionSide: "SHORT", type: "MARKET", status: "FILLED", price: "0", stopPrice: "0", origQty: "2", executedQty: "2", avgPrice: "3000", time: now - 20 * MIN, updateTime: now - 20 * MIN }];
const algos = [
  { algoId: 6001, clientAlgoId: "web_sl", symbol: "ETHUSDT", side: "BUY", positionSide: "SHORT", orderType: "STOP_MARKET", algoType: "CONDITIONAL", algoStatus: "NEW", quantity: "0", triggerPrice: "3100", closePosition: true, createTime: now - 19 * MIN, updateTime: now - 19 * MIN, triggerTime: 0, actualOrderId: "" },
  { algoId: 6002, clientAlgoId: "web_tp", symbol: "ETHUSDT", side: "BUY", positionSide: "SHORT", orderType: "TAKE_PROFIT_MARKET", algoType: "CONDITIONAL", algoStatus: "NEW", quantity: "0", triggerPrice: "2800", closePosition: true, createTime: now - 19 * MIN, updateTime: now - 19 * MIN, triggerTime: 0, actualOrderId: "" },
];
const answered: { method: string; path: string; params: Record<string, unknown> }[] = [];
/** Every request as it came down the socket. */
const raw: Record<string, any>[] = [];
function answer(method: string, path: string, params: Record<string, any>): { status: number; body: unknown } {
  answered.push({ method, path, params });
  switch (`${method} ${path}`) {
    case "GET /fapi/v2/positionRisk":
      return { status: 200, body: positions };
    case "GET /fapi/v1/userTrades":
      return { status: 200, body: fills.filter((f) => f.symbol === params.symbol) };
    case "GET /fapi/v1/openOrders":
      return { status: 200, body: orders.filter((o) => o.status === "NEW") };
    case "GET /fapi/v1/openAlgoOrders":
      return { status: 200, body: algos.filter((a) => a.algoStatus === "NEW") };
    case "GET /fapi/v1/order":
      return { status: 200, body: orders.find((o) => o.orderId === Number(params.orderId)) ?? { code: -2013, msg: "Order does not exist." } };
    case "GET /fapi/v1/algoOrder":
      return { status: 200, body: algos.find((a) => a.algoId === Number(params.algoId)) ?? { code: -2013, msg: "Order does not exist." } };
    default:
      return { status: 400, body: { code: -1121, msg: "Invalid symbol." } };
  }
}

/** A relay as the real one behaves on the wire. */
function fakeRelay(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/relay/ws?token=${encodeURIComponent(token)}`);
    ws.on("open", () => {
      ws.send(JSON.stringify({ t: "hello", env: "live", canTrade: false, keyHint: "relaykey" }));
      resolve(ws);
    });
    ws.on("message", (data) => {
      const m = JSON.parse(String(data));
      if (m.t === "req") raw.push(m);
      if (m.t === "req") {
        const r = answer(m.method, m.path, m.params ?? {});
        ws.send(JSON.stringify({ t: "res", id: m.id, status: r.status, body: JSON.stringify(r.body) }));
      }
    });
    ws.on("error", reject);
  });
}
async function waitFor<T>(check: () => Promise<T>, ok: (v: T) => boolean, ms = 4_000): Promise<T> {
  const until = Date.now() + ms;
  let last: T;
  do {
    last = await check();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  } while (Date.now() < until);
  return last;
}

describe.skipIf(!DB)("the relay", () => {
  let relay: WebSocket | null = null;
  beforeAll(async () => {
    // Every Binance host points at a port nobody answers: a relayed account must never need one.
    const dead = "http://127.0.0.1:1";
    process.env.BINANCE_BASE = dead;
    process.env.BINANCE_SAPI_BASE = dead;
    process.env.BINANCE_FUTURES_BASE = dead;
    process.env.BINANCE_ARCHIVE_BASE = dead;
    process.env.BINANCE_LISTING_BASE = dead;
    process.env.HYPERLIQUID_BASE = dead;
    process.env.SESSION_SECRET = `test-${stamp}-session-secret-long-enough`;
    process.env.TERMINAL_PLAN_WATCH_GAP_MS = "0";
    process.env.CHART_WARM_MS = "0";
    delete process.env.ANTHROPIC_API_KEY;
    const { initSchema, accounts, storageFor } = await import("../server/storage");
    await initSchema();
    const acct = await accounts.create({ googleSub: `relay-${stamp}`, email: `relay-${stamp}@x.test` });
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
    const { startTerminalWatch } = await import("../server/terminal");
    startTerminalWatch(600_000);
  });
  afterAll(async () => {
    const { stopTerminalWatch } = await import("../server/terminal");
    const { closeRelays } = await import("../server/relay");
    stopTerminalWatch();
    closeRelays();
    relay?.terminate();
    await new Promise<void>((r) => app.close(() => r()));
  });

  it("mints a token for the account, and shows no key held here", async () => {
    const r = await send("PUT", "/api/account-settings", { name: ACCOUNT, feeMode: "percent", makerFee: 0, takerFee: 0, relay: true, track: true });
    expect(r.status).toBe(200);
    const row = await r.json();
    expect(row.relayToken).toMatch(/^[0-9a-f]{64}$/);
    expect(row.binanceKeyHint).toBeNull();
    expect(row.relay).toMatchObject({ connected: false });
    // Saving the fees again keeps the token.
    await send("PUT", "/api/account-settings", { name: ACCOUNT, feeMode: "percent", makerFee: 0.02, takerFee: 0.05 });
    const again = (await get("/api/account-settings")).find((a: any) => a.name === ACCOUNT);
    expect(again.relayToken).toBe(row.relayToken);
  });

  it("refuses a socket without the right token", async () => {
    const bad = new WebSocket(`${base.replace(/^http/, "ws")}/api/relay/ws?token=nope`);
    const outcome = await new Promise<string>((resolve) => {
      bad.on("open", () => resolve("open"));
      bad.on("error", () => resolve("refused"));
      bad.on("unexpected-response", () => resolve("refused"));
    });
    expect(outcome).toBe("refused");
  });

  it("reports the relay connected once it says hello, with what it brought", async () => {
    const row = (await get("/api/account-settings")).find((a: any) => a.name === ACCOUNT);
    relay = await fakeRelay(row.relayToken);
    const seen = await waitFor(async () => (await get("/api/account-settings")).find((a: any) => a.name === ACCOUNT), (a: any) => a.relay?.connected && a.binanceKeyHint != null);
    expect(seen.relay).toMatchObject({ connected: true, env: "live", canTrade: false });
    expect(seen.binanceKeyHint).toBe("…ykey");
    expect(seen.binanceTrade).toBe(false);
  });

  it("tracks the account through the relay: the position becomes a trade, and no Binance host is ever asked", async () => {
    answered.length = 0;
    const out = await send("POST", "/api/tracking/run").then((x) => x.json());
    const mine = out.accounts.find((a: any) => a.account === ACCOUNT);
    expect(mine.error).toBeUndefined();
    expect(mine.opened).toHaveLength(1);
    const [eth] = (await get("/api/trades")).filter((t: any) => t.symbol === "ETH" && t.account === ACCOUNT);
    expect(eth).toMatchObject({ direction: "short", size: 2, entryPrice: 3000, initialStop: 3100, initialTarget: 2800, status: "open", externalId: "binance:ETHUSDT:9001" });
    expect(JSON.parse(eth.terminal)).toMatchObject({ venue: "binance", tracked: true, stopOrderId: 6001, targetOrderIds: [6002] });
    expect(answered.some((a) => a.path === "/fapi/v2/positionRisk")).toBe(true);
    expect(answered.some((a) => a.path === "/fapi/v1/userTrades" && a.params.symbol === "ETHUSDT")).toBe(true);
  });

  it("reads back within the second when the relay forwards a stream event", async () => {
    answered.length = 0;
    // The stop moved on the venue: the relay's stream says so, and the next read sees the new price.
    algos[0] = { ...algos[0], algoId: 6003, triggerPrice: "3050" };
    relay!.send(JSON.stringify({ t: "event", msg: { e: "ALGO_UPDATE", T: Date.now(), E: Date.now(), o: { s: "ETHUSDT", aid: 6003, X: "NEW" } } }));
    const eth = await waitFor(
      async () => (await get("/api/trades")).find((t: any) => t.symbol === "ETH" && t.account === ACCOUNT),
      (t: any) => JSON.parse(t.terminal).stopOrderId === 6003,
    );
    const ref = JSON.parse(eth.terminal);
    expect(ref.moves).toMatchObject([{ kind: "stop", from: 3100, to: 3050 }]);
    expect(answered.some((a) => a.path === "/fapi/v2/positionRisk")).toBe(true);
  });

  it("asks for public market data with a real host, from a live relay that says it can", async () => {
    const { publicRelayFor, relayPublic } = await import("../server/relay");
    // This relay's hello named no features: an older copy, reported as one to update.
    expect(publicRelayFor(userId)).toEqual({ account: null, outdated: true });
    relay!.send(JSON.stringify({ t: "hello", env: "live", canTrade: false, keyHint: "relaykey", features: ["public"] }));
    await waitFor(async () => publicRelayFor(userId), (r) => r.account === ACCOUNT);
    expect(publicRelayFor(userId)).toEqual({ account: ACCOUNT, outdated: false });
    await relayPublic(userId, ACCOUNT, "/fapi/v1/premiumIndex", { symbol: "ETHUSDT", skipped: undefined });
    const sent = raw.find((m) => m.public);
    // The base is Binance's own: sent empty, every copy of the relay answered "Invalid URL" and no flow was ever read.
    expect(sent).toMatchObject({ method: "GET", path: "/fapi/v1/premiumIndex", public: true, base: "https://fapi.binance.com", params: { symbol: "ETHUSDT" } });
    expect(() => new URL(sent!.base)).not.toThrow();
    // A testnet relay is never asked for the market: its prices are the testnet's.
    relay!.send(JSON.stringify({ t: "hello", env: "testnet", canTrade: false, keyHint: "relaykey", features: ["public"] }));
    await waitFor(async () => publicRelayFor(userId), (r) => r.account === null);
    expect(publicRelayFor(userId).account).toBeNull();
    relay!.send(JSON.stringify({ t: "hello", env: "live", canTrade: false, keyHint: "relaykey" }));
  });

  it("says so when the relay is gone, instead of waiting on a host", async () => {
    relay!.close();
    await waitFor(async () => (await get("/api/account-settings")).find((a: any) => a.name === ACCOUNT), (a: any) => a.relay && !a.relay.connected);
    const out = await send("POST", "/api/tracking/run").then((x) => x.json());
    const mine = out.accounts.find((a: any) => a.account === ACCOUNT);
    expect(mine.error).toMatch(/relay is not connected/);
    // Giving the relay up clears the token and leaves the account keyless.
    const r = await send("PUT", "/api/account-settings", { name: ACCOUNT, feeMode: "percent", makerFee: 0, takerFee: 0, relay: false, track: false });
    expect((await r.json()).relayToken).toBeNull();
  });
});
