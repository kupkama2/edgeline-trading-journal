import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { parseHyperliquidMeta, venueOfAccount } from "../shared/hyperliquid";

/**
 * The other venue.
 *
 * Hyperliquid's universe is a flat list of coins, and the tests that matter
 * are the ones about what is KEPT: the venue's own spelling (kPEPE), the
 * delisted flag rather than a silently shorter list, and nothing at all when
 * the answer is not shaped like an answer.
 */

const DB = process.env.DATABASE_URL;
if (process.env.CI && !DB) {
  throw new Error("DATABASE_URL is required in CI — the Hyperliquid route tests must run");
}
const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** What `{"type":"meta"}` actually comes back as, trimmed. */
const META = {
  universe: [
    { name: "BTC", szDecimals: 5, maxLeverage: 40, marginTableId: 50 },
    { name: "ETH", szDecimals: 4, maxLeverage: 25, marginTableId: 50 },
    { name: "kPEPE", szDecimals: 0, maxLeverage: 10, onlyIsolated: true, marginTableId: 10 },
    { name: "OLDCOIN", szDecimals: 1, maxLeverage: 3, isDelisted: true, marginTableId: 3 },
    { name: "HYPE", szDecimals: 2, maxLeverage: 10, marginTableId: 10 },
  ],
  marginTables: [[50, { description: "", marginTiers: [{ lowerBound: "0", maxLeverage: 50 }] }]],
};

describe("reading Hyperliquid's universe", () => {
  it("keeps the venue's own names, kPEPE included", () => {
    expect(parseHyperliquidMeta(META).map((p) => p.name)).toEqual([
      "BTC",
      "ETH",
      "kPEPE",
      "OLDCOIN",
      "HYPE",
    ]);
  });

  it("carries the delisted flag rather than dropping the coin", () => {
    const perps = parseHyperliquidMeta(META);
    expect(perps.find((p) => p.name === "OLDCOIN")!.delisted).toBe(true);
    expect(perps.filter((p) => p.delisted)).toHaveLength(1);
  });

  it("reads leverage as a number, and as unknown when it is not one", () => {
    expect(parseHyperliquidMeta(META).find((p) => p.name === "BTC")!.maxLeverage).toBe(40);
    expect(parseHyperliquidMeta({ universe: [{ name: "X", maxLeverage: "lots" }] })[0].maxLeverage).toBeNull();
    expect(parseHyperliquidMeta({ universe: [{ name: "X" }] })[0].maxLeverage).toBeNull();
  });

  it("answers nothing, not half a list, when the shape is wrong", () => {
    expect(parseHyperliquidMeta(null)).toEqual([]);
    expect(parseHyperliquidMeta(undefined)).toEqual([]);
    expect(parseHyperliquidMeta({})).toEqual([]);
    expect(parseHyperliquidMeta({ universe: "BTC,ETH" })).toEqual([]);
    expect(parseHyperliquidMeta([{ name: "BTC" }])).toEqual([]);
  });

  it("skips an entry without a name and keeps the rest", () => {
    const out = parseHyperliquidMeta({
      universe: [{ name: "BTC" }, { szDecimals: 1 }, { name: "" }, { name: "  " }, { name: "BTC" }],
    });
    expect(out.map((p) => p.name)).toEqual(["BTC"]);
  });
});

describe("which venue an account points at", () => {
  it("reads the usual spellings", () => {
    expect(venueOfAccount("Hyperliquid")).toBe("hyperliquid");
    expect(venueOfAccount("HL main")).toBe("hyperliquid");
    expect(venueOfAccount("hyperliquid perps")).toBe("hyperliquid");
    expect(venueOfAccount("Binance Futures")).toBe("binance");
    expect(venueOfAccount("bn perps")).toBe("binance");
  });

  it("says nothing for a name that does not say", () => {
    expect(venueOfAccount("Prop eval 50k")).toBeNull();
    expect(venueOfAccount("")).toBeNull();
    expect(venueOfAccount(null)).toBeNull();
    expect(venueOfAccount(undefined)).toBeNull();
    // "hl" only counts as a word of its own.
    expect(venueOfAccount("Shlomo")).toBeNull();
  });
});

describe.skipIf(!DB)("the universe, cached and served", () => {
  let venue: Server;
  let app: Server;
  let base: string;
  let hits = 0;
  let answer: unknown = META;

  beforeAll(async () => {
    venue = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.method !== "POST" || req.url !== "/info") {
          res.statusCode = 404;
          return res.end("{}");
        }
        hits += 1;
        const asked = JSON.parse(body || "{}");
        if (asked.type !== "meta") {
          res.statusCode = 400;
          return res.end("{}");
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(answer));
      });
    });
    await new Promise<void>((r) => venue.listen(0, "127.0.0.1", () => r()));
    const stub = `http://127.0.0.1:${(venue.address() as any).port}`;
    process.env.HYPERLIQUID_BASE = stub;
    // Binance pointed at the same stub, which 404s it: no test reaches a
    // real venue, whatever the network here allows.
    process.env.BINANCE_BASE = stub;
    process.env.BINANCE_FUTURES_BASE = stub;
    process.env.BINANCE_ARCHIVE_BASE = stub;
    process.env.BINANCE_LISTING_BASE = stub;

    const { initSchema, accounts } = await import("../server/storage");
    await initSchema();
    const acct = await accounts.create({ googleSub: `hl-${stamp}`, email: `hl-${stamp}@x.test` });

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
    // Ask the venue once, now, whatever an earlier run left in the table: the
    // status assertions below are about a process that has actually fetched.
    await fetch(`${base}/api/binance/status?refresh=1`);
  });

  afterAll(async () => {
    const shut = (x: Server | undefined) =>
      new Promise<void>((r) => (x ? x.close(() => r()) : r()));
    await shut(venue);
    await shut(app);
  });

  it("serves the perps the venue lists, delisted ones left out", async () => {
    const r = await fetch(`${base}/api/hyperliquid/symbols`).then((x) => x.json());
    expect(r.map((p: any) => p.name)).toEqual(["BTC", "ETH", "kPEPE", "HYPE"]);
    expect(r.find((p: any) => p.name === "BTC").maxLeverage).toBe(40);
  });

  it("reads from the cache rather than asking the venue on every request", async () => {
    const before = hits;
    await fetch(`${base}/api/hyperliquid/symbols`);
    await fetch(`${base}/api/hyperliquid/symbols`);
    expect(hits).toBe(before);
  });

  it("says in the status what it has and when it last asked", async () => {
    const r = await fetch(`${base}/api/binance/status`).then((x) => x.json());
    expect(r.hyperliquid.listed).toBe(4);
    expect(r.hyperliquid.delisted).toBe(1);
    expect(r.hyperliquid.perps).toBe(5);
    expect(r.hyperliquid.lastOkAt).toBeTruthy();
    expect(r.hyperliquid.lastError).toBeNull();
  });

  it("keeps the cache when the venue stops making sense", async () => {
    answer = { universe: "gone" };
    const r = await fetch(`${base}/api/binance/status?refresh=1`).then((x) => x.json());
    expect(r.hyperliquid.lastError).toMatch(/universe/);
    // The last good list is still what gets served.
    const list = await fetch(`${base}/api/hyperliquid/symbols`).then((x) => x.json());
    expect(list.map((p: any) => p.name)).toContain("kPEPE");
    expect(r.hyperliquid.listed).toBe(4);
  });
});
