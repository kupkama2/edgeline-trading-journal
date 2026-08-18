import { describe, expect, it } from "vitest";
import {
  EMPTY_SCOPE,
  filterByScope,
  filterByStyle,
  OWN_IDEA,
  knownAccounts,
  knownSources,
  toggleAccountIn,
  toggleStyleIn,
} from "../client/src/lib/style-filter";

/**
 * Two axes, each a set. The one that matters is "both" — a per-account risk
 * limit is only checkable if you can ask "my swings, on the Apex eval" rather
 * than one or the other. And each axis takes several values, because a trade
 * belongs to one book on one account but comparing two books side by side is a
 * question worth asking.
 */
const t = (styleId: number | null, account: string | null, id = 0) =>
  ({ id, styleId, account }) as any;

const book = [
  t(1, "Apex eval", 1),
  t(1, "Binance Futures", 2),
  t(2, "Apex eval", 3),
  t(2, null, 4),
  t(null, "Binance Futures", 5),
  t(3, "IBKR", 6),
];

const ids = (out: { id: number }[]) => out.map((x) => x.id);

describe("scoping a page", () => {
  it("neither axis is the whole log", () => {
    expect(filterByScope(book, EMPTY_SCOPE)).toHaveLength(6);
  });

  it("style alone ignores the account", () => {
    expect(ids(filterByScope(book, { styleIds: [1], accounts: [] }))).toEqual([1, 2]);
  });

  it("account alone ignores the style", () => {
    expect(ids(filterByScope(book, { styleIds: [], accounts: ["Apex eval"] }))).toEqual([1, 3]);
  });

  it("both crosses them", () => {
    expect(ids(filterByScope(book, { styleIds: [2], accounts: ["Apex eval"] }))).toEqual([3]);
  });

  it("several styles union rather than intersect", () => {
    // A trade cannot be two styles at once, so requiring both would empty the
    // page; picking two books means "show me these two".
    expect(ids(filterByScope(book, { styleIds: [1, 2], accounts: [] }))).toEqual([1, 2, 3, 4]);
  });

  it("several accounts union too", () => {
    expect(ids(filterByScope(book, { styleIds: [], accounts: ["Apex eval", "IBKR"] }))).toEqual([
      1, 3, 6,
    ]);
  });

  it("crosses many against many", () => {
    // Union within an axis, intersection across them: styles 1 or 2, AND on one
    // of these two accounts. Trade 4 has style 2 but no account, so it drops.
    expect(
      ids(
        filterByScope(book, {
          styleIds: [1, 2],
          accounts: ["Apex eval", "Binance Futures"],
        }),
      ),
    ).toEqual([1, 2, 3]);
  });

  it("selecting every style is the same view as selecting none", () => {
    // Otherwise clicking each chip in turn would silently drop the unassigned
    // trades — a filter nobody asked for.
    const each = filterByScope(book, { styleIds: [1, 2, 3], accounts: [] });
    expect(ids(each)).toEqual([1, 2, 3, 4, 6]);
    expect(each.length).toBeLessThan(book.length); // trade 5 has no style
  });

  it("matches an account regardless of how it was typed", () => {
    // The column is free text, so "Apex Eval" and "apex eval " are one account
    // that happened to be typed twice — filtering has to agree with that or
    // half the trades vanish from their own page.
    expect(ids(filterByScope(book, { styleIds: [], accounts: ["  APEX EVAL "] }))).toEqual([1, 3]);
  });

  it("excludes trades with no account when one is selected", () => {
    // A trade that never recorded where it ran is not evidence about the Apex
    // eval, and quietly including it would inflate that account's record.
    const out = filterByScope(book, { styleIds: [2], accounts: ["Apex eval"] });
    expect(out.some((x) => x.account == null)).toBe(false);
  });

  it("still behaves like the old style-only filter", () => {
    expect(filterByStyle(book, 1)).toEqual(filterByScope(book, { styleIds: [1], accounts: [] }));
    expect(filterByStyle(book, null)).toHaveLength(6);
  });
});

describe("picking chips", () => {
  it("adds, then removes, one style at a time", () => {
    expect(toggleStyleIn([], 1)).toEqual([1]);
    expect(toggleStyleIn([1], 2)).toEqual([1, 2]);
    expect(toggleStyleIn([1, 2], 1)).toEqual([2]);
    expect(toggleStyleIn([2], 2)).toEqual([]);
  });

  it("turns an account off however it was spelled when stored", () => {
    // The chip shows the first spelling seen; the stored selection may be a
    // different one. Comparing by equality would add a near-duplicate and the
    // chip would refuse to switch off.
    expect(toggleAccountIn(["apex eval "], "Apex eval")).toEqual([]);
    expect(toggleAccountIn(["Apex eval"], "IBKR")).toEqual(["Apex eval", "IBKR"]);
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

/**
 * Source — whose idea the trade was.
 *
 * The interesting case is the empty one. A trade with no source is not
 * missing data, it is your own idea, and it is the baseline every followed
 * call is measured against; "am I better off on my own than following
 * Severin" is unanswerable if the only thing you can isolate is Severin.
 */
const sourced = [
  { id: 1, styleId: 1, account: "Apex eval", source: "Severin" },
  { id: 2, styleId: 1, account: "Apex eval", source: "Daniel" },
  { id: 3, styleId: 2, account: "Binance Futures", source: null },
  { id: 4, styleId: 2, account: "Apex eval", source: "  severin " },
  { id: 5, styleId: 1, account: "Binance Futures", source: "   " },
] as any[];

describe("scoping by source", () => {
  it("picks out one person's calls, however the name was typed", () => {
    expect(
      ids(filterByScope(sourced, { styleIds: [], accounts: [], sources: ["Severin"] })),
    ).toEqual([1, 4]);
  });

  it("unions several people", () => {
    expect(
      ids(filterByScope(sourced, { styleIds: [], accounts: [], sources: ["Severin", "Daniel"] })),
    ).toEqual([1, 2, 4]);
  });

  it("isolates your own ideas, including a source that is only whitespace", () => {
    // Trade 5 has "   " in the column — written, but saying nothing. Treating
    // that as a source called "   " would put a blank row in the breakdown and
    // quietly keep the trade out of your own baseline.
    expect(ids(filterByScope(sourced, { styleIds: [], accounts: [], sources: [OWN_IDEA] }))).toEqual(
      [3, 5],
    );
  });

  it("crosses source with the other axes", () => {
    expect(
      ids(
        filterByScope(sourced, {
          styleIds: [2],
          accounts: ["Apex eval"],
          sources: ["Severin"],
        }),
      ),
    ).toEqual([4]);
  });

  it("selecting nobody is everyone", () => {
    expect(filterByScope(sourced, EMPTY_SCOPE)).toHaveLength(5);
  });

  it("offers each source once for the picker, ignoring blanks", () => {
    expect(knownSources(sourced)).toEqual(["Daniel", "Severin"]);
  });
});
