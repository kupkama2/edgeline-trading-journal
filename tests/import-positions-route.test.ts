import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";

/**
 * A Positions tab, imported: the four rows from the screenshot that asked for
 * this, through the route and into the journal as open trades sharing one
 * idea, account and time — each with its stop, a 1R target where none was
 * set, and the book it trades on.
 */
const DB = process.env.DATABASE_URL;
if (process.env.CI && !DB) {
  throw new Error("DATABASE_URL is required in CI — the route tests must run");
}

let server: Server;
let base: string;

beforeAll(async () => {
  if (!DB) return;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { initSchema, accounts } = await import("../server/storage");
  const { registerRoutes } = await import("../server/routes");
  await initSchema();
  const account = await accounts.create({ googleSub: `pos-${stamp}`, email: `pos-${stamp}@x.test` });
  const app = express();
  app.use(express.json({ limit: "25mb" }));
  app.use((req, _res, next) => {
    (req as any).userId = account.id;
    next();
  });
  server = createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
});

const post = (body: unknown) =>
  fetch(`${base}/api/trades/import-positions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const tab = {
  account: "Binance Futures",
  rationale: "Bullish crypto: BTC as the core, smaller alts for the upside.",
  entryTime: "2026-10-18T09:00:00.000Z",
  positions: [
    { symbol: "ZECUSDT", direction: "long", size: 3028.28, sizeUnit: "quote", entryPrice: 1137.29, initialStop: 1068.14 },
    { symbol: "INJUSDT", direction: "long", size: 1500, sizeUnit: "quote", entryPrice: 8.429, initialStop: 7.946 },
    {
      symbol: "BTCUSDC",
      direction: "long",
      size: 10079.95,
      sizeUnit: "quote",
      entryPrice: 81620.1,
      initialStop: 80539.2,
      initialTarget: 84262.8,
    },
    { symbol: "ONDOUSDT", direction: "long", size: 800, sizeUnit: "quote", entryPrice: 0.4408999, initialStop: 0.3943 },
  ],
};

describe.skipIf(!DB)("importing a Positions tab", () => {
  it("opens one trade per row, sharing the idea, account and time", async () => {
    const res = await post(tab);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.imported).toBe(4);
    expect(body.skipped).toEqual([]);
    for (const t of body.trades) {
      expect(t.status).toBe("open");
      expect(t.account).toBe("Binance Futures");
      expect(t.rationale).toMatch(/Bullish crypto/);
      expect(t.entryTime).toBe("2026-10-18T09:00:00.000Z");
    }
    const [zec, , btc, ondo] = body.trades;
    // No target on the screen: 1R, marked.
    expect(zec.initialTarget).toBe(1206.44);
    expect(zec.targetSource).toBe("default");
    expect(ondo.initialTarget).toBe(0.4874998);
    // A target on the screen: kept as given.
    expect(btc.initialTarget).toBe(84262.8);
    expect(btc.targetSource ?? null).toBeNull();
    // The USDC book is recorded, so prices are read from where it trades.
    expect(btc.pricePair).toBe("binance:BTCUSDC:futures");
  });

  it("skips a row already open in the journal, so the same tab twice is not doubled", async () => {
    const res = await post(tab);
    const body = await res.json();
    expect(body.imported).toBe(0);
    expect(body.skipped).toEqual(["ZECUSDT", "INJUSDT", "BTCUSDC", "ONDOUSDT"]);
  });

  it("refuses a stop on the profit side", async () => {
    const res = await post({
      positions: [{ symbol: "SOLUSDT", direction: "long", size: 100, sizeUnit: "quote", entryPrice: 150, initialStop: 160 }],
    });
    expect(res.status).toBe(400);
  });

  it("refuses a position with no stop", async () => {
    const res = await post({
      positions: [{ symbol: "SOLUSDT", direction: "long", size: 100, sizeUnit: "quote", entryPrice: 150 }],
    });
    expect(res.status).toBe(400);
  });
});
