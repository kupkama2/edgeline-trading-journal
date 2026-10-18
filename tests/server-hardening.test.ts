import { describe, expect, it } from "vitest";
import { trade } from "./helpers";
import { claimPatch, closingPatch, oneAtATime } from "../server/venue-sync";
import { loggableError } from "../server/errors";

/**
 * The server's own housekeeping, where it was wrong.
 *
 * A failed query's message carries its parameters — on an account write,
 * the API key — and that message went to the browser and the logs. Two
 * syncs at once both inserted the same position. A trade the person logged
 * and the sync claimed had its entry overwritten by the next sync, which
 * moved its 1R.
 */
const venue = (over: any = {}) => ({
  coin: "ETH",
  direction: "long" as const,
  size: 2,
  entryPrice: 2010,
  entryTime: Date.parse("2026-10-10T10:00:00Z"),
  exitPrice: 2100,
  exitTime: Date.parse("2026-10-10T12:00:00Z"),
  status: "closed" as const,
  fees: 1.5,
  closedPnl: 180,
  externalId: "hl:ETH:1",
  opens: [],
  closes: [],
  ...over,
});
const none = { initialStop: null, initialTarget: null };

describe("a claimed trade on a later sync", () => {
  it("keeps the person's entry and size when the position closes", () => {
    const mine = trade({ status: "open", exitPrice: null, exitTime: null, entryPrice: 2000, size: 1, claimedAt: "2026-10-10T11:00:00Z", fees: null } as any);
    const p = closingPatch(mine, venue(), none)!;
    expect(p).toMatchObject({ status: "closed", exitPrice: 2100, fees: 1.5 });
    expect(p).not.toHaveProperty("entryPrice");
    expect(p).not.toHaveProperty("size");
  });

  it("does not follow an add while it is open", () => {
    const mine = trade({ status: "open", exitPrice: null, exitTime: null, size: 1, claimedAt: "x" } as any);
    expect(closingPatch(mine, venue({ status: "open", exitPrice: null, exitTime: null, size: 3 }), none)).toBeNull();
  });

  it("is still followed when the sync created it", () => {
    const made = trade({ status: "open", exitPrice: null, exitTime: null, entryPrice: 2000, size: 1, claimedAt: null } as any);
    expect(closingPatch(made, venue(), none)).toMatchObject({ entryPrice: 2010, size: 2 });
  });

  it("is stamped when it is claimed", () => {
    expect(claimPatch(trade({ status: "open", exitPrice: null } as any), venue(), none).claimedAt).toEqual(expect.any(String));
  });
});

describe("two syncs at once", () => {
  it("run one after the other, per person, and a failure does not jam the queue", async () => {
    const order: string[] = [];
    const slow = (tag: string, ms: number, fail = false) => async () => {
      order.push(`${tag}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${tag}:end`);
      if (fail) throw new Error(tag);
      return tag;
    };
    const a = oneAtATime("sync:1", slow("a", 30, true));
    const b = oneAtATime("sync:1", slow("b", 5));
    const other = oneAtATime("sync:2", slow("c", 1));
    await expect(a).rejects.toThrow("a");
    expect(await b).toBe("b");
    expect(await other).toBe("c");
    expect(order.indexOf("b:start")).toBeGreaterThan(order.indexOf("a:end"));
    expect(order.indexOf("c:start")).toBeLessThan(order.indexOf("a:end"));
  });
});

describe("an error, as logged", () => {
  it("drops a failed query's parameters", () => {
    const err = new Error('Failed query: insert into "account_settings" ("binance_key") values ($1) params: readonlykey0123456789abcdef');
    const out = loggableError(err);
    expect(out).toContain("Failed query");
    expect(out).not.toContain("readonlykey");
  });

  it("keeps a database cause and its code, without its parameters", () => {
    const err: any = new Error("Failed query: update x params: secret-value");
    err.cause = { message: "duplicate key value violates unique constraint", code: "23505" };
    expect(loggableError(err)).toBe("Failed query: update x (cause: duplicate key value violates unique constraint) [23505]");
  });
});

const DB = process.env.DATABASE_URL;
describe.skipIf(!DB)("a day's note saved twice at once", () => {
  it("never fails, and keeps one row", async () => {
    const { initSchema, accounts, storageFor } = await import("../server/storage");
    await initSchema();
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const me = await accounts.create({ googleSub: `notes-${stamp}`, email: `notes-${stamp}@x.test` });
    const store = storageFor(me.id);
    // Twenty overlapping first saves of a brand-new day: the autosave
    // debounce plus a slow database is exactly this.
    const bodies = Array.from({ length: 20 }, (_, i) => "x".repeat(i + 1));
    const results = await Promise.allSettled(bodies.map((b) => store.upsertDailyNote("2026-10-18", b)));
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    const notes = (await store.listDailyNotes()).filter((n) => n.day === "2026-10-18");
    expect(notes).toHaveLength(1);
    expect(bodies).toContain(notes[0].body);
  });
});
