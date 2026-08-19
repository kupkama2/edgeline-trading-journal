import { describe, expect, it } from "vitest";
import { reviewStyle } from "../shared/coach";

/**
 * A finding is a door into its own evidence.
 *
 * "3 exits ran on after you left" is only reviewable if those three trades
 * are one click away, so each finding carries the ids the figure was computed
 * FROM — and exactly those, because padding the list with innocent trades
 * would send the review to the wrong charts.
 */
const base = {
  direction: "long" as const,
  size: 1,
  sizeUnit: "base" as const,
  pointValue: 1,
  entryPrice: 100,
  initialStop: 90, // 1R = 10
  initialTarget: 130,
  status: "closed" as const,
  styleId: 1,
  mistakeTagIds: [] as number[],
  fills: [] as any[],
  imageCount: 0,
  rationale: "setup",
};
const at = (day: number) => `2026-08-${String(day).padStart(2, "0")}T10:00:00Z`;

it("the early-exit finding lists exactly the trades that ran on, newest first", () => {
  const trades = [
    // Three early exits — the evidence.
    { ...base, id: 1, symbol: "A", entryTime: at(1), exitTime: at(1), exitPrice: 112, postExitPeak: 125 },
    { ...base, id: 2, symbol: "B", entryTime: at(2), exitTime: at(2), exitPrice: 110, postExitPeak: 118 },
    { ...base, id: 3, symbol: "C", entryTime: at(3), exitTime: at(3), exitPrice: 111, postExitPeak: 130 },
    // Innocent bystanders: one died on cue, one unmeasured. MIN_STYLE=8 needs bulk.
    { ...base, id: 4, symbol: "D", entryTime: at(4), exitTime: at(4), exitPrice: 112, postExitPeak: 112 },
    { ...base, id: 5, symbol: "E", entryTime: at(5), exitTime: at(5), exitPrice: 112 },
    { ...base, id: 6, symbol: "F", entryTime: at(6), exitTime: at(6), exitPrice: 108 },
    { ...base, id: 7, symbol: "G", entryTime: at(7), exitTime: at(7), exitPrice: 109 },
    { ...base, id: 8, symbol: "H", entryTime: at(8), exitTime: at(8), exitPrice: 113 },
  ] as any[];

  const review = reviewStyle(trades, [], 1, "Test book");
  const f = review.findings.find((x) => x.id.startsWith("early-exits:"));
  expect(f).toBeDefined();
  expect(f!.tradeIds).toEqual([3, 2, 1]); // newest first, bystanders excluded
});

it("the demon finding lists the trades carrying that demon", () => {
  const tag = { id: 7, name: "FOMO Entry", color: "red", sortOrder: 0 } as any;
  const carriers = [1, 3, 5];
  const trades = Array.from({ length: 9 }, (_, i) => ({
    ...base,
    id: i + 1,
    symbol: `S${i}`,
    entryTime: at(i + 1),
    exitTime: at(i + 1),
    exitPrice: carriers.includes(i + 1) ? 85 : 112, // demon trades lose
    mistakeTagIds: carriers.includes(i + 1) ? [7] : [],
  })) as any[];

  const review = reviewStyle(trades, [tag], 1, "Test book");
  const f = review.findings.find((x) => x.id.startsWith("demon:"));
  expect(f).toBeDefined();
  expect([...f!.tradeIds!].sort((a, b) => a - b)).toEqual(carriers);
});
