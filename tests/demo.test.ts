import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { demoTrades, rng, syntheticCandles } from "../shared/demo";
import { aggregate, closedTrades, computeMetrics } from "../shared/metrics";

/**
 * The demo journal: sample trades generated on a price path, the account
 * that holds them, and the rule that a visitor cannot change it.
 */
const HOUR = 3600_000;
const NOW = Date.UTC(2026, 10, 15, 12);

describe("the demo's sample trades", () => {
  const series = new Map([["BTC", syntheticCandles(90000, 120 * 24, NOW, 1)], ["SOL", syntheticCandles(190, 120 * 24, NOW, 2)], ["NEW", syntheticCandles(1, 100, NOW, 3)]]);
  const trades = demoTrades(series, { seed: 7, count: 80 });

  it("is the same journal for the same candles and seed, and leaves out a market with too little history", () => {
    expect(demoTrades(series, { seed: 7, count: 80 })).toEqual(trades);
    expect(demoTrades(series, { seed: 8, count: 80 })).not.toEqual(trades);
    expect(rng(1)()).toBe(rng(1)());
    expect(trades.some((t) => t.symbol === "NEW")).toBe(false);
    expect(trades.filter((t) => t.status === "closed")).toHaveLength(80);
    expect(trades.filter((t) => t.status === "open")).toHaveLength(1);
    expect(demoTrades(new Map())).toEqual([]);
  });

  it("puts every entry, stop, target and exit on prices the candles printed", () => {
    for (const t of trades.filter((x) => x.status === "closed")) {
      const c = series.get(t.symbol)!;
      const sign = t.direction === "long" ? 1 : -1;
      const entryAt = new Date(t.entryTime).getTime();
      const exitAt = new Date(t.exitTime!).getTime();
      // Entered at a bar's close; out no more than three days later.
      const bar = c.find((b) => b.t + HOUR === entryAt)!;
      expect(bar.c).toBe(t.entryPrice);
      expect(exitAt).toBeGreaterThan(entryAt);
      expect(exitAt - entryAt).toBeLessThanOrEqual(72 * HOUR);
      // The stop is on the losing side and the target on the winning one.
      expect(sign * (t.initialStop - t.entryPrice)).toBeLessThan(0);
      expect(sign * (t.initialTarget - t.entryPrice)).toBeGreaterThan(0);
      // The exit lies inside the range the candles covered while the trade was on.
      const held = c.filter((b) => b.t + HOUR > entryAt && b.t + HOUR <= exitAt);
      const hi = Math.max(...held.map((b) => b.h));
      const lo = Math.min(...held.map((b) => b.l));
      expect(t.exitPrice!).toBeGreaterThanOrEqual(lo * (1 - 1e-6));
      expect(t.exitPrice!).toBeLessThanOrEqual(hi * (1 + 1e-6));
      // A stop-out is −1R before fees, and a target the plan's multiple.
      const r = (sign * (t.exitPrice! - t.entryPrice)) / Math.abs(t.entryPrice - t.initialStop);
      if (t.exitReason === "stop") expect(r).toBeCloseTo(-1, 4);
      if (t.exitReason === "target") expect([1.5, 2, 3].some((x) => Math.abs(r - x) < 1e-4)).toBe(true);
      // The best reach is at least the exit's, the worst dip no better than the entry.
      expect(sign * (t.mfe! - t.entryPrice)).toBeGreaterThanOrEqual(0);
      expect(sign * (t.mae! - t.entryPrice)).toBeLessThanOrEqual(0);
    }
  });

  it("reads as a journal: wins and losses, every way out, habits that show", () => {
    const closed = trades.filter((t) => t.status === "closed");
    const reasons = new Set(closed.map((t) => t.exitReason));
    expect(reasons.has("stop") && reasons.has("target")).toBe(true);
    expect(closed.some((t) => t.entryType === "limit") && closed.some((t) => t.entryType === "market")).toBe(true);
    expect(closed.some((t) => t.notes) && closed.some((t) => !t.notes)).toBe(true);
    // The journal's own arithmetic takes them: a win rate that is neither nothing nor everything.
    const rows = closed.map((t, i) => ({ ...t, id: i + 1, sizeUnit: "base", pointValue: 1, fills: [], scalp: false }) as any);
    const a = aggregate(closedTrades(rows));
    expect(a.count).toBe(80);
    expect(a.winRate).toBeGreaterThan(0.15);
    expect(a.winRate).toBeLessThan(0.85);
    // A trade that tilted is twice the size, and marked.
    for (const t of closed.filter((x) => x.tilt)) expect(t.riskAmount).toBe(200);
    // Management is measurable: where the plan would have hit the target and the trader left early, it cost.
    const early = rows.find((t: any) => t.exitReason === "discretion" && t.noManagementOutcome === "target_first");
    if (early) expect(computeMetrics(early).managementDeltaR!).toBeLessThan(0);
  });
});

