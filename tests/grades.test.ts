import { describe, expect, it } from "vitest";
import {
  axisReport,
  exitCost,
  executionReport,
  gradeOf,
  overrideReport,
  overrodeThePlan,
} from "../shared/grades";
import { trade } from "./helpers";

/*
 * The defaults: entry 100, stop 90, target 130 — so 1R = 10 points, an exit at
 * 120 is +2R and the untouched plan would have paid +3R. Every figure below is
 * checkable in your head from those four numbers, which is the point.
 */

describe("grade reading", () => {
  it("ignores a grade that isn't in the axis's own taxonomy", () => {
    // Free-text column, so a stale or hand-edited value must not become a
    // fourth bucket that silently changes every share on the axis.
    expect(gradeOf(trade({ exitGrade: "late" }), "exit")).toBe("late");
    expect(gradeOf(trade({ exitGrade: "tight" }), "exit")).toBeNull();
    expect(gradeOf(trade({ stopGrade: "late" }), "stop")).toBeNull();
    expect(gradeOf(trade({ entryGrade: null }), "entry")).toBeNull();
  });

  it("counts only closed trades, and only the ones actually graded", () => {
    const r = axisReport(
      [
        trade({ id: 1, exitGrade: "late" }),
        trade({ id: 2, exitGrade: "early" }),
        trade({ id: 3, exitGrade: null }),
        trade({ id: 4, exitGrade: "perfect", status: "open", exitPrice: null }),
      ],
      "exit",
    );
    expect(r.graded).toBe(2);
    expect(r.buckets.find((b) => b.grade === "perfect")!.count).toBe(0);
  });

  it("shares are of the graded trades, not of everything closed", () => {
    const r = axisReport(
      [
        trade({ id: 1, exitGrade: "late" }),
        trade({ id: 2, exitGrade: "late" }),
        trade({ id: 3, exitGrade: "perfect" }),
        trade({ id: 4 }),
        trade({ id: 5 }),
      ],
      "exit",
    );
    // An ungraded trade is absent, never average: 2 of 3, not 2 of 5.
    expect(r.buckets.find((b) => b.grade === "late")!.share).toBeCloseTo(2 / 3, 10);
  });
});

describe("what a grade costs", () => {
  it("prices a late exit as R reached and handed back", () => {
    // Ran to 150 (+5R), closed at 120 (+2R): 3R given back.
    const r = axisReport([trade({ exitGrade: "late", mfe: 150 })], "exit");
    const late = r.buckets.find((b) => b.grade === "late")!;
    expect(late.leftOnTableR).toBeCloseTo(3, 10);
  });

  it("prices an early exit as R the move went on to offer", () => {
    const r = axisReport([trade({ exitGrade: "early", exitPrice: 110, mfe: 150 })], "exit");
    const early = r.buckets.find((b) => b.grade === "early")!;
    expect(early.leftOnTableR).toBeCloseTo(4, 10); // 5R best reach − 1R kept
  });

  it("never counts a negative give-back as a cost", () => {
    // Exit above the recorded best reach can only be a logging slip; it must
    // not appear as a credit that quietly offsets a real leak elsewhere.
    const r = axisReport([trade({ exitGrade: "late", mfe: 110 })], "exit");
    expect(r.buckets.find((b) => b.grade === "late")!.leftOnTableR).toBe(0);
  });

  it("prices a stop called too tight by what the untouched plan would have paid", () => {
    const t = trade({
      stopGrade: "tight",
      exitPrice: 90, // stopped out, −1R
      exitReason: "stop",
      noManagementOutcome: "target_first", // ...and then it went to the target
    });
    const tight = axisReport([t], "stop").buckets.find((b) => b.grade === "tight")!;
    expect(tight.missedPlanR).toBeCloseTo(4, 10); // +3R planned vs −1R taken
  });

  it("leaves the plan-gap at zero when the untouched outcome was never recorded", () => {
    const tight = axisReport([trade({ stopGrade: "tight", exitPrice: 90 })], "stop").buckets.find(
      (b) => b.grade === "tight",
    )!;
    expect(tight.missedPlanR).toBe(0);
  });
});

