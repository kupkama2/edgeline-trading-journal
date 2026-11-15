import { describe, expect, it } from "vitest";
import { moved, orderOf } from "../client/src/components/sections";

describe("a page's sections", () => {
  it("draw in the kept order, with anything new where the page put it and anything gone left out", () => {
    expect(orderOf(["totals", "hl", "wallets", "sigil"], [])).toEqual(["totals", "hl", "wallets", "sigil"]);
    expect(orderOf(["totals", "hl", "wallets", "sigil"], ["sigil", "vaults", "totals"])).toEqual(["sigil", "totals", "hl", "wallets"]);
    // A section added to the top of the page since the order was kept arrives at the top; one added mid-page follows its neighbour.
    expect(orderOf(["networth", "totals", "hl", "typed", "sigil"], ["sigil", "hl", "totals"])).toEqual(["networth", "sigil", "hl", "typed", "totals"]);
  });

  it("move before or after another, and stay put when dropped on themselves", () => {
    const o = ["totals", "hl", "wallets", "sigil"];
    expect(moved(o, "wallets", "sigil", true)).toEqual(["totals", "hl", "sigil", "wallets"]);
    expect(moved(o, "sigil", "totals", false)).toEqual(["sigil", "totals", "hl", "wallets"]);
    expect(moved(o, "hl", "hl", true)).toBe(o);
    expect(moved(o, "hl", "gone", true)).toBe(o);
  });
});
