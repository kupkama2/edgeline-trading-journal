import { describe, expect, it } from "vitest";
import { exclusiveVerdict } from "../shared/well-traded";

describe("one answer about the execution", () => {
  it("lets traded well rule out traded poorly and tilt", () => {
    expect(exclusiveVerdict({ wellTraded: true })).toEqual({ wellTraded: true, tilt: false, tradedPoorly: false });
  });
  it("lets traded poorly and tilt rule out traded well, and stand together", () => {
    expect(exclusiveVerdict({ tradedPoorly: true })).toEqual({ tradedPoorly: true, wellTraded: false });
    expect(exclusiveVerdict({ tilt: true })).toEqual({ tilt: true, wellTraded: false });
    expect(exclusiveVerdict({ tilt: true, tradedPoorly: true })).toEqual({ tilt: true, tradedPoorly: true, wellTraded: false });
  });
  it("leaves a patch about neither alone", () => {
    expect(exclusiveVerdict({ notes: "x" } as any)).toEqual({ notes: "x" });
  });
});
