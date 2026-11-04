import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

/**
 * Bars already read are not read again.
 *
 * A window that ended in the past is the same bars every time; one that
 * runs to now is the same bars until the current bar closes. Two readers
 * asking for the same window at once share one trip to the venue.
 */
let hits = 0;
let venue: Server;
let base = "";
const HOUR = 3_600_000;
const bars = (start: number, end: number, step: number) => {
  const out: any[] = [];
  for (let t = Math.ceil(start / step) * step; t <= end && out.length < 1000; t += step) out.push([t, "100", "101", "99", "100.5", "1", t + step - 1, "0", 0, "0", "0", "0"]);
  return out;
};

describe("the candle cache", () => {
  beforeAll(async () => {
    venue = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      res.setHeader("content-type", "application/json");
      if (u.pathname === "/fapi/v1/exchangeInfo") {
        return res.end(JSON.stringify({ symbols: [{ symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", status: "TRADING", contractType: "PERPETUAL" }] }));
      }
      if (u.pathname === "/api/v3/exchangeInfo") return res.end(JSON.stringify({ symbols: [] }));
      if (u.pathname === "/fapi/v1/klines") {
        hits += 1;
        const step = u.searchParams.get("interval") === "1m" ? 60_000 : HOUR;
        return res.end(JSON.stringify(bars(Number(u.searchParams.get("startTime")), Number(u.searchParams.get("endTime")), step)));
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((r) => venue.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(venue.address() as any).port}`;
    process.env.BINANCE_BASE = base;
    process.env.BINANCE_FUTURES_BASE = base;
    process.env.BINANCE_ARCHIVE_BASE = base;
  });
  afterAll(async () => {
    await new Promise<void>((r) => venue.close(() => r()));
  });

  it("reads a past window once, and shares one read between callers asking at the same time", async () => {
    const { readCandlesAt, forgetCandles } = await import("../server/candles");
    forgetCandles();
    hits = 0;
    const pair = { symbol: "BTCUSDT", market: "futures" as const };
    const from = Date.now() - 48 * HOUR;
    const to = Date.now() - 24 * HOUR;
    const [a, b] = await Promise.all([readCandlesAt(pair, "1h", from, to, 1200, true), readCandlesAt(pair, "1h", from, to, 1200, true)]);
    expect(a.candles.length).toBeGreaterThan(20);
    expect(b.candles).toEqual(a.candles);
    expect(hits).toBe(1);
    const c = await readCandlesAt(pair, "1h", from, to, 1200, true);
    expect(c.candles).toEqual(a.candles);
    expect(hits).toBe(1);
    // Another window, another read.
    await readCandlesAt(pair, "1h", from - HOUR, to, 1200, true);
    expect(hits).toBe(2);
  });

  it.skipIf(!process.env.DATABASE_URL)("keeps a past window across a restart, and reads the charts of what is on ahead of the page", async () => {
    const { initSchema, accounts, storageFor, candleStore } = await import("../server/storage");
    await initSchema();
    const { readCandlesAt, forgetCandles } = await import("../server/candles");
    forgetCandles();
    hits = 0;
    const pair = { symbol: "BTCUSDT", market: "futures" as const };
    const from = Math.floor((Date.now() - 72 * HOUR) / HOUR) * HOUR;
    const to = from + 24 * HOUR;
    const first = await readCandlesAt(pair, "1h", from, to, 1200, true);
    expect(hits).toBe(1);
    // Another process: nothing in memory, the row in the table.
    forgetCandles();
    await new Promise((r) => setTimeout(r, 50));
    const again = await readCandlesAt(pair, "1h", from, to, 1200, true);
    expect(again.candles).toEqual(first.candles);
    expect(hits).toBe(1);
    expect(await candleStore.prune(Date.now() + 365 * 24 * HOUR)).toBeGreaterThan(0);

    // The warmer: an open trade's window is read before anyone opens the trade.
    const acct = await accounts.create({ googleSub: `warm-${Date.now()}`, email: `warm-${Date.now()}@x.test` });
    const s = storageFor(acct.id);
    const t = await s.createTrade({
      symbol: "BTC", direction: "long", size: 1, sizeUnit: "base", entryPrice: 100, initialStop: 90, initialTarget: 120,
      entryTime: new Date(Date.now() - 3 * HOUR).toISOString(), status: "open", account: "Binance",
    } as any);
    const { ensureCatalogue } = await import("../server/outcomes");
    await ensureCatalogue(true).catch(() => {});
    const { warmCharts } = await import("../server/chart-warm");
    forgetCandles();
    hits = 0;
    const clock = Date.now();
    const r = await warmCharts(clock, acct.id);
    expect(r).toMatchObject({ users: 1, warmed: 1, failed: 0 });
    const after = hits;
    expect(after).toBe(1);
    // The page's own read, within the same bar: served from memory.
    const { chartWindow } = await import("../server/chart-window");
    const { pairForTradeAt } = await import("../server/candles");
    const cat = await ensureCatalogue();
    const p = pairForTradeAt(t, cat, [])!;
    const w = chartWindow(t, undefined, undefined, clock);
    await readCandlesAt(p, w.interval, w.from, w.to, 1200, true);
    expect(hits).toBe(after);
    await s.deleteTrade(t.id);
  }, 60_000);

  it("keys a window that runs to now by the current bar, so it is re-read once the bar closes", async () => {
    const { readCandlesAt, forgetCandles } = await import("../server/candles");
    forgetCandles();
    hits = 0;
    const pair = { symbol: "BTCUSDT", market: "futures" as const };
    const from = Date.now() - 3 * HOUR;
    await readCandlesAt(pair, "1m", from, Date.now(), 1200, true);
    await readCandlesAt(pair, "1m", from, Date.now() + 10, 1200, true);
    expect(hits).toBe(1);
    // The same window asked for as if the next minute had begun: a new key.
    await readCandlesAt(pair, "1m", from, Date.now() + 60_000, 1200, true);
    expect(hits).toBe(2);
  });
});
