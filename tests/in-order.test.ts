import { describe, expect, it } from "vitest";
import { inTradeOrder } from "../client/src/lib/in-order";

const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("saves to one trade", () => {
  it("land in the order they were asked for, however long each takes", async () => {
    const landed: string[] = [];
    const slow = inTradeOrder(1, async () => (await later(30), landed.push("gone over")));
    const fast = inTradeOrder(1, async () => (await later(1), landed.push("traded well")));
    await Promise.all([slow, fast]);
    expect(landed).toEqual(["gone over", "traded well"]);
  });

  it("do not wait for another trade's, and carry on after one that failed", async () => {
    const landed: string[] = [];
    const held = inTradeOrder(1, async () => (await later(40), landed.push("trade 1")));
    await inTradeOrder(2, async () => landed.push("trade 2"));
    expect(landed).toEqual(["trade 2"]);
    await held;
    const failed = inTradeOrder(3, async () => {
      throw new Error("refused");
    });
    const next = inTradeOrder(3, async () => "saved");
    await expect(failed).rejects.toThrow("refused");
    await expect(next).resolves.toBe("saved");
  });
});
