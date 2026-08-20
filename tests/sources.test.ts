import { describe, expect, it } from "vitest";
import { splitSourceFromTags } from "../shared/sources";

/**
 * A person's name in the setup list is not a setup.
 *
 * Before `source` was a column, "this was Severin's call" could only be
 * written as a tag — so it was. Left there, it splits the Setup breakdown
 * with rows that belong to the Source breakdown, and keeps the trade out of
 * the source stats that exist to judge exactly that call.
 */
const ROSTER = ["Severin", "Daniel", "CBS", "UB"];

describe("promoting a source out of the tags", () => {
  it("moves a lone source name into the source field", () => {
    expect(splitSourceFromTags(["61.8 Fib", "Severin"], ROSTER, null)).toEqual({
      tags: ["61.8 Fib"],
      source: "Severin",
    });
  });

  it("matches however the tag was typed, and answers with the roster spelling", () => {
    expect(splitSourceFromTags(["  severin "], ROSTER, null)).toEqual({
      tags: [],
      source: "Severin",
    });
  });

  it("refuses to choose between two different sources", () => {
    // A trade has one origin. Two names on it is a question, and a promotion
    // must never answer questions — everything stays as typed.
    const out = splitSourceFromTags(["Severin", "Daniel"], ROSTER, null);
    expect(out).toEqual({ tags: ["Severin", "Daniel"], source: null });
  });

  it("never overwrites a source that was set deliberately", () => {
    // The explicit field is the answer; the tag was a duplicate of the claim
    // and still moves out, so the two breakdowns cannot disagree about the
    // trade.
    expect(splitSourceFromTags(["Daniel", "Reclaim"], ROSTER, "Severin")).toEqual({
      tags: ["Reclaim"],
      source: "Severin",
    });
  });

  it("passes unknown tags through untouched — this promotes, it never filters", () => {
    expect(splitSourceFromTags(["VAH Rejection", "Golden Pocket"], ROSTER, null)).toEqual({
      tags: ["VAH Rejection", "Golden Pocket"],
      source: null,
    });
  });

  it("does nothing with an empty roster", () => {
    expect(splitSourceFromTags(["Severin"], [], null)).toEqual({
      tags: ["Severin"],
      source: null,
    });
  });
});

/**
 * The one-time boot migration over real rows. Same DB-guard convention as the
 * isolation suite: skipped without a database locally, mandatory in CI.
 */
const DB = process.env.DATABASE_URL;

describe.skipIf(!DB)("the boot migration over stored trades", () => {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  it("moves the name, skips the ambiguous, respects the deliberate", async () => {
    const { initSchema, accounts, storageFor, promoteSourceTagsOnce } = await import(
      "../server/storage"
    );
    await initSchema();
    const user = await accounts.create({
      googleSub: `src-${stamp}`,
      email: `src-${stamp}@x.test`,
    });
    const store = storageFor(user.id);
    const base = {
      symbol: "NQ",
      direction: "long" as const,
      size: 1,
      sizeUnit: "base" as const,
      entryPrice: 100,
      initialStop: 90,
      initialTarget: 130,
      entryTime: "2026-08-19T09:30:00.000Z",
      status: "open" as const,
    };
    const tagged = await store.createTrade(
      { ...base, rationaleTags: JSON.stringify(["Severin", "61.8 Fib"]) } as any,
      [],
    );
    const ambiguous = await store.createTrade(
      { ...base, rationaleTags: JSON.stringify(["Severin", "Daniel"]) } as any,
      [],
    );
    const deliberate = await store.createTrade(
      { ...base, source: "CBS", rationaleTags: JSON.stringify(["UB"]) } as any,
      [],
    );

    await promoteSourceTagsOnce();

    const after = await store.listTrades();
    const t1 = after.find((t) => t.id === tagged.id)!;
    expect(t1.source).toBe("Severin");
    expect(JSON.parse(t1.rationaleTags!)).toEqual(["61.8 Fib"]);

    // Two names is a question; a migration must never answer questions.
    const t2 = after.find((t) => t.id === ambiguous.id)!;
    expect(t2.source).toBeNull();
    expect(JSON.parse(t2.rationaleTags!)).toEqual(["Severin", "Daniel"]);

    // source already set: the migration only fills blanks, so the tag "UB"
    // stays where it is rather than being second-guessed.
    const t3 = after.find((t) => t.id === deliberate.id)!;
    expect(t3.source).toBe("CBS");
    expect(JSON.parse(t3.rationaleTags!)).toEqual(["UB"]);

    // Idempotent: a second boot changes nothing.
    const movedAgain = await promoteSourceTagsOnce();
    expect(movedAgain).toBe(0);
    const twice = (await store.listTrades()).find((t) => t.id === tagged.id)!;
    expect(twice.source).toBe("Severin");
    expect(JSON.parse(twice.rationaleTags!)).toEqual(["61.8 Fib"]);
  });
});
