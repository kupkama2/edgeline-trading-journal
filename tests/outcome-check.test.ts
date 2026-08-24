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
            ],
          }),
        );
      }
      if (u.pathname === "/fapi/v1/klines" || u.pathname === "/api/v3/klines") {
        const symbol = u.searchParams.get("symbol");
        const start = Number(u.searchParams.get("startTime"));
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
    const { initSchema, accounts, storageFor } = await import("../server/storage");
    await initSchema();
    const acct = await accounts.create({
      googleSub: `oc-${stamp}`,
      email: `oc-${stamp}@x.test`,
    });
    userId = acct.id;
    store = storageFor(userId);
    ({ checkOutcomes } = await import("../server/outcomes"));
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

  it("fills in the path where the trade has nothing", async () => {
    // The stub's one bar runs 100 -> high 131, low 99. Held bars give MAE/MFE.
    const t = await closedTrade({ symbol: "AAA", exitTime: ago(2.5) });
    await checkOutcomes(userId);
    const after = await store.getTrade(t.id);
    expect(after.mfe).toBe(131);
    expect(after.mae).toBe(99);
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
