import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { zipSync, strToU8 } from "fflate";

/**
 * The trade on screen: a P&L and no chart.
 *
 * USELESS is a recent listing held from a host the perpetual API will not
 * talk to. The mark, which reads five days, found a price in the archive and
 * printed it. The chart, which reads the whole trade, reached back past the
 * coin's listing date, hit a run of files that are not there because the coin
 * did not exist yet, gave up before it had started — and then reported the
 * LIVE book's failure as the reason there was no chart. "Unexpected end of
 * JSON input", under a working P&L read out of the very same files.
 *
 * Two things had to be true at once for it to look like that, so both are
 * here: the live API answers 200 with a body that is not JSON, and the
 * archive begins partway into the window.
 */
const DB = process.env.DATABASE_URL;
if (process.env.CI && !DB) {
  throw new Error("DATABASE_URL is required in CI — the newly-listed chart test must run");
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const day0 = (ms: number) => Math.floor(ms / DAY) * DAY;

/** Listed three days ago. The trade was opened the day after. */
const LISTED = day0(Date.now() - 3 * DAY);

let venue: Server;
let app: Server;
let base: string;
let userId: number;
let store: any;
let tradeId: number;

/** The archive runs a little behind, so its last bar is always a closed one. */
const ARCHIVE_ENDS = Math.floor((Date.now() - 2 * HOUR) / HOUR) * HOUR;

function csv(dayStart: number): string {
  const rows: string[] = [];
  for (let t = dayStart; t < dayStart + DAY && t < ARCHIVE_ENDS; t += HOUR) {
    rows.push(`${t},0.29,0.30,0.28,0.292,1000,${t + HOUR - 1},290,10,500,145,0`);
  }
  return rows.join("\n");
}

/**
 * One host playing both parts: the live API that cannot be read, and the
 * bucket that only goes back as far as the listing.
 */
function startVenue(): Promise<number> {
  return new Promise((resolve) => {
    venue = createServer((req, res) => {
      const path = req.url ?? "";
      if (path.includes("/klines/")) {
        const m = path.match(/-(\d{4})-(\d{2})-(\d{2})\.zip$/);
        if (!m) {
          res.statusCode = 404;
          return res.end("no monthly file");
        }
        const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        if (day < LISTED) {
          res.statusCode = 404;
          return res.end("before the listing");
        }
        const name = path.split("/").pop()!.replace(".zip", ".csv");
        res.writeHead(200, { "content-type": "application/zip" });
        return res.end(Buffer.from(zipSync({ [name]: strToU8(csv(day)) })));
      }
      if (path.startsWith("/fapi/v1/exchangeInfo")) {
        res.setHeader("content-type", "application/json");
        return res.end(
          JSON.stringify({
            symbols: [
              {
                symbol: "USELESSUSDT",
                baseAsset: "USELESS",
                quoteAsset: "USDT",
                status: "TRADING",
                contractType: "PERPETUAL",
              },
            ],
          }),
        );
      }
      // Spot lists nothing, so there is no other book to fall back to.
      if (path.startsWith("/api/v3/exchangeInfo")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ symbols: [] }));
      }
      // Everything else on the live API: a 200 with an empty body, which is
      // what produced "Unexpected end of JSON input" on the card.
      res.writeHead(200, { "content-type": "application/json" });
      res.end("");
    });
    venue.listen(0, "127.0.0.1", () => {
      const a = venue.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
}

describe.skipIf(!DB)("a newly listed coin, on a host the perp API refuses", () => {
  beforeAll(async () => {
    const port = await startVenue();
    process.env.BINANCE_BASE = `http://127.0.0.1:${port}`;
    process.env.BINANCE_FUTURES_BASE = `http://127.0.0.1:${port}`;
    process.env.BINANCE_ARCHIVE_BASE = `http://127.0.0.1:${port}`;
    const { initSchema, accounts, storageFor } = await import("../server/storage");
    const { registerRoutes } = await import("../server/routes");
    await initSchema();
    const acct = await accounts.create({
      googleSub: `new-${stamp}`,
      email: `new-${stamp}@x.test`,
    });
    userId = acct.id;
    store = storageFor(userId);
    const { forgetRefusals } = await import("../server/binance");
    forgetRefusals();
    const { ensureCatalogue } = await import("../server/outcomes");
    await ensureCatalogue(true);

    const t = await store.createTrade({
      symbol: "USELESS",
      direction: "long",
      size: 5000,
      sizeUnit: "quote",
      entryPrice: 0.269,
      initialStop: 0.2616,
      initialTarget: 0.31,
      entryTime: new Date(LISTED + DAY).toISOString(),
      status: "open",
      account: "Binance Futures",
    } as any);
    tradeId = t.id;

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
  });

  afterAll(async () => {
    const shut = (s: Server | undefined) =>
      new Promise<void>((r) => (s ? s.close(() => r()) : r()));
    await shut(venue);
    await shut(app);
  });

  it("draws the chart from the listing onward", async () => {
    const res = await (await fetch(`${base}/api/trades/${tradeId}/candles`)).json();
    expect(res.error).toBeUndefined();
    expect(res.pair).toBe("USELESSUSDT");
    expect(res.candles.length).toBeGreaterThan(0);
    expect(res.source).toBe("archive");
    // It begins where the coin does, not where the window asked.
    expect(res.candles[0].t).toBeGreaterThanOrEqual(LISTED);
  });

  it("still has the P&L it always had, out of the same files", async () => {
    const marks = await (await fetch(`${base}/api/marks`)).json();
    expect(marks[tradeId]).toMatchObject({ venue: "binance", book: "perp", stale: true });
    expect(marks[tradeId].price).toBeGreaterThan(0);
  });

  it("names the host when the live book sends something unreadable", async () => {
    /*
     * The other half of the card. "Unexpected end of JSON input" is a
     * sentence about a parser, shown to somebody asking about a market; the
     * status errors already name the host and this one lost it.
     */
    const { forgetRefusals, fetchPerpPrices } = await import("../server/binance");
    forgetRefusals();
    const err = await fetchPerpPrices(["USELESSUSDT"]).then(
      () => null,
      (e) => String(e?.message ?? e),
    );
    expect(err).toContain("127.0.0.1");
    expect(err).toContain("/fapi/v1/ticker/price");
    expect(err).toContain("unreadable reply");
  });
});
