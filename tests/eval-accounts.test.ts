import { describe, expect, it } from "vitest";
import { filterByScope, scopeActive, EMPTY_SCOPE } from "../client/src/lib/style-filter";

/**
 * Keeping a prop evaluation out of the live record.
 *
 * An evaluation is somebody else's money under somebody else's rules — a
 * drawdown limit and a profit target that change how a trade gets managed.
 * Averaged into the live record it is not a bigger sample, it is a different
 * game contaminating the one being measured, and the damage is invisible:
 * the numbers still look exactly like numbers.
 */
const t = (account: string | null, id = 0) => ({ id, styleId: null, account, source: null });

const book = [t("Apex eval", 1), t("Binance Futures", 2), t(null, 3), t("APEX EVAL", 4)];
const scope = { ...EMPTY_SCOPE, evaluationAccounts: ["Apex eval"] };

describe("what the default view shows", () => {
  it("leaves the evaluation out", () => {
    expect(filterByScope(book, scope).map((x) => x.id)).toEqual([2, 3]);
  });

  it("matches the account name the way a human reads it", () => {
    // Case and spacing are how the same account gets typed twice, not how two
    // accounts differ.
    expect(filterByScope(book, scope).some((x) => x.id === 4)).toBe(false);
  });

  it("shows everything when no account is marked", () => {
    expect(filterByScope(book, EMPTY_SCOPE)).toHaveLength(4);
  });

  it("keeps a trade with no account at all", () => {
    // Unassigned is not an evaluation, and dropping it would quietly shrink
    // the record of anyone who never used accounts.
    expect(filterByScope(book, scope).some((x) => x.id === 3)).toBe(true);
  });
});

describe("opening the evaluation on purpose", () => {
  it("shows it when it is the account being asked for", () => {
    /*
     * The whole point of the exception. A filter that refused to show what it
     * was explicitly pointed at would be broken rather than careful.
     */
    const asked = { ...scope, accounts: ["Apex eval"] };
    expect(filterByScope(book, asked).map((x) => x.id)).toEqual([1, 4]);
  });

  it("still narrows to another account without dragging the evaluation in", () => {
    const asked = { ...scope, accounts: ["Binance Futures"] };
    expect(filterByScope(book, asked).map((x) => x.id)).toEqual([2]);
  });
});

describe("what counts as being filtered", () => {
  it("does not call the default view a filtered one", () => {
    /*
     * The "you are scoped" glow says a page is showing a SUBSET of the log.
     * Hiding an evaluation is a property of the account, not a choice the
     * trader just made, and lighting the whole viewport for it would cry wolf
     * on every page forever.
     */
    expect(scopeActive(scope)).toBe(false);
    expect(scopeActive({ ...scope, accounts: ["Apex eval"] })).toBe(true);
  });
});
