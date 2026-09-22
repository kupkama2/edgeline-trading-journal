import { describe, expect, it } from "vitest";
import {
  dailyProgress,
  dueSentence,
  isMiss,
  isReviewed,
  reviewDue,
  reviewProgress,
  tradesInWeek,
  tradesOnDay,
  weekBefore,
  weekKey,
  weekLabel,
  weekStart,
} from "../shared/review";
import { trade } from "./helpers";
import { tradeXp } from "../shared/xp";

/**
 * The Sunday pass: which trades a week's review is about, how far through it
 * you are, and when it starts asking. It asks from Sunday and does not stop
 * asking — a nag that clears itself on Monday is for people who were going
 * to do it anyway.
 */
// September 2026: the 14th is a Monday, the 20th the Sunday that ends it.
const MON = new Date(2026, 8, 14, 9);
const WED = new Date(2026, 8, 16, 9);
const SUN = new Date(2026, 8, 20, 18);
const NEXT_TUE = new Date(2026, 8, 22, 9);

const closedOn = (id: number, day: number, over = {}) =>
  trade({
    id,
    entryTime: new Date(2026, 8, day, 9).toISOString(),
    exitTime: new Date(2026, 8, day, 10).toISOString(),
    status: "closed",
    ...over,
  });

describe("which week a trade belongs to", () => {
  it("starts the week on Monday, whatever day you ask on", () => {
    for (const d of [MON, WED, SUN]) expect(weekStart(d).getDate()).toBe(14);
    expect(weekKey(WED)).toBe("2026-09-14");
    expect(weekLabel(WED)).toMatch(/14/);
    expect(weekBefore(WED).getDate()).toBe(7);
  });

  it("takes the closed trades that finished inside it, oldest first", () => {
    const ts = [
      closedOn(3, 18),
      closedOn(1, 14),
      closedOn(9, 13), // the Sunday before — a different week
      closedOn(8, 21), // the Monday after
      closedOn(5, 16, { status: "open", exitTime: null, exitPrice: null }),
      closedOn(6, 16, { status: "cancelled", exitTime: null, exitPrice: null }),
    ];
    expect(tradesInWeek(ts, WED).map((t) => t.id)).toEqual([1, 3]);
  });
});

describe("how far through the week you are", () => {
  const ts = [closedOn(1, 14, { reviewedAt: "2026-09-20T18:00:00Z" }), closedOn(2, 16), closedOn(3, 18)];

  it("counts what is done and hands back what is left, in order", () => {
    const p = reviewProgress(ts, WED);
    expect(p).toMatchObject({ reviewed: 1, done: false, key: "2026-09-14" });
    expect(p.left.map((t) => t.id)).toEqual([2, 3]);
    expect(isReviewed(ts[0])).toBe(true);
    expect(isReviewed(ts[1])).toBe(false);
  });

  it("is done when every trade has been gone over, and when there were none", () => {
    const all = ts.map((t) => ({ ...t, reviewedAt: "2026-09-20T18:00:00Z" }));
    expect(reviewProgress(all, WED).done).toBe(true);
    expect(reviewProgress([], WED)).toMatchObject({ done: true, reviewed: 0 });
  });
});

describe("when it starts asking", () => {
  const thisWeek = [closedOn(1, 14), closedOn(2, 16)];

  it("says nothing about a week still being traded", () => {
    expect(reviewDue(thisWeek, WED)).toBeNull();
  });

  it("asks on the Sunday that ends the week", () => {
    const due = reviewDue(thisWeek, SUN)!;
    expect(due.weeksAgo).toBe(0);
    expect(due.progress.left).toHaveLength(2);
    expect(dueSentence(due)).toBe("2 trades from this week go unreviewed.");
  });

  it("keeps asking after the week is over, and says how old it is", () => {
    const due = reviewDue(thisWeek, NEXT_TUE)!;
    expect(due.weeksAgo).toBe(1);
    expect(dueSentence(due)).toBe("2 trades from last week went unreviewed.");
  });

  it("stops asking once the week is done", () => {
    const all = thisWeek.map((t) => ({ ...t, reviewedAt: "2026-09-20T18:00:00Z" }));
    expect(reviewDue(all, SUN)).toBeNull();
    expect(reviewDue(all, NEXT_TUE)).toBeNull();
  });

  it("offers the newest week still owed rather than the oldest", () => {
    const older = [closedOn(9, 7), ...thisWeek];
    const due = reviewDue(older, NEXT_TUE)!;
    expect(due.weeksAgo).toBe(1);
    expect(dueSentence(due)).toMatch(/last week/);
  });

  it("says nothing about a week with nothing in it", () => {
    expect(reviewDue([], SUN)).toBeNull();
  });
});

