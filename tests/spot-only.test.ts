import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";

/**
 * What happens when only HALF of Binance answers.
 *
 * This is the shape of the real failure, not a hypothetical: fapi.binance.com
 * returns 451 to a US IP, while data-api.binance.vision — the spot mirror — is
 * not geo-restricted and answers happily. The catalogue then comes back full
 * of pairs with every perp missing, and nothing about it looks broken. Every
 * crypto trade quietly resolves to the spot book, the chart says "spot", and
 * it reads as a preference rather than a refusal.
 *
 * Two rules have to hold in that state, and they pull in opposite directions:
 *
 *   The chart still draws. Spot is within a fraction of a percent of the perp
 *   most of the time, and a labelled approximation beats a blank rectangle.
 *
 *   The resolver still refuses. noManagementOutcome is what potentialR and
 *   managementDeltaR are built from, and the perp wicks through levels the
 *   spot book never prints — so a stop that "was not hit" on spot may well
 *   have been hit on the market the order was actually resting in. That is a
 *   wrong answer at exactly the price where it decides the result.
 */
const DB = process.env.DATABASE_URL;
if (process.env.CI && !DB) {
  throw new Error("DATABASE_URL is required in CI — the spot-only tests must run");
}

const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let feed: Server;
let app: Server;
let base: string;
let userId: number;
let store: any;
let checkOutcomes: (id: number) => Promise<any>;

