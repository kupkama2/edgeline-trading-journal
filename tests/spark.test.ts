import { describe, expect, it } from "vitest";
import { monotonePath, sampleCubic, type Pt } from "../shared/spark";

const pts = (ys: number[]): Pt[] => ys.map((y, i) => ({ x: i * 10, y }));

describe("the smoothed sparkline", () => {
  it("draws nothing from fewer than two points", () => {
    expect(monotonePath([])).toBe("");
    expect(monotonePath([{ x: 0, y: 5 }])).toBe("");
  });

  it("draws a straight line between exactly two", () => {
    expect(monotonePath(pts([0, 10]))).toBe("M0,0 L10,10");
  });

  it("passes through every point it was given", () => {
    // A curve that misses its own data is decoration, not a chart.
    const p = pts([0, 5, 3, 9, 2]);
    const path = monotonePath(p);
    for (const q of p) expect(path).toContain(`${q.x},${q.y}`);
  });

  it("never invents a low the numbers never reached", () => {
    // The reason this is monotone interpolation and not a plain spline: an
    // equity curve that dips below its true minimum shows a drawdown that
    // never happened, which is the one thing a sparkline must not do.
    const ys = [0, 8, 1, 9, 2, 10];
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    for (const q of sampleCubic(pts(ys), 24)) {
      expect(q.y).toBeGreaterThanOrEqual(lo - 1e-6);
      expect(q.y).toBeLessThanOrEqual(hi + 1e-6);
    }
  });

  it("stays inside each segment, not merely inside the whole series", () => {
    // A rise, a plateau, then a rise: the flat stretch must stay flat rather
    // than bulging on its way to the next high.
    const ys = [0, 5, 5, 5, 20];
    const sampled = sampleCubic(pts(ys), 20);
    const middle = sampled.filter((q) => q.x >= 10 && q.x <= 30);
    for (const q of middle) expect(Math.abs(q.y - 5)).toBeLessThan(1e-6);
  });

  it("keeps a monotone rise monotone", () => {
    const sampled = sampleCubic(pts([0, 1, 3, 6, 10]), 16);
    for (let i = 1; i < sampled.length; i++) {
      expect(sampled[i].y).toBeGreaterThanOrEqual(sampled[i - 1].y - 1e-6);
    }
  });

  it("survives repeated values without dividing by zero", () => {
    const path = monotonePath(pts([4, 4, 4, 4]));
    expect(path).not.toContain("NaN");
    expect(path.startsWith("M0,4")).toBe(true);
  });
});
