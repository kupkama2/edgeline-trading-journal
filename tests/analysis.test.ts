import { describe, expect, it } from "vitest";
import { byAccount, byHour, byWeekday, dailyResults, sliceBy } from "../shared/breakdowns";
import { drawdown, streaks } from "../shared/streaks";
import { MIN_SAMPLE, simulate } from "../shared/montecarlo";
import { missedStats, plannedR } from "../shared/missed";
import { localIso, trade } from "./helpers";

/** One closed trade at a local hour on a local date, with a chosen R. */
function at(y: number, mo: number, d: number, h: number, r: number) {
  return trade({
    entryTime: localIso(y, mo, d, h),
    exitTime: localIso(y, mo, d, h, 55),
    exitPrice: 100 + 10 * r, // stop distance is 10, so ±10 points = ±1R
  });
}

describe("breakdowns", () => {
  it("buckets by local entry hour and averages per trade", () => {
    const rows = byHour([at(2026, 8, 3, 9, 2), at(2026, 8, 4, 9, -1), at(2026, 8, 3, 14, -1)]);
    const nine = rows.find((r) => r.label === "09:00")!;
    expect(nine.count).toBe(2);
    expect(nine.expectancyR).toBe(0.5);
    expect(nine.winRate).toBe(0.5);
    const fourteen = rows.find((r) => r.label === "14:00")!;
    expect(fourteen.expectancyR).toBe(-1);
  });

  it("buckets by weekday, Monday first", () => {
    // 2026-08-03 is a Monday.
    const rows = byWeekday([at(2026, 8, 3, 9, 1), at(2026, 8, 4, 9, 1)]);
    expect(rows.map((r) => r.label)).toEqual(["Monday", "Tuesday"]);
  });

  it("counts a multi-key trade in every bucket it belongs to", () => {
    const t = at(2026, 8, 3, 9, 2);
    const rows = sliceBy([t], () => [
      { key: "a", label: "a" },
      { key: "b", label: "b" },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].count).toBe(1);
    expect(rows[1].count).toBe(1);
  });

  it("buckets by account and leaves unlabelled trades out", () => {
    const rows = byAccount([
      { ...at(2026, 8, 3, 9, 2), account: "Apex eval" },
      { ...at(2026, 8, 4, 9, -1), account: "Apex eval" },
      { ...at(2026, 8, 4, 10, 1), account: "Binance" },
      at(2026, 8, 4, 11, 1), // pre-accounts trade: no bucket
    ]);
    expect(rows.map((r) => r.label)).toEqual(["Apex eval", "Binance"]);
    expect(rows[0].count).toBe(2);
    expect(rows[0].expectancyR).toBe(0.5);
    expect(rows[1].count).toBe(1);
  });

  it("attributes realised results to the exit day", () => {
    const swing = trade({
      entryTime: localIso(2026, 8, 3, 15),
      exitTime: localIso(2026, 8, 5, 10),
      exitPrice: 120,
    });
    const days = dailyResults([swing]);
    expect(days).toHaveLength(1);
    expect(days[0].r).toBe(2);
    expect(days[0].day).toMatch(/2026-08-05/);
  });
});

describe("streaks", () => {
  it("runs over results in the order they were realised", () => {
    const seq = [2, 1, -1, -1, -1, 1].map((r, i) =>
      trade({ exitTime: localIso(2026, 8, 3 + i, 10), exitPrice: 100 + 10 * r }),
    );
    // Shuffle input order to prove sorting is by exit, not array position.
    const s = streaks([seq[3], seq[0], seq[5], seq[1], seq[2], seq[4]]);
    expect(s.longestWin).toBe(2);
    expect(s.longestLoss).toBe(3);
    expect(s.current).toBe(1);
  });
});

