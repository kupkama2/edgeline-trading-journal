import { describe, expect, it } from "vitest";
import { insertTradeSchema, missingRisk, needsRisk } from "../shared/schema";

/**
 * Which statuses owe a stop and a target.
 *
 * 1R is entry-to-stop, so a LIVE trade without one poisons every R-based
 * number in the app. A resting order and a cancelled one are different: one is
 * a plan, the other never became a position, and neither has an R to poison.
 *
 * This has a test of its own because the rule was written twice — once as a
 * schema refinement, once by hand on the PATCH route — and the two drifted.
 * The route's copy excluded only "pending", which made cancelling an order
 * that never had a stop impossible: every button on the "didn't become a
 * position" dialog came back 400, and because the dialog swallowed the error
 * it looked like a button that simply did nothing.
 */
describe("when a trade owes a stop and a target", () => {
  it("wants them once the trade is live", () => {
    expect(needsRisk("open")).toBe(true);
    expect(needsRisk("closed")).toBe(true);
    // Absent means open: the insert schema's own default.
    expect(needsRisk(undefined)).toBe(true);
    expect(needsRisk(null)).toBe(true);
  });

  it("does not want them from a plan or from something that never ran", () => {
    expect(needsRisk("pending")).toBe(false);
    // The one that broke. A resting order usually has no stop recorded yet,
    // and cancelling it is the ONLY thing you can do with an order that never
    // filled — so demanding risk levels here forbids the normal case.
    expect(needsRisk("cancelled")).toBe(false);
  });

  it("names exactly what is absent, and nothing when the status excuses it", () => {
    expect(missingRisk({ status: "open", initialStop: 90, initialTarget: null })).toEqual([
      "initialTarget",
    ]);
    expect(missingRisk({ status: "open" })).toEqual(["initialStop", "initialTarget"]);
    expect(missingRisk({ status: "cancelled" })).toEqual([]);
    expect(missingRisk({ status: "pending" })).toEqual([]);
  });

  it("is the same rule the insert schema enforces", () => {
    // Not two implementations agreeing today — one implementation, used twice.
    const order = {
      symbol: "BTC",
      direction: "long" as const,
      size: 1,
      entryPrice: 100,
      entryTime: "2026-08-24T08:00:00.000Z",
    };
    expect(insertTradeSchema.safeParse({ ...order, status: "cancelled" }).success).toBe(true);
    expect(insertTradeSchema.safeParse({ ...order, status: "pending" }).success).toBe(true);
    expect(insertTradeSchema.safeParse({ ...order, status: "open" }).success).toBe(false);
  });
});
