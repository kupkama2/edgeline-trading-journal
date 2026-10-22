import { describe, expect, it } from "vitest";
import { managedBy, splitOpen } from "../shared/managed";
import { trade } from "./helpers";

/* Long 1 unit from 100, stop 90 — the helper's trade, held open. */
const open = (over: Parameters<typeof trade>[0] = {}) =>
  trade({ status: "open", exitPrice: null, exitTime: null, exitReason: null, ...over } as any);
const fill = (kind: "add" | "partial", size: number, price = 110) =>
  ({ id: Math.random(), tradeId: 1, kind, size, price, time: "2026-08-03T09:45:00.000Z", note: null }) as any;

describe("which open trades are managed", () => {
  it("is the one you marked majority out", () => {
    expect(managedBy(open({ managedAt: "2026-10-22T10:00:00.000Z" } as any))).toBe("marked");
  });

  it("is one whose partials leave a third or less", () => {
    expect(managedBy(open({ size: 3, fills: [fill("partial", 2)] }))).toBe("scaled");
    // Half off is not the majority out.
    expect(managedBy(open({ size: 2, fills: [fill("partial", 1)] }))).toBeNull();
  });

  it("counts what was added to the position before asking what is left", () => {
    // 1 on, 2 added, 1 taken: two of three still on.
    expect(managedBy(open({ size: 1, fills: [fill("add", 2, 101), fill("partial", 1)] }))).toBeNull();
  });

  it("is one whose stop is at or through the entry", () => {
    const moved = JSON.stringify([{ at: "2026-08-03T09:50:00.000Z", price: 100 }]);
    expect(managedBy(open({ stopMoves: moved } as any))).toBe("risk-off");
  });

  it("leaves a full position with its stop below the entry to manage", () => {
    expect(managedBy(open())).toBeNull();
  });

  it("is only ever an open trade", () => {
    expect(managedBy(trade({ managedAt: "x" } as any))).toBeNull();
  });

  it("splits the list without dropping or reordering anything", () => {
    const a = open({ id: 1 });
    const b = open({ id: 2, managedAt: "x" } as any);
    const c = open({ id: 3 });
    const s = splitOpen([a, b, c]);
    expect(s.toManage.map((t) => t.id)).toEqual([1, 3]);
    expect(s.managed.map((m) => [m.t.id, m.why])).toEqual([[2, "marked"]]);
  });
});
