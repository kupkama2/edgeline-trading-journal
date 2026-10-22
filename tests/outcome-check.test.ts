import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

/**
 * The resolver, driven end to end against a stand-in for Binance.
 *
 * Two of the bugs this pins are invisible to a unit test on the pure logic,
 * because the logic was right both times and the wiring around it was not.
 *
 *   Unmatched trades — futures, unlisted tickers — are never marked as
 *   checked, so they sit at the head of the queue forever. Applying the
 *   per-run cap BEFORE filtering them out meant a couple of dozen recent
 *   futures trades could eat the whole budget on every single run and no
 *   crypto trade would ever be read. Nothing errors; the feature simply
 *   never works.
 *
 *   A human answer must survive contact with the feed, and a parked
 *   "undetermined" must not.
 */
const DB = process.env.DATABASE_URL;
if (process.env.CI && !DB) {
  throw new Error("DATABASE_URL is required in CI — the outcome tests must run");
}

const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let feed: Server;
let userId: number;
let checkOutcomes: (id: number) => Promise<any>;
let store: any;

const INTERVAL_MS: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };

/*
 * CCC's path, one minute at a time: flat at 100 ± 1, a dip to 91 twenty
 * minutes after the entry, and a spike to 130 twenty minutes after the
 * exit. Entry and exit sit at :20 and :30 past the hour, inside hourly bars.
 */
const cccEntry = Math.floor((Date.now() - 10 * 86_400_000) / 3_600_000) * 3_600_000 + 20 * 60_000;
const cccExit = cccEntry + 3 * 3_600_000 + 10 * 60_000;
function cccMinute(t: number): [number, number] {
  if (t === cccEntry + 20 * 60_000) return [101, 91];
  if (t === cccExit + 20 * 60_000) return [130, 99];
  // Before the entry, a wick no trade was ever in.
  if (t === cccEntry - 10 * 60_000) return [125, 99];
  return [101, 99];
}

