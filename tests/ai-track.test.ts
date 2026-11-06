import { describe, expect, it } from "vitest";
import { priceAfter, priceAtStart, summarizeCalls, trackCalls, type PricePoint } from "../shared/ai-track";

/**
 * The AI read's track record: each call priced from the hourly snapshots
 * at the read and 4 hours, a day, three days and a week on, scored in the
 * call's direction, "avoid" as a short and "watch" not at all.
 */
const H = 3600_000;
const T0 = Date.UTC(2026, 10, 1, 8, 0);
const hourly = (from: number, hours: number, px: (i: number) => number): PricePoint[] => Array.from({ length: hours + 1 }, (_, i) => ({ at: from + i * H + 5 * 60_000, mark: px(i) }));

describe("pricing a call", () => {
  it("starts at the snapshot just before the read, ends at the first one after each horizon, and waits while it is ahead", () => {
    const pts: PricePoint[] = [
      { at: T0 - 50 * 60_000, mark: 10 },
      { at: T0 + 10 * 60_000, mark: 11 },
      { at: T0 + 4 * H + 20 * 60_000, mark: 12 },
    ];
    expect(priceAtStart(pts, T0)?.mark).toBe(10);
    expect(priceAfter(pts, T0 + 4 * H)?.mark).toBe(12);
    expect(priceAfter(pts, T0 + 24 * H)).toBeNull();
    // Nothing within two hours of the read: no start.
    expect(priceAtStart([{ at: T0 - 3 * H, mark: 1 }], T0)).toBeNull();
  });

  it("scores longs up, shorts and avoids down, leaves a watch unscored, and measures against BTC", () => {
    const now = T0 + 8 * 24 * H;
    // SOL up 1% an hour for the first four hours, then flat: +4.06%. DOGE down 10% over the same four hours. BTC flat.
    const sol = hourly(T0 - H, 8 * 24, (i) => 100 * Math.pow(1.01, Math.min(Math.max(i - 1, 0), 4)));
    const doge = hourly(T0 - H, 8 * 24, (i) => (i <= 1 ? 1 : i >= 5 ? 0.9 : 1 - 0.025 * (i - 1)));
    const btc = hourly(T0 - H, 8 * 24, () => 50_000);
    const series = new Map([
      ["SOL", sol],
      ["DOGE", doge],
      ["BTC", btc],
    ]);
    const reads = [
      {
        id: 1,
        at: new Date(T0).toISOString(),
        tips: [
          { coin: "SOL", stance: "long" as const },
          { coin: "DOGE", stance: "avoid" as const },
          { coin: "DOGE", stance: "short" as const },
          { coin: "SOL", stance: "watch" as const },
          { coin: "GONE", stance: "long" as const },
        ],
      },
    ];
    const calls = trackCalls(reads, series, now);
    const [long, avoid, short, watch, gone] = calls;
    expect(long.entry?.px).toBe(100);
    expect(long.moves["4h"]!.ret).toBeCloseTo(Math.pow(1.01, 4) - 1, 9);
    expect(long.moves["4h"]!.score).toBeCloseTo(long.moves["4h"]!.ret, 12);
    expect(long.moves["1w"]!.ret).toBeCloseTo(Math.pow(1.01, 4) - 1, 9);
    // BTC flat: the move against it is the move itself.
    expect(long.moves["24h"]!.rs).toBeCloseTo(long.moves["24h"]!.ret, 12);
    expect(avoid.moves["24h"]!.ret).toBeCloseTo(-0.1, 9);
    expect(avoid.moves["24h"]!.score).toBeCloseTo(0.1, 9);
    expect(short.moves["3d"]!.score).toBeCloseTo(0.1, 9);
    expect(watch.moves["24h"]!.score).toBeNull();
    expect(gone.entry).toBeNull();
    expect(gone.moves.now).toBeNull();

    const s = summarizeCalls(calls);
    expect(s.long["24h"]).toMatchObject({ n: 1, hits: 1 });
    expect(s.avoid["1w"]).toMatchObject({ n: 1, hits: 1 });
    expect(s.avoid["1w"].avg).toBeCloseTo(0.1, 9);
    // A watch counts how many rose, with the plain price move.
    expect(s.watch["24h"]).toMatchObject({ n: 1, hits: 1 });
    expect(s.watch["24h"].avg).toBeCloseTo(Math.pow(1.01, 4) - 1, 9);
  });

  it("does not score a horizon that has not come yet", () => {
    const now = T0 + 30 * H;
    const pts = hourly(T0 - H, 30, () => 1);
    const [c] = trackCalls([{ id: 1, at: new Date(T0).toISOString(), tips: [{ coin: "X", stance: "long" }] }], new Map([["X", pts]]), now);
    expect(c.moves["24h"]).not.toBeNull();
    expect(c.moves["3d"]).toBeNull();
    expect(c.moves["1w"]).toBeNull();
    expect(summarizeCalls([c]).long["3d"].n).toBe(0);
  });
});
