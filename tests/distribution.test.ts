import { describe, expect, it } from "vitest";
import { describeShape, rDistribution } from "../shared/distribution";
import { trade } from "./helpers";

/** A closed trade worth exactly `r` R (stop distance is 10, entry 100). */
const at = (r: number) => trade({ exitPrice: 100 + 10 * r });

describe("rDistribution", () => {
  it("returns null with nothing closed", () => {
    expect(rDistribution([])).toBeNull();
    expect(rDistribution([trade({ status: "open", exitPrice: null })])).toBeNull();
  });

  it("puts a bin boundary exactly at zero, so no bar straddles win and loss", () => {
    const d = rDistribution([at(-1), at(-0.4), at(0.4), at(2)])!;
    for (const b of d.bins) {
      expect(b.from < 0 && b.to > 0).toBe(false);
    }
    // Every bin edge is a multiple of the width.
    for (const b of d.bins) {
      expect(Math.abs(b.from / d.binSize - Math.round(b.from / d.binSize))).toBeLessThan(1e-9);
    }
  });

  it("counts every trade exactly once, including the very best one", () => {
    const rs = [-1, -1, -0.5, 0.5, 1, 1, 2, 3.5];
    const d = rDistribution(rs.map(at))!;
    expect(d.bins.reduce((a, b) => a + b.count, 0)).toBe(rs.length);
    expect(d.count).toBe(rs.length);
    expect(d.bestR).toBeCloseTo(3.5);
    expect(d.worstR).toBeCloseTo(-1);
  });

  it("widens the bins rather than drawing dozens of them", () => {
    const narrow = rDistribution([at(-1), at(1)])!;
    const wide = rDistribution([at(-20), at(30)])!;
    expect(narrow.binSize).toBeLessThan(wide.binSize);
    expect(wide.bins.length).toBeLessThanOrEqual(16);
  });

  it("reports median and mean separately — the whole point of the chart", () => {
    // Eight scratches and one monster: mean positive, median negative.
    const d = rDistribution([...Array(8).fill(0).map(() => at(-1)), at(20)])!;
    expect(d.medianR).toBeLessThan(0);
    expect(d.meanR).toBeGreaterThan(0);
  });

  it("measures how much of the winnings ride on the best trades", () => {
    const d = rDistribution([at(-1), at(1), at(1), at(18)])!;
    expect(d.topWinShare).toBeCloseTo(18 / 20);
    expect(d.top10PctShare).toBeCloseTo(18 / 20); // top 10% of 3 winners = 1
  });

  it("has no winners to apportion when everything lost", () => {
    const d = rDistribution([at(-1), at(-1)])!;
    expect(d.topWinShare).toBe(0);
    expect(d.top10PctShare).toBe(0);
  });
});

describe("describeShape", () => {
  it("stays quiet on a sample too small to characterise", () => {
    expect(describeShape(rDistribution([at(1), at(-1)])!)).toBeNull();
  });

  it("calls out an edge that lives in one trade", () => {
    const rs = [...Array(14).fill(0).map(() => at(-1)), at(1), at(30)];
    expect(describeShape(rDistribution(rs)!)).toMatch(/tail/i);
  });

  it("calls a broad edge durable", () => {
    const rs = Array.from({ length: 16 }, (_, i) => at(i % 3 === 0 ? -1 : 1.2));
    expect(describeShape(rDistribution(rs)!)).toMatch(/durable/i);
  });
});
