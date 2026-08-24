import { describe, expect, it } from "vitest";
import { aftermathGaps, impliedOutcome, owedAftermath } from "../shared/aftermath";
import { trade } from "./helpers";

/** Long from 100, stop 90, target 130 — 1R is 10 points. */
const t = (over: Record<string, unknown> = {}) =>
  trade({
    id: 1,
    entryPrice: 100,
    initialStop: 90,
    initialTarget: 130,
    status: "closed",
    exitPrice: 112,
    exitReason: "discretion",
    ...over,
  } as any);

describe("did the plan resolve itself", () => {
  it("reads a fill at the stop as the stop going first", () => {
    expect(impliedOutcome(t({ exitPrice: 90 }))).toBe("stop_first");
  });

  it("allows for slipping through the level", () => {
    // Stops fill past the level, not on it. Calling 89.5 "not the stop" would
    // ask the trader to look up something the row already proves.
    expect(impliedOutcome(t({ exitPrice: 89.5 }))).toBe("stop_first");
  });

  it("reads a fill at the target the same way", () => {
    expect(impliedOutcome(t({ exitPrice: 130 }))).toBe("target_first");
    expect(impliedOutcome(t({ exitPrice: 130.5 }))).toBe("target_first");
  });

  it("says nothing about an exit between the two", () => {
    expect(impliedOutcome(t({ exitPrice: 112 }))).toBeNull();
  });

  it("works for a short, where the stop is above", () => {
    const short = t({ direction: "short", entryPrice: 100, initialStop: 110, initialTarget: 70 });
    expect(impliedOutcome({ ...short, exitPrice: 110 } as any)).toBe("stop_first");
    expect(impliedOutcome({ ...short, exitPrice: 70 } as any)).toBe("target_first");
    expect(impliedOutcome({ ...short, exitPrice: 88 } as any)).toBeNull();
  });

  it("does not trust the exit reason on its own", () => {
    // A stop MOVED to breakeven still closes as "stopped out". Reading that as
    // "the untouched plan hit its stop" would write a false answer into the
    // one field this whole module exists to protect.
    expect(impliedOutcome(t({ exitReason: "stop", exitPrice: 100 }))).toBeNull();
  });
});

describe("what a closed trade still owes", () => {
  it("asks a hand-closed trade what would have happened", () => {
    const g = aftermathGaps(t())!;
    expect(g.cutShort).toBe(true);
    expect(g.gaps).toContain("outcome");
  });

  it("does not ask a trade that ran to its own stop", () => {
    // The market answered it. A permanent amber flag over a question with a
    // known answer is how a signal gets taught to be ignored.
    const g = aftermathGaps(t({ exitReason: "stop", exitPrice: 90 }))!;
    expect(g.cutShort).toBe(false);
    expect(g.gaps).not.toContain("outcome");
  });

  it("still wants the aftermath from a stop-out", () => {
    // "Was my stop too tight" is only answerable from these two.
    expect(aftermathGaps(t({ exitReason: "stop", exitPrice: 90 }))!.gaps).toEqual([
      "runOn",
      "worse",
      "path",
    ]);
  });

  it("is satisfied by a fully filled-in trade", () => {
    const done = t({ noManagementOutcome: "target_first", postExitPeak: 140, postExitAdverse: 95, mfe: 126, mae: 96 });
    expect(aftermathGaps(done)!.gaps).toEqual([]);
  });

  it("counts the path as recorded if either leg is", () => {
    // MAE alone is a measured trade. Demanding both would leave a flag on a
    // row that has nothing more to give.
    expect(aftermathGaps(t({ mae: 96 }))!.gaps).not.toContain("path");
    expect(aftermathGaps(t({ mfe: 126 }))!.gaps).not.toContain("path");
  });

  it("has no opinion about a trade that is still running", () => {
    expect(aftermathGaps(t({ status: "open", exitPrice: null }))).toBeNull();
    expect(aftermathGaps(t({ status: "pending", exitPrice: null }))).toBeNull();
    expect(aftermathGaps(t({ status: "cancelled", exitPrice: null }))).toBeNull();
  });
});

describe("the worklist", () => {
  it("leaves out the trades that owe nothing", () => {
    const done = t({ id: 1, noManagementOutcome: "stop_first", postExitPeak: 1, postExitAdverse: 1, mae: 96 });
    expect(owedAftermath([done])).toHaveLength(0);
  });

  it("puts the unanswered hand-close above a stop-out missing more fields", () => {
    // Three blanks on a resolved trade is tidying. One blank that makes the
    // trade uncomparable against leaving it alone is the actual hole.
    const handClose = t({ id: 1, postExitPeak: 140, postExitAdverse: 95, mae: 96 }); // only "outcome"
    const stopOut = t({ id: 2, exitReason: "stop", exitPrice: 90 }); // three, none of them outcome
    expect(owedAftermath([stopOut, handClose]).map((o) => o.trade.id)).toEqual([1, 2]);
  });

  it("breaks ties toward the trade you can still remember", () => {
    const older = t({ id: 1, exitTime: "2026-08-01T10:00:00Z" });
    const newer = t({ id: 2, exitTime: "2026-08-09T10:00:00Z" });
    expect(owedAftermath([older, newer]).map((o) => o.trade.id)).toEqual([2, 1]);
  });

  it("reports which gaps each trade has, not just that it has some", () => {
    const [only] = owedAftermath([t({ postExitPeak: 140, mae: 96 })]);
    expect(only.gaps).toEqual(["outcome", "worse"]);
    expect(only.cutShort).toBe(true);
  });
});
