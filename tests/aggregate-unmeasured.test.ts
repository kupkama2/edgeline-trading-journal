import { describe, expect, it } from "vitest";
import { aggregate } from "../shared/metrics";
import { trade } from "./helpers";

/**
 * The headline figures on the dashboard, with a trade that has money but
 * no R in the mix — which a venue's fills can now produce. Money is money
 * and stays in; R needs a stop, so the trade is out of every R figure and
 * counted as left out rather than folded in as a 0R loss.
 */
describe("aggregate stats with a closed trade that has no stop", () => {
  const trades = [
    trade({ id: 1, exitPrice: 110 }), // +1R, +$10
    trade({ id: 2, exitPrice: 90 }), // −1R, −$10
    trade({ id: 3, initialStop: null, exitPrice: 130 }), // +$30, no R
  ];
  const a = aggregate(trades);

  it("keeps the count of closed trades and says how many have no R", () => {
    expect(a.count).toBe(3);
    expect(a.measured).toBe(2);
    expect(a.unmeasured).toBe(1);
  });

  it("measures the win rate over the trades that have an R", () => {
    expect(a.wins).toBe(1);
    expect(a.losses).toBe(1);
    expect(a.winRate).toBeCloseTo(0.5);
    expect(a.expectancyR).toBeCloseTo(0);
    expect(a.avgWinnerR).toBeCloseTo(1);
    expect(a.avgLoserR).toBeCloseTo(-1);
  });

  it("keeps the money of every closed trade", () => {
    expect(a.totalPnL).toBeCloseTo(30);
    expect(a.profitFactor).toBeCloseTo(40 / 10);
    // The per-trade dollar averages split on R, so the stop-less trade is in neither.
    expect(a.avgWinnerPnL).toBeCloseTo(10);
    expect(a.avgLoserPnL).toBeCloseTo(-10);
  });

  it("nets a recorded fee before any of it", () => {
    const b = aggregate([trade({ id: 1, exitPrice: 100.2, fees: 5 })]);
    expect(b.wins).toBe(0);
    expect(b.losses).toBe(1);
    expect(b.totalPnL).toBeCloseTo(-4.8);
  });
});
