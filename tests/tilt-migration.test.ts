import { describe, expect, it } from "vitest";

/**
 * "Trade Not In Plan" was the tilt verdict recorded as a demon. On boot the
 * tick moves onto the trade's tilt flag and the tag goes — under both names
 * it ever had — and the taxonomy sync must not bring it back.
 */
const DB = process.env.DATABASE_URL;
if (process.env.CI && !DB) {
  throw new Error("DATABASE_URL is required in CI — the migration test must run");
}
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
  exitPrice: 95,
  exitTime: "2026-08-03T10:30:00.000Z",
  status: "closed" as const,
};

describe.skipIf(!DB)("the tilt verdict leaves the demon list", () => {
  it("copies every tick onto the trade, removes the tag, and stays gone after seeding", async () => {
    const { initSchema, accounts, db, storageFor } = await import("../server/storage");
    const { mistakeTags, tradeMistakes, trades } = await import("../shared/schema");
    await initSchema();

    const user = await accounts.create({ googleSub: `tilt-${stamp}`, email: `tilt-${stamp}@x.test` });
    const tag = async (name: string) =>
      (
        await db
          .insert(mistakeTags)
          .values({ name, sortOrder: 50, color: "red", userId: user.id } as any)
          .returning()
      )[0];
    const canonical = await tag("Trade Not In Plan");
    const legacy = await tag("Trade Not In Trading Plan");
    const row = async () =>
      (await db.insert(trades).values({ ...baseTrade, userId: user.id } as any).returning())[0];
    const ticked = await row();
    const tickedLegacy = await row();
    const clean = await row();
    await db.insert(tradeMistakes).values([
      { tradeId: ticked.id, mistakeTagId: canonical.id },
      { tradeId: tickedLegacy.id, mistakeTagId: legacy.id },
    ] as any);

    await initSchema();
    await storageFor(user.id).seedDemons();

    const byId = new Map((await storageFor(user.id).listTrades()).map((t) => [t.id, t]));
    expect(byId.get(ticked.id)?.tilt).toBe(true);
    expect(byId.get(tickedLegacy.id)?.tilt).toBe(true);
    expect(byId.get(clean.id)?.tilt).toBe(false);
    // The tick itself is gone with the tag: nothing counts it twice.
    expect(byId.get(ticked.id)?.mistakeTagIds).toEqual([]);

    const names = (await storageFor(user.id).listMistakeTags()).map((t) => t.name);
    expect(names).not.toContain("Trade Not In Plan");
    expect(names).not.toContain("Trade Not In Trading Plan");
  });
});
