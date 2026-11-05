import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import {
  coinMetrics,
  exitPlan,
  flagRows,
  parseScreenerCandles,
  ratioSeries,
  rebasedLine,
  readScreenerSettings,
  tfMetrics,
  TIMEFRAMES,
  type ScreenerCandle,
  type ScreenerRow,
} from "../shared/screener";

/**
 * The relative-strength screener: its arithmetic against numbers worked by
 * hand, and its run against a fake Hyperliquid — the universe filtered,
 * one coin refusing, the snapshot kept, the cooldown, the clock.
 */
const HOUR = 3600_000;
const DAY = 86400_000;
const T0 = Date.UTC(2026, 0, 1);

/** Hourly bars whose close is a function of the hour index. */
const hourly = (n: number, close: (i: number) => number, vol: (i: number) => number = () => 100): ScreenerCandle[] =>
  Array.from({ length: n }, (_, i) => ({ t: T0 + i * HOUR, o: close(i) * 0.99, h: close(i) * 1.02, l: close(i) * 0.98, c: close(i), v: vol(i) }));
const daily = (n: number, close: (i: number) => number, vol: (i: number) => number = () => 1000): ScreenerCandle[] =>
  Array.from({ length: n }, (_, i) => ({ t: T0 + i * DAY, o: close(i) * 0.99, h: close(i) * 1.02, l: close(i) * 0.98, c: close(i), v: vol(i) }));

