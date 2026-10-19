import { describe, expect, it } from "vitest";
import { oneRTarget, targetFields, wantsDefaultTarget } from "../shared/default-target";

/** A target of 1R when none was given, on the rows that prompted it. */
describe("the 1R default", () => {
  it("mirrors the stop across the entry, at the price's own precision", () => {
    expect(oneRTarget({ direction: "long", entryPrice: 1137.29, initialStop: 1068.14 })).toBe(1206.44);
    expect(oneRTarget({ direction: "long", entryPrice: 0.4408999, initialStop: 0.3943 })).toBe(0.4874998);
    expect(oneRTarget({ direction: "short", entryPrice: 100, initialStop: 110 })).toBe(90);
  });

  it("is nothing without a stop, or with a stop on the wrong side", () => {
    expect(oneRTarget({ direction: "long", entryPrice: 100, initialStop: null })).toBeNull();
    expect(oneRTarget({ direction: "long", entryPrice: 100, initialStop: 105 })).toBeNull();
    expect(oneRTarget({ direction: "short", entryPrice: 100, initialStop: 100 })).toBeNull();
    // A short whose 1R would go below zero has no default.
    expect(oneRTarget({ direction: "short", entryPrice: 1, initialStop: 3 })).toBeNull();
  });

  it("is for live trades with a stop and no target — never a scalp or a cancelled one", () => {
    expect(wantsDefaultTarget({ status: "pending", initialStop: 90, initialTarget: null })).toBe(true);
    expect(wantsDefaultTarget({ status: "cancelled", initialStop: 90, initialTarget: null })).toBe(false);
    expect(wantsDefaultTarget({ status: "closed", scalp: true, initialStop: 90, initialTarget: null })).toBe(false);
    expect(wantsDefaultTarget({ status: "open", initialStop: 90, initialTarget: 130 })).toBe(false);
  });
});

describe("what a write carries", () => {
  const live = { status: "open", direction: "long", entryPrice: 100, initialStop: 90 };

  it("fills a default and marks it", () => {
    expect(targetFields({ ...live, initialTarget: null })).toEqual({ initialTarget: 110, targetSource: "default" });
  });

  it("lets a typed target replace the default and clears the mark", () => {
    expect(targetFields({ ...live, initialTarget: 130, targetSource: "default" }, { initialTarget: 130 })).toEqual({ targetSource: null });
  });

  it("moves a default with the stop", () => {
    expect(targetFields({ ...live, initialStop: 95, initialTarget: 110, targetSource: "default" }, { initialStop: 95 })).toEqual({
      initialTarget: 105,
      targetSource: "default",
    });
  });

  it("leaves a typed target alone when the stop moves", () => {
    expect(targetFields({ ...live, initialStop: 95, initialTarget: 130, targetSource: null }, { initialStop: 95 })).toEqual({});
  });

  it("takes a default back when the stop it mirrored is cleared", () => {
    expect(targetFields({ ...live, initialStop: null, initialTarget: 110, targetSource: "default" }, { initialStop: null })).toEqual({
      initialTarget: null,
      targetSource: null,
    });
  });
});
