import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import postgres from "postgres";

/**
 * The filtered trade reads the timers lean on, the quiet update that tells
 * no page to reload, and the packed storage of the big JSON blobs. These
 * exist to keep the database's outbound transfer down: the watch and the
 * tracker read every twenty seconds, and reading the whole journal each
 * time was most of a day's transfer.
 */
const DB = process.env.DATABASE_URL;
type Storage = import("../server/storage").DatabaseStorage;

const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const H = 3600_000;
const base = {
  symbol: "NQ",
  direction: "long" as const,
  size: 1,
  sizeUnit: "base" as const,
  pointValue: 1,
  entryPrice: 100,
  initialStop: 90,
  initialTarget: 130,
  entryTime: "2026-08-03T09:30:00.000Z",
};
const ref = (tag: string) => JSON.stringify({ venue: "binance", env: "live", account: "A", symbol: "NQUSDT", positionSide: "LONG", tag, leverage: 1, qty: 1, entryOrderId: null, stopOrderId: null, targetOrderIds: [], tracked: true });

let S: Storage;
let userId = 0;
let pg: ReturnType<typeof postgres>;
const ids: Record<string, number> = {};

beforeAll(async () => {
  if (!DB) return;
  pg = postgres(DB, { prepare: false });
  const { initSchema, accounts, storageFor } = await import("../server/storage");
  await initSchema();
  const me = await accounts.create({ googleSub: `tl-${stamp}`, email: `tl-${stamp}@x.test` });
  userId = me.id;
  S = storageFor(me.id);
  const now = Date.now();
  const make = async (name: string, extra: Record<string, unknown>) => {
    ids[name] = (await S.createTrade({ ...base, ...extra } as any)).id;
  };
  await make("open", { status: "open", terminal: ref("t1") });
  await make("pending", { status: "pending", terminal: ref("t2") });
  await make("closedNew", { status: "closed", exitPrice: 120, exitTime: new Date(now - 2 * H).toISOString(), terminal: ref("t3") });
  await make("closedOld", { status: "closed", exitPrice: 80, exitTime: new Date(now - 3 * 24 * H).toISOString(), terminal: ref("t4") });
  await make("cancelled", { status: "cancelled", terminal: ref("t5") });
  await make("paperOpen", { status: "open", paper: true, terminal: ref("t6") });
  await make("plainOpen", { status: "open" });
  // An empty string where a ref would be: no terminal's business.
  await make("blankRef", { status: "closed", exitPrice: 100, exitTime: new Date(now - 3 * 24 * H).toISOString(), terminal: "" });
}, 60_000);

afterAll(async () => {
  if (!DB) return;
  await pg`DELETE FROM screener_series WHERE coin = ${`ZZ-${stamp}`}`;
  await pg`DELETE FROM candle_cache WHERE key = ${`test:${stamp}`}`;
  await pg.end();
});

const names = (rows: { id: number }[]) =>
  rows
    .map((r) => Object.entries(ids).find(([, id]) => id === r.id)?.[0] ?? "?")
    .sort();

describe.skipIf(!DB)("the filtered trade reads", () => {
  it("open trades: on now, not paper", async () => {
    expect(names(await S.listOpenTrades())).toEqual(["open", "plainOpen"]);
  });

  it("live trades: on, pending, or closed since the moment given; not paper", async () => {
    expect(names(await S.listLiveTrades(new Date(Date.now() - 24 * H).toISOString()))).toEqual(["closedNew", "open", "pending", "plainOpen"]);
  });

  it("terminal trades: every trade with a ref but the cancelled, paper included; or only those still on", async () => {
    expect(names(await S.listTerminalTrades())).toEqual(["closedNew", "closedOld", "open", "paperOpen", "pending"]);
    expect(names(await S.listTerminalTrades(true))).toEqual(["open", "paperOpen", "pending"]);
    // The same set the whole-list filter gave.
    const theirs = (await S.listTrades(true)).filter((t) => t.terminal && t.status !== "cancelled");
    expect(names(theirs)).toEqual(names(await S.listTerminalTrades()));
  });

  it("a quiet update tells no page to reload; an ordinary one does", async () => {
    const { subscribe } = await import("../server/events");
    const events: string[] = [];
    const res = {
      status: () => res,
      setHeader: () => res,
      flushHeaders: () => {},
      write: (s: string) => {
        const m = /^event: (\w+)/m.exec(s);
        if (m && m[1] !== "hello") events.push(m[1]);
        return true;
      },
      on: () => res,
    };
    subscribe(userId, res as any);
    await S.updateTrade(ids.open, { notes: "a word" } as any);
    await new Promise((r) => setTimeout(r, 700));
    expect(events).toEqual(["trades"]);
    await S.updateTrade(ids.open, { terminal: ref("t1-again") } as any, undefined, { quiet: true });
    await new Promise((r) => setTimeout(r, 700));
    expect(events).toEqual(["trades"]);
  });
});

describe.skipIf(!DB)("the packed blobs", () => {
  it("a series goes in gzipped and comes back as the same JSON", async () => {
    const { screenerStore } = await import("../server/storage");
    const coin = `ZZ-${stamp}`;
    const hourly = Array.from({ length: 50 }, (_, i) => ({ t: i * H, o: 1, h: 2, l: 0.5, c: 1.5, v: 7 }));
    await screenerStore.saveSeries(coin, hourly, [{ t: 0, o: 1, h: 2, l: 0.5, c: 1.5, v: 7 }]);
    expect(JSON.parse((await screenerStore.series(coin, "1h"))!)).toEqual(hourly);
    const [row] = await pg<{ body: string; body_gz: Buffer }[]>`SELECT body, body_gz FROM screener_series WHERE coin = ${coin} AND interval = ${"1h"}`;
    expect(row.body).toBe("");
    expect(row.body_gz.length).toBeLessThan(JSON.stringify(hourly).length / 4);
    expect(JSON.parse(gunzipSync(row.body_gz).toString())).toEqual(hourly);
    // A row from before the packing, text only, still reads.
    await pg`UPDATE screener_series SET body = ${JSON.stringify(hourly.slice(0, 2))}, body_gz = NULL WHERE coin = ${coin} AND interval = ${"1h"}`;
    expect(JSON.parse((await screenerStore.series(coin, "1h"))!)).toEqual(hourly.slice(0, 2));
  });

  it("a chart window too", async () => {
    const { candleStore } = await import("../server/storage");
    const key = `test:${stamp}`;
    const body = JSON.stringify({ candles: Array.from({ length: 30 }, (_, i) => ({ t: i, o: 1, h: 1, l: 1, c: 1 })), coveredTo: 30 });
    await candleStore.put(key, Date.now() + H, body);
    expect(await candleStore.get(key)).toEqual({ until: expect.any(Number), body });
  });
});
