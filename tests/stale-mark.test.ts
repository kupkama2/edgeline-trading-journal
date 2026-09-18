import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";

/**
 * A price for a position nothing will quote.
 *
 * Binance's perpetual API refuses some hosts outright and, unlike spot, has
 * no open mirror — so from such a host an open perp had no mark at all: no
 * live P&L, no live R, two dashes sitting beside a chart drawn from the very
 * prices that would have filled them in. The chart could draw because the
 * candle ARCHIVE answers from anywhere; nothing had thought to ask it for a
 * price.
 *
 * Now it is asked, and the answer is labelled. That is the whole rule: a
 * day-old number that says it is a day old is useful, and the same number
 * presented as live is the one thing this journal must never do. So the mark
 * carries the instant it is FOR and a flag, and every surface that shows it
 * prints "last read" instead of "open".
 */
const DB = process.env.DATABASE_URL;
if (process.env.CI && !DB) {
  throw new Error("DATABASE_URL is required in CI — the stale-mark tests must run");
}

const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let feed: Server;
let app: Server;
let base: string;
let userId: number;
let store: any;

/** The last bar any kline read can reach: three hours old, and closed. */
const CUTOFF = Math.floor((Date.now() - 3 * 3600e3) / 3600e3) * 3600e3;

/** How many candle reads the rescue actually costs. */
let klineCalls = 0;

/** Nine strandable coins, so the cap on rescue reads has something to cap. */
const STRANDED = Array.from({ length: 9 }, (_, i) => `STRND${i}`);
const PERPS = ["LIVEX", ...STRANDED];

/**
 * The perp book quotes one coin and forgets the rest, while its klines answer
 * for everything — the exact asymmetry a geo-block produces, with the ticker
 * failing on a status that is NOT remembered, so klines stay reachable.
 */
function startFeed(): Promise<number> {
  return new Promise((resolve) => {
    feed = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      res.setHeader("content-type", "application/json");
      if (u.pathname === "/fapi/v1/exchangeInfo") {
        return res.end(
          JSON.stringify({
            symbols: PERPS.map((c) => ({
              symbol: `${c}USDT`,
              baseAsset: c,
              quoteAsset: "USDT",
              status: "TRADING",
              contractType: "PERPETUAL",
            })),
          }),
        );
      }
      // Spot lists none of them, so there is no spot mark to hide behind.
      if (u.pathname === "/api/v3/exchangeInfo") return res.end(JSON.stringify({ symbols: [] }));
      if (u.pathname === "/fapi/v1/ticker/price") {
        return res.end(JSON.stringify([{ symbol: "LIVEXUSDT", price: "120" }]));
      }
      if (u.pathname === "/fapi/v1/klines") {
        klineCalls += 1;
        const start = Number(u.searchParams.get("startTime"));
        const step = 3600e3;
        const out: any[] = [];
        for (let t = Math.floor(start / step) * step; t <= CUTOFF && out.length < 1000; t += step) {
          out.push([t, "100", "111", "99", "110", "1", t + step - 1, "1", 1, "1", "1", "0"]);
        }
        return res.end(JSON.stringify(out));
      }
      res.statusCode = 404;
      res.end("{}");
    });
    feed.listen(0, "127.0.0.1", () => {
      const a = feed.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
}

/**
 * One per hour going back, newest first in PERPS order — the same order the
 * journal lists them in, which is the order the cap consumes.
 */
const open = (symbol: string, hoursAgo: number) =>
  store.createTrade({
    symbol,
    direction: "long",
    size: 1,
    sizeUnit: "base",
    entryPrice: 100,
    initialStop: 90,
    initialTarget: 130,
    entryTime: new Date(Date.now() - hoursAgo * 3600e3).toISOString(),
    status: "open",
  } as any);

describe.skipIf(!DB)("when nothing will quote the book", () => {
  let marks: Record<string, any>;
  let ids: Record<string, number> = {};

  beforeAll(async () => {
    const port = await startFeed();
    // Read at module load by server/binance.ts, so it must be set first.
    process.env.BINANCE_BASE = `http://127.0.0.1:${port}`;
    process.env.BINANCE_FUTURES_BASE = `http://127.0.0.1:${port}`;
    // Pinned at the stub so a runner with egress cannot quietly answer from
    // the real bucket and make this test about the internet.
    process.env.BINANCE_ARCHIVE_BASE = `http://127.0.0.1:${port}`;
    const { initSchema, accounts, storageFor } = await import("../server/storage");
    const { registerRoutes } = await import("../server/routes");
    await initSchema();
    const acct = await accounts.create({ googleSub: `stale-${stamp}`, email: `stale-${stamp}@x.test` });
    userId = acct.id;
    store = storageFor(userId);
    // Forced, and the held ticker book dropped: another file may have cached
    // either minutes ago, and both would answer instead of this stub.
    const { forgetRefusals } = await import("../server/binance");
    forgetRefusals();
    const { ensureCatalogue } = await import("../server/outcomes");
    await ensureCatalogue(true);

    for (const [i, c] of PERPS.entries()) ids[c] = (await open(c, i + 1)).id;

    const server = express();
    server.use(express.json({ limit: "25mb" }));
    server.use((req, _res, next) => {
      (req as any).userId = userId;
      next();
    });
    app = createServer(server);
    await registerRoutes(app, server);
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const addr = app.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    marks = await (await fetch(`${base}/api/marks`)).json();
  });

  afterAll(async () => {
    const shut = (s: Server | undefined) =>
      new Promise<void>((r) => (s ? s.close(() => r()) : r()));
    await shut(feed);
    await shut(app);
  });

  it("takes the live quote where there is one, and says nothing about it", () => {
    const m = marks[ids.LIVEX];
    expect(m).toMatchObject({ price: 120, book: "perp", venue: "binance" });
    expect(m.stale).toBeFalsy();
    expect(m.at).toBeGreaterThan(CUTOFF);
  });

  it("falls back to the last readable close, timed to the bar it came from", () => {
    const m = marks[ids.STRND0];
    expect(m).toMatchObject({ price: 110, book: "perp", venue: "binance", stale: true });
    // The bar's close, not now: that is the last moment anybody can say the
    // price was true.
    expect(m.at).toBe(CUTOFF + 3600e3);
  });

  it("caps the rescue, because a venue that is down stays down", () => {
    // Eight round trips is a rescue; nine hundred is a second pricing
    // strategy aimed at a host that has already said no. The cap takes them
    // in the order the journal lists them — newest entry first — so what
    // falls off the end is the oldest position, which is also the one least
    // likely to be the reason somebody opened the page.
    const rescued = STRANDED.filter((c) => marks[ids[c]]?.stale);
    expect(rescued).toEqual(STRANDED.slice(0, 8));
    expect(marks[ids.STRND8]).toBeUndefined();
  });

  it("holds each read, because the journal asks for marks every minute", async () => {
    /*
     * The rescue is a window of candles PER pair — from the archive, on the
     * host that needs it — against a live quote's one call for everything. A
     * poll every sixty seconds would make it the most expensive thing the
     * journal does, aimed at a venue that has already refused to talk.
     */
    const before = klineCalls;
    const again = await (await fetch(`${base}/api/marks`)).json();
    expect(klineCalls).toBe(before);
    expect(again[ids.STRND0]).toMatchObject({ price: 110, stale: true });
    // And "ask again" still means everything.
    await fetch(`${base}/api/markets/refresh`, { method: "POST" });
    await fetch(`${base}/api/marks`);
    expect(klineCalls).toBeGreaterThan(before);
  });
});
