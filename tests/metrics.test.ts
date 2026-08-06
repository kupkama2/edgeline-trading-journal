import { describe, expect, it } from "vitest";
import {
  aggregate,
  computeMetrics,
  mistakeCostLeaderboard,
} from "../shared/metrics";
import { trade } from "./helpers";

describe("computeMetrics", () => {
  it("prices R off entry-to-stop and P&L off the move", () => {
    const m = computeMetrics(trade()); // entry 100, stop 90, exit 120
    expect(m.risk).toBe(10);
    expect(m.riskDollars).toBe(10);
    expect(m.actualR).toBe(2);
    expect(m.actualPnL).toBe(20);
  });

  it("inverts for shorts", () => {
    const m = computeMetrics(
      trade({ direction: "short", initialStop: 110, exitPrice: 80 }),
    );
    expect(m.actualR).toBe(2);
    expect(m.actualPnL).toBe(20);
  });

  /**
   * The micro-contract regression, encoded. MNQ and NQ roll up to one symbol
   * for grouping but differ tenfold in dollars per point — the same 10-point
   * win on 2 contracts must produce $40 on micros and $400 on e-minis.
   */
  it("scales futures by their contract point value", () => {
    const base = { size: 2, entryPrice: 20000, initialStop: 19990, exitPrice: 20010 };
    const micro = computeMetrics(trade({ ...base, symbol: "NQ", pointValue: 2 }));
    const emini = computeMetrics(trade({ ...base, symbol: "NQ", pointValue: 20 }));
    expect(micro.actualPnL).toBe(40);
    expect(emini.actualPnL).toBe(400);
    // Identical in R — the whole point of the unit.
    expect(micro.actualR).toBe(1);
    expect(emini.actualR).toBe(1);
  });

  it("converts quote-sized crypto to base units before any arithmetic", () => {
    // $5,000 notional at entry 50 holds 100 coins; a 5-point move is $500.
    const m = computeMetrics(
      trade({
        sizeUnit: "quote",
        size: 5000,
        entryPrice: 50,
        initialStop: 45,
        exitPrice: 55,
      }),
    );
    expect(m.riskDollars).toBe(500);
    expect(m.actualPnL).toBe(500);
    expect(m.actualR).toBe(1);
  });

  it("reports unknown rather than fabricating R when there is no stop", () => {
    const m = computeMetrics(trade({ initialStop: null }));
    expect(m.actualR).toBeNull();
    expect(m.riskDollars).toBe(0);
    // P&L needs no stop and must still be there.
    expect(m.actualPnL).toBe(20);
  });

  it("prices the no-management counterfactual", () => {
    const m = computeMetrics(
      trade({ noManagementOutcome: "target_first", exitPrice: 110 }),
    );
    expect(m.potentialR).toBe(3); // target 130 = 30 points / 10
    expect(m.actualR).toBe(1);
    expect(m.managementDeltaR).toBe(-2); // management cost 2R
  });
});

describe("aggregate", () => {
  it("summarises only closed trades and keeps wins/losses honest", () => {
    const a = aggregate([
      trade({ exitPrice: 120 }), // +2R, +$20
      trade({ exitPrice: 90 }), // -1R, -$10
      trade({ status: "open", exitPrice: null }),
      trade({ status: "pending", exitPrice: null, initialStop: null }),
    ]);
    expect(a.count).toBe(2);
    expect(a.wins).toBe(1);
    expect(a.losses).toBe(1);
    expect(a.winRate).toBe(0.5);
    expect(a.expectancyR).toBe(0.5);
    expect(a.totalPnL).toBe(10);
    expect(a.profitFactor).toBe(2);
  });
});

describe("mistakeCostLeaderboard", () => {
  it("splits a trade's cost evenly across its tags", () => {
    const t = trade({
      exitPrice: 110, // +1R actual
      noManagementOutcome: "target_first", // 3R potential → delta -2R = $20
      mistakeTagIds: [1, 2],
    });
    const rows = mistakeCostLeaderboard([t], { 1: "Exited Too Soon", 2: "FOMO" });
    expect(rows).toHaveLength(2);
    expect(rows[0].cost).toBe(10);
    expect(rows[1].cost).toBe(10);
  });
});
