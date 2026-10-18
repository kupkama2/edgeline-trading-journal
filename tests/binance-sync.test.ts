import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";

/**
 * A Binance Futures account, synced.
 *
 * A stub plays the venue, and it is not a friendly one: every signed call has
 * to carry the key in its header and a signature that verifies over exactly
 * the query it received, or it is refused the way the real host refuses it.
 * The real routes, storage and database do the rest.
 *
 * What is checked is what lands in the journal, and what does not:
 *
 *   a key that can withdraw is turned away at the door, with the reason
 *   the key that is kept is sealed, and the browser is told only how it ends
 *   an open short with the stop and target still resting on it
 *   an open long with nothing resting
 *   a closed long that a PERSON had already logged on the way in and never
 *     closed — claimed, not duplicated: stamped, and its exit filled in
 *   a short the person logged that the venue has as a long — left alone
 *   a symbol whose history begins mid-position — set aside, counted, unwritten
 *   a symbol the venue will not answer for — skipped and named, the rest read
 *   a symbol traded in hedge mode — set aside and named, not misread
 *   a commission paid in BNB — the fee left blank, not booked as dollars
 *   every time-filtered read asked in windows of at most seven days
 *   a second sync that changes nothing
 */
const DB = process.env.DATABASE_URL;
if (process.env.CI && !DB) {
  throw new Error("DATABASE_URL is required in CI — the Binance sync tests must run");
}
const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const H = 3_600_000;
const now = Date.now();

const KEY = "readonlykey0123456789abcdefABCDEF";
const SECRET = "readonlysecret0123456789abcdefABCDEF";
const SPENDING_KEY = "withdrawingkey0123456789abcdef";

const ethIn = now - 30 * H;
const ethOut = now - 27 * H;
const btcIn = now - 5 * H;
const solIn = now - 2 * H;

const userTrades: Record<string, unknown[]> = {
  ETHUSDT: [
    { symbol: "ETHUSDT", id: 1, orderId: 10, side: "BUY", price: "2000", qty: "1", realizedPnl: "0", commission: "0.4", time: ethIn },
    { symbol: "ETHUSDT", id: 2, orderId: 11, side: "SELL", price: "2100", qty: "1", realizedPnl: "100", commission: "0.6", time: ethOut },
  ],
  // The commission paid in BNB: a quantity of a coin, not a dollar figure.
  BTCUSDT: [
    { symbol: "BTCUSDT", id: 3, orderId: 12, side: "SELL", price: "100", qty: "2", realizedPnl: "0", commission: "0.0004", commissionAsset: "BNB", time: btcIn },
  ],
  SOLUSDT: [
    { symbol: "SOLUSDT", id: 4, orderId: 13, side: "BUY", price: "150", qty: "3", realizedPnl: "0", commission: "0.3", time: solIn },
  ],
  // Begins with a sell and the venue says nothing is open: a position whose
  // entry this record never saw.
  DOGEUSDT: [
    { symbol: "DOGEUSDT", id: 5, orderId: 14, side: "SELL", price: "0.2", qty: "500", realizedPnl: "12", commission: "0.1", time: now - 10 * H },
  ],
  // Hedge mode: a long opened and closed under its own position side.
  ADAUSDT: [
    { symbol: "ADAUSDT", id: 6, orderId: 15, side: "BUY", price: "0.5", qty: "100", realizedPnl: "0", commission: "0.01", positionSide: "LONG", time: now - 20 * H },
    { symbol: "ADAUSDT", id: 7, orderId: 16, side: "SELL", price: "0.6", qty: "100", realizedPnl: "10", commission: "0.01", positionSide: "LONG", time: now - 19 * H },
  ],
};
// LINKUSDT realised something but the venue no longer answers for it.
const REFUSED = "LINKUSDT";
const positions = [
  { symbol: "BTCUSDT", positionAmt: "-2", entryPrice: "100" },
  { symbol: "SOLUSDT", positionAmt: "3", entryPrice: "150" },
  { symbol: "ETHUSDT", positionAmt: "0", entryPrice: "0" },
  { symbol: "DOGEUSDT", positionAmt: "0", entryPrice: "0" },
];
const openOrders = [
  { symbol: "BTCUSDT", orderId: 20, side: "BUY", type: "STOP_MARKET", stopPrice: "110", reduceOnly: true, time: btcIn + 60_000 },
  { symbol: "BTCUSDT", orderId: 21, side: "BUY", type: "TAKE_PROFIT_MARKET", stopPrice: "80", closePosition: true, time: btcIn + 120_000 },
];
// Which symbols realised something in the window — including DOGE, whose
// close is in the record even though its open is not. That is how the sync
// finds it, and finding it is what lets it refuse to invent the entry.
const income = [
  { symbol: "ETHUSDT", incomeType: "REALIZED_PNL", income: "100", time: ethOut },
  { symbol: "DOGEUSDT", incomeType: "REALIZED_PNL", income: "12", time: now - 10 * H },
  { symbol: "ADAUSDT", incomeType: "REALIZED_PNL", income: "10", time: now - 19 * H },
  { symbol: REFUSED, incomeType: "REALIZED_PNL", income: "-3", time: now - 40 * H },
];
// The venue's own rule: a time-filtered read names both ends, at most a week apart.
const WEEK = 7 * 24 * H;
const windowed: { path: string; span: number | null }[] = [];
const inWindow = (u: URL, t: number) => t >= Number(u.searchParams.get("startTime")) && t <= Number(u.searchParams.get("endTime"));