describe("the screener's arithmetic", () => {
  it("measures RS change over the lookback on the ratio of closes, matching a hand calculation", () => {
    const btcD = daily(40, (i) => 50_000 + i * 100);
    const altD = daily(40, (i) => 100 + i * 2);
    const r = ratioSeries(altD, btcD);
    const m = tfMetrics(r, "1D");
    // By hand: ratio[39] / ratio[38] - 1
    const byHand = (altD[39].c / btcD[39].c) / (altD[38].c / btcD[38].c) - 1;
    expect(m.rs).toBeCloseTo(byHand, 12);
    const w = tfMetrics(r, "1W");
    expect(w.rs).toBeCloseTo((altD[39].c / btcD[39].c) / (altD[32].c / btcD[32].c) - 1, 12);
    // Short of 30 days of history: the month is "—", not a number.
    expect(tfMetrics(r.slice(-20), "1M").rs).toBeNull();
  });

  it("aligns on timestamps: an alt bar with no BTC bar at its time is skipped", () => {
    const btc = hourly(10, () => 100);
    const alt = hourly(10, (i) => 10 + i).filter((_, i) => i !== 5);
    const r = ratioSeries(alt, btc);
    expect(r).toHaveLength(9);
    expect(r.map((x) => x.t)).not.toContain(T0 + 5 * HOUR);
  });

  it("calls acceleration up when the last block beats the mean of the ones before, and breakout on a 20-block high", () => {
    const btc = hourly(200, () => 100);
    // Flat ratio for 196 hours, then a jump in the last 4: the 4h change beats the mean 4h change of the past 30 blocks.
    const alt = hourly(200, (i) => (i >= 196 ? 12 : 10));
    const m = tfMetrics(ratioSeries(alt, btc), "4h");
    expect(m.rs).toBeCloseTo(0.2, 12);
    expect(m.accel).toBe("up");
    expect(m.breakout).toBe(true);
    expect(m.breakoutLevel).toBeCloseTo(0.1, 12);
    // Steady: a ratio rising the same amount every hour.
    const steady = tfMetrics(ratioSeries(hourly(200, (i) => 10 + i * 0.01), btc), "4h");
    expect(steady.accel).toBe("steady");
    // Fading: rising, then flat in the last block.
    const fading = tfMetrics(ratioSeries(hourly(200, (i) => (i >= 196 ? 10 + 195 * 0.05 : 10 + i * 0.05)), btc), "4h");
    expect(fading.accel).toBe("down");
    expect(fading.breakout).toBe(false);
  });

  it("gives RVOL as the last block's volume over the mean of the previous twenty, and null short of five blocks", () => {
    const btc = hourly(100, () => 100);
    const alt = hourly(100, () => 10, (i) => (i >= 96 ? 300 : 100));
    const m = tfMetrics(ratioSeries(alt, btc), "4h");
    expect(m.rvol).toBeCloseTo(3, 12);
    expect(tfMetrics(ratioSeries(alt.slice(-20), btc), "4h").rvol).toBeNull();
  });

  it("flags against the universe: top decile and accelerating is moving fast; with volume and no leverage, a candidate", () => {
    const row = (coin: string, rs4h: number, accel: "up" | "steady", rvol: number, funding: number, oi: number | null): ScreenerRow => ({
      coin,
      mark: 1,
      volume24h: 1e7,
      fundingAnnual: funding,
      fundingHourly: funding / 8760,
      openInterest: 1,
      oiChange: oi,
      leverageDriven: false,
      tf: Object.fromEntries(TIMEFRAMES.map((tf) => [tf, { rs: tf === "4h" || tf === "1D" ? rs4h : null, accel: tf === "4h" ? accel : null, breakout: null, rvol: tf === "4h" ? rvol : null, breakoutLevel: null }])) as any,
      flags: {} as any,
      error: null,
      bars: { "1h": 720, "1d": 400 },
    });
    const rows = [
      row("A", 0.3, "up", 2, 0.1, 0.05),
      row("B", 0.25, "up", 1.0, 0.1, 0.0),
      row("C", 0.2, "up", 2, 0.9, 0.5), // top funding and OI jumped: leverage-driven
      ...Array.from({ length: 10 }, (_, i) => row(`X${i}`, 0.01 * i - 0.05, "steady", 1, 0.05, 0)),
    ];
    const out = flagRows(rows, { rvolMin: 1.5, oiJumpMin: 0.15 });
    const f = (c: string) => out.find((r) => r.coin === c)!;
    expect(f("A").flags["4h"]).toMatchObject({ movingFast: true, candidate: true, volumeConfirmed: true });
    expect(f("B").flags["4h"]).toMatchObject({ movingFast: true, candidate: false, volumeConfirmed: false });
    expect(f("C").leverageDriven).toBe(true);
    expect(f("C").flags["4h"].movingFast).toBe(false); // top decile is the top 2 of 13 here
    expect(f("X0").flags["4h"].weakest).toBe(true);
    expect(f("X9").flags["4h"].weakest).toBe(false);
  });

  it("plans the exit: the lowest low of the last N candles, the distance, and the size for the risk", () => {
    const alt = hourly(100, (i) => 100 + i * 0.1, () => 1);
    const plan = exitPlan(alt, "4h", 110, { rs: 0.1, accel: "up", breakout: true, rvol: 2, breakoutLevel: 1.05 }, 1.1, { stopLookback: 10, riskDollars: 250 });
    // Last 10 blocks of 4 = 40 bars; the lowest low among them is bar 60's low.
    expect(plan.structureStop).toBeCloseTo((100 + 60 * 0.1) * 0.98, 10);
    expect(plan.stopDistance).toBeCloseTo((110 - plan.structureStop!) / 110, 10);
    expect(plan.size).toBeCloseTo(250 / (110 - plan.structureStop!), 10);
    expect(plan.rsInvalidation).toBe(1.05);
  });

  it("rebases a line to 0% at the window's first bar, reads candles with volume, and settings leniently", () => {
    const line = rebasedLine([{ t: 1, r: 2 }, { t: 2, r: 2.2 }, { t: 3, r: 1.8 }], 1, 3);
    expect(line).toEqual([{ t: 2, pct: 0 }, { t: 3, pct: 1.8 / 2.2 - 1 }]);
    expect(parseScreenerCandles([{ t: "5", o: "1", h: "2", l: "0.5", c: "1.5", v: "7" }, { t: "x" }])).toEqual([{ t: 5, o: 1, h: 2, l: 0.5, c: 1.5, v: 7 }]);
    expect(readScreenerSettings({ minVolume: "nope", rvolMin: 2 })).toMatchObject({ minVolume: 5_000_000, rvolMin: 2, stopLookback: 10, riskDollars: 250 });
  });
});

/* ------------------------------- the run, against a fake venue ------------------------------- */

const DB = process.env.DATABASE_URL;
if (process.env.CI && !DB) throw new Error("DATABASE_URL is required in CI — the screener tests must run");

let venue: Server;
let app: Server;
let base = "";
let fail = new Set<string>();
let oi: Record<string, number> = { SOL: 1000, ETH: 5000, DOGE: 200, TINY: 10 };
let infoCalls = 0;
const calls: string[] = [];

const closes = {
  BTC: (i: number, iv: string) => (iv === "1h" ? 60_000 + i * 5 : 40_000 + i * 50),
  SOL: (i: number, iv: string) => (iv === "1h" ? 150 + i * 0.05 : 80 + i * 0.3),
  ETH: (i: number, iv: string) => (iv === "1h" ? 3000 - i * 0.2 : 2000 + i * 2),
  DOGE: (i: number, iv: string) => (iv === "1h" ? 0.2 + i * 0.0001 : 0.1 + i * 0.0002),
  TINY: () => 1,
} as Record<string, (i: number, iv: string) => number>;

