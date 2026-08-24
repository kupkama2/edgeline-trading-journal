import { describe, expect, it } from "vitest";
import { impliedOutcome, outcomeUnknown, owedOutcome } from "../shared/aftermath";
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

describe("did price reach one of the trade's own levels", () => {
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

  it("reads the price, never the label", () => {
    // A stop MOVED to breakeven still closes as "stopped out". Reading the
    // label as "the untouched plan hit its stop" would write a false answer
    // into the one field this module exists to protect — and it is exactly
    // the trade where the question is most worth asking.
    expect(impliedOutcome(t({ exitReason: "stop", exitPrice: 100 }))).toBeNull();
    expect(outcomeUnknown(t({ exitReason: "stop", exitPrice: 100 }))).toBe(true);
  });
});

/**
 * One question, and only one: left completely alone, would price have hit the
 * target or the stop first?
 *
 * The post-exit prices and the MAE/MFE path are worth recording but not worth
 * an alert. A flag that fires on four things at once is a flag nobody reads,
 * and it buried the one question that genuinely needs a chart to answer.
 */
describe("whether the untouched-plan outcome is still unanswered", () => {
  it("asks a trade taken off between the levels", () => {
    expect(outcomeUnknown(t())).toBe(true);
  });

  it("does not ask a trade that ran to its own stop or target", () => {
    // The market answered it. A permanent amber flag over a question with a
    // known answer is how a signal gets taught to be ignored.
    expect(outcomeUnknown(t({ exitPrice: 90 }))).toBe(false);
    expect(outcomeUnknown(t({ exitPrice: 130 }))).toBe(false);
  });

  it("stops asking once it has been answered", () => {
    expect(outcomeUnknown(t({ noManagementOutcome: "target_first" }))).toBe(false);
    expect(outcomeUnknown(t({ noManagementOutcome: "stop_first" }))).toBe(false);
  });

  it("treats UNDETERMINED as an answer, not a blank", () => {
    // You went back, the path wasn't legible, and you said so. A flag that
    // cannot be cleared by looking teaches you to stop looking — and the
    // field already distinguishes null (never asked) from undetermined
    // (asked, and the chart didn't say).
    expect(outcomeUnknown(t({ noManagementOutcome: "undetermined" }))).toBe(false);
  });

  it("ignores the fields that are no longer worth an alert", () => {
    // Missing post-exit prices and no MAE/MFE at all: still not a question
    // this asks. Recording them is good; nagging about them is noise.
    const bare = t({
      noManagementOutcome: "undetermined",
      postExitPeak: null,
      postExitAdverse: null,
      mae: null,
      mfe: null,
    });
    expect(outcomeUnknown(bare)).toBe(false);
  });

  it("has no opinion about a trade that is still running", () => {
    expect(outcomeUnknown(t({ status: "open", exitPrice: null }))).toBe(false);
    expect(outcomeUnknown(t({ status: "pending", exitPrice: null }))).toBe(false);
    expect(outcomeUnknown(t({ status: "cancelled", exitPrice: null }))).toBe(false);
  });
});

describe("the worklist", () => {
  it("leaves out everything already answered", () => {
    expect(
      owedOutcome([
        t({ id: 1, noManagementOutcome: "stop_first" }),
        t({ id: 2, noManagementOutcome: "undetermined" }),
        t({ id: 3, exitPrice: 130 }),
      ]),
    ).toHaveLength(0);
  });

  it("puts the trade you can still remember first", () => {
    const older = t({ id: 1, exitTime: "2026-08-01T10:00:00Z" });
    const newer = t({ id: 2, exitTime: "2026-08-09T10:00:00Z" });
    expect(owedOutcome([older, newer]).map((x) => x.id)).toEqual([2, 1]);
  });

  it("does not mutate the list it was handed", () => {
    const list = [t({ id: 1, exitTime: "2026-08-01T10:00:00Z" }), t({ id: 2, exitTime: "2026-08-09T10:00:00Z" })];
    owedOutcome(list);
    expect(list.map((x) => x.id)).toEqual([1, 2]);
  });
});