describe("what the pass is worth", () => {
  it("pays for going back over a trade, once", () => {
    const paid = (t: ReturnType<typeof trade>) =>
      tradeXp(t).filter((e) => e.id.endsWith(":reviewed")).length;
    expect(paid(trade({ reviewedAt: "2026-09-20T18:00:00Z" }))).toBe(1);
    expect(paid(trade({ reviewedAt: null }))).toBe(0);
  });

  it("pays nothing on a trade that was never closed", () => {
    const open = trade({ status: "open", exitPrice: null, exitTime: null, reviewedAt: "2026-09-20T18:00:00Z" });
    expect(tradeXp(open).some((e) => e.id.endsWith(":reviewed"))).toBe(false);
  });
});

/**
 * The passes, read back beside the takes.
 *
 * A setup you saw and let go is a decision with a cost, and the only way it
 * ever becomes a number is being read in a row with the others: one pass says
 * nothing, six in a week say what your filter is actually doing. So a miss
 * joins its week and the week is not done until it has been gone over.
 *
 * Which is NOT the same as counting every dead order. "Not filled" and
 * "changed my mind" are things that happened to an order; only 'never_placed'
 * is a decision somebody made, and only that one is worth a Sunday.
 */
const missOn = (id: number, day: number, over = {}) =>
  trade({
    id,
    entryTime: new Date(2026, 8, day, 9).toISOString(),
    exitTime: null,
    exitPrice: null,
    status: "cancelled",
    cancelReason: "never_placed",
    ...over,
  });

describe("setups that were passed on", () => {
  it("counts a miss into its week, dated by the entry it never made", () => {
    const ts = [closedOn(1, 15), missOn(2, 16), missOn(7, 21)];
    // 21 September is the Monday after — a different week, as for any trade.
    expect(tradesInWeek(ts, WED).map((t) => t.id)).toEqual([1, 2]);
  });

  it("leaves the other ways an order dies alone", () => {
    /*
     * An order that did not fill was never a decision, and a review full of
     * them is a review nobody finishes. The distinction is the cancel reason,
     * not the status.
     */
    const ts = [
      missOn(1, 16),
      missOn(2, 16, { cancelReason: "not_filled" }),
      missOn(3, 16, { cancelReason: "pulled" }),
      missOn(4, 16, { cancelReason: "changed_mind" }),
      missOn(5, 16, { cancelReason: null }),
    ];
    expect(tradesInWeek(ts, WED).map((t) => t.id)).toEqual([1]);
  });

  it("holds the week open until the misses have been gone over too", () => {
    const ts = [
      closedOn(1, 15, { reviewedAt: new Date(2026, 8, 20, 12).toISOString() }),
      missOn(2, 16),
    ];
    const p = reviewProgress(ts, WED);
    expect(p.trades.map((t) => t.id)).toEqual([1, 2]);
    expect(p.left.map((t) => t.id)).toEqual([2]);
    expect(p.done).toBe(false);
    expect(reviewDue(ts, NEXT_TUE)?.progress.left.map((t) => t.id)).toEqual([2]);
  });

  it("is done when the misses are, and the nag counts them as trades", () => {
    const seen = new Date(2026, 8, 20, 12).toISOString();
    const ts = [closedOn(1, 15, { reviewedAt: seen }), missOn(2, 16, { reviewedAt: seen })];
    expect(reviewProgress(ts, WED).done).toBe(true);
    expect(reviewDue(ts, NEXT_TUE)).toBeNull();

    // And when they are not: one sentence covering both, because what is owed
    // is a pass over the week's decisions and passing was one of them.
    const owed = reviewDue([closedOn(1, 15), missOn(2, 16)], NEXT_TUE)!;
    expect(dueSentence(owed)).toBe("2 trades from last week went unreviewed.");
  });

  it("brings a week that is nothing but misses to the review", () => {
    // A week where you took nothing at all is the week most worth reading.
    const owed = reviewDue([missOn(1, 15), missOn(2, 17)], NEXT_TUE);
    expect(owed?.progress.trades.map((t) => t.id)).toEqual([1, 2]);
  });

  it("names a miss as one", () => {
    expect(isMiss(missOn(1, 16))).toBe(true);
    expect(isMiss(missOn(2, 16, { cancelReason: "not_filled" }))).toBe(false);
    expect(isMiss(closedOn(3, 16))).toBe(false);
    expect(isReviewed(missOn(4, 16))).toBe(false);
  });
});

