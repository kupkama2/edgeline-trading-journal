import { describe, expect, it } from "vitest";
import { trade } from "./helpers";
import { aggregate, computeMetrics, outcomeOf } from "../shared/metrics";
import { summarizeDays } from "../shared/daily";
import { bySymbol } from "../shared/breakdowns";
import { streaks } from "../shared/streaks";
import { missedStats } from "../shared/missed";

/**
 * The rules every statistic shares, pinned where they used to disagree.
 *
 * A scalp is a closed trade with a result and no exit price; it used to
 * fall out of the headline totals while the tilt card counted it. A trade
 * with no stop has no R; it used to count as a 0R loss in the day, the
 * breakdowns and the streaks while the headline left it out. The untouched
 * plan was measured before fees against a result after them. Each of those
 * made two cards on one screen tell different stories about the same trades.
 */
const scalp = (pnl: number, risk: number | null, id: number) =>
  trade({ id, scalp: true, exitPrice: null, entryPrice: 0, size: 0, initialStop: null, initialTarget: null, netPnl: pnl, riskAmount: risk });
const noStop = (id: number, exitPrice = 130) => trade({ id, initialStop: null, exitPrice });

describe("a scalp", () => {
  it("is in the totals, in dollars always and in R when a risk was typed", () => {
    const a = aggregate([scalp(100, 50, 1), scalp(-20, null, 2)]);
    expect(a.count).toBe(2);
    expect(a.totalPnL).toBe(80);
    expect(a.measured).toBe(1);
    expect(a.totalR).toBe(2);
  });

  it("is in its day", () => {
    const day = Array.from(summarizeDays([scalp(100, 50, 1)]).values())[0];
    expect(day).toMatchObject({ closed: 1, wins: 1, losses: 0, totalPnL: 100, totalR: 2 });
  });
});

describe("a trade with no stop", () => {
  const win = trade({ id: 1 }); // +2R
  const unmeasured = noStop(2);

  it("is neither a win nor a loss", () => {
    expect(outcomeOf(computeMetrics(unmeasured))).toBe("unmeasured");
    expect(outcomeOf(computeMetrics(win))).toBe("win");
  });

  it("counts in dollars on its day but not as a loss", () => {
    const day = Array.from(summarizeDays([win, unmeasured]).values())[0];
    expect(day).toMatchObject({ closed: 2, wins: 1, losses: 0, totalR: 2 });
    expect(day.totalPnL).toBe(50);
  });

  it("leaves a breakdown's win rate and expectancy alone", () => {
    const [s] = bySymbol([win, unmeasured]);
    expect(s).toMatchObject({ count: 2, measured: 1, wins: 1, losses: 0, winRate: 1, expectancyR: 2 });
    expect(s.totalPnL).toBe(50);
  });

  it("neither extends a run nor breaks one", () => {
    const later = (id: number, h: number, exitPrice: number, stop: number | null = 90) =>
      trade({ id, initialStop: stop, exitPrice, exitTime: `2026-08-03T1${h}:00:00.000Z` });
    const s = streaks([later(1, 0, 120), later(2, 1, 130, null), later(3, 2, 120)]);
    expect(s).toMatchObject({ longestWin: 2, longestLoss: 0, current: 2 });
  });
});

describe("the untouched plan", () => {
  it("is measured after the same fees as the result, so a trade left alone is not a leak", () => {
    // Entry 100, stop 90 (1R = $10), target 130, left alone to it; $1 of fees.
    const m = computeMetrics(trade({ exitPrice: 130, fees: 1, noManagementOutcome: "target_first" }));
    expect(m.actualR).toBeCloseTo(2.9);
    expect(m.potentialR).toBeCloseTo(2.9);
    expect(m.managementDeltaR).toBeCloseTo(0);
  });

  it("puts a clean stop-out at minus one R minus its fees, the same as the result", () => {
    const m = computeMetrics(trade({ exitPrice: 90, fees: 1, noManagementOutcome: "stop_first" }));
    expect(m.actualR).toBeCloseTo(-1.1);
    expect(m.managementDeltaR).toBeCloseTo(0);
  });
});

describe("a missed trade", () => {
  it("without levels is not a won miss worth nothing", () => {
    const miss = (id: number, over: any) =>
      trade({ id, status: "cancelled", cancelReason: "never_placed", exitPrice: null, wouldHaveHitTarget: true, ...over });
    const s = missedStats([miss(1, {}), miss(2, { initialStop: null })]);
    expect(s.wouldHaveWon).toBe(1);
    expect(s.forgoneR).toBeCloseTo(3);
  });
});

describe("a scalp, elsewhere", () => {
  it("gets an excursion bar from the best and worst it showed", async () => {
    const { excursions } = await import("../shared/excursion");
    const s = { ...scalp(60, 30, 9), netMfe: 90, netMae: -15 } as any;
    const [bar] = excursions([s]);
    expect(bar).toMatchObject({ tradeId: 9, mfeR: 3 });
    expect(bar.maeR).toBeCloseTo(-0.5);
  });
});
