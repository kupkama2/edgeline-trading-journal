import { describe, expect, it } from "vitest";
import {
  dueSentence,
  isReviewed,
  reviewDue,
  reviewProgress,
  tradesInWeek,
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
