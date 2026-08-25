import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { zipSync, strToU8 } from "fflate";

/**
 * Reading perpetuals out of Binance's public file archive.
 *
 * This is the path that makes perps readable at all from a US host: the API
 * answers 451 and has no mirror, while data.binance.vision serves the same
 * bars as zipped CSVs from a domain that is not geo-restricted. It is a day
 * behind, which is fine for the only question it is asked — "left alone,
 * would this have hit the target or the stop?" is about the past.
 *
 * The zips here are REAL zips, built with the same library that reads them,
 * because a hand-mocked "unzip" would test nothing about the part most likely
 * to be wrong. Each test uses its own coin: files are cached by URL, correctly
 * — the archive is immutable — so two tests sharing a symbol and a date would
 * share a file and one would silently read the other's fixture.
 *
 * The rule under test above all others is the prefix rule. Gathering stops at
 * the first file that cannot be read, so a scan always walks a contiguous run
 * forward from the entry. Skipping a hole and carrying on would let a stop hit
 * on day three be reported as a target hit on day ten — a confident wrong
 * answer, which is the one output this whole subsystem is built never to
 * produce.
 */
const DB = process.env.DATABASE_URL;
if (process.env.CI && !DB) {
  throw new Error("DATABASE_URL is required in CI — the archive tests must run");
}

const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DAY = 86_400_000;
const HOUR = 3_600_000;

let feed: Server;
let userId: number;
let store: any;
let checkOutcomes: (id: number) => Promise<any>;

/** Which days the archive has, and what is in them. Rewritten per test. */
let days = new Map<string, { t: number; o: number; h: number; l: number; c: number }[]>();

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A day of hourly bars, flat unless a spike is asked for. */
function flatDay(dayStart: number, price: number, spike?: { hour: number; high: number; low: number }) {
  const bars = [];
  for (let i = 0; i < 24; i++) {
    const s = spike && spike.hour === i;
    bars.push({
      t: dayStart + i * HOUR,
      o: price,
      h: s ? spike!.high : price + 0.5,
      l: s ? spike!.low : price - 0.5,
      c: price,
    });
  }
  return bars;
}

/**
 * Binance's own shape: a zip holding one CSV, no header on the older files,
 * twelve columns, timestamps in microseconds the way the current ones are.
 */
function archiveZip(bars: { t: number; o: number; h: number; l: number; c: number }[], micros = true) {
  const rows = bars.map((b) =>
    [
      micros ? b.t * 1000 : b.t,
      b.o,
      b.h,
      b.l,
      b.c,
      "1",
      (micros ? b.t * 1000 : b.t) + 1,
      "1",
      1,
      "1",
      "1",
      "0",
    ].join(","),
  );
  return zipSync({ "klines.csv": strToU8(rows.join("\n") + "\n") });
}

