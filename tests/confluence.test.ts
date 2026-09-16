import { describe, expect, it } from "vitest";
import { CONFLUENCE_MIN, confluenceBucket, confluenceNudge, confluencesOf } from "../shared/confluence";
import { byConfluence } from "../shared/breakdowns";
import { tradeXp } from "../shared/xp";
import { trade } from "./helpers";

/**
 * One reason is a hunch, two is a setup. The count is the tags on the
 * trade — tapped or pulled out of the rationale — and it is what the card
 * nudges on, what XP pays for, and what the breakdown slices by.
 */
describe("the reasons a trade had", () => {
  it("reads the tags off the trade, deduped the way the picker dedupes them", () => {
    // Case-insensitive dedupe, first spelling kept — the picker's rule.
    expect(confluencesOf(trade({ rationaleTags: JSON.stringify(["61.8 Fib", "vah", "VAH"]) }))).toEqual([
      "61.8 Fib",
      "vah",
    ]);
    expect(confluencesOf(trade({ rationaleTags: null }))).toEqual([]);
    expect(confluencesOf(trade({ rationaleTags: "not json" }))).toEqual([]);
  });

  it("buckets the count where the rule bends", () => {
    expect(confluenceBucket(0)).toBe("none");
    expect(confluenceBucket(1)).toBe("one");
    expect(confluenceBucket(CONFLUENCE_MIN)).toBe("two");
    expect(confluenceBucket(5)).toBe("three-plus");
  });

  it("nudges at the moment of the decision, and stops nudging once there is a setup", () => {
    expect(confluenceNudge(0)).toMatch(/what is the setup/i);
    expect(confluenceNudge(1)).toMatch(/hunch/i);
    expect(confluenceNudge(2)).toMatch(/setup/i);
    expect(confluenceNudge(3)).toMatch(/3 reasons/);
  });
});

describe("confluence in the score and the breakdown", () => {
  it("pays for naming two or more reasons, never for one", () => {
    const two = tradeXp(trade({ rationaleTags: JSON.stringify(["VAH", "61.8 Fib"]) }));
    const one = tradeXp(trade({ rationaleTags: JSON.stringify(["VAH"]) }));
    expect(two.some((e) => e.id.endsWith(":confluence"))).toBe(true);
    expect(one.some((e) => e.id.endsWith(":confluence"))).toBe(false);
  });

  it("slices closed trades by how many reasons they had", () => {
    const rows = byConfluence([
      trade({ id: 1, rationaleTags: JSON.stringify(["VAH", "61.8 Fib", "Reclaim"]) }),
      trade({ id: 2, rationaleTags: JSON.stringify(["VAH"]), exitPrice: 90 }),
      trade({ id: 3, rationaleTags: null, exitPrice: 90 }),
      trade({ id: 4, rationaleTags: JSON.stringify(["VAH", "Reclaim"]) }),
    ]);
    expect(rows.map((r) => [r.key, r.count])).toEqual([
      ["none", 1],
      ["one", 1],
      ["two", 1],
      ["three-plus", 1],
    ]);
    expect(rows.find((r) => r.key === "three-plus")!.label).toBe("Three or more");
  });
});