/**
 * The same pass, on the day it happened.
 *
 * The point of having both is that there is only one reviewed flag: a trade
 * gone over on Tuesday evening is already done when Sunday comes. Nothing
 * synchronises the two because there is nothing to synchronise — the day and
 * the week are two ways of asking the same column — and these are the tests
 * that say so out loud, because the day that stops being true is the day
 * somebody is asked to write the same note twice.
 */
describe("a day's review", () => {
  const TUE = new Date(2026, 8, 15, 20);

  it("takes what ended that day, oldest first", () => {
    const ts = [
      closedOn(2, 15, {
        entryTime: new Date(2026, 8, 15, 14).toISOString(),
        exitTime: new Date(2026, 8, 15, 15).toISOString(),
      }),
      closedOn(1, 15),
      closedOn(3, 16),
      missOn(4, 15),
    ];
    expect(tradesOnDay(ts, TUE).map((t) => t.id)).toEqual([4, 1, 2]);
  });

  it("files a swing on the day it ENDED, not the day it was opened", () => {
    // Thursday is when there was something to judge.
    const swing = trade({
      id: 1,
      entryTime: new Date(2026, 8, 14, 9).toISOString(),
      exitTime: new Date(2026, 8, 17, 11).toISOString(),
      status: "closed",
    });
    expect(tradesOnDay([swing], new Date(2026, 8, 14, 20)).map((t) => t.id)).toEqual([]);
    expect(tradesOnDay([swing], new Date(2026, 8, 17, 20)).map((t) => t.id)).toEqual([1]);
  });

  it("counts the day the way it counts the week", () => {
    const ts = [closedOn(1, 15), closedOn(2, 15, { reviewedAt: TUE.toISOString() })];
    const p = dailyProgress(ts, TUE);
    expect(p.key).toBe("2026-09-15");
    expect(p.trades.map((t) => t.id)).toEqual([1, 2]);
    expect(p.left.map((t) => t.id)).toEqual([1]);
    expect(p.reviewed).toBe(1);
    expect(p.done).toBe(false);
  });

  it("is a day done when its trades are", () => {
    const seen = TUE.toISOString();
    expect(dailyProgress([closedOn(1, 15, { reviewedAt: seen })], TUE).done).toBe(true);
    // A day with nothing on it is not owed anything.
    expect(dailyProgress([closedOn(1, 16)], TUE).trades).toEqual([]);
    expect(dailyProgress([closedOn(1, 16)], TUE).done).toBe(true);
  });
});

describe("the day and the week are one flag", () => {
  it("does not ask again on Sunday for what was done on Tuesday", () => {
    const onTheDay = new Date(2026, 8, 15, 20).toISOString();
    const ts = [closedOn(1, 15, { reviewedAt: onTheDay }), closedOn(2, 17)];

    // Tuesday's own review is finished.
    expect(dailyProgress(ts, new Date(2026, 8, 15, 21)).done).toBe(true);
    // And the week only still wants the one that was never gone over.
    const week = reviewProgress(ts, WED);
    expect(week.left.map((t) => t.id)).toEqual([2]);
    expect(dueSentence(reviewDue(ts, NEXT_TUE)!)).toBe(
      "1 trade from last week went unreviewed.",
    );
  });

  it("finishes the week outright when every day was done on the day", () => {
    const stamp = (day: number) => new Date(2026, 8, day, 20).toISOString();
    const ts = [
      closedOn(1, 15, { reviewedAt: stamp(15) }),
      closedOn(2, 17, { reviewedAt: stamp(17) }),
      missOn(3, 18, { reviewedAt: stamp(18) }),
    ];
    expect(reviewProgress(ts, WED).done).toBe(true);
    // Nothing owed, and nothing to nag about: the Sunday is already spent.
    expect(reviewDue(ts, NEXT_TUE)).toBeNull();
  });

  it("works the other way round too", () => {
    // Reviewed in the weekly pass, so the day it belongs to is finished as
    // well — there is no direction to this, only the one column.
    const ts = [closedOn(1, 15, { reviewedAt: new Date(2026, 8, 20, 12).toISOString() })];
    expect(dailyProgress(ts, new Date(2026, 8, 15, 9)).done).toBe(true);
  });
});