function startFeed(): Promise<number> {
  return new Promise((resolve) => {
    feed = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      // The API refuses everything, exactly as it does from a US IP.
      if (u.pathname.startsWith("/fapi/") && !u.pathname.includes("exchangeInfo")) {
        res.statusCode = 451;
        return res.end("{}");
      }
      if (u.pathname === "/fapi/v1/exchangeInfo") {
        res.statusCode = 451;
        return res.end("{}");
      }
      if (u.pathname === "/api/v3/exchangeInfo") {
        res.setHeader("content-type", "application/json");
        return res.end(
          JSON.stringify({
            symbols: [
              { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "TRADING" },
            ],
          }),
        );
      }
      // The archive: /data/futures/um/daily/klines/BTCUSDT/1h/BTCUSDT-1h-2026-08-24.zip
      const m = /\/data\/futures\/um\/daily\/klines\/[^/]+\/[^/]+\/[^-]+-[^-]+-(\d{4}-\d{2}-\d{2})\.zip$/.exec(
        u.pathname,
      );
      if (m) {
        const bars = days.get(m[1]);
        if (!bars) {
          res.statusCode = 404;
          return res.end("not published yet");
        }
        res.setHeader("content-type", "application/zip");
        return res.end(Buffer.from(archiveZip(bars)));
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

const closed = (over: Record<string, unknown>) =>
  store.createTrade({
    symbol: "BTC",
    direction: "long",
    size: 1,
    sizeUnit: "base",
    entryPrice: 100,
    initialStop: 90,
    initialTarget: 130,
    status: "closed",
    exitPrice: 112,
    exitReason: "discretion",
    ...over,
  } as any);

describe.skipIf(!DB)("settling a perp out of the file archive", () => {
  beforeAll(async () => {
    const port = await startFeed();
    process.env.BINANCE_BASE = `http://127.0.0.1:${port}`;
    process.env.BINANCE_FUTURES_BASE = `http://127.0.0.1:${port}`;
    process.env.BINANCE_ARCHIVE_BASE = `http://127.0.0.1:${port}`;
    const { initSchema, accounts, storageFor } = await import("../server/storage");
    await initSchema();
    const acct = await accounts.create({ googleSub: `arc-${stamp}`, email: `arc-${stamp}@x.test` });
    userId = acct.id;
    store = storageFor(userId);
    ({ checkOutcomes } = await import("../server/outcomes"));
    const { ensureCatalogue } = await import("../server/outcomes");
    await ensureCatalogue(true);
  });

  afterAll(() => new Promise<void>((r) => (feed ? feed.close(() => r()) : r())));

  it("reads the perp the API refuses, and settles from it", async () => {
    // Three whole days published, the target tagged on the middle one.
    const t0 = Math.floor((Date.now() - 4 * DAY) / DAY) * DAY;
    days = new Map([
      [ymd(t0), flatDay(t0, 100)],
      [ymd(t0 + DAY), flatDay(t0 + DAY, 100, { hour: 5, high: 131, low: 99 })],
      [ymd(t0 + 2 * DAY), flatDay(t0 + 2 * DAY, 105)],
    ]);

    const t = await closed({
      symbol: "BTC",
      entryTime: new Date(t0 + HOUR).toISOString(),
      exitTime: new Date(t0 + 2 * DAY + HOUR).toISOString(),
    });
    const res = await checkOutcomes(userId);
    expect(res.error).toBeUndefined();

    const after = await store.getTrade(t.id);
    expect(after.noManagementOutcome).toBe("target_first");
    expect(after.outcomeSource).toBe("auto");
    // The hit is the bar that tagged it, not the end of the window.
    expect(new Date(after.outcomeHitAt).getTime()).toBe(t0 + DAY + 5 * HOUR);
  });

  it("stops at the first missing day rather than reading across the hole", async () => {
    /*
     * The whole reason the prefix rule exists. Day 2 is missing and day 3
     * contains the target; day 1 contains nothing. Reading across the gap
     * would report target_first for a trade whose stop may well have been hit
     * inside the day nobody can see.
     */
    const t0 = Math.floor((Date.now() - 5 * DAY) / DAY) * DAY;
    days = new Map([
      [ymd(t0), flatDay(t0, 100)],
      // t0 + DAY deliberately absent
      [ymd(t0 + 2 * DAY), flatDay(t0 + 2 * DAY, 100, { hour: 3, high: 131, low: 99 })],
    ]);

    const t = await closed({
      symbol: "ETH",
      entryTime: new Date(t0 + HOUR).toISOString(),
      exitTime: new Date(t0 + 2 * DAY + 2 * HOUR).toISOString(),
    });
    await checkOutcomes(userId);
    const after = await store.getTrade(t.id);
    expect(after.noManagementOutcome).toBeNull();
    // Stamped as looked at, so it is asked again in an hour rather than
    // hammered on every run — and answered the moment the day is published.
    expect(after.outcomeCheckedAt).toBeTruthy();
  });

  it("withholds the excursion until the data reaches the exit", async () => {
    // One day published out of a two-day hold. The high in that first day is
    // not the high of the trade, and writing it down would be a wrong number
    // with nothing to mark it provisional.
    const t0 = Math.floor((Date.now() - 3 * DAY) / DAY) * DAY;
    days = new Map([[ymd(t0), flatDay(t0, 100, { hour: 8, high: 120, low: 95 })]]);

    const t = await closed({
      symbol: "SOL",
      entryTime: new Date(t0 + HOUR).toISOString(),
      exitTime: new Date(t0 + DAY + 6 * HOUR).toISOString(),
    });
    await checkOutcomes(userId);
    const after = await store.getTrade(t.id);
    expect(after.mfe).toBeNull();
    expect(after.mae).toBeNull();
  });

  it("does not touch a position that is still running", async () => {
    /*
     * The excursion fields are filled in only where they are BLANK, so a
     * number written today is the trade's final answer forever — and the best
     * price of an open position can be beaten tomorrow. The filter upstream
     * already excludes anything not closed; this pins that it stays that way,
     * because the failure would be silent and permanent.
     */
    const t0 = Math.floor((Date.now() - 3 * DAY) / DAY) * DAY;
    days = new Map([
      [ymd(t0), flatDay(t0, 100, { hour: 4, high: 131, low: 95 })],
      [ymd(t0 + DAY), flatDay(t0 + DAY, 100)],
      [ymd(t0 + 2 * DAY), flatDay(t0 + 2 * DAY, 100)],
    ]);

    const t = await store.createTrade({
      symbol: "LTC",
      direction: "long",
      size: 1,
      sizeUnit: "base",
      entryPrice: 100,
      initialStop: 90,
      initialTarget: 130,
      entryTime: new Date(t0 + HOUR).toISOString(),
      status: "open",
    } as any);

    await checkOutcomes(userId);
    const after = await store.getTrade(t.id);
    expect(after.mae).toBeNull();
    expect(after.mfe).toBeNull();
    expect(after.noManagementOutcome).toBeNull();
    expect(after.outcomeCheckedAt).toBeNull();
  });

  it("fills the excursion once the hold is covered", async () => {
    // Same shape, but every day of the hold is published now.
    const t0 = Math.floor((Date.now() - 3 * DAY) / DAY) * DAY;
    days = new Map([
      [ymd(t0), flatDay(t0, 100, { hour: 8, high: 120, low: 95 })],
      [ymd(t0 + DAY), flatDay(t0 + DAY, 100)],
      [ymd(t0 + 2 * DAY), flatDay(t0 + 2 * DAY, 100)],
    ]);

    const t = await closed({
      symbol: "XRP",
      entryTime: new Date(t0 + HOUR).toISOString(),
      exitTime: new Date(t0 + DAY + 6 * HOUR).toISOString(),
      initialTarget: 500,
    });
    await checkOutcomes(userId);
    const after = await store.getTrade(t.id);
    expect(after.mfe).toBe(120);
    expect(after.mae).toBe(95);
  });
});

describe("the file plan", () => {
  it("takes a completed month as one file and days for the rest", async () => {
    const { archivePlan } = await import("../server/binance-archive");
    // A window over all of July plus two days of August, asked in August.
    const plan = archivePlan(
      "BTCUSDT",
      "futures",
      "1h",
      Date.UTC(2026, 6, 1),
      Date.UTC(2026, 7, 2, 23, 59),
      Date.UTC(2026, 7, 20),
    );
    expect(plan[0].url).toContain("monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2026-07.zip");
    expect(plan[1].url).toContain("daily/klines/BTCUSDT/1h/BTCUSDT-1h-2026-08-01.zip");
    expect(plan[2].url).toContain("BTCUSDT-1h-2026-08-02.zip");
    expect(plan).toHaveLength(3);
  });

  it("never asks for a monthly file of the month in progress", async () => {
    // It does not exist until the month ends, and asking wastes a request on
    // every single run for as long as the month lasts.
    const { archivePlan } = await import("../server/binance-archive");
    const plan = archivePlan(
      "BTCUSDT",
      "futures",
      "1h",
      Date.UTC(2026, 7, 1),
      Date.UTC(2026, 7, 31, 23, 59),
      Date.UTC(2026, 7, 20),
    );
    expect(plan.every((p) => p.url.includes("/daily/"))).toBe(true);
  });

  it("reads both CSV eras, and no others", async () => {
    const { parseArchiveCsv } = await import("../server/binance-archive");
    // Microseconds (current), a header row (newer files carry one), and a
    // blank line. All three appear in real files.
    const csv = [
      "open_time,open,high,low,close,volume,close_time,x,y,z,w,v",
      "1787000000000000,100,131,99,130,1,1787000059999000,1,1,1,1,0",
      "",
      "1787003600000000,130,140,129,138,1,1787003659999000,1,1,1,1,0",
    ].join("\n");
    const bars = parseArchiveCsv(csv);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toEqual({ t: 1787000000000, o: 100, h: 131, l: 99, c: 130 });
    expect(bars[1].t).toBe(1787003600000);
  });

  it("leaves a millisecond timestamp alone", async () => {
    // Older files are in milliseconds and must not be divided by anything.
    const { parseArchiveCsv } = await import("../server/binance-archive");
    const bars = parseArchiveCsv("1600000000000,10,11,9,10.5,1,1600000059999,1,1,1,1,0");
    expect(bars[0].t).toBe(1600000000000);
  });
});
