import { describe, expect, it } from "vitest";
import { dayKey, dayLabel, groupByDay, isWin, tradeVerdict, verdictOf } from "../shared/verdict";
import { localIso, trade } from "./helpers";

/**
 * One word per closed trade, and the day it belongs to. The quiet layout is
 * built on both: if the word is wrong the row lies, and if the grouping is
 * wrong the day totals belong to the wrong day.
 */
describe("the one word", () => {
  it("is the money when there is no verdict on the row", () => {
    expect(tradeVerdict({ tilt: false, wellTraded: false }, 120)).toBe("win");
    expect(tradeVerdict({ tilt: false, wellTraded: false }, -40)).toBe("loss");
  });

  it("calls a scratch a win — flat is not a loss", () => {
    expect(tradeVerdict({ tilt: false, wellTraded: false }, 0)).toBe("win");
  });

  it("says tilt over everything, including a tilt trade that paid", () => {
    expect(tradeVerdict({ tilt: true, wellTraded: false }, 900)).toBe("tilt");
    expect(tradeVerdict({ tilt: true, wellTraded: false }, -50)).toBe("tilt");
  });

  it("says great for a well-traded loss, because the verdict is on the execution", () => {
    expect(tradeVerdict({ tilt: false, wellTraded: true }, -220)).toBe("great");
    expect(tradeVerdict({ tilt: false, wellTraded: true }, 220)).toBe("great");
  });

  it("refuses both verdicts on one row, the way the rest of the journal does", () => {
    expect(tradeVerdict({ tilt: true, wellTraded: true }, 100)).toBe("tilt");
  });

  it("still decides when the money is missing", () => {
    expect(tradeVerdict({ tilt: false, wellTraded: false }, null)).toBe("win");
  });

  it("reads the trade itself when the caller has no metrics in hand", () => {
    expect(verdictOf(trade({ entryPrice: 100, exitPrice: 120 }))).toBe("win");
    expect(verdictOf(trade({ entryPrice: 100, exitPrice: 80 }))).toBe("loss");
    expect(verdictOf(trade({ entryPrice: 100, exitPrice: 80, wellTraded: true }))).toBe("great");
  });

  it("keeps win and loss separate from the verdict", () => {
    // A great trade that lost is both "great" and not a win. The row shows
    // one in the badge and the other in the colour of the money.
    const t = trade({ entryPrice: 100, exitPrice: 80, wellTraded: true });
    expect(verdictOf(t)).toBe("great");
    expect(isWin(-200)).toBe(false);
  });
});

describe("the day a trade closed", () => {
  it("files a trade under its local day, not its UTC one", () => {
    // 23:30 local on the 4th is the 5th in UTC for anywhere east of London.
    const iso = localIso(2026, 9, 4, 23, 30);
    expect(dayKey(iso)).toBe("2026-09-04");
  });

  it("groups by the close, newest day first", () => {
    const groups = groupByDay([
      trade({ id: 1, exitTime: localIso(2026, 9, 3, 10) }),
      trade({ id: 2, exitTime: localIso(2026, 9, 5, 10) }),
      trade({ id: 3, exitTime: localIso(2026, 9, 4, 10) }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["2026-09-05", "2026-09-04", "2026-09-03"]);
  });

  it("puts the newest close first inside a day", () => {
    const groups = groupByDay([
      trade({ id: 1, exitTime: localIso(2026, 9, 3, 9) }),
      trade({ id: 2, exitTime: localIso(2026, 9, 3, 15) }),
      trade({ id: 3, exitTime: localIso(2026, 9, 3, 12) }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].trades.map((t) => t.id)).toEqual([2, 3, 1]);
  });

  it("falls back to the entry when a close has no stamp", () => {
    const groups = groupByDay([
      trade({ id: 1, entryTime: localIso(2026, 9, 7, 10), exitTime: null }),
    ]);
    expect(groups[0].key).toBe("2026-09-07");
  });

  it("adds up the day the way the rest of the journal adds up", () => {
    const groups = groupByDay([
      // +$2000 on a $1000 risk, and −$1000 on the same: +1R then −1R.
      trade({ id: 1, entryPrice: 100, initialStop: 90, size: 100, exitPrice: 120,
              exitTime: localIso(2026, 9, 8, 10) }),
      trade({ id: 2, entryPrice: 100, initialStop: 90, size: 100, exitPrice: 90,
              exitTime: localIso(2026, 9, 8, 14) }),
    ]);
    expect(groups[0].pnl).toBe(1000);
    expect(groups[0].r).toBe(1);
    expect(groups[0].wins).toBe(1);
    expect(groups[0].losses).toBe(1);
  });

  it("counts every row it is handed, tilt included — the scope already chose", () => {
    /*
     * A tilt trade only reaches here once the book filter is Tilt or Both,
     * because the plan book drops them before the list is built. So a row on
     * screen missing from the sum above it was the header contradicting its
     * own rows, never "tilt kept out of the numbers".
     */
    const groups = groupByDay([
      trade({ id: 1, entryPrice: 100, initialStop: 90, size: 100, exitPrice: 120,
              exitTime: localIso(2026, 9, 9, 10) }),
      trade({ id: 2, entryPrice: 100, initialStop: 90, size: 100, exitPrice: 50,
              tilt: true, exitTime: localIso(2026, 9, 9, 15) }),
    ]);
    expect(groups[0].trades).toHaveLength(2);
    // +$2000 on the plan trade, −$5000 on the tilt one.
    expect(groups[0].pnl).toBe(-3000);
    expect(groups[0].wins).toBe(1);
    expect(groups[0].losses).toBe(1);
  });

  it("still says how many of the day were tilt, as a note rather than a deduction", () => {
    const groups = groupByDay([
      trade({ id: 1, exitTime: localIso(2026, 9, 9, 10) }),
      trade({ id: 2, tilt: true, exitTime: localIso(2026, 9, 9, 15) }),
      trade({ id: 3, tilt: true, exitTime: localIso(2026, 9, 9, 16) }),
    ]);
    expect(groups[0].tilt).toBe(2);
    expect(groups[0].trades).toHaveLength(3);
  });

  it("totals the plan alone when the plan is all it was given", () => {
    // The default book, where the filter has already removed the tilt trades.
    const groups = groupByDay([
      trade({ id: 1, entryPrice: 100, initialStop: 90, size: 100, exitPrice: 120,
              exitTime: localIso(2026, 9, 9, 10) }),
    ]);
    expect(groups[0].pnl).toBe(2000);
    expect(groups[0].tilt).toBe(0);
  });

  it("says null rather than zero R when nothing in the day was measured", () => {
    const groups = groupByDay([
      trade({ id: 1, initialStop: null, exitTime: localIso(2026, 9, 10, 10) }),
    ]);
    expect(groups[0].r).toBeNull();
    expect(groups[0].pnl).not.toBe(0);
  });

  it("gives a day a name when it has one", () => {
    const now = new Date(2026, 8, 18, 12);
    expect(dayLabel(new Date(2026, 8, 18), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 8, 17), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 8, 14), now)).not.toBe("Today");
  });
});