/** Binance's shape, with a price path we choose per symbol. */
function startFeed(): Promise<number> {
  return new Promise((resolve) => {
    feed = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      res.setHeader("content-type", "application/json");
      if (u.pathname === "/fapi/v1/exchangeInfo" || u.pathname === "/api/v3/exchangeInfo") {
        return res.end(
          JSON.stringify({
            symbols: [
              { symbol: "AAAUSDT", baseAsset: "AAA", quoteAsset: "USDT", status: "TRADING", contractType: "PERPETUAL" },
              { symbol: "BBBUSDT", baseAsset: "BBB", quoteAsset: "USDT", status: "TRADING", contractType: "PERPETUAL" },
              { symbol: "CCCUSDT", baseAsset: "CCC", quoteAsset: "USDT", status: "TRADING", contractType: "PERPETUAL" },
            ],
          }),
        );
      }
      if (u.pathname === "/fapi/v1/klines" || u.pathname === "/api/v3/klines") {
        const symbol = u.searchParams.get("symbol");
        const start = Number(u.searchParams.get("startTime"));
        if (symbol === "CCCUSDT") {
          // A real venue: bars at the width asked for, aggregated from one
          // path minute by minute, opening on the width's own boundaries.
          const span = INTERVAL_MS[u.searchParams.get("interval") ?? "1h"];
          const end = Number(u.searchParams.get("endTime") ?? Date.now());
          const limit = Number(u.searchParams.get("limit") ?? 500);
          const rows = [];
          for (let t = Math.ceil(start / span) * span; t <= end && rows.length < limit; t += span) {
            let h = -Infinity;
            let l = Infinity;
            for (let m = t; m < t + span; m += 60_000) {
              const [mh, ml] = cccMinute(m);
              h = Math.max(h, mh);
              l = Math.min(l, ml);
            }
            rows.push([t, "100", String(h), String(l), "100", "1", t + span - 1, "1", 1, "1", "1", "0"]);
          }
          return res.end(JSON.stringify(rows));
        }
        // AAA runs to the target, BBB to the stop. One bar is enough.
        const bar = symbol === "BBBUSDT"
          ? [start, "100", "101", "89", "90"]
          : [start, "100", "131", "99", "130"];
        return res.end(JSON.stringify([[...bar, "1", start + 1, "1", 1, "1", "1", "0"]]));
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

async function closedTrade(over: Record<string, unknown>) {
  return store.createTrade({
    symbol: "AAA",
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
}

describe.skipIf(!DB)("settling parked trades against the feed", () => {
  beforeAll(async () => {
    const port = await startFeed();
    // Read before the module that captures it is first imported.
    process.env.BINANCE_BASE = `http://127.0.0.1:${port}`;
    process.env.BINANCE_FUTURES_BASE = `http://127.0.0.1:${port}`;
    // Nothing here should ever reach the archive — the stub answers every
    // kline request — but pinning it means a CI runner with egress cannot
    // quietly start reading real prices if that ever stops being true.
    process.env.BINANCE_ARCHIVE_BASE = `http://127.0.0.1:${port}`;
    const { initSchema, accounts, storageFor } = await import("../server/storage");
    await initSchema();
    const acct = await accounts.create({
      googleSub: `oc-${stamp}`,
      email: `oc-${stamp}@x.test`,
    });
    userId = acct.id;
    store = storageFor(userId);
    ({ checkOutcomes } = await import("../server/outcomes"));
    /*
     * Force a fetch from THIS file's stub before anything reads a price.
     *
     * The pair catalogue is one table shared by the whole database, so another
     * test file that ran first leaves its own symbols in it with a fresh
     * timestamp — and the TTL would hand those back rather than asking this
     * stub anything. Every trade below would then go unmatched and the
     * failures would point at the resolver rather than at the fixture.
     */
    const { ensureCatalogue } = await import("../server/outcomes");
    await ensureCatalogue(true);
  });

  afterAll(() => new Promise<void>((r) => feed?.close(() => r())));

  it("settles a crypto trade even behind a wall of trades it cannot read", async () => {
    // Thirty futures trades, all newer than the crypto one, so they sort to
    // the front of the queue and — before the fix — consumed the entire
    // per-run budget of 25 every time.
    for (let i = 0; i < 30; i++) {
      await closedTrade({ symbol: "NQ", contract: `MNQU${i}`, exitTime: ago(1) });
    }
    const target = await closedTrade({ symbol: "AAA", exitTime: ago(5) });

    const res = await checkOutcomes(userId);
    expect(res.unmatched).toBeGreaterThanOrEqual(30);
    expect(res.resolved.map((r: any) => r.tradeId)).toContain(target.id);

    const after = await store.getTrade(target.id);
    expect(after.noManagementOutcome).toBe("target_first");
    expect(after.outcomeSource).toBe("auto");
    expect(after.outcomeHitAt).toBeTruthy();
  });

  it("reads the stop when that is what price did", async () => {
    const t = await closedTrade({ symbol: "BBB", exitTime: ago(4) });
    await checkOutcomes(userId);
    expect((await store.getTrade(t.id)).noManagementOutcome).toBe("stop_first");
  });

  it("fills in a trade parked at undetermined", async () => {
    // The point of the whole feature: you write "undetermined" at the time
    // because neither level has been reached, and the market finishes it.
    const t = await closedTrade({ symbol: "AAA", noManagementOutcome: "undetermined", exitTime: ago(3) });
    await checkOutcomes(userId);
    const after = await store.getTrade(t.id);
    expect(after.noManagementOutcome).toBe("target_first");
    expect(after.outcomeSource).toBe("auto");
  });

  it("fills the path on a trade whose verdict a human already gave", async () => {
    /*
     * The two errands have to coexist. Widening the worklist to bring back
     * trades that were settled but never measured put ANSWERED trades in
     * front of the settler again — and with the guard living in the worklist
     * filter, it wrote over a verdict the trader had typed themselves.
     *
     * So the guard moved to the write. A trade read for its price path keeps
     * the answer it was given, and gains the numbers it was missing.
     */
    const t = await closedTrade({
      symbol: "AAA",
      exitTime: ago(3),
      noManagementOutcome: "stop_first",
      mae: null,
      mfe: null,
    });
    await checkOutcomes(userId);
    const after = await store.getTrade(t.id);
    // Untouched, and still not claimed as the market's answer.
    expect(after.noManagementOutcome).toBe("stop_first");
    expect(after.outcomeSource).toBeNull();
    // But the errand it was actually visited for did happen.
    expect(after.mae).not.toBeNull();
    expect(after.mfe).not.toBeNull();
  });

  it("never touches an answer a human already gave", async () => {
    // The feed would say target_first for AAA. It must not get the chance:
    // a wrong overwrite here is indistinguishable from the trader's own
    // judgement forever after.
    const t = await closedTrade({ symbol: "AAA", noManagementOutcome: "stop_first", exitTime: ago(2) });
    await checkOutcomes(userId);
    const after = await store.getTrade(t.id);
    expect(after.noManagementOutcome).toBe("stop_first");
    expect(after.outcomeSource).toBeNull();
  });

  it("says what the market makes of the plan when asked by name, without overruling you", async () => {
    // "Would my stop have been hit" is the question the button is pressed for.
    const t = await closedTrade({ symbol: "AAA", noManagementOutcome: "stop_first", exitTime: ago(2) });
    const res = await (checkOutcomes as any)(userId, t.id);
    expect(res.plan).toMatchObject({ tradeId: t.id, verdict: "target_first", recorded: "stop_first", applied: false });
    expect((await store.getTrade(t.id)).noManagementOutcome).toBe("stop_first");
  });

  it("writes nothing in preview, and says what it would write", async () => {
    const t = await closedTrade({ symbol: "AAA", exitTime: ago(2), mae: null, mfe: null });
    const res = await (checkOutcomes as any)(userId, t.id, { preview: true });
    const after = await store.getTrade(t.id);
    expect(after.noManagementOutcome).toBeNull();
    expect(after.mae).toBeNull();
    expect(res.proposed.tradeId).toBe(t.id);
    const fields = res.proposed.changes.map((c: any) => c.field);
    expect(fields).toEqual(expect.arrayContaining(["noManagementOutcome", "mae", "mfe"]));
    expect(res.proposed.changes.find((c: any) => c.field === "noManagementOutcome")).toMatchObject({ from: null, to: "target_first" });
    // Bookkeeping rides along in the patch but is not listed as a change.
    expect(fields).not.toContain("outcomeCheckedAt");
    expect(res.proposed.patch.outcomeCheckedAt).toBeTruthy();
  });

  it("lets the market replace an answer that was only read out of the note", async () => {
    const t = await closedTrade({ symbol: "AAA", noManagementOutcome: "stop_first", exitTime: ago(2) });
    await store.updateTrade(t.id, {
      notes: "it would have stopped me",
      noteRead: JSON.stringify({ hash: "x", at: "2026-10-01", set: { demonIds: [], noManagementOutcome: "stop_first" } }),
    });
    const res = await (checkOutcomes as any)(userId, t.id);
    expect(res.plan).toMatchObject({ verdict: "target_first", applied: true });
    const after = await store.getTrade(t.id);
    expect(after.noManagementOutcome).toBe("target_first");
    expect(after.outcomeSource).toBe("auto");
  });

  it("fills in the path where the trade has nothing", async () => {
    // The stub's one bar runs 100 -> high 131, low 99. Held bars give MAE/MFE.
    const t = await closedTrade({ symbol: "AAA", exitTime: ago(2.5) });
    await checkOutcomes(userId);
    const after = await store.getTrade(t.id);
    expect(after.mfe).toBe(131);
    expect(after.mae).toBe(99);
  });

  it("measures a trade's excursions on its own hold, not on the bars around it", async () => {
    /*
     * Read ten days later, the window to now is long enough for hourly bars,
     * and the entry and exit both fall inside one. By open time, the entry
     * bar was dropped (losing the 91 dip and keeping nothing of the hold's
     * first forty minutes) and the exit bar kept whole (gaining the 130
     * spike from after the exit). On bars sized to a three-hour hold, and
     * minutes at its edges, only the hold counts.
     */
    const t = await closedTrade({
      symbol: "CCC",
      entryTime: new Date(cccEntry).toISOString(),
      exitTime: new Date(cccExit).toISOString(),
      initialStop: 80,
      initialTarget: 140,
      exitPrice: 100,
    });
    await checkOutcomes(userId);
    const after = await store.getTrade(t.id);
    expect(after.mae).toBe(91);
    expect(after.mfe).toBe(101);
  });

  it("re-measures one trade when asked, replacing numbers the old reading wrote", async () => {
    // The numbers the older method gave this trade: the after-exit spike as MFE.
    const t = await closedTrade({
      symbol: "CCC",
      entryTime: new Date(cccEntry).toISOString(),
      exitTime: new Date(cccExit).toISOString(),
      initialStop: 80,
      initialTarget: 140,
      exitPrice: 100,
      mae: 97,
      mfe: 130,
    });
    // The sweep leaves them: it fills blanks, never overrules a number.
    await checkOutcomes(userId);
    expect(await store.getTrade(t.id)).toMatchObject({ mae: 97, mfe: 130, pathMeasuredAt: null });
    // Asked for, on this one trade, it replaces them and says when.
    const res = await (checkOutcomes as any)(userId, t.id, { remeasure: true });
    const after = await store.getTrade(t.id);
    expect(after).toMatchObject({ mae: 91, mfe: 101 });
    expect(after.pathMeasuredAt).toEqual(expect.any(String));
    expect(res.measured.find((m: any) => m.tradeId === t.id).fields).toEqual(expect.arrayContaining(["mae", "mfe"]));
  });

  it("never overwrites a path number read off a chart by hand", async () => {
    // A hand-entered MAE is a judgement about which wick counted. There is no
    // provenance column on these fields, so replacing one would rewrite the
    // record with nothing left to say it had been rewritten.
    const t = await closedTrade({ symbol: "AAA", mae: 95.5, mfe: 120.25, exitTime: ago(2.2) });
    await checkOutcomes(userId);
    const after = await store.getTrade(t.id);
    expect(after.mae).toBe(95.5);
    expect(after.mfe).toBe(120.25);
  });

  it("folds historical pair symbols into the coin, once a catalogue exists", async () => {
    // "AAAUSDT" and "AAA" were two instruments before the entry path learned
    // to collapse them: one coin, two rows in every breakdown, two win rates,
    // neither true. Written straight to the database so it arrives the way
    // history did rather than through the route that now prevents it.
    const legacy = await closedTrade({ symbol: "AAA", exitTime: ago(1.5) });
    const { db } = await import("../server/storage");
    const { trades } = await import("../shared/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(trades).set({ symbol: "AAAUSDT" }).where(eq(trades.id, legacy.id));
    expect((await store.getTrade(legacy.id)).symbol).toBe("AAAUSDT");

    const { collapsePairSymbolsOnce } = await import("../server/storage");
    const { ensureCatalogue } = await import("../server/outcomes");
    await collapsePairSymbolsOnce(await ensureCatalogue());

    expect((await store.getTrade(legacy.id)).symbol).toBe("AAA");
  });

  it("leaves a futures row out of the fold entirely", async () => {
    // A contract has its own rollup rules and no business near a crypto-pair
    // collapse — "NQ" must not be hunted for in a list of coins.
    const fut = await closedTrade({ symbol: "NQ", contract: "MNQH7", exitTime: ago(1.4) });
    const { collapsePairSymbolsOnce } = await import("../server/storage");
    const { ensureCatalogue } = await import("../server/outcomes");
    await collapsePairSymbolsOnce(await ensureCatalogue());
    const after = await store.getTrade(fut.id);
    expect(after.symbol).toBe("NQ");
    expect(after.contract).toBe("MNQH7");
  });

  it("leaves futures trades entirely alone", async () => {
    const t = await closedTrade({ symbol: "NQ", contract: "MNQZ6", exitTime: ago(2) });
    await checkOutcomes(userId);
    const after = await store.getTrade(t.id);
    expect(after.noManagementOutcome).toBeNull();
    expect(after.outcomeCheckedAt).toBeNull();
  });
});
