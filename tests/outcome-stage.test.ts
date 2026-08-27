import { describe, expect, it } from "vitest";
import { outcomeStage, pathQuestions, resolveLifecycle } from "../client/src/components/trade-outcome";

/**
 * The rule that decides what a trade is asked.
 *
 * It shipped wrong once in exactly the way an untested rule does: the entry
 * card gated the outcome questions behind "already closed" and the editor
 * rendered them unconditionally, so opening a LIVE trade to fix its stop also
 * asked you to grade an exit that had not happened and offered demons for a
 * trade with no outcome. One rule living in one of two places is no rule.
 *
 * Now both surfaces call this, so a change here changes both or neither.
 */
describe("what an unfinished trade gets asked", () => {
  it("asks nothing about the outcome before there is one", () => {
    expect(outcomeStage("", null)).toEqual({ priced: false, explained: false });
    expect(outcomeStage("   ", null)).toEqual({ priced: false, explained: false });
  });

  it("does not treat a half-typed price as an exit", () => {
    // The state of the field mid-keystroke: a minus sign, a lone dot.
    for (const partial of ["-", ".", "-.", "abc"]) {
      expect(outcomeStage(partial, null).priced).toBe(false);
    }
  });

  it("opens the facts once there is a price", () => {
    expect(outcomeStage("5030", null)).toEqual({ priced: true, explained: false });
  });

  it("treats zero as a real price, not a missing one", () => {
    // A spread or a fully-hedged close can settle at 0, and !0 is true — the
    // obvious truthiness check would silently refuse to close that trade.
    expect(outcomeStage("0", "target").priced).toBe(true);
  });

  it("accepts a negative exit, because some instruments print one", () => {
    expect(outcomeStage("-12.5", null).priced).toBe(true);
  });

  it("opens the judgements only once the facts are there", () => {
    // A reason with no price is not enough: "was that exit late" is not a
    // question until there is an exit.
    expect(outcomeStage("", "target")).toEqual({ priced: false, explained: false });
    expect(outcomeStage("5030", "target")).toEqual({ priced: true, explained: true });
  });

  it("never claims explained without priced", () => {
    for (const price of ["", "  ", "x", "5030", "0"]) {
      for (const reason of [null, "target", "stop"]) {
        const s = outcomeStage(price, reason);
        if (s.explained) expect(s.priced).toBe(true);
      }
    }
  });
});

/**
 * Waiting to fill -> open -> closed, and back again.
 *
 * This shipped broken for exactly one browser run: the editor saved an exit
 * price, a reason, MFE, fees and an exit grade onto a trade that stayed
 * "open" — every number right, the trade still in the open list, and invisible
 * to every closed-trade statistic. The close dialog used to set the status;
 * deleting it took that with it, and nothing typed complained.
 *
 * The fix is not to infer the state from the exit price but to ask for it, and
 * then refuse to save a picked state and an exit price that contradict each
 * other. There are exactly two contradictions and both produce a row the app
 * cannot read, so neither may be reachable by pressing Save.
 */
const ok = (r: ReturnType<typeof resolveLifecycle>) => ("status" in r ? r.status : `ERROR: ${r.error}`);

describe("reconciling the picked state with the exit price", () => {
  it("closes a trade that has an exit price", () => {
    expect(ok(resolveLifecycle("closed", "124"))).toBe("closed");
  });

  it("keeps a live trade open, and a resting order pending", () => {
    expect(ok(resolveLifecycle("open", ""))).toBe("open");
    expect(ok(resolveLifecycle("pending", "   "))).toBe("pending");
  });

  it("refuses closed with nothing to close it at", () => {
    // "Closed with no exit price" computes nothing: no R, no P&L, no row in
    // any statistic. It has to be unreachable rather than merely unlikely.
    const r = resolveLifecycle("closed", "");
    expect("error" in r).toBe(true);
    expect(ok(r)).toMatch(/needs an exit price/);
  });

  it("refuses open with an exit price sitting on it", () => {
    // The original bug, from the other side: an exit recorded on a trade the
    // app still calls open. Every number right, counted nowhere.
    expect("error" in resolveLifecycle("open", "124")).toBe(true);
    expect(ok(resolveLifecycle("pending", "124"))).toMatch(/Clear the exit price/);
  });

  it("names the state you picked, so the fix is obvious", () => {
    expect(ok(resolveLifecycle("pending", "124"))).toMatch(/waiting to fill/);
    expect(ok(resolveLifecycle("open", "124"))).toMatch(/open/);
  });

  it("never returns closed without a usable exit price", () => {
    for (const price of ["", "  ", "abc"]) {
      expect(ok(resolveLifecycle("closed", price))).not.toBe("closed");
    }
  });

  it("treats an exit of exactly zero as a real exit", () => {
    // A spread or an option can settle at 0. Falsy-checking the number is how
    // that trade silently reopens itself.
    expect(ok(resolveLifecycle("closed", "0"))).toBe("closed");
    expect("error" in resolveLifecycle("open", "0")).toBe(true);
  });
});

describe("what a running trade gets asked about its path", () => {
  /*
   * The two halves of "what price did" become knowable at different moments,
   * and gating both on the exit price is what put the Best reach field on the
   * read-only view and nowhere in the editor: an open position had a figure
   * you could see and no box to type it into.
   */
  it("asks a live position how far it has gone", () => {
    expect(pathQuestions("", true)).toEqual({ held: true, after: false });
  });

  it("does not ask a live position what happened after an exit it has not had", () => {
    expect(pathQuestions("", true).after).toBe(false);
    expect(pathQuestions("   ", true).after).toBe(false);
  });

  it("asks a closed trade both halves", () => {
    expect(pathQuestions("112", false)).toEqual({ held: true, after: true });
  });

  it("asks a trade that never filled neither", () => {
    expect(pathQuestions("", false)).toEqual({ held: false, after: false });
  });

  it("follows the exit price, not the flag, once one is typed", () => {
    // Typing an exit into a trade still marked open is how closing works;
    // the questions have to follow the price rather than wait for the state.
    expect(pathQuestions("112", true)).toEqual({ held: true, after: true });
  });
});
