import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import {
  basketSeries,
  breadthOf,
  ema,
  oiRead,
  priceReadings,
  rsi,
  signalsOf,
  coinMetrics,
  completeBars,
  daysFromHours,
  DEFAULT_SCREENER_SETTINGS,
  deriveDaily,
  exitPlan,
  flagRows,
  mergeBars,
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

describe("the other readings", () => {
  it("RSI: 100 on a rise, 0 on a fall, 50 on an even chop, null short of fifteen closes", () => {
    expect(rsi(Array.from({ length: 30 }, (_, i) => 100 + i))).toBe(100);
    expect(rsi(Array.from({ length: 30 }, (_, i) => 100 - i))).toBeCloseTo(0, 10);
    // An even chop sits near the middle; Wilder's smoothing leaves it a point or two either side, depending on which way the last bar went.
    const chop = rsi(Array.from({ length: 31 }, (_, i) => (i % 2 ? 101 : 100)))!;
    expect(chop).toBeGreaterThan(45);
    expect(chop).toBeLessThan(55);
    expect(rsi([1, 2, 3])).toBeNull();
    // The exponential average starts from the plain mean of the first `period` values.
    expect(ema([1, 2, 3], 3)).toBeCloseTo(2, 12);
    expect(ema([1, 2, 3, 4], 3)).toBeCloseTo(4 * 0.5 + 2 * 0.5, 12);
  });

  it("reads open interest against price, and stays quiet under half a percent", () => {
    expect(oiRead(0.03, 0.05)).toBe("new-longs");
    expect(oiRead(0.03, -0.05)).toBe("short-covering");
    expect(oiRead(-0.03, 0.05)).toBe("new-shorts");
    expect(oiRead(-0.03, -0.05)).toBe("longs-out");
    expect(oiRead(0.001, 0.2)).toBeNull();
    expect(oiRead(null, 0.2)).toBeNull();
  });

  it("price readings: trend, a 20-period high, ATR; and a high RS does not confirm is a bearish divergence", () => {
    // Daily closes rising for 60 days: above both averages, at a 20-day high.
    const up = daily(60, (i) => 100 + i);
    const p = priceReadings(up, "1D", 0.01, 0.02);
    expect(p.ema).toBe(2);
    expect(p.priceHigh20).toBe(true);
    expect(p.offHigh).toBe(0);
    expect(p.atrPct).toBeGreaterThan(0);
    expect(p.rsEth).toBe(0.01);
    // Price at a high while the ratio is not: bearish divergence.
    const m = { rs: -0.01, accel: "down" as const, breakout: false, rvol: 1, breakoutLevel: 1 };
    const sig = signalsOf(m, p, null, null, null);
    expect(sig.divergence).toBe("bearish");
    expect(sig).toMatchObject({ rs: -1, accel: -1, rsi: 1, trend: 1, oi: 0, funding: 0, score: 0 });
    // Crowded longs and new longs: funding counts against, OI for.
    const crowded = signalsOf({ ...m, breakout: true, rs: 0.05, accel: "up" }, p, { oi1h: null, oi4h: null, oi1d: 0.1, px1d: 0.05, read: "new-longs", premium: 0, fundingPct: 0.95 }, null, null);
    expect(crowded).toMatchObject({ rs: 1, accel: 1, oi: 1, funding: -1, divergence: null });
  });

  it("builds the alt basket weighted by volume, and the breadth of the tape", () => {
    const a = daily(5, (i) => 10 * (1 + i * 0.1));
    const b = daily(5, () => 50);
    const basket = basketSeries([{ candles: a, weight: 3 }, { candles: b, weight: 1 }]);
    // Each coin as a share of its own first close, weighted 3:1.
    expect(basket[4].c).toBeCloseTo((1.4 * 3 + 1 * 1) / 4, 12);
    // A coin listed on day three joins without moving the index: it used to come in at 1.0 against a basket at 1.2,
    // a step down on the day it joined that every coin's strength against the basket then showed as a step up.
    const old1 = daily(5, (i) => 10 * (1 + i * 0.1));
    const old2 = daily(5, (i) => 20 * (1 + i * 0.1));
    const late = daily(5, () => 7).slice(3);
    const joined = basketSeries([{ candles: old1, weight: 1 }, { candles: old2, weight: 1 }, { candles: late, weight: 1 }]);
    expect(joined.map((b) => b.t)).toEqual(old1.map((b) => b.t));
    expect(joined[2].c).toBeCloseTo(1.2, 12);
    // Day three: the two old coins went 1.2 -> 1.3; the newcomer has no day before, so it says nothing yet.
    expect(joined[3].c).toBeCloseTo(1.3, 12);
    // Day four: 1.3 -> 1.4 for two, flat for the third, each weighted by where it stands.
    expect(joined[4].c).toBeCloseTo(1.3 * ((1.4 + 1.4 + 1) / (1.3 + 1.3 + 1)), 12);
    const rising = Array.from({ length: 25 }, (_, i) => ({ t: i, r: 1 + i * 0.01 }));
    const falling = Array.from({ length: 25 }, (_, i) => ({ t: i, r: 1 - i * 0.01 }));
    expect(breadthOf([rising, rising, falling, rising.slice(0, 10)])).toBeCloseTo(2 / 3, 12);
  });
});

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

  it("plans the exit: the lowest low of the last N candles, the distance, and the size for the risk — or nothing short of N", () => {
    const alt = hourly(100, (i) => 100 + i * 0.1, () => 1);
    const plan = exitPlan(alt, "4h", 110, { rs: 0.1, accel: "up", breakout: true, rvol: 2, breakoutLevel: 1.05 }, 1.1, { stopLookback: 10, riskDollars: 250 });
    // Last 10 blocks of 4 = 40 bars; the lowest low among them is bar 60's low.
    expect(plan.structureStop).toBeCloseTo((100 + 60 * 0.1) * 0.98, 10);
    expect(plan.stopDistance).toBeCloseTo((110 - plan.structureStop!) / 110, 10);
    expect(plan.size).toBeCloseTo(250 / (110 - plan.structureStop!), 10);
    expect(plan.stopCandles).toBe(10);
    expect(plan.rsInvalidation).toBe(1.05);
    // Thirty hourly bars cannot make ten 4h candles: no stop, rather than one from fewer.
    expect(exitPlan(alt.slice(-30), "4h", 110, plan as any, 1.1, { stopLookback: 10, riskDollars: 250 }).structureStop).toBeNull();
  });

  it("measures on completed bars, scales a partial day's volume, and keeps the series between runs", () => {
    const now = T0 + 10 * HOUR + 15 * 60_000;
    const bars = hourly(12, () => 1);
    // Bars at hours 0..9 have closed by 10:15; hour 10 is forming, hour 11 is in the future.
    expect(completeBars(bars, HOUR, now).map((b) => b.t)).toEqual(bars.slice(0, 10).map((b) => b.t));

    // A fresh read laid over the store: the same timestamp replaced, the window trimmed.
    const stored = hourly(5, () => 1);
    const fresh = [{ ...stored[4], c: 9 }, { t: T0 + 5 * HOUR, o: 1, h: 1, l: 1, c: 2, v: 1 }];
    const merged = mergeBars(stored, fresh, T0 + 2 * HOUR);
    expect(merged.map((b) => [b.t, b.c])).toEqual([[T0 + 2 * HOUR, 1], [T0 + 3 * HOUR, 1], [T0 + 4 * HOUR, 9], [T0 + 5 * HOUR, 2]]);

    // Hours folded into days: the open of the first hour, the high and low across, the last close, the volume summed.
    const hours = hourly(30, (i) => 10 + i, () => 2);
    const days = daysFromHours(hours);
    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({ t: T0, o: hours[0].o, c: hours[23].c, v: 48 });
    expect(days[0].h).toBeCloseTo(hours[23].h, 10);
    expect(days[1]).toMatchObject({ t: T0 + DAY, c: hours[29].c, v: 12 });

    // The daily series from the stored days and the hours: the stored days before the hours' first full day, then the hours' days.
    const storedDays = daily(40, (i) => 100 + i);
    const hrs = hourly(60, (i) => 500 + i).map((b) => ({ ...b, t: T0 + 38 * DAY + 6 * HOUR + (b.t - T0) }));
    const derived = deriveDaily(storedDays, hrs, -Infinity)!;
    // The hours begin at 06:00 on day 38: day 38 is partial on the left, so the store supplies it; days 39 and 40 come from the hours.
    expect(derived.map((d) => d.t)).toEqual([...storedDays.slice(0, 39).map((d) => d.t), T0 + 39 * DAY, T0 + 40 * DAY]);
    expect(derived[40].c).toBe(hrs[59].c);
    // A store that ends before the hours begin cannot be bridged; nor can no store at all.
    expect(deriveDaily(storedDays.slice(0, 30), hrs, -Infinity)).toBeNull();
    expect(deriveDaily([], hrs, -Infinity)).toBeNull();
    // A store whose last bar is the very day the hours start inside: that bar was still forming when it was stored,
    // so it is not kept as a finished day. The venue is asked.
    expect(deriveDaily(storedDays.slice(0, 39), hrs, -Infinity)).toBeNull();

    // RVOL on a day seven hours old: the seven hours' volume against seven twenty-fourths of a day, not a whole one.
    const btc = daily(40, () => 100);
    const vols = daily(40, () => 1, () => 2400);
    vols[39] = { ...vols[39], v: 700 };
    const r = ratioSeries(vols, btc);
    expect(tfMetrics(r, "1D", 7 / 24).rvol).toBeCloseTo(1, 10);
    expect(tfMetrics(r, "1D", 1).rvol).toBeCloseTo(700 / 2400, 10);
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
  ETH: (i: number, iv: string) => (iv === "1h" ? 3000 - (i % 1000) * 0.2 : 2000 + i * 2),
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
    out.push({ t, T: t + step - 1, s: coin, i: iv, o: String(c), h: String(c * 1.01), l: String(c * 0.99), c: String(c), v: String(coin === "SOL" && t > end - 5 * step ? 900 : 100), n: 1 });
  }
  return out;
}

function startVenue(): Promise<string> {
  return new Promise((resolve) => {
    venue = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        // The liquidation map's leaderboard, answered empty and not counted among the venue's info calls.
        if (req.url?.includes("/leaderboard")) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ leaderboardRows: [] }));
        }
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
            names.map((name) => ({ funding: name === "ETH" ? "0.0005" : "0.0000125", openInterest: String(oi[name] ?? 1), dayNtlVlm: name === "TINY" ? "100000" : "20000000", markPx: String(closes[name]?.(Math.floor(Date.now() / HOUR), "1h") ?? 1), oraclePx: String((closes[name]?.(Math.floor(Date.now() / HOUR), "1h") ?? 1) / 1.001) })),
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
  // The liquidation map's leaderboard too: the fake answers it with an empty list. Left unset, the
  // run reaches the real host, which GitHub's runners wait on until the test times out.
  process.env.HL_STATS_BASE = process.env.HYPERLIQUID_BASE;
  process.env.SCREENER_CLOCK_MS = "0";
  process.env.SCREENER_WEIGHT_PER_MIN = "100000";
  const { initSchema, accounts, screenerStore } = await import("../server/storage");
  const { registerRoutes } = await import("../server/routes");
  await initSchema();
  // A clean slate: earlier runs of this file left snapshots and series behind, and the series would be read incrementally.
  await screenerStore.clearAll();
  await screenerStore.saveSettings(DEFAULT_SCREENER_SETTINGS);
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const account = await accounts.create({ googleSub: `sc-${stamp}`, email: `sc-${stamp}@x.test` });
  const ex = express();
  ex.use(express.json({ limit: "25mb" }));
  ex.use((req, _res, next) => {
    (req as any).userId = account.id;
    // The owner, unless a test says otherwise: the screener is theirs alone.
    (req as any).account = { id: account.id, email: account.email, isOwner: req.headers["x-not-owner"] !== "1" };
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

    // SOL's 1D, 1W and 1M RS change, by hand from the same candles the fake served, as measured: completed hours, today from them.
    const sol = run.rows.find((r) => r.coin === "SOL")!;
    const { storedSeries, measuredSeries } = await import("../server/screener");
    const [s, b] = await Promise.all([storedSeries("SOL"), storedSeries("BTC")]);
    const sm = measuredSeries(s, run.barsTo);
    const bm = measuredSeries(b, run.barsTo);
    const last = sm["1d"].length - 1;
    const byHand = (k: number) => (sm["1d"][last].c / bm["1d"][last].c) / (sm["1d"][last - k].c / bm["1d"][last - k].c) - 1;
    expect(sol.tf["1D"].rs).toBeCloseTo(byHand(1), 12);
    expect(sol.tf["1W"].rs).toBeCloseTo(byHand(7), 12);
    expect(sol.tf["1M"].rs).toBeCloseTo(byHand(30), 12);
    // The last hour, on completed bars: the hour before the one forming.
    const hl = sm["1h"].length - 1;
    expect(sm["1h"][hl].t + HOUR).toBeLessThanOrEqual(new Date(run.at).getTime());
    expect(sol.tf["1h"].rs).toBeCloseTo((sm["1h"][hl].c / bm["1h"][hl].c) / (sm["1h"][hl - 1].c / bm["1h"][hl - 1].c) - 1, 12);
    // Its last four completed hourly bars carried nine times the volume.
    expect(sol.tf["4h"].rvol).toBeCloseTo(9, 6);
    expect(sol.flags["4h"].volumeConfirmed).toBe(true);
    // Funding annualized from the hourly rate; no OI change before a second snapshot.
    expect(sol.fundingAnnual).toBeCloseTo(0.0000125 * 24 * 365, 12);
    expect(sol.oiChange).toBeNull();
    expect(sol.bars["1d"]).toBeGreaterThan(600);
    // Every coin read in full the first time (DOGE failed before its daily read).
    expect(run.fullReads).toBe(3);

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
    // An hourly snapshot from an hour and a day back, as the hourly job would have left.
    const { screenerStore } = await import("../server/storage");
    const solNow = closes.SOL(Math.floor(Date.now() / HOUR), "1h");
    await screenerStore.saveSnapshot(new Date(Date.now() - HOUR - 60_000).toISOString(), [{ coin: "SOL", funding: 0, openInterest: 1200, volume: 2e7, mark: solNow, oracle: solNow }]);
    await screenerStore.saveSnapshot(new Date(Date.now() - DAY - 60_000).toISOString(), [{ coin: "SOL", funding: 0, openInterest: 1000, volume: 2e7, mark: solNow * 0.9, oracle: solNow * 0.9 }]);
    const run = await runScreener({ force: true });
    const sol = run.rows.find((r) => r.coin === "SOL")!;
    expect(sol.oiChange).toBeCloseTo(0.3, 9);
    expect(run.errors).toBe(0);
    expect(run.rows.find((r) => r.coin === "DOGE")!.error).toBeNull();
    // The second time: only DOGE, which had nothing stored, needed the full read; the rest took the hours since their last bar and derived the days.
    expect(run.fullReads).toBe(1);
    expect(sol.tf["1D"].rs).not.toBeNull();
    expect(sol.bars["1d"]).toBeGreaterThan(600);
    // Positioning off the snapshots: OI up 30% on the day with price up ~11%, up 8.3% on the hour.
    expect(sol.positioning!.oi1d).toBeCloseTo(0.3, 9);
    expect(sol.positioning!.oi1h).toBeCloseTo(1300 / 1200 - 1, 9);
    expect(sol.positioning!.px1d).toBeCloseTo(1 / 0.9 - 1, 6);
    expect(sol.positioning!.read).toBe("new-longs");
    expect(sol.positioning!.premium).toBeCloseTo(0.001, 9);
    expect(sol.signals["1D"].oi).toBe(1);
    expect(sol.price["1D"].rsi).not.toBeNull();
    expect(sol.price["4h"].rsEth).not.toBeNull();
    expect(sol.price["4h"].rsBasket).not.toBeNull();
    expect(run.breadth).not.toBeNull();
  });

  it("serves the chart's lines rebased to zero, and a coin with its exit plan", async () => {
    const lines = await get("/api/screener/series?tf=1D&coins=SOL,ETH,NOPE");
    expect(Object.keys(lines.lines).sort()).toEqual(["ETH", "SOL"]);
    expect(lines.lines.SOL[0].pct).toBe(0);
    expect(lines.lines.SOL.length).toBeGreaterThan(80);
    expect(lines.lines.SOL.length).toBeLessThanOrEqual(92);

    const coin = await get("/api/screener/coin/SOL?tf=4h");
    expect(coin.row.coin).toBe("SOL");
    expect(coin.price.length).toBeGreaterThan(100);
    expect(coin.ratio.length).toBe(coin.price.length);
    expect(coin.plan.structureStop).toBeGreaterThan(0);
    expect(coin.plan.stopCandles).toBe(10);
    // The arithmetic shown is the table's number.
    expect(coin.audit.rs).toBeCloseTo(coin.row.tf["4h"].rs, 12);
    expect(coin.audit.lookbackBars).toBe(4);
    // The two runs' snapshots and the two planted an hour and a day back.
    expect(coin.snapshots.length).toBe(4);
    // The search's lookup: in the table, under the volume line, not an alt, not listed.
    expect((await get("/api/screener/lookup/sol")).where).toBe("table");
    const tiny = await get("/api/screener/lookup/TINY");
    expect(tiny.where).toBe("under-volume");
    expect(tiny.reason).toMatch(/\$100K, under the \$5\.0M line/);
    expect((await get("/api/screener/lookup/USDC")).where).toBe("excluded");
    const nope = await get("/api/screener/lookup/LIGHTER");
    expect(nope.where).toBe("not-listed");
    expect(nope.reason).toMatch(/LIT/);
    const status = await get("/api/screener/status");
    expect(status.running).toBe(false);
    expect(status.nextAllowedAt).toBeTruthy();

    const saved = await (await fetch(`${base}/api/screener/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ rvolMin: 2, stopLookback: 5 }) })).json();
    expect(saved).toMatchObject({ rvolMin: 2, stopLookback: 5, minVolume: 5_000_000 });
    // A value out of range keeps what was there, not the default.
    const kept = await (await fetch(`${base}/api/screener/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ rvolMin: 0 }) })).json();
    expect(kept.rvolMin).toBe(2);
    const news = await (await fetch(`${base}/api/screener/news/kPEPE`, { method: "POST" })).json();
    expect(news.links.map((l: any) => l.label)).toEqual(["CoinGecko", "X: $PEPE", "Unlocks (DefiLlama)"]);
  });

  it("does not exist for anyone but the owner", async () => {
    const r = await fetch(`${base}/api/screener`, { headers: { "x-not-owner": "1" } });
    expect(r.status).toBe(404);
    const c = await fetch(`${base}/api/screener/coin/SOL`, { headers: { "x-not-owner": "1" } });
    expect(c.status).toBe(404);
  });

  it("takes an hourly snapshot, once an hour", async () => {
    const { takeSnapshot } = await import("../server/screener");
    // The run just wrote one: nothing to do.
    expect(await takeSnapshot()).toBeNull();
    // A little over the hour: at fifty minutes it landed between two hourly runs, and the second measured against it.
    expect(await takeSnapshot(() => Date.now() + 51 * 60_000)).toBeNull();
    const later = await takeSnapshot(() => Date.now() + 66 * 60_000);
    expect(later?.perps).toBe(7);
  });

  it("knows when a run is due on the Prague clock", async () => {
    const { runDue: hourlyDue, aiReadDue: runDue, nextRunAt, aiRidesHourly } = await import("../server/screener");
    const prague = (iso: string) => new Date(iso).getTime();
    // The hourly run: at five past, once per hour; the slot before five past is the previous hour's.
    expect(hourlyDue(prague("2026-01-10T14:06:00Z"), "2026-01-10T13:05:30Z")).toBe(true);
    expect(hourlyDue(prague("2026-01-10T14:06:00Z"), "2026-01-10T14:05:10Z")).toBe(false);
    expect(hourlyDue(prague("2026-01-10T14:03:00Z"), "2026-01-10T13:05:30Z")).toBe(false);
    expect(hourlyDue(prague("2026-01-10T14:03:00Z"), null)).toBe(true);
    expect(new Date(nextRunAt(prague("2026-01-10T14:03:00Z"))).toISOString()).toBe("2026-01-10T14:05:00.000Z");
    expect(new Date(nextRunAt(prague("2026-01-10T14:06:00Z"))).toISOString()).toBe("2026-01-10T15:05:00.000Z");
    // 08:00 Prague's read goes with the 08:05 run; 13:30's, half an hour from the next, gets a run of its own.
    expect(aiRidesHourly(prague("2026-01-10T07:00:00Z"))).toBe(true);
    expect(aiRidesHourly(prague("2026-01-10T07:06:00Z"))).toBe(false);
    expect(aiRidesHourly(prague("2026-01-10T12:30:00Z"))).toBe(false);
    // The AI read's slots, 08:00 and 13:30 Prague:
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
    // Two runs and one hourly snapshot.
    expect(calls.filter((c) => c.startsWith("metaAndAssetCtxs")).length).toBe(3);
    expect(calls.filter((c) => c === "candleSnapshot:SOL:1h").length).toBe(2);
    // Run one: the universe, BTC twice, SOL and ETH twice, DOGE once (its hourly read failed). Run two: all nine.
    // The night the clocks go forward (2026-03-29): at 00:30 on the 30th, yesterday is still the 29th.
    expect(runDue(prague("2026-03-29T22:30:00Z"), "2026-03-29T11:35:00Z")).toBe(false);
    expect(runDue(prague("2026-03-29T22:30:00Z"), "2026-03-29T06:05:00Z")).toBe(true);
    // Run one: the universe, BTC twice, SOL and ETH twice, DOGE once (its hourly read failed).
    // Run two: the universe, BTC, SOL and ETH once each (the hours since the last bar), DOGE twice.
    expect(infoCalls).toBe(8 + 6 + 1);
  });

  it("pins a coin found by the search under the volume line: on the chart now, in every run after, until unpinned", async () => {
    const post = (path: string, method = "POST") => fetch(`${base}${path}`, { method });
    expect((await post("/api/screener/pin/LIGHTER")).status).toBe(404);
    expect((await post("/api/screener/pin/USDC")).status).toBe(400);
    const pinned = await (await post("/api/screener/pin/tiny")).json();
    // By the venue's own name, with its candles read straight away.
    expect(pinned.coin).toBe("TINY");
    expect(pinned.settings.pinned).toEqual(["TINY"]);
    const lines = await get("/api/screener/series?tf=1D&coins=TINY");
    expect(lines.lines.TINY?.length).toBeGreaterThan(80);
    const asked = await get("/api/screener/lookup/TINY");
    expect(asked).toMatchObject({ where: "under-volume", pinned: true, canPin: false });
    // The next run reads it whatever its volume, marked as pinned.
    const { runScreener } = await import("../server/screener");
    const run = await runScreener({ force: true });
    expect(run.rows.find((r) => r.coin === "TINY")).toMatchObject({ pinned: true });
    expect(run.rows.find((r) => r.coin === "SOL")?.pinned).toBeUndefined();
    // A settings save leaves the pins alone; unpinning takes it out of the next run.
    await fetch(`${base}/api/screener/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ rvolMin: 1.5 }) });
    expect((await get("/api/screener/settings")).pinned).toEqual(["TINY"]);
    expect((await (await post("/api/screener/pin/TINY", "DELETE")).json()).pinned).toEqual([]);
    const after = await runScreener({ force: true });
    expect(after.rows.some((r) => r.coin === "TINY")).toBe(false);
  });
});
