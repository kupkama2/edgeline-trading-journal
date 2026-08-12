import { describe, expect, it } from "vitest";
import { filterByScope, filterByStyle, knownAccounts } from "../client/src/lib/style-filter";

/**
 * Two axes, four combinations. The one that matters is "both" — a per-account
 * risk limit is only checkable if you can ask "my swings, on the Apex eval"
 * rather than one or the other.
 */
const t = (styleId: number | null, account: string | null, id = 0) =>
  ({ id, styleId, account }) as any;

const book = [
  t(1, "Apex eval", 1),
  t(1, "Binance Futures", 2),
  t(2, "Apex eval", 3),
  t(2, null, 4),
  t(null, "Binance Futures", 5),
];

describe("scoping a page", () => {
  it("neither axis is the whole log", () => {
    expect(filterByScope(book, { styleId: null, account: null })).toHaveLength(5);
  });

  it("style alone ignores the account", () => {
    expect(filterByScope(book, { styleId: 1, account: null }).map((x) => x.id)).toEqual([1, 2]);
  });

  it("account alone ignores the style", () => {
    expect(filterByScope(book, { styleId: null, account: "Apex eval" }).map((x) => x.id)).toEqual(
      [1, 3],
    );
  });

  it("both crosses them", () => {
    expect(filterByScope(book, { styleId: 2, account: "Apex eval" }).map((x) => x.id)).toEqual([3]);
  });

  it("matches an account regardless of how it was typed", () => {
    // The column is free text, so "Apex Eval" and "apex eval " are one account
    // that happened to be typed twice — filtering has to agree with that or
    // half the trades vanish from their own page.
    expect(filterByScope(book, { styleId: null, account: "  APEX EVAL " }).map((x) => x.id)).toEqual(
      [1, 3],
    );
  });

  it("excludes trades with no account when one is selected", () => {
    // A trade that never recorded where it ran is not evidence about the Apex
    // eval, and quietly including it would inflate that account's record.
    const out = filterByScope(book, { styleId: 2, account: "Apex eval" });
    expect(out.some((x) => x.account == null)).toBe(false);
  });

  it("still behaves like the old style-only filter", () => {
    expect(filterByStyle(book, 1)).toEqual(filterByScope(book, { styleId: 1, account: null }));
    expect(filterByStyle(book, null)).toHaveLength(5);
  });
});

describe("the account list", () => {
  it("offers each account once, however it was spelled", () => {
    expect(
      knownAccounts([
        { account: "Apex eval" },
        { account: "apex eval " },
        { account: "Binance Futures" },
      ]),
    ).toEqual(["Apex eval", "Binance Futures"]);
  });

  it("ignores blanks rather than offering an empty chip", () => {
    expect(knownAccounts([{ account: null }, { account: "   " }, { account: "IBKR" }])).toEqual([
      "IBKR",
    ]);
  });
});