/** Spot answers; the perp book refuses exactly the way the real one does. */
function startFeed(): Promise<number> {
  return new Promise((resolve) => {
    feed = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      if (u.pathname.startsWith("/fapi/")) {
        res.statusCode = 451;
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ code: 0, msg: "Service unavailable from a restricted location." }));
      }
      res.setHeader("content-type", "application/json");
      if (u.pathname === "/api/v3/exchangeInfo") {
        return res.end(
          JSON.stringify({
            symbols: [
              // BTC is on the written-down perp list; JUNKX is not, so it
              // stands for a coin that genuinely only trades on spot.
              { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "TRADING" },
              { symbol: "JUNKXUSDT", baseAsset: "JUNKX", quoteAsset: "USDT", status: "TRADING" },
            ],
          }),
        );
      }
      if (u.pathname === "/api/v3/klines") {
        const start = Number(u.searchParams.get("startTime"));
        const end = Number(u.searchParams.get("endTime"));
        const step = 3600e3;
        const out: any[] = [];
        // A run to the target, so a trade that IS read comes back settled —
        // which is what makes the refusal below meaningful rather than vacuous.
        for (let t = Math.floor(start / step) * step; t <= end && out.length < 1000; t += step) {
          out.push([t, "100", "131", "99", "130", "1", t + step - 1, "1", 1, "1", "1", "0"]);
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

const ago = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();

const closed = (over: Record<string, unknown>) =>
  store.createTrade({
    symbol: "BTC",
    direction: "long",
    size: 1,
    sizeUnit: "base",
    entryPrice: 100,
    initialStop: 90,
    initialTarget: 130,
    entryTime: ago(10),
    exitTime: ago(6),
    status: "closed",
    exitPrice: 112,
    exitReason: "discretion",
    ...over,
  } as any);

describe.skipIf(!DB)("when only the spot book answers", () => {
  beforeAll(async () => {
    const port = await startFeed();
    // Read at module load by server/binance.ts, so it must be set first.
    process.env.BINANCE_BASE = `http://127.0.0.1:${port}`;
    process.env.BINANCE_FUTURES_BASE = `http://127.0.0.1:${port}`;
    // Pinned at the stub, which serves no archive: without this the fallback
    // would reach for the real data.binance.vision, and a CI runner with
    // egress would settle these trades from live BTC prices.
    process.env.BINANCE_ARCHIVE_BASE = `http://127.0.0.1:${port}`;
    const { initSchema, accounts, storageFor } = await import("../server/storage");
    const { registerRoutes } = await import("../server/routes");
    await initSchema();
    const acct = await accounts.create({ googleSub: `spot-${stamp}`, email: `spot-${stamp}@x.test` });
    userId = acct.id;
    store = storageFor(userId);
    ({ checkOutcomes } = await import("../server/outcomes"));
    // Forced: another test file may have cached a catalogue minutes ago, and
    // the TTL would hand it back instead of asking this stub anything.
    const { ensureCatalogue } = await import("../server/outcomes");
    await ensureCatalogue(true);

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
    // Each closed on its own: chaining them through optional calls means one
    // server that never started leaves the promise unresolved and the hook
    // times out instead of reporting whatever really failed.
    const shut = (s: Server | undefined) =>
      new Promise<void>((r) => (s ? s.close(() => r()) : r()));
    await shut(feed);
    await shut(app);
  });

  it("never settles a coin that has a perp from spot candles", async () => {
    /*
     * The trade IS matched — to the perpetual, not to the spot pair sitting in
     * the catalogue — and then read from wherever perp bars can be had. Here
     * that is nowhere: the API refuses and the archive is a stub with no files
     * in it. So nothing is written, which is the point. The one outcome that
     * must never happen is the spot candles in this fixture, which run to the
     * target, settling it as target_first.
     */
    const t = await closed({ symbol: "BTC", exitTime: ago(5) });
    await checkOutcomes(userId);

    const after = await store.getTrade(t.id);
    // Left exactly as it was — including outcomeCheckedAt, so it is asked
    // again the moment perp bars can be reached rather than being marked done
    // on the strength of a market it was never traded in.
    expect(after.noManagementOutcome).toBeNull();
    expect(after.outcomeCheckedAt).toBeNull();
  });

  it("still settles a coin that only ever traded on spot", async () => {
    // The refusal has to be about the missing perp, not about spot itself.
    const t = await closed({ symbol: "JUNKX", exitTime: ago(4) });
    await checkOutcomes(userId);
    const after = await store.getTrade(t.id);
    expect(after.noManagementOutcome).toBe("target_first");
    expect(after.outcomeSource).toBe("auto");
  });

  it("still draws the chart, and says which book it had to use", async () => {
    const t = await closed({ symbol: "BTC", exitTime: ago(3) });
    const r = await fetch(`${base}/api/trades/${t.id}/candles`).then((x) => x.json());
    expect(r.pair).toBe("BTCUSDT");
    expect(r.market).toBe("spot");
    expect(r.candles.length).toBeGreaterThan(0);
    // What the chart's "perp book unreachable" line is keyed off. A count of
    // zero perps is the only thing that separates "spot because that is where
    // it trades" from "spot because the perp book refused".
    expect(r.books).toEqual({ futures: 0, spot: 2 });
  });

  it("hands back older bars when the chart is scrolled off its left edge", async () => {
    // A chart you cannot scroll back on is a screenshot. The trade's own
    // window is all the first request returns; everything before it arrives a
    // page at a time, and every bar in a page must be older than what is
    // already drawn or the series would be handed unsorted data.
    const t = await closed({ symbol: "BTC", exitTime: ago(2) });
    const first = await fetch(`${base}/api/trades/${t.id}/candles?interval=1h`).then((x) => x.json());
    expect(first.candles.length).toBeGreaterThan(0);
    const edge = first.candles[0].t;

    const page = await fetch(
      `${base}/api/trades/${t.id}/candles?interval=1h&before=${edge - 1}`,
    ).then((x) => x.json());
    expect(page.candles.length).toBeGreaterThan(100);
    expect(page.candles.every((c: any) => c.t < edge)).toBe(true);
  });

  it("reports the refusal even though the other book answered", async () => {
    // The failure that hides best: half a catalogue, a healthy-looking pair
    // count, and lastError cleared by whichever request happened to succeed
    // last. The 451 has to survive the spot fetch landing after it.
    const { feedStatus } = await import("../server/binance");
    const s = feedStatus();
    // catalogueError rather than lastError, and that is the whole point of it
    // existing: by now several spot klines calls have succeeded, and each one
    // cleared lastError. The 451 has to outlive them.
    expect(s.catalogueError).toMatch(/futures:/);
    expect(s.catalogueError).toMatch(/451/);
    expect(s.books).toEqual({ futures: 0, spot: 2 });
  });
});
