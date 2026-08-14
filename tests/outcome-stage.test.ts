import { describe, expect, it } from "vitest";
import { outcomeStage, statusAfterEdit } from "../client/src/components/trade-outcome";

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
 * Closing is editing now, so the editor has to close.
 *
 * This shipped broken for exactly one browser run: the editor saved an exit
 * price, a reason, MFE, fees and an exit grade onto a trade that stayed
 * "open" — every number right, the trade still in the open list, and invisible
 * to every closed-trade statistic. The close dialog used to set the status;
 * deleting it took that with it, and nothing typed complained.
 */
describe("the status an edit leaves behind", () => {
  it("closes an open trade once it has an exit", () => {
    expect(statusAfterEdit("open", "124")).toBe("closed");
  });

  it("closes a pending order that turns out to have filled and finished", () => {
    expect(statusAfterEdit("pending", "124")).toBe("closed");
  });

  it("leaves a pending order pending while it has no exit", () => {
    expect(statusAfterEdit("pending", "")).toBe("pending");
    expect(statusAfterEdit("pending", "   ")).toBe("pending");
  });

  it("leaves an open trade open while it has no exit", () => {
    expect(statusAfterEdit("open", "")).toBe("open");
  });

  it("reopens a closed trade whose exit was cleared", () => {
    // "Closed with no exit price" is not a state the metrics can read, so it
    // must not be reachable by deleting one field and saving.
    expect(statusAfterEdit("closed", "")).toBe("open");
  });

  it("keeps a closed trade closed when the exit is merely corrected", () => {
    expect(statusAfterEdit("closed", "131")).toBe("closed");
  });

  it("never returns closed without an exit price", () => {
    for (const cur of ["pending", "open", "closed"]) {
      for (const price of ["", "  ", "abc"]) {
        expect(statusAfterEdit(cur, price)).not.toBe("closed");
      }
    }
  });
});