describe("early vs late, side by side", () => {
  const trades = [
    // One early exit that left 4R behind.
    trade({ id: 1, exitGrade: "early", exitPrice: 110, mfe: 150 }),
    // Two late exits that gave back 1R each.
    trade({ id: 2, exitGrade: "late", exitPrice: 120, mfe: 130 }),
    trade({ id: 3, exitGrade: "late", exitPrice: 120, mfe: 130 }),
  ];

  it("adds each side up separately", () => {
    const c = exitCost(trades);
    expect(c.earlyR).toBeCloseTo(4, 10);
    expect(c.lateR).toBeCloseTo(2, 10);
    expect(c.earlyCount).toBe(1);
    expect(c.lateCount).toBe(2);
  });

  it("names the expensive habit rather than the frequent one", () => {
    // Late happens twice as often; early costs twice as much. The verdict
    // follows the money, which is the entire reason the card exists.
    expect(exitCost(trades).worse).toBe("early");
  });

  it("calls it neither way when the two are within a rounding error", () => {
    expect(
      exitCost([
        trade({ id: 1, exitGrade: "early", exitPrice: 120, mfe: 130 }),
        trade({ id: 2, exitGrade: "late", exitPrice: 120, mfe: 130 }),
      ]).worse,
    ).toBeNull();
  });
});

describe("the lean", () => {
  const many = (n: number, over: Record<string, unknown>) =>
    Array.from({ length: n }, (_, i) => trade({ id: i + 1, ...over }));

  it("stays quiet below the sample floor", () => {
    expect(axisReport(many(4, { exitGrade: "late" }), "exit").lean).toBeNull();
  });

  it("names the miss you make most once there is enough of it", () => {
    const r = axisReport(
      [...many(6, { exitGrade: "late" }), ...many(2, { exitGrade: "perfect" })],
      "exit",
    );
    expect(r.lean?.grade).toBe("late");
  });

  it("never calls doing it right a lean", () => {
    expect(axisReport(many(8, { exitGrade: "perfect" }), "exit").lean).toBeNull();
  });

  it("stays quiet when the misses are split evenly", () => {
    const r = axisReport(
      [...many(3, { exitGrade: "late" }), ...many(3, { exitGrade: "early" }).map((t, i) => ({ ...t, id: i + 10 }))],
      "exit",
    );
    expect(r.lean).toBeNull(); // 50/50 between two directions is not a habit
  });
});

describe("overriding the plan", () => {
  it("counts an exit as an override only when the plan didn't finish it", () => {
    expect(overrodeThePlan(trade({ exitReason: "target" }))).toBe(false);
    expect(overrodeThePlan(trade({ exitReason: "stop" }))).toBe(false);
    expect(overrodeThePlan(trade({ exitReason: "trailed" }))).toBe(true);
    expect(overrodeThePlan(trade({ exitReason: "discretion" }))).toBe(true);
    // Unlabelled is not assumed either way — guessing from the exit price is
    // how a statistic turns into a story.
    expect(overrodeThePlan(trade({ exitReason: null }))).toBe(false);
    expect(overrodeThePlan(trade({ exitReason: "discretion", status: "open", exitPrice: null }))).toBe(
      false,
    );
  });

  it("scores the override against what the untouched trade would have done", () => {
    const r = overrideReport([
      // Out at +2R by hand; left alone it would have hit target for +3R.
      trade({ id: 1, exitReason: "discretion", noManagementOutcome: "target_first" }),
      // Out at +2R by hand; left alone it would have stopped out for −1R.
      trade({ id: 2, exitReason: "discretion", noManagementOutcome: "stop_first" }),
    ]);
    expect(r.count).toBe(2);
    expect(r.judged).toBe(2);
    expect(r.ahead).toBe(1);
    expect(r.netR).toBeCloseTo(-1 + 3, 10); // −1R then +3R
  });

  it("reports the ones it cannot judge instead of dropping them silently", () => {
    const r = overrideReport([
      trade({ id: 1, exitReason: "discretion" }),
      trade({ id: 2, exitReason: "trailed" }),
    ]);
    expect(r.count).toBe(2);
    expect(r.judged).toBe(0);
    expect(r.verdict).toContain("none of them record");
  });

  it("says so plainly when discretion is paying", () => {
    const r = overrideReport([
      trade({ id: 1, exitReason: "discretion", noManagementOutcome: "stop_first" }),
    ]);
    expect(r.netR).toBeCloseTo(3, 10);
    expect(r.verdict).toContain("paid");
  });

  it("says so plainly when it is not", () => {
    const r = overrideReport([
      trade({
        id: 1,
        exitReason: "discretion",
        exitPrice: 95, // −0.5R by hand...
        noManagementOutcome: "target_first", // ...where the plan paid +3R
      }),
    ]);
    expect(r.netR).toBeCloseTo(-3.5, 10);
    expect(r.verdict).toContain("cost");
  });
});

describe("coverage", () => {
  it("counts a trade as graded when any one axis is filled in", () => {
    const r = executionReport([
      trade({ id: 1, entryGrade: "perfect" }),
      trade({ id: 2, stopGrade: "wide" }),
      trade({ id: 3 }),
    ]);
    expect(r.closed).toBe(3);
    expect(r.graded).toBe(2);
  });
});
