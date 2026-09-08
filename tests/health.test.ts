import { describe, expect, it } from "vitest";
import { journalHealth, staleAfterMs } from "../shared/health";
import { trade } from "./helpers";

/**
 * The gaps the panel names.
 *
 * Each rule has a case it must flag and a neighbour it must leave alone:
 * a cancelled order without a stop is fine, a swing held a week in a
 * scalping style is not, and a trade closed yesterday has not had time to
 * be measured yet.
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 8, 12);
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

const base = { account: "Binance Futures", contract: null, styleId: 1, exitReason: "target" as const, mae: 1, mfe: 1 };
const closed = (over = {}) =>
  trade({ ...base, status: "closed", entryTime: ago(10), exitTime: ago(9), ...over });
const open = (over = {}) =>
  trade({ ...base, status: "open", exitPrice: null, exitTime: null, exitReason: null, entryTime: ago(2), ...over });

const kinds = (issues: ReturnType<typeof journalHealth>) => issues.map((i) => i.kind);
const ids = (issues: ReturnType<typeof journalHealth>, kind: string) =>
  issues.find((i) => i.kind === kind)?.trades.map((t) => t.id) ?? [];

describe("what the panel flags", () => {
  it("a live trade without a stop, and not a cancelled order", () => {
    const issues = journalHealth(
      [
        open({ id: 1, initialStop: null }),
        closed({ id: 2, initialStop: null }),
        trade({ ...base, id: 3, status: "cancelled", initialStop: null, exitPrice: null, exitTime: null }),
        open({ id: 4 }),
      ],
      NOW,
    );
    expect(new Set(ids(issues, "no-stop"))).toEqual(new Set([1, 2]));
  });

  it("a missing target, account and exit reason", () => {
    const issues = journalHealth(
      [
        open({ id: 1, initialTarget: null }),
        closed({ id: 2, account: "  " }),
        closed({ id: 3, exitReason: null }),
        open({ id: 4 }),
      ],
      NOW,
    );
    expect(ids(issues, "no-target")).toEqual([1]);
    expect(ids(issues, "no-account")).toEqual([2]);
    expect(ids(issues, "no-exit-reason")).toEqual([3]);
  });

  it("a closed crypto trade whose path the archive should have measured by now", () => {
    const issues = journalHealth(
      [
        closed({ id: 1, mae: null, mfe: null, exitTime: ago(5) }),
        // Yesterday: the archive may not have published its day yet.
        closed({ id: 2, mae: null, mfe: null, entryTime: ago(2), exitTime: ago(1) }),
        // An index future has no archive to measure it from.
        closed({ id: 3, mae: null, mfe: null, contract: "MNQU6", exitTime: ago(5) }),
        closed({ id: 4, exitTime: ago(5) }),
      ],
      NOW,
    );
    expect(ids(issues, "path-unmeasured")).toEqual([1]);
  });

  it("leaves out kinds with nothing in them and orders the rest by consequence", () => {
    const issues = journalHealth([open({ id: 1, initialStop: null, account: "" }), closed({ id: 2, exitReason: null })], NOW);
    expect(kinds(issues)).toEqual(["no-stop", "no-exit-reason", "no-account"]);
  });

  it("has nothing to say about a complete journal", () => {
    expect(journalHealth([closed({ id: 1 }), open({ id: 2 })], NOW)).toEqual([]);
  });
});

describe("an open trade held far longer than its style does", () => {
  it("is a week at least, whatever the style, when the style has no record", () => {
    expect(staleAfterMs([], 1)).toBe(7 * DAY);
    const issues = journalHealth([open({ id: 1, entryTime: ago(10) }), open({ id: 2, entryTime: ago(6) })], NOW);
    expect(ids(issues, "stale-open")).toEqual([1]);
  });

  it("is three times the style's median hold once there are enough closed trades", () => {
    // Six swings held three days each: the norm is nine days, so eight days open is not stale.
    const swings = Array.from({ length: 6 }, (_, i) =>
      closed({ id: 100 + i, entryTime: ago(40 - i), exitTime: ago(37 - i) }),
    );
    expect(staleAfterMs(swings, 1)).toBe(9 * DAY);
    const issues = journalHealth([...swings, open({ id: 1, entryTime: ago(8) }), open({ id: 2, entryTime: ago(10) })], NOW);
    expect(ids(issues, "stale-open")).toEqual([2]);
  });

  it("never drops below a week for a scalping style", () => {
    const scalps = Array.from({ length: 6 }, (_, i) =>
      closed({ id: 200 + i, styleId: 2, entryTime: ago(20 - i), exitTime: new Date(NOW - (20 - i) * DAY + 3_600_000).toISOString() }),
    );
    expect(staleAfterMs(scalps, 2)).toBe(7 * DAY);
  });
});