const DB = process.env.DATABASE_URL;
let fake: Server;
let asked = 0;

beforeAll(async () => {
  if (!DB) return;
  await new Promise<void>((resolve) => {
    fake = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const q = JSON.parse(body || "{}");
        asked++;
        res.writeHead(200, { "content-type": "application/json" });
        // The venue gives BTC and ETH; anything else it refuses, and the demo walks a stand-in path for it.
        if (q.type === "candleSnapshot" && ["BTC", "ETH"].includes(q.req.coin)) {
          return res.end(JSON.stringify(syntheticCandles(q.req.coin === "BTC" ? 90000 : 3000, 120 * 24, Date.now(), 5).map((b) => ({ t: b.t, T: b.t + HOUR - 1, s: q.req.coin, i: "1h", o: String(b.o), h: String(b.h), l: String(b.l), c: String(b.c), v: "1", n: 1 }))));
        }
        res.end("[]");
      });
    });
    fake.listen(0, "127.0.0.1", () => resolve());
  });
  process.env.HYPERLIQUID_BASE = `http://127.0.0.1:${(fake.address() as any).port}`;
  process.env.SESSION_SECRET = "demo-test-session-secret-long-enough";
  const { initSchema } = await import("../server/storage");
  await initSchema();
}, 60_000);

afterAll(async () => {
  if (fake) await new Promise((r) => fake.close(r));
});

describe.skipIf(!DB)("the demo account", () => {
  it("is an ordinary account with a journal in it, built once and rebuilt when stale", async () => {
    const { demoAccount, DEMO_EMAIL } = await import("../server/demo");
    const { accounts, storageFor } = await import("../server/storage");
    // Start from nothing, whatever an earlier run left.
    const before = await accounts.byGoogleSub("edgeline-demo");
    if (before) for (const t of await storageFor(before.id).listTrades()) await storageFor(before.id).deleteTrade(t.id);

    const id = await demoAccount();
    const user = (await accounts.byId(id))!;
    expect(user).toMatchObject({ email: DEMO_EMAIL, isOwner: false });
    const trades = await storageFor(id).listTrades();
    expect(trades.length).toBeGreaterThan(100);
    expect(new Set(trades.map((t) => t.symbol)).size).toBeGreaterThanOrEqual(5);
    expect(trades.filter((t) => t.status === "open").length).toBeGreaterThanOrEqual(1);
    expect(trades.every((t) => t.account === "Demo")).toBe(true);
    // Some carry a mistake tag from the journal's own list.
    expect(trades.some((t) => t.mistakeTagIds.length > 0)).toBe(true);

    // Asked for again: the same journal, and the venue is not asked.
    const calls = asked;
    expect(await demoAccount()).toBe(id);
    expect(asked).toBe(calls);
    expect((await storageFor(id).listTrades()).length).toBe(trades.length);
    // Four days on, it is stale: rebuilt, not added to.
    await demoAccount(() => Date.now() + 4 * 24 * HOUR);
    expect(asked).toBeGreaterThan(calls);
    const rebuilt = await storageFor(id).listTrades();
    expect(Math.abs(rebuilt.length - trades.length)).toBeLessThan(10);
    expect(rebuilt.some((t) => trades.some((o) => o.id === t.id))).toBe(false);
  }, 60_000);

  it("lets a demo visitor read and refuses anything that writes; everyone else passes", async () => {
    const { demoReadOnly, isDemoEmail, demoEnabled } = await import("../server/demo");
    const run = (method: string, demo: boolean) => {
      let status = 200;
      let passed = false;
      demoReadOnly({ method, session: { demo } } as any, { status: (s: number) => ((status = s), { json: () => {} }) } as any, () => (passed = true));
      return { status, passed };
    };
    expect(run("GET", true)).toEqual({ status: 200, passed: true });
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(run(m, true)).toEqual({ status: 403, passed: false });
    expect(run("DELETE", false)).toEqual({ status: 200, passed: true });
    expect(isDemoEmail("demo@edgeline.invalid")).toBe(true);
    expect(isDemoEmail("someone@example.com")).toBe(false);
    expect(demoEnabled()).toBe(true);
  });
});

describe("the demo's door", () => {
  it("drops a visitor on a page it knows, and on the journal for anything else", async () => {
    const { landing } = await import("../server/demo");
    expect(landing("stats")).toBe("/#/stats");
    expect(landing("screener")).toBe("/#/screener");
    for (const to of [undefined, "", "settings", "//evil.example", "https://evil.example", ["stats"], "stats/../x"]) expect(landing(to)).toBe("/");
  });
});
