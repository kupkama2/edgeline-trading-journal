import { describe, expect, it } from "vitest";
import { cutAtVenueFlat } from "../shared/terminal";

const f = (tid: number, side: "B" | "A", sz: number, startPosition: number) => ({ tid, time: tid, side, sz, startPosition });

describe("where a position went flat, by the venue's own count", () => {
  it("starts at the first fill that leaves the position on, and ends at the first that takes it flat", () => {
    // The end of an earlier long, then this one: in, a take, out, and the next one in.
    const out = cutAtVenueFlat([f(1, "A", 5, 5), f(2, "B", 10, 0), f(3, "A", 4, 10), f(4, "A", 6, 6), f(5, "B", 3, 0)], true);
    expect(out.cut).toBe(true);
    expect(out.fills.map((x) => x.tid)).toEqual([2, 3, 4]);
  });

  it("knows a position it met already open, though the first fill it sees is a take", () => {
    const out = cutAtVenueFlat([f(1, "A", 20000, 108225.1), f(2, "A", 88225.1, 88225.1), f(3, "B", 56837.5, 0)], true);
    expect(out).toMatchObject({ cut: true });
    expect(out.fills.map((x) => x.tid)).toEqual([1, 2]);
  });

  it("is not fooled by dust on large sizes, and ends a short through zero", () => {
    const big = cutAtVenueFlat([f(1, "B", 0.1 + 0.2, 0), f(2, "A", 0.3, 0.1 + 0.2)], true);
    expect(big.cut).toBe(true);
    const short = cutAtVenueFlat([f(1, "A", 1_234_567.8, 0), f(2, "B", 2_000_000, -1_234_567.8)], false);
    expect(short).toMatchObject({ cut: true });
    expect(short.fills).toHaveLength(2);
    expect(cutAtVenueFlat([f(1, "A", 7, 0)], false)).toMatchObject({ cut: false });
  });
});
