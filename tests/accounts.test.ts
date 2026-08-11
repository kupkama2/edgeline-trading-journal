import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The test that has to exist.
 *
 * Once a journal has more than one person in it, "can account B read account
 * A's trades?" stops being a nice property and becomes the only property. The
 * failure is silent — a forgotten WHERE returns someone else's data with a
 * 200 — so nothing but an adversarial test will ever notice it.
 *
 * So: two real accounts in a real Postgres, and B tries every door in turn. A
 * pass means B saw nothing and changed nothing. The day someone adds a query
 * without a scope, one of these goes red.
 */
const DB = process.env.DATABASE_URL;

// A developer without a database still gets a useful `npm test`; CI must never
// be allowed to skip this quietly, so there it is a hard failure.
if (process.env.CI && !DB) {
  throw new Error("DATABASE_URL is required in CI — the isolation tests must run");
}

type Storage = import("../server/storage").DatabaseStorage;

let A: Storage;
let B: Storage;
let aUserId = 0;
let bUserId = 0;

/** Unique per run, so reruns against the same database never collide. */
const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const baseTrade = {
  symbol: "NQ",
  direction: "long" as const,
  size: 1,
  sizeUnit: "base" as const,
  pointValue: 1,
  entryPrice: 100,
  initialStop: 90,
  initialTarget: 130,
  entryTime: "2026-08-03T09:30:00.000Z",
  status: "open" as const,
};