function candles(coin: string, iv: "1h" | "1d", start: number, end: number) {
  const step = iv === "1h" ? HOUR : DAY;
  const out: any[] = [];
  // Bars aligned to the step, closed at the end: the same timestamps for every coin.
  for (let t = Math.ceil(start / step) * step, i = 0; t <= end; t += step, i++) {
    const idx = Math.floor(t / step);
    const c = closes[coin]?.(idx, iv) ?? 1;
    out.push({ t, T: t + step - 1, s: coin, i: iv, o: String(c), h: String(c * 1.01), l: String(c * 0.99), c: String(c), v: String(coin === "SOL" && t > end - 4 * step ? 900 : 100), n: 1 });
  }
  return out;
}

function startVenue(): Promise<string> {
  return new Promise((resolve) => {
    venue = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        infoCalls++;
        const q = JSON.parse(body || "{}");
        calls.push(`${q.type}:${q.req?.coin ?? ""}:${q.req?.interval ?? ""}`);
        const json = (o: unknown, status = 200) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(o));
        };
        if (q.type === "metaAndAssetCtxs") {
          const names = ["BTC", "SOL", "ETH", "DOGE", "TINY", "USDC", "OLD"];
          return json([
            { universe: names.map((name) => ({ name, szDecimals: 2, ...(name === "OLD" ? { isDelisted: true } : {}) })) },
            names.map((name) => ({ funding: name === "ETH" ? "0.0005" : "0.0000125", openInterest: String(oi[name] ?? 1), dayNtlVlm: name === "TINY" ? "100000" : "20000000", markPx: String(closes[name]?.(Math.floor(Date.now() / HOUR), "1h") ?? 1) })),
          ]);
        }
        if (q.type === "candleSnapshot") {
          const { coin, interval, startTime, endTime } = q.req;
          if (fail.has(coin)) return json({ error: "boom" }, 500);
          return json(candles(coin, interval, Number(startTime), Number(endTime)));
        }
        return json([]);
      });
    });
    venue.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(venue.address() as any).port}`));
  });
}

beforeAll(async () => {
  if (!DB) return;
  process.env.HYPERLIQUID_BASE = await startVenue();
  process.env.SCREENER_CLOCK_MS = "0";
  process.env.SCREENER_WEIGHT_PER_MIN = "100000";
  const { initSchema, accounts, screenerStore } = await import("../server/storage");
  const { registerRoutes } = await import("../server/routes");
  await initSchema();
  // A clean slate: earlier runs of this file left snapshots behind.
  await screenerStore.prune(new Date(Date.now() + 365 * DAY).toISOString());
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const account = await accounts.create({ googleSub: `sc-${stamp}`, email: `sc-${stamp}@x.test` });
  const ex = express();
  ex.use(express.json({ limit: "25mb" }));
  ex.use((req, _res, next) => {
    (req as any).userId = account.id;
    next();
  });
  app = createServer(ex);
  await registerRoutes(app, ex);
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as any).port}`;
}, 60_000);

afterAll(async () => {
  if (app) await new Promise((r) => app.close(r));
  if (venue) await new Promise((r) => venue.close(r));
});

const get = (path: string) => fetch(`${base}${path}`).then((r) => r.json());

