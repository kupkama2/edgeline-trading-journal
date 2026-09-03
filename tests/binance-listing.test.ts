import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import {
  LISTING_PREFIX,
  livenessQuery,
  parseListingPage,
  perpFromListing,
  readLiveness,
  ymdUtc,
} from "../shared/binance-listing";
import { matchBinanceSymbol } from "../shared/binance";

/**
 * The perp list read off the bucket, when the API will not give it.
 *
 * The test that earns its keep is the census: a folder in the bucket is not
 * a contract that trades, and a name from the listing must stay provisional
 * until the folder has been asked whether it still publishes. Everything
 * else is reading XML correctly, which is dull and has to be right.
 */

const DB = process.env.DATABASE_URL;
if (process.env.CI && !DB) {
  throw new Error("DATABASE_URL is required in CI — the listing tests must run");
}
const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DAY = 86_400_000;

const folder = (s: string) => `<CommonPrefixes><Prefix>${LISTING_PREFIX}${s}/</Prefix></CommonPrefixes>`;
/** A listing page as S3 actually writes one, with the request prefix echoed. */
const page = (names: string[], tail = "<IsTruncated>false</IsTruncated>") =>
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>data.binance.vision</Name>` +
  `<Prefix>${LISTING_PREFIX}</Prefix><Marker></Marker><MaxKeys>1000</MaxKeys><Delimiter>/</Delimiter>${tail}` +
  names.map(folder).join("\n") +
  `</ListBucketResult>`;

describe("reading a listing page", () => {
  it("takes every folder name and not the echoed request prefix", () => {
    const r = parseListingPage(page(["1000PEPEUSDT", "BTCUSDT", "ETHBUSD"]));
    expect(r.symbols).toEqual(["1000PEPEUSDT", "BTCUSDT", "ETHBUSD"]);
    expect(r.nextMarker).toBeNull();
  });

  it("knows where to resume when the bucket cut the page short", () => {
    const cut = page(
      ["AUSDT", "BUSDT"],
      `<IsTruncated>true</IsTruncated><NextMarker>${LISTING_PREFIX}BUSDT/</NextMarker>`,
    );
    expect(parseListingPage(cut).nextMarker).toBe(`${LISTING_PREFIX}BUSDT/`);
    // Without a NextMarker the last folder seen is the marker.
    expect(parseListingPage(page(["AUSDT", "BUSDT"], "<IsTruncated>true</IsTruncated>")).nextMarker).toBe(
      `${LISTING_PREFIX}BUSDT/`,
    );
  });

  it("has nothing to say about an empty or foreign page", () => {
    expect(parseListingPage(page([])).symbols).toEqual([]);
    expect(parseListingPage("<html>not a bucket</html>").symbols).toEqual([]);
  });
});

describe("a folder name as a catalogue row", () => {
  it("splits the quote off a perp and calls it a futures row", () => {
    expect(perpFromListing("BTCUSDT")).toEqual({
      symbol: "BTCUSDT",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      status: "TRADING",
      market: "futures",
    });
    expect(perpFromListing("1000PEPEUSDT")!.baseAsset).toBe("1000PEPE");
    expect(perpFromListing("SOLUSDC")!.quoteAsset).toBe("USDC");
    expect(perpFromListing("ETHBUSD")!.quoteAsset).toBe("BUSD");
  });

  it("skips a quarterly, which is a different contract at a different price", () => {
    expect(perpFromListing("BTCUSDT_240329")).toBeNull();
  });

  it("refuses a name that is only a quote, or quoted in nothing it knows", () => {
    expect(perpFromListing("USDT")).toBeNull();
    expect(perpFromListing("BTCEUR")).toBeNull();
    expect(perpFromListing("")).toBeNull();
  });
});

describe("asking whether a perp still publishes", () => {
  const since = "2026-08-20";

  it("asks for the first daily file on or after two weeks ago, and only one", () => {
    const q = livenessQuery("BTCUSDT", since);
    expect(q).toContain(`prefix=${encodeURIComponent(`${LISTING_PREFIX}BTCUSDT/1d/`)}`);
    expect(q).toContain(`marker=${encodeURIComponent(`${LISTING_PREFIX}BTCUSDT/1d/BTCUSDT-1d-${since}`)}`);
    expect(q).toContain("max-keys=1");
  });

  it("calls a folder live when a file from within the window comes back", () => {
    const xml = `<ListBucketResult><Contents><Key>${LISTING_PREFIX}BTCUSDT/1d/BTCUSDT-1d-2026-08-21.zip</Key></Contents></ListBucketResult>`;
    expect(readLiveness(xml, "BTCUSDT", since)).toBe(true);
  });

  it("calls it dead when nothing comes back, or only something older", () => {
    expect(readLiveness("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>", "OLDUSDT", since)).toBe(false);
    const stale = `<ListBucketResult><Contents><Key>${LISTING_PREFIX}OLDUSDT/1d/OLDUSDT-1d-2023-02-01.zip</Key></Contents></ListBucketResult>`;
    expect(readLiveness(stale, "OLDUSDT", since)).toBe(false);
  });

  it("does not let another symbol's file vouch for this one", () => {
    const other = `<ListBucketResult><Contents><Key>${LISTING_PREFIX}BTCUSDT/1d/BTCUSDT-1d-2026-08-21.zip</Key></Contents></ListBucketResult>`;
    expect(readLiveness(other, "OLDUSDT", since)).toBe(false);
  });

  it("names the day the way the archive does, in UTC", () => {
    expect(ymdUtc(Date.UTC(2026, 7, 3, 23, 59))).toBe("2026-08-03");
    expect(ymdUtc(Date.UTC(2026, 0, 1))).toBe("2026-01-01");
  });
});

describe.skipIf(!DB)("the perp book, read off the bucket when the API refuses", () => {
  let stub: Server;
  let app: Server;
  let base: string;
  const hits = { fapi: 0, listing: 0, probes: 0 };
  const alive = new Set(["BTCUSDT", "ETHUSDT"]);

  beforeAll(async () => {
    stub = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      const xml = (s: string) => {
        res.setHeader("content-type", "application/xml");
        res.end(s);
      };
      if (u.pathname.startsWith("/fapi/")) {
        hits.fapi += 1;
        res.statusCode = 451;
        return res.end("{}");
      }
      if (u.pathname === "/api/v3/exchangeInfo") {
        res.setHeader("content-type", "application/json");
        return res.end(
          JSON.stringify({
            symbols: [{ symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "TRADING" }],
          }),
        );
      }
      const prefix = u.searchParams.get("prefix") ?? "";
      if (u.pathname === "/" && prefix === LISTING_PREFIX) {
        hits.listing += 1;
        return xml(page(["BTCUSDT", "BTCUSDT_240329", "DEADUSDT", "ETHUSDT"]));
      }
      const probe = /^data\/futures\/um\/daily\/klines\/([A-Z0-9]+)\/1d\/$/.exec(prefix);
      if (u.pathname === "/" && probe) {
        hits.probes += 1;
        const sym = probe[1];
        const found = alive.has(sym)
          ? `<Contents><Key>${prefix}${sym}-1d-${ymdUtc(Date.now() - DAY)}.zip</Key></Contents>`
          : "";
        return xml(
          `<ListBucketResult><Prefix>${prefix}</Prefix><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated>${found}</ListBucketResult>`,
        );
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
    const host = `http://127.0.0.1:${(stub.address() as any).port}`;
    process.env.BINANCE_BASE = host;
    process.env.BINANCE_FUTURES_BASE = host;
    process.env.BINANCE_ARCHIVE_BASE = host;
    process.env.BINANCE_LISTING_BASE = host;
    process.env.HYPERLIQUID_BASE = host;

    const { initSchema, accounts } = await import("../server/storage");
    await initSchema();
    const acct = await accounts.create({ googleSub: `ls-${stamp}`, email: `ls-${stamp}@x.test` });

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
    await shut(stub);
    await shut(app);
  });

  it("names every perp folder, skips the quarterly, and demotes the dead one", async () => {
    const { ensureCatalogue } = await import("../server/outcomes");
    const cat = await ensureCatalogue(true, "await");
    const futures = cat.filter((s) => s.market === "futures");
    expect(futures.map((s) => `${s.symbol}:${s.status}`).sort()).toEqual([
      "BTCUSDT:TRADING",
      "DEADUSDT:DELISTED",
      "ETHUSDT:TRADING",
    ]);
    // One probe per perp; the quarterly was never a perp and was never asked.
    expect(hits.probes).toBe(3);
    const { feedStatus } = await import("../server/binance");
    expect(feedStatus().futuresSource).toBe("listing");
    expect(feedStatus().listing.probedDead).toBe(1);
    expect(feedStatus().listing.probedLive).toBe(2);
  });

  it("matches a live perp and refuses the dead one", async () => {
    const { ensureCatalogue } = await import("../server/outcomes");
    const cat = await ensureCatalogue();
    expect(matchBinanceSymbol("ETH", cat)).toEqual({ symbol: "ETHUSDT", market: "futures" });
    // The perp over the spot pair of the same name, as ever.
    expect(matchBinanceSymbol("BTC", cat)).toEqual({ symbol: "BTCUSDT", market: "futures" });
    expect(matchBinanceSymbol("DEAD", cat)).toBeNull();
  });

  it("offers only the live ones to the picker, perps first", async () => {
    const r = await fetch(`${base}/api/binance/symbols`).then((x) => x.json());
    expect(r.map((s: any) => `${s.symbol}:${s.market}`)).toEqual([
      "BTCUSDT:futures",
      "ETHUSDT:futures",
      "BTCUSDT:spot",
    ]);
  });

  it("says where the book came from", async () => {
    const r = await fetch(`${base}/api/binance/status`).then((x) => x.json());
    expect(r.futuresSource).toBe("listing");
    expect(r.futures).toBe(3);
    expect(r.delisted).toBe(1);
    expect(r.listing.symbols).toBe(3);
    expect(r.listing.lastError).toBeNull();
    // The API's refusal is still on record — the listing is a workaround, not a cure.
    expect(r.catalogueError).toMatch(/451/);
  });

  it("does not ask a host that said 451 again for hours, unless told to", async () => {
    const { fetchCatalogue, forgetRefusals } = await import("../server/binance");
    const before = hits.fapi;
    await fetchCatalogue();
    expect(hits.fapi).toBe(before);
    forgetRefusals();
    await fetchCatalogue();
    expect(hits.fapi).toBe(before + 1);
  });
});
