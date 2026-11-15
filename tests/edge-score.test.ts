import { describe, expect, it } from "vitest";
import { EDGE_SCORE_MIN_TRADES, edgeScore } from "../shared/edge-score";
import { trade } from "./helpers";
import type { TradeWithTags } from "../shared/schema";

const NOW = new Date("2026-08-30T12:00:00.000Z").getTime();
const DAY = 24 * 3600_000;
let id = 0;
/** A trade entered `daysAgo` days back at `hour`, held an hour, worth `r` R, reviewed. */
const t = (daysAgo: number, r: number, over: Partial<TradeWithTags> = {}, hour = 9): TradeWithTags => {
  const at = new Date(NOW - daysAgo * DAY);
  at.setHours(hour, 0, 0, 0);
  return trade({ id: ++id, entryTime: at.toISOString(), exitTime: new Date(at.getTime() + 3600_000).toISOString(), exitPrice: 100 + 10 * r, reviewedAt: at.toISOString(), ...over });
};
/** Twenty clean trades, one a day: alternating +2R and −1R. */
const clean = () => Array.from({ length: 20 }, (_, i) => t(i + 2, i % 2 ? -1 : 2));
const part = (s: ReturnType<typeof edgeScore>, pid: string) => s.parts.find((p) => p.id === pid)!;

describe("edge score", () => {
  it("gives no score under the minimum number of trades", () => {
    const s = edgeScore(clean().slice(0, EDGE_SCORE_MIN_TRADES - 1), { now: NOW });
    expect(s.score).toBeNull();
    expect(s.headline).toMatch(/1 more trade/);
  });

  it("scores a clean record high, whatever it made", () => {
    const s = edgeScore(clean(), { now: NOW });
    expect(s.score).toBeGreaterThanOrEqual(90);
    expect(part(s, "sizing").score).toBe(100);
    expect(part(s, "overtrading").score).toBe(100);
    const losing = edgeScore(Array.from({ length: 20 }, (_, i) => t(i + 2, -1)), { now: NOW });
    expect(part(losing, "sizing").score).toBe(100);
    expect(part(losing, "losses").score).toBe(100);
  });

  it("names uneven sizing as the leak", () => {
    const trades = clean().map((x, i) => (i % 3 === 0 ? { ...x, size: 4 } : x));
    const s = edgeScore(trades, { now: NOW });
    expect(part(s, "sizing").score).toBeLessThan(60);
    expect(s.weakest?.id).toBe("sizing");
    expect(s.headline).toMatch(/Biggest leak: Sizing/);
    expect(part(s, "sizing").tradeIds.length).toBe(7);
  });

  it("counts the trades past twice a normal day as overtrading", () => {
    // One day with nine trades among days of one: the limit is three, so six are extra.
    const binge = Array.from({ length: 9 }, (_, i) => t(1, 1, {}, 8 + i));
    const s = edgeScore([...clean(), ...binge], { now: NOW });
    const p = part(s, "overtrading");
    expect(p.tradeIds.length).toBe(6);
    expect(p.score).toBeLessThan(100);
    expect(p.detail).toMatch(/more than 3 trades/);
  });

  it("sees an entry straight after a loss", () => {
    const base = clean();
    const revenge = base.filter((x) => x.exitPrice! < 100).slice(0, 5).map((l) => trade({ id: ++id, entryTime: new Date(new Date(l.exitTime!).getTime() + 5 * 60_000).toISOString(), exitTime: new Date(new Date(l.exitTime!).getTime() + 30 * 60_000).toISOString(), exitPrice: 90, reviewedAt: "x" }));
    const s = edgeScore([...base, ...revenge], { now: NOW });
    expect(part(s, "after-loss").tradeIds.length).toBe(5);
    expect(part(s, "after-loss").score).toBeLessThan(50);
    expect(part(edgeScore(base, { now: NOW }), "after-loss").score).toBe(100);
  });

  it("marks down losses past 1R, tilt, mistakes and trades never reviewed", () => {
    const trades = clean().map((x, i) => ({
      ...x,
      exitPrice: i % 2 && i < 8 ? 75 : x.exitPrice, // −2.5R
      tilt: i >= 16,
      mistakeTagIds: i < 6 ? [7] : [],
      reviewedAt: i < 10 ? null : x.reviewedAt,
    }));
    const s = edgeScore(trades, { now: NOW, tags: [{ id: 7, name: "Chased" }] });
    expect(part(s, "losses").score).toBeLessThan(70);
    expect(part(s, "losses").detail).toMatch(/4 of 10 losses went past/);
    expect(part(s, "plan").detail).toMatch(/4 tilt trades/);
    expect(part(s, "mistakes").tip).toMatch(/"Chased" is the most common, on 6 trades/);
    expect(part(s, "review").detail).toMatch(/10 of 20 closed trades were never reviewed/);
  });

  it("scores management against the plan left alone", () => {
    // Every winner cut at +0.5R where the target (+3R) was hit first.
    const trades = clean().map((x) => (x.exitPrice! > 100 ? { ...x, exitPrice: 105, noManagementOutcome: "target_first" as const } : { ...x, noManagementOutcome: "stop_first" as const }));
    const p = part(edgeScore(trades, { now: NOW }), "exits");
    expect(p.score).toBe(0);
    expect(p.r).toBeCloseTo(-25);
  });

  it("compares with the window before, and leaves trades outside both alone", () => {
    const now = clean();
    const before = clean().map((x, i) => ({ ...x, entryTime: new Date(new Date(x.entryTime).getTime() - 30 * DAY).toISOString(), exitTime: new Date(new Date(x.exitTime!).getTime() - 30 * DAY).toISOString(), size: i % 2 ? 5 : 1 }));
    const s = edgeScore([...now, ...before], { now: NOW });
    expect(s.trades).toBe(20);
    expect(s.previous).not.toBeNull();
    expect(s.score!).toBeGreaterThan(s.previous!);
  });
});