describe("drawdown", () => {
  it("measures peak-to-trough on the daily curve and knows when it recovered", () => {
    // Daily R: +2, -1, -2, +4 → equity 2, 1, -1, 3.
    const days = [2, -1, -2, 4].map((r, i) =>
      trade({ exitTime: localIso(2026, 8, 3 + i, 10), exitPrice: 100 + 10 * r }),
    );
    const dd = drawdown(days);
    expect(dd.maxDrawdownR).toBe(3); // peak 2 → trough -1
    expect(dd.troughDay).toMatch(/2026-08-05/);
    expect(dd.troughLengthDays).toBe(2);
    expect(dd.recovered).toBe(true);
    expect(dd.currentDrawdownR).toBe(0);
    expect(dd.bestDay!.r).toBe(4);
    expect(dd.worstDay!.r).toBe(-2);
    expect(dd.equityR.map((e) => e.cumulativeR)).toEqual([2, 1, -1, 3]);
  });

  it("reports an open drawdown as not recovered", () => {
    const days = [2, -3].map((r, i) =>
      trade({ exitTime: localIso(2026, 8, 3 + i, 10), exitPrice: 100 + 10 * r }),
    );
    const dd = drawdown(days);
    expect(dd.recovered).toBe(false);
    expect(dd.currentDrawdownR).toBe(3);
  });
});

describe("simulate", () => {
  const sample = (n: number, r: (i: number) => number) =>
    Array.from({ length: n }, (_, i) =>
      trade({ id: i, exitTime: localIso(2026, 8, 3, 10), exitPrice: 100 + 10 * r(i) }),
    );

  it("refuses to run on too little history", () => {
    expect(simulate(sample(MIN_SAMPLE - 1, () => 1), { horizon: 50, runs: 100 })).toBeNull();
  });

  it("is deterministic for the same record", () => {
    const trades = sample(30, (i) => (i % 3 === 0 ? 2 : -1));
    const a = simulate(trades, { horizon: 100, runs: 500 })!;
    const b = simulate(trades, { horizon: 100, runs: 500 })!;
    expect(a).toEqual(b);
  });

  it("cannot lose money resampling a record with no losers", () => {
    const s = simulate(sample(25, () => 2), { horizon: 100, runs: 500 })!;
    expect(s.probLosing).toBe(0);
    expect(s.finalR.p5).toBeGreaterThan(0);
    expect(s.maxDrawdownR.p95).toBe(0);
  });

  it("block sampling reports deeper drawdowns on a streaky record", () => {
    // Ten straight losers then ten straight winners, repeated: heavily
    // clustered. Independent draws shuffle the clusters away; blocks keep
    // them, so the block simulation must see the deeper hole.
    const streaky = sample(40, (i) => (i % 20 < 10 ? -1 : 1.2));
    const independent = simulate(streaky, { horizon: 100, runs: 800 })!;
    const blocked = simulate(streaky, { horizon: 100, runs: 800, blockSize: 8 })!;
    expect(blocked.maxDrawdownR.p50).toBeGreaterThan(independent.maxDrawdownR.p50);
  });

  it("block mode is deterministic too", () => {
    const trades = sample(30, (i) => (i % 3 === 0 ? 2 : -1));
    const a = simulate(trades, { horizon: 100, runs: 500, blockSize: 4 })!;
    const b = simulate(trades, { horizon: 100, runs: 500, blockSize: 4 })!;
    expect(a).toEqual(b);
  });
});

describe("missed trades", () => {
  const missed = (over: Parameters<typeof trade>[0]) =>
    trade({
      status: "cancelled",
      cancelReason: "never_placed",
      exitPrice: null,
      exitTime: null,
      ...over,
    });

  it("prices the plan from its own levels", () => {
    expect(plannedR(missed({ initialTarget: 140 }))).toBe(4);
    expect(plannedR(missed({ initialStop: null }))).toBeNull();
  });

  it("scores winners at planned R, losers at exactly -1R, unknowns not at all", () => {
    const s = missedStats([
      missed({ initialTarget: 140, wouldHaveHitTarget: true }), // +4R forgone
      missed({ wouldHaveHitTarget: false }), // 1R avoided
      missed({ wouldHaveHitTarget: null }), // uncounted
    ]);
    expect(s.count).toBe(3);
    expect(s.resolved).toBe(2);
    expect(s.forgoneR).toBe(4);
    expect(s.avoidedR).toBe(1);
    expect(s.netR).toBe(3);
  });

  it("ignores ordinary cancelled orders", () => {
    const pulled = trade({
      status: "cancelled",
      cancelReason: "pulled",
      wouldHaveHitTarget: true,
    });
    expect(missedStats([pulled]).count).toBe(0);
  });
});
