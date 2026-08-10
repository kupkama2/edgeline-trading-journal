import { describe, expect, it } from "vitest";
import { SCORE_MIN_SAMPLE, scorecard } from "../shared/scorecard";
import { reviewAll, reviewStyle } from "../shared/coach";
import { localIso, trade } from "./helpers";
import type { MistakeTag } from "../shared/schema";

/** A closed trade worth `r` R. Entry 100, stop 90, so exit = 100 + 10r. */
const at = (r: number, over: Parameters<typeof trade>[0] = {}) =>
  trade({ exitPrice: 100 + 10 * r, ...over });

const many = (n: number, r: number, over: Parameters<typeof trade>[0] = {}) =>
  Array.from({ length: n }, () => at(r, over));

describe("scorecard", () => {
  it("pairs win rate with payoff, because neither means anything alone", () => {
    // 8 wins of +0.2R, 2 losses of −1R: 80% winners, and it loses money.
    const s = scorecard([...many(8, 0.2), ...many(2, -1)]);
    expect(s.winRate).toBeCloseTo(0.8);
    expect(s.payoff).toBeCloseTo(0.2);
    expect(s.expectancyR).toBeCloseTo(-0.04);
  });

  it("withholds a score until there is enough evidence", () => {
    const few = scorecard(many(SCORE_MIN_SAMPLE - 1, 1));
    expect(few.score).toBeNull();
    expect(few.verdict).toMatch(/before these numbers mean anything/);
    expect(scorecard(many(SCORE_MIN_SAMPLE, 1)).score).not.toBeNull();
  });

  it("ranks a steady edge above a lucky one at the same expectancy", () => {
    // Both average +0.5R over 40 trades: one grinds it out with ordinary
    // winners and losers, the other is 39 scratches and one lottery ticket.
    const steady = scorecard([...many(20, 1.5), ...many(20, -0.5)]);
    const lumpy = scorecard([...many(39, -0.25), ...many(1, 29.75)]);
    expect(steady.expectancyR).toBeCloseTo(lumpy.expectancyR, 4);
    const c = (s: typeof steady) => s.parts.find((p) => p.label === "Consistency")!.points;
    expect(c(steady)).toBeGreaterThan(c(lumpy));
    expect(steady.score!).toBeGreaterThan(lumpy.score!);
  });

  it("is unmoved by trading the same edge larger", () => {
    const small = scorecard(many(25, 1));
    const big = scorecard(many(25, 1, { size: 10 }));
    expect(big.score).toBe(small.score);
    expect(big.totalPnL).toBeGreaterThan(small.totalPnL);
  });

  it("treats a flawless run as perfectly consistent, not inconsistent", () => {
    // Degenerate but worth pinning: identical results have zero variance.
    const s = scorecard(many(25, 1));
    expect(s.parts.find((p) => p.label === "Consistency")!.points).toBe(25);
  });

  it("credits a clean log and names the weakest part", () => {
    const sloppy = scorecard(many(25, 0.6));
    const clean = scorecard(many(25, 0.6, { rationale: "vah retest", exitReason: "target" }));
    const d = (s: typeof clean) => s.parts.find((p) => p.label === "Discipline")!.points;
    expect(d(clean)).toBeGreaterThan(d(sloppy));
    expect(sloppy.verdict).toMatch(/logging/i);
  });

  it("builds a cumulative curve in exit order", () => {
    const s = scorecard([
      at(1, { exitTime: localIso(2026, 8, 3, 10) }),
      at(-1, { exitTime: localIso(2026, 8, 2, 10) }),
      at(2, { exitTime: localIso(2026, 8, 4, 10) }),
    ]);
    expect(s.curve).toEqual([-1, 0, 2]);
    expect(s.totalR).toBe(2);
  });
});

const tags: MistakeTag[] = [{ id: 1, name: "Revenge Trade", sortOrder: 0, color: "red" }];

describe("coach", () => {
  it("says nothing about a style with almost no history", () => {
    const r = reviewStyle(many(3, -1, { styleId: 1 }), tags, 1, "Scalps");
    expect(r.findings).toEqual([]);
  });

  it("finds the hour that leaks and prices it in R", () => {
    const good = Array.from({ length: 10 }, (_, i) =>
      at(1, { styleId: 1, entryTime: localIso(2026, 8, 3 + (i % 5), 9) }),
    );
    const bad = Array.from({ length: 5 }, (_, i) =>
      at(-1, { styleId: 1, entryTime: localIso(2026, 8, 3 + (i % 5), 14) }),
    );
    const r = reviewStyle([...good, ...bad], tags, 1, "Scalps");
    const hour = r.findings.find((f) => f.kind === "timing");
    expect(hour).toBeDefined();
    expect(hour!.title).toMatch(/14:00/);
    expect(hour!.costR).toBeCloseTo(5);
  });

  it("prices the demon that keeps showing up", () => {
    const r = reviewStyle(
      [...many(10, 1, { styleId: 1 }), ...many(4, -1, { styleId: 1, mistakeTagIds: [1] })],
      tags,
      1,
      "Scalps",
    );
    const demon = r.findings.find((f) => f.kind === "demon");
    expect(demon!.title).toMatch(/Revenge Trade/);
    expect(demon!.costR).toBeCloseTo(4);
  });

  it("calls out a high win rate that does not pay", () => {
    const r = reviewStyle(
      [...many(8, 0.2, { styleId: 1 }), ...many(4, -1, { styleId: 1 })],
      tags,
      1,
      "Scalps",
    );
    expect(r.findings.some((f) => f.kind === "sizing")).toBe(true);
  });

  it("reviews each style separately and ranks the worst book first", () => {
    const scalps = [...many(10, 1, { styleId: 1 }), ...many(5, -1, { styleId: 1, mistakeTagIds: [1] })];
    const swings = [...many(10, 1, { styleId: 2 }), ...many(3, -1, { styleId: 2, mistakeTagIds: [1] })];
    const out = reviewAll([...scalps, ...swings], tags, [
      { id: 1, name: "Scalps" },
      { id: 2, name: "Swings" },
    ]);
    expect(out.map((r) => r.styleName)).toEqual(["Scalps", "Swings"]);
    // Advice never crosses books: the scalps finding counts scalps trades only.
    const demon = out[0].findings.find((f) => f.kind === "demon")!;
    expect(demon.costR).toBeCloseTo(5);
  });

  it("keeps at most three findings per style, most expensive first", () => {
    const noisy = [
      ...many(10, 1, { styleId: 1, entryTime: localIso(2026, 8, 3, 9) }),
      ...many(5, -1, { styleId: 1, mistakeTagIds: [1], entryTime: localIso(2026, 8, 3, 14) }),
      ...many(4, -0.5, { styleId: 1, entryTime: localIso(2026, 8, 4, 15) }),
    ];
    const r = reviewStyle(noisy, tags, 1, "Scalps");
    expect(r.findings.length).toBeLessThanOrEqual(3);
    const costs = r.findings.map((f) => f.costR);
    expect([...costs].sort((a, b) => b - a)).toEqual(costs);
  });
});