describe.skipIf(!DB)("one account cannot reach another", () => {
  let aTradeId = 0;
  let aFillId = 0;
  let aImageId = 0;
  let aStyleId = 0;
  let aTagId = 0;

  beforeAll(async () => {
    const { initSchema, accounts, storageFor } = await import("../server/storage");
    await initSchema();

    const a = await accounts.create({ googleSub: `test-a-${stamp}`, email: `a-${stamp}@x.test` });
    const b = await accounts.create({ googleSub: `test-b-${stamp}`, email: `b-${stamp}@x.test` });
    aUserId = a.id;
    bUserId = b.id;
    A = storageFor(a.id);
    B = storageFor(b.id);

    // A's journal: a trade with a partial, a screenshot, a style, a demon,
    // a note and a weekly review — one of everything B might reach for.
    const style = await A.createTradingStyle({ name: `A style ${stamp}`, color: "violet" });
    aStyleId = style.id;
    const tag = await A.createMistakeTag({ name: `A demon ${stamp}` });
    aTagId = tag.id;
    const trade = await A.createTrade({ ...baseTrade, styleId: style.id } as any, [tag.id]);
    aTradeId = trade.id;
    const fill = await A.addFill(trade.id, {
      kind: "partial",
      price: 120,
      size: 0.5,
      time: "2026-08-03T10:00:00.000Z",
    });
    aFillId = fill!.id;
    const image = await A.addTradeImage(trade.id, "setup", "data:image/png;base64,AAAA");
    aImageId = image!.id;
    await A.upsertDailyNote("2026-08-03", "A's private note");
    await A.createWeeklyReview({
      weekStart: "2026-08-03",
      plans: "A's plan",
      submittedAt: "2026-08-03T18:00:00.000Z",
    } as any);
    await A.upsertAccountSettings({
      name: "Shared Broker Name",
      feeMode: "percent",
      makerFee: 0.02,
      takerFee: 0.05,
    });
  });

  /* ------------------------------- reading ------------------------------ */

  it("does not list the other account's trades", async () => {
    const mine = await B.listTrades();
    expect(mine.map((t) => t.id)).not.toContain(aTradeId);
  });

  it("cannot fetch the other account's trade by id", async () => {
    expect(await B.getTrade(aTradeId)).toBeUndefined();
    // ...and A still can, so the test is proving scoping and not a broken id.
    expect(await A.getTrade(aTradeId)).toBeDefined();
  });

  it("cannot see the other account's screenshots", async () => {
    expect(await B.listTradeImages(aTradeId)).toEqual([]);
    expect((await A.listTradeImages(aTradeId)).length).toBe(1);
  });

  it("counts only its own storage", async () => {
    expect((await B.imageUsage()).images).toBe(0);
    expect((await A.imageUsage()).images).toBeGreaterThan(0);
  });

  it("does not list the other account's styles, demons, notes or reviews", async () => {
    expect((await B.listTradingStyles()).map((s) => s.id)).not.toContain(aStyleId);
    expect((await B.listMistakeTags()).map((t) => t.id)).not.toContain(aTagId);
    expect((await B.listDailyNotes()).map((n) => n.body)).not.toContain("A's private note");
    expect((await B.listWeeklyReviews()).map((r) => r.plans)).not.toContain("A's plan");
    expect((await B.listAccountSettings()).map((s) => s.name)).not.toContain(
      "Shared Broker Name",
    );
  });

  /* ------------------------------- writing ------------------------------ */

  it("cannot edit the other account's trade", async () => {
    expect(await B.updateTrade(aTradeId, { symbol: "HACKED" } as any)).toBeUndefined();
    expect((await A.getTrade(aTradeId))?.symbol).toBe("NQ");
  });

  it("cannot delete the other account's trade", async () => {
    await B.deleteTrade(aTradeId);
    expect(await A.getTrade(aTradeId)).toBeDefined();
  });

  it("cannot add a fill to the other account's trade", async () => {
    const fill = await B.addFill(aTradeId, {
      kind: "partial",
      price: 1,
      size: 0.1,
      time: "2026-08-03T11:00:00.000Z",
    });
    expect(fill).toBeUndefined();
    expect((await A.getTrade(aTradeId))?.fills.length).toBe(1);
  });

  it("cannot delete the other account's fill", async () => {
    await B.deleteFill(aFillId);
    expect((await A.getTrade(aTradeId))?.fills.map((f) => f.id)).toContain(aFillId);
  });

  it("cannot attach or remove the other account's screenshots", async () => {
    expect(await B.addTradeImage(aTradeId, "setup", "data:image/png;base64,BBBB")).toBeUndefined();
    await B.deleteTradeImage(aImageId);
    expect((await A.listTradeImages(aTradeId)).map((i) => i.id)).toContain(aImageId);
  });

  it("cannot edit or delete the other account's style", async () => {
    expect(await B.updateTradingStyle(aStyleId, { name: "HACKED" })).toBeUndefined();
    await B.deleteTradingStyle(aStyleId);
    expect((await A.listTradingStyles()).find((s) => s.id === aStyleId)?.name).toContain(
      "A style",
    );
    // The style survived, so the trade that pointed at it kept pointing there.
    expect((await A.getTrade(aTradeId))?.styleId).toBe(aStyleId);
  });

  it("cannot edit or delete the other account's demon", async () => {
    expect(await B.updateMistakeTag(aTagId, { name: "HACKED" })).toBeUndefined();
    await B.deleteMistakeTag(aTagId);
    expect((await A.listMistakeTags()).map((t) => t.id)).toContain(aTagId);
    // Deleting a demon also unlinks it; A's trade must still carry its tag.
    expect((await A.getTrade(aTradeId))?.mistakeTagIds).toContain(aTagId);
  });

  it("silently drops a foreign demon id rather than linking across accounts", async () => {
    const mine = await B.createTrade(baseTrade as any, [aTagId]);
    expect(mine.mistakeTagIds).toEqual([]);
  });

  /* --------------------------- shared key space -------------------------- */

  it("lets both accounts write a note on the same day", async () => {
    // The old schema had a global UNIQUE on day, which would have made this
    // throw — the second person to journal on a Monday hitting a row they
    // cannot see.
    const note = await B.upsertDailyNote("2026-08-03", "B's own note");
    expect(note.body).toBe("B's own note");
    const aNote = (await A.listDailyNotes()).find((n) => n.day === "2026-08-03");
    expect(aNote?.body).toBe("A's private note");
  });

  it("lets both accounts use the same broker name", async () => {
    const row = await B.upsertAccountSettings({
      name: "Shared Broker Name",
      feeMode: "percent",
      makerFee: 0.1,
      takerFee: 0.2,
    });
    expect(row.makerFee).toBe(0.1);
    const aRow = (await A.listAccountSettings()).find((s) => s.name === "Shared Broker Name");
    expect(aRow?.makerFee).toBe(0.02);
  });

  it("lets both accounts keep a review for the same week", async () => {
    await B.createWeeklyReview({
      weekStart: "2026-08-03",
      plans: "B's plan",
      submittedAt: "2026-08-03T18:00:00.000Z",
    } as any);
    expect((await A.listWeeklyReviews()).find((r) => r.weekStart === "2026-08-03")?.plans).toBe(
      "A's plan",
    );
  });

  /* ------------------------------ new journal ---------------------------- */

  it("gives a new account its own demons and styles, not a shared set", async () => {
    const tags = await B.listMistakeTags();
    const styles = await B.listTradingStyles();
    expect(tags.length).toBeGreaterThan(0);
    expect(styles.length).toBeGreaterThan(0);
    // Same names, different rows — renaming a style must not rename it for A.
    const aTags = await A.listMistakeTags();
    expect(tags.map((t) => t.id).some((id) => aTags.map((t) => t.id).includes(id))).toBe(false);
    expect(aUserId).not.toBe(bUserId);
  });
});

/**
 * A structural guard, not a behavioural one.
 *
 * The isolation above proves the storage layer is scoped; this proves the
 * routes cannot go around it. `store(req)` is the only sanctioned door, and an
 * import of the raw `db` handle or a module-level storage singleton in the
 * route file would reopen every hole the tests above just closed.
 */
describe("the routes cannot reach the database directly", () => {
  const src = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");

  it("imports no unscoped storage handle", () => {
    expect(src).not.toMatch(/import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*["']\.\/storage["']/);
    expect(src).not.toMatch(/import\s*\{[^}]*\bstorage\b[^}]*\}\s*from\s*["']\.\/storage["']/);
  });

  it("reaches storage only through the per-request scope", () => {
    // Any `<something>.listTrades(` that isn't `store(req).listTrades(` means a
    // handler found another way to the data.
    const calls = src.match(/(\w+(?:\(\w+\))?)\.(listTrades|getTrade|createTrade)\(/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.startsWith("store(req).")).toBe(true);
  });
});