let venue: Server;
let app: Server;
let base: string;
const asked: { path: string; signed: boolean; key: string | undefined }[] = [];
const windowOk = (u: URL) => {
  const a = Number(u.searchParams.get("startTime"));
  const b = Number(u.searchParams.get("endTime"));
  const ok = u.searchParams.has("startTime") && u.searchParams.has("endTime") && b >= a && b - a <= WEEK;
  windowed.push({ path: u.pathname, span: ok ? b - a : null });
  return ok;
};

function startVenue(): Promise<string> {
  return new Promise((resolve) => {
    venue = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      const json = (x: unknown, status = 200) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(x));
      };
      // The catalogue, unsigned, as the market-data client asks for it.
      if (u.pathname === "/fapi/v1/exchangeInfo") {
        return json({
          symbols: Object.keys(userTrades).map((s) => ({
            symbol: s, baseAsset: s.replace(/USDT$/, ""), quoteAsset: "USDT", status: "TRADING", contractType: "PERPETUAL",
          })),
        });
      }
      if (u.pathname === "/api/v3/exchangeInfo") return json({ symbols: [] });

      // Everything else is an account read, and has to be signed properly.
      const key = req.headers["x-mbx-apikey"] as string | undefined;
      const sig = u.searchParams.get("signature") ?? "";
      u.searchParams.delete("signature");
      const query = u.search.slice(1);
      const secretFor = key === KEY ? SECRET : key === SPENDING_KEY ? "spendingsecret0123456789abcdef" : null;
      const expected = secretFor ? createHmac("sha256", secretFor).update(query).digest("hex") : "";
      const signed = Boolean(secretFor) && sig === expected && Math.abs(Number(u.searchParams.get("timestamp")) - Date.now()) < 60_000;
      asked.push({ path: u.pathname, signed, key });
      if (!signed) return json({ code: -2015, msg: "Invalid API-key, IP, or permissions for action." }, 401);

      switch (u.pathname) {
        case "/sapi/v1/account/apiRestrictions":
          return json(
            key === SPENDING_KEY
              ? { enableReading: true, enableFutures: true, enableWithdrawals: true }
              : // A real read-only key: Enable Reading and nothing else. "Enable
                // Futures" is futures TRADING, and is off on a key like this.
                { enableReading: true, enableFutures: false, enableWithdrawals: false, enableSpotAndMarginTrading: false },
          );
        case "/fapi/v2/positionRisk":
          return json(positions);
        case "/fapi/v1/openOrders":
          return json(openOrders);
        case "/fapi/v1/income":
          if (!windowOk(u)) return json({ code: -1130, msg: "Data sent for parameter is not valid." }, 400);
          return json(u.searchParams.get("incomeType") === "REALIZED_PNL" ? income.filter((r) => inWindow(u, r.time)) : []);
        case "/fapi/v1/userTrades": {
          const symbol = u.searchParams.get("symbol") ?? "";
          if (symbol === REFUSED) return json({ code: -1121, msg: "Invalid symbol." }, 400);
          if (!windowOk(u)) return json({ code: -1130, msg: "Data sent for parameter is not valid." }, 400);
          return json((userTrades[symbol] ?? []).filter((r: any) => inWindow(u, r.time)));
        }
        default:
          return json({ code: -1121, msg: "Invalid symbol." }, 400);
      }
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

const ACCOUNT = "Binance Futures";
let store: any;
let manualEthId: number;
let manualSolShortId: number;

describe.skipIf(!DB)("a Binance account, synced", () => {
  beforeAll(async () => {
    const stub = await startVenue();
    process.env.BINANCE_BASE = stub;
    process.env.BINANCE_FUTURES_BASE = stub;
    process.env.BINANCE_ARCHIVE_BASE = stub;
    process.env.BINANCE_LISTING_BASE = stub;
    process.env.HYPERLIQUID_BASE = stub;
    process.env.SESSION_SECRET = `test-${stamp}-session-secret-long-enough`;

    const { initSchema, accounts, storageFor } = await import("../server/storage");
    await initSchema();
    const acct = await accounts.create({ googleSub: `bns-${stamp}`, email: `bns-${stamp}@x.test` });
    store = storageFor(acct.id);
    const { forgetRefusals } = await import("../server/binance");
    forgetRefusals();
    const { ensureCatalogue } = await import("../server/outcomes");
    await ensureCatalogue(true);

    // What a person logged before the venue was ever asked: the ETH long on
    // the way in, ten minutes late and never closed; and a SOL SHORT that is
    // not the venue's SOL long, whatever the clock says.
    manualEthId = (
      await store.createTrade({
        symbol: "ETH", direction: "long", size: 1, sizeUnit: "base", entryPrice: 2001, initialStop: 1950, initialTarget: 2200,
        entryTime: new Date(ethIn + 10 * 60_000).toISOString(), status: "open", account: ACCOUNT,
      })
    ).id;
    manualSolShortId = (
      await store.createTrade({
        symbol: "SOL", direction: "short", size: 3, sizeUnit: "base", entryPrice: 150, initialStop: 160, initialTarget: 130,
        entryTime: new Date(solIn + 5 * 60_000).toISOString(), status: "open", account: ACCOUNT,
      })
    ).id;

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

  const fees = { name: ACCOUNT, feeMode: "percent", makerFee: 0.02, takerFee: 0.05 };

  it("says so when no account holds a key", async () => {
    const r = await (await send("POST", "/api/binance/sync", {})).json();
    expect(r.accounts).toEqual([]);
    expect(r.message).toMatch(/read-only/);
  });

  it("turns away a key that can withdraw, before it is stored", async () => {
    const r = await send("PUT", "/api/account-settings", {
      ...fees, binanceKey: SPENDING_KEY, binanceSecret: "spendingsecret0123456789abcdef",
    });
    expect(r.status).toBe(400);
    expect((await r.json()).message).toMatch(/withdraw/);
    const rows = await store.listAccountSettings();
    expect(rows.find((a: any) => a.name === ACCOUNT)?.binanceKey ?? null).toBeNull();
  });

  it("will not keep a key whose permissions it could not confirm", async () => {
    // A key the venue has never heard of: the restrictions call is refused,
    // and so is the key — "probably fine" is not a permission.
    const r = await send("PUT", "/api/account-settings", {
      ...fees, binanceKey: "unknownkey0123456789abcdefghij", binanceSecret: "unknownsecret0123456789abcdef",
    });
    expect(r.status).toBe(400);
    expect((await r.json()).message).toMatch(/Could not confirm/);
  });

  it("keeps a read-only key, sealed, and tells the browser only how it ends", async () => {
    const r = await send("PUT", "/api/account-settings", { ...fees, binanceKey: KEY, binanceSecret: SECRET });
    expect(r.status).toBe(200);
    const shown: any = await r.json();
    expect(shown.binanceKeyHint).toBe(`…${KEY.slice(-4)}`);
    expect(shown).not.toHaveProperty("binanceSecret");
    expect(shown).not.toHaveProperty("binanceKey");

    const listed: any[] = await get("/api/account-settings");
    const mine = listed.find((a) => a.name === ACCOUNT);
    expect(mine.binanceKeyHint).toBe(`…${KEY.slice(-4)}`);
    expect(JSON.stringify(listed)).not.toContain(SECRET);

    // On disk: the key as given, the secret as ciphertext.
    const rows = await store.listAccountSettings();
    const row = rows.find((a: any) => a.name === ACCOUNT);
    expect(row.binanceKey).toBe(KEY);
    expect(row.binanceSecret.startsWith("v1.")).toBe(true);
    expect(row.binanceSecret).not.toContain(SECRET);
    // And every call the venue saw carried the key and a signature that held.
    expect(asked.filter((a) => a.key === KEY).every((a) => a.signed)).toBe(true);
  });

  it("writes the venue's positions, claims the one a person had logged, and sets aside what it cannot read", async () => {
    asked.length = 0;
    const r = await (await send("POST", "/api/binance/sync", { account: ACCOUNT })).json();
    const a = r.accounts[0];
    // One refused symbol and one hedged one are named — and the rest is
    // still read and written, rather than the whole account failing.
    expect(a.error).toMatch(/would not answer for LINKUSDT/);
    expect(a.error).toMatch(/ADAUSDT was traded in hedge mode/);
    expect(a).toMatchObject({ account: ACCOUNT, created: 2, claimed: 1, updated: 0, unchanged: 0, unreconstructed: 3 });
    // Every time-filtered read named both ends, a week apart at most.
    expect(windowed.length).toBeGreaterThan(10);
    expect(windowed.every((w) => w.span != null)).toBe(true);
    // The census: which key was asked, and what each market's fills became —
    // DOGE's one fill set aside before anything was reconstructed from it.
    expect(a.source).toBe(`…${KEY.slice(-4)}`);
    expect(a.markets.map((m: any) => [m.coin, m.fills, m.trades, m.unreconstructed])).toEqual(
      expect.arrayContaining([["ETHUSDT", 2, 1, 0], ["BTCUSDT", 1, 1, 0], ["SOLUSDT", 1, 1, 0], ["DOGEUSDT", 1, 0, 1], ["ADAUSDT", 2, 0, 2]]),
    );
    // Every account read was signed; the venue was asked for each symbol's
    // fills, the open positions, the income record and the resting orders.
    expect(asked.every((x) => x.signed)).toBe(true);
    expect(asked.map((x) => x.path)).toEqual(
      expect.arrayContaining(["/fapi/v2/positionRisk", "/fapi/v1/income", "/fapi/v1/userTrades", "/fapi/v1/openOrders"]),
    );

    const trades: any[] = await get("/api/trades");
    const byId = (ext: string) => trades.find((t) => t.externalId === ext);

    // The open short, with the stop and target read off the resting orders,
    // under the journal's own name for the market.
    const btc = byId("binance:BTCUSDT:3");
    expect(btc).toMatchObject({ symbol: "BTC", direction: "short", status: "open", size: 2, entryPrice: 100, initialStop: 110, initialTarget: 80, account: ACCOUNT });
    // Paid in BNB: unknown in dollars, so blank rather than $0.0004.
    expect(btc.fees).toBeNull();

    // The open long with nothing resting: blanks, for the person to fill.
    const sol = byId("binance:SOLUSDT:4");
    expect(sol).toMatchObject({ symbol: "SOL", direction: "long", status: "open", size: 3, entryPrice: 150, initialStop: null, initialTarget: null });

    // The claim: the person's ETH row, not a second one. Their entry and
    // their levels stand; the exit they never logged is filled in.
    const eth = byId("binance:ETHUSDT:1");
    expect(eth.id).toBe(manualEthId);
    expect(eth).toMatchObject({ status: "closed", exitPrice: 2100, entryPrice: 2001, initialStop: 1950, initialTarget: 2200, exitReason: "other" });
    expect(eth.fees).toBeCloseTo(1.0);
    expect(trades.filter((t) => t.symbol === "ETH")).toHaveLength(1);

    // The SOL short the person logged is not the venue's SOL long.
    const solShort = trades.find((t) => t.id === manualSolShortId);
    expect(solShort).toMatchObject({ direction: "short", status: "open", externalId: null });

    // And nothing was written for DOGE: its record opens mid-position.
    expect(trades.some((t) => t.symbol === "DOGE")).toBe(false);

    // The sync says WHAT it touched, not only how many — and names the one
    // judgement it made, the claim, so it can be looked at.
    expect(a.written.map((w: any) => [w.how, w.symbol, w.status])).toEqual(
      expect.arrayContaining([
        ["created", "BTC", "open"],
        ["created", "SOL", "open"],
        ["claimed", "ETH", "closed"],
      ]),
    );
    expect(a.written).toHaveLength(3);
    expect(a.written.find((w: any) => w.how === "claimed")).toMatchObject({ id: manualEthId, entryPrice: 2001, exitPrice: 2100 });
  });

  it("changes nothing on a second pass", async () => {
    const r = await (await send("POST", "/api/binance/sync", { account: ACCOUNT })).json();
    expect(r.accounts[0]).toMatchObject({ created: 0, claimed: 0, updated: 0, unchanged: 3, written: [] });
    const trades: any[] = await get("/api/trades");
    expect(trades.filter((t) => t.account === ACCOUNT)).toHaveLength(4);
  });

  it("clears the key, and the sealed secret with it", async () => {
    const r = await send("PUT", "/api/account-settings", { ...fees, binanceKey: null });
    expect(r.status).toBe(200);
    expect((await r.json()).binanceKeyHint).toBeNull();
    const rows = await store.listAccountSettings();
    const row = rows.find((a: any) => a.name === ACCOUNT);
    expect(row.binanceKey).toBeNull();
    expect(row.binanceSecret).toBeNull();
  });
});