describe.skipIf(!DB)("the screener's run", () => {
  it("reads the universe, filters it, measures every coin, keeps the snapshot, and records how long it took", async () => {
    const { runScreener } = await import("../server/screener");
    fail = new Set(["DOGE"]);
    const run = await runScreener({ force: true });
    expect(run.tookMs).toBeGreaterThanOrEqual(0);
    // BTC, the stable, the delisted and the thin one are out; DOGE is in with its error.
    expect(run.rows.map((r) => r.coin).sort()).toEqual(["DOGE", "ETH", "SOL"]);
    expect(run.errors).toBe(1);
    const doge = run.rows.find((r) => r.coin === "DOGE")!;
    expect(doge.error).toMatch(/HTTP 500/);
    expect(doge.tf["1D"].rs).toBeNull();

    // SOL's 1D and 1W RS change, by hand from the same candles the fake served.
    const sol = run.rows.find((r) => r.coin === "SOL")!;
    const { storedSeries } = await import("../server/screener");
    const [s, b] = await Promise.all([storedSeries("SOL"), storedSeries("BTC")]);
    const last = s["1d"].length - 1;
    const byHand = (k: number) => (s["1d"][last].c / b["1d"][last].c) / (s["1d"][last - k].c / b["1d"][last - k].c) - 1;
    expect(sol.tf["1D"].rs).toBeCloseTo(byHand(1), 12);
    expect(sol.tf["1W"].rs).toBeCloseTo(byHand(7), 12);
    expect(sol.tf["1M"].rs).toBeCloseTo(byHand(30), 12);
    // Its last four hourly bars carried nine times the volume.
    expect(sol.tf["4h"].rvol).toBeCloseTo(9, 6);
    expect(sol.flags["4h"].volumeConfirmed).toBe(true);
    // Funding annualized from the hourly rate; no OI change before a second snapshot.
    expect(sol.fundingAnnual).toBeCloseTo(0.0000125 * 24 * 365, 12);
    expect(sol.oiChange).toBeNull();
    expect(sol.bars["1d"]).toBeGreaterThan(390);

    // The page reads the stored run.
    const page = await get("/api/screener");
    expect(page.run.id).toBe(run.id);
    expect(page.run.rows).toHaveLength(3);
    expect(page.status.running).toBe(false);
  });

  it("refuses a refresh inside the cooldown, and measures OI against the previous snapshot on the next run", async () => {
    const { runScreener } = await import("../server/screener");
    await expect(runScreener()).rejects.toMatchObject({ status: 429 });
    const refused = await fetch(`${base}/api/screener/run`, { method: "POST" });
    expect(refused.status).toBe(429);
    fail = new Set();
    oi = { ...oi, SOL: 1300 };
    const run = await runScreener({ force: true });
    const sol = run.rows.find((r) => r.coin === "SOL")!;
    expect(sol.oiChange).toBeCloseTo(0.3, 9);
    expect(run.errors).toBe(0);
    expect(run.rows.find((r) => r.coin === "DOGE")!.error).toBeNull();
  });

  it("serves the chart's lines rebased to zero, and a coin with its exit plan", async () => {
    const lines = await get("/api/screener/series?tf=1D&coins=SOL,ETH,NOPE");
    expect(Object.keys(lines.lines).sort()).toEqual(["ETH", "SOL"]);
    expect(lines.lines.SOL[0].pct).toBe(0);
    expect(lines.lines.SOL.length).toBeGreaterThan(80);
    expect(lines.lines.SOL.length).toBeLessThanOrEqual(92);

    const coin = await get("/api/screener/coin/SOL?tf=4h&risk=500");
    expect(coin.row.coin).toBe("SOL");
    expect(coin.price.length).toBeGreaterThan(100);
    expect(coin.ratio.length).toBe(coin.price.length);
    expect(coin.plan.structureStop).toBeGreaterThan(0);
    expect(coin.plan.size).toBeCloseTo(500 / (coin.row.mark - coin.plan.structureStop), 6);
    expect(coin.snapshots.length).toBe(2);

    const saved = await (await fetch(`${base}/api/screener/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ rvolMin: 2, stopLookback: 5 }) })).json();
    expect(saved).toMatchObject({ rvolMin: 2, stopLookback: 5, minVolume: 5_000_000 });
    const news = await (await fetch(`${base}/api/screener/news/kPEPE`, { method: "POST" })).json();
    expect(news.links.map((l: any) => l.label)).toEqual(["CoinGecko", "X: $PEPE", "Unlocks (DefiLlama)"]);
  });

  it("knows when a run is due on the Prague clock", async () => {
    const { runDue } = await import("../server/screener");
    const prague = (iso: string) => new Date(iso).getTime();
    // 09:00 Prague in winter is 08:00Z. Nothing ran today: due.
    expect(runDue(prague("2026-01-10T08:00:00Z"), "2026-01-09T12:40:00Z")).toBe(true);
    // Ran at 08:05 Prague today, now 09:00: not due. At 13:30 Prague (12:30Z): due. Ran at 13:31: not.
    expect(runDue(prague("2026-01-10T08:00:00Z"), "2026-01-10T07:05:00Z")).toBe(false);
    expect(runDue(prague("2026-01-10T12:30:00Z"), "2026-01-10T07:05:00Z")).toBe(true);
    expect(runDue(prague("2026-01-10T12:40:00Z"), "2026-01-10T12:31:00Z")).toBe(false);
    // 02:00 Prague with the 13:30 of yesterday done: not due; with only yesterday's morning run: due.
    expect(runDue(prague("2026-01-10T01:00:00Z"), "2026-01-09T12:35:00Z")).toBe(false);
    expect(runDue(prague("2026-01-10T01:00:00Z"), "2026-01-09T07:05:00Z")).toBe(true);
    // Never ran: due.
    expect(runDue(prague("2026-01-10T01:00:00Z"), null)).toBe(true);
    expect(calls.filter((c) => c.startsWith("metaAndAssetCtxs")).length).toBe(2);
    expect(calls.filter((c) => c === "candleSnapshot:SOL:1h").length).toBe(2);
    // Run one: the universe, BTC twice, SOL and ETH twice, DOGE once (its hourly read failed). Run two: all nine.
    expect(infoCalls).toBe(8 + 9);
  });
});
