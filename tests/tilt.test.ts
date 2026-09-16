import { describe, expect, it } from "vitest";
import {
  REENTRY_MINUTES,
  TILT_LOCK,
  TILT_STRICT,
  WALK_MINUTES,
  bookTotals,
  closesOn,
  entriesOn,
  tiltByHour,
  tiltBySource,
  tiltCost,
  tiltFromHere,
  tiltLocked,
  tiltMeter,
  tiltSignals,
  trailingLosses,
} from "../shared/tilt";
import type { TradingStyle } from "../shared/schema";
import { localIso, trade } from "./helpers";

/**
 * Tilt is a verdict on the entry. These are the rules that read a day as it
 * is being logged: what is wrong with the next trade, how full the bar is,
 * when it locks and for how long, and what the tilt book cost.
 */
const Y = 2026, M = 9, D = 15;
const at = (h: number, mi = 0) => localIso(Y, M, D, h, mi);
const NOW = new Date(Y, M - 1, D, 12, 0);

const style = (over: Partial<TradingStyle> = {}): TradingStyle => ({
  id: 1,
  userId: 1,
  name: "NQ Scalps",
  color: "slate",
  sortOrder: 0,
  sessionStart: null,
  sessionEnd: null,
  maxTradesPerDay: null,
  ...over,
});

/** A trade entered and closed today; +20 by default, `pnl` sets the exit. */
const today = (id: number, h: number, over: Partial<ReturnType<typeof trade>> = {}) =>
  trade({ id, styleId: 1, entryTime: at(h), exitTime: at(h, 30), ...over });
const loss = (id: number, h: number, over = {}) => today(id, h, { exitPrice: 95, ...over });

describe("reading the day", () => {
  it("lists entries and closes made today, in order, and not yesterday's", () => {
    const ts = [
      today(2, 10),
      today(1, 9),
      trade({ id: 3, entryTime: localIso(Y, M, D - 1, 9), exitTime: localIso(Y, M, D - 1, 10) }),
      today(4, 11, { status: "cancelled", exitPrice: null, exitTime: null }),
    ];
    expect(entriesOn(ts, NOW).map((t) => t.id)).toEqual([1, 2]);
    expect(closesOn(ts, NOW).map((t) => t.id)).toEqual([1, 2]);
  });

  it("counts trailing losses from the newest close back", () => {
    expect(trailingLosses([today(1, 9), loss(2, 10), loss(3, 11)])).toBe(2);
    expect(trailingLosses([loss(1, 9), today(2, 10)])).toBe(0);
    expect(trailingLosses([])).toBe(0);
  });
});

describe("what is wrong with the next trade", () => {
  const cand = (h: number, symbol = "NQ", styleId: number | null = 1) => ({
    symbol,
    styleId,
    entryTime: new Date(Y, M - 1, D, h, 0),
  });
  const kinds = (xs: ReturnType<typeof tiltSignals>) => xs.map((s) => s.kind);

  it("nothing, on a quiet day with no rules set", () => {
    expect(tiltSignals(cand(10), [today(1, 9)], style())).toEqual([]);
  });

  it("a book's daily cap, counting only that book's entries before this one", () => {
    const ts = [today(1, 9), today(2, 10), today(3, 10, { styleId: 2 })];
    const s = tiltSignals(cand(11), ts, style({ maxTradesPerDay: 2 }));
    expect(s).toEqual([{ kind: "over-cap", count: 3, cap: 2 }]);
    expect(tiltSignals(cand(11), ts, style({ maxTradesPerDay: 3 }))).toEqual([]);
  });

  it("a re-entry: the same symbol, minutes after a loss on it", () => {
    const ts = [loss(1, 10, { symbol: "ETH", exitTime: at(10, 0) })];
    // Not before it closed.
    expect(tiltSignals({ ...cand(10, "ETH"), entryTime: new Date(Y, M - 1, D, 9, 50) }, ts, style())).toEqual([]);
    const s = tiltSignals({ ...cand(10, "eth"), entryTime: new Date(Y, M - 1, D, 10, 10) }, ts, style());
    expect(s).toEqual([{ kind: "reentry", symbol: "ETH", minutesAgo: 10 }]);
    // Long enough after, a different symbol, or a win on it: not a re-entry.
    expect(
      kinds(tiltSignals({ ...cand(10, "ETH"), entryTime: new Date(Y, M - 1, D, 10, REENTRY_MINUTES + 1) }, ts, style())),
    ).toEqual([]);
    expect(kinds(tiltSignals({ ...cand(10, "BTC"), entryTime: new Date(Y, M - 1, D, 10, 5) }, ts, style()))).toEqual([]);
    const win = [today(1, 10, { symbol: "ETH", exitTime: at(10, 0) })];
    expect(kinds(tiltSignals({ ...cand(10, "ETH"), entryTime: new Date(Y, M - 1, D, 10, 5) }, win, style()))).toEqual([]);
  });

  it("outside the book's session window", () => {
    const s = style({ sessionStart: "09:00", sessionEnd: "12:00" });
    expect(tiltSignals(cand(14), [], s)).toEqual([{ kind: "outside-window", window: "09:00–12:00" }]);
    expect(tiltSignals(cand(10), [], s)).toEqual([]);
  });

  it("a losing streak at the guard's limit, and the daily stop", () => {
    const three = [loss(1, 9), loss(2, 10), loss(3, 11)];
    expect(kinds(tiltSignals(cand(12), three, style()))).toEqual(["loss-streak"]);
    expect(kinds(tiltSignals(cand(12), three.slice(1), style()))).toEqual([]);
    // A loss that closes after the candidate's time has not happened yet.
    expect(kinds(tiltSignals(cand(9), three, style()))).toEqual([]);
    const stop = [loss(1, 9, { size: 100 })]; // −$500
    expect(kinds(tiltSignals(cand(12), stop, style()))).toEqual(["daily-stop"]);
  });
});

describe("the meter", () => {
  const tilt = (id: number, h: number) => today(id, h, { tilt: true });

  it("is calm on a day with nothing on it, and warm with a tilt trade", () => {
    const calm = tiltMeter([today(1, 9)], NOW);
    expect(calm).toMatchObject({ tradesToday: 1, tiltToday: 0, filled: 0, state: "calm", walkEndsAt: null });
    const warm = tiltMeter([today(1, 9), tilt(2, 10)], NOW);
    expect(warm).toMatchObject({ tradesToday: 2, tiltToday: 1, filled: 1, state: "warm" });
    expect(warm.reasons.map((r) => r.label)).toEqual(["1 tilt trade"]);
  });

  it("turns strict at three and locks at five, thirty minutes past the last sign", () => {
    const three = [tilt(1, 9), tilt(2, 10), tilt(3, 11)];
    expect(tiltMeter(three, NOW)).toMatchObject({ filled: TILT_STRICT, state: "strict", walkEndsAt: null });
    const five = [...three, tilt(4, 11), tilt(5, 11)];
    const m = tiltMeter(five, NOW);
    expect(m).toMatchObject({ filled: TILT_LOCK, state: "locked" });
    expect(m.walkEndsAt).toBe(new Date(Y, M - 1, D, 11, WALK_MINUTES).getTime());
    expect(m.lockKey).toBeTruthy();
  });

  it("adds a segment for a losing streak, and fills the bar on the daily stop", () => {
    const m = tiltMeter([tilt(1, 9), tilt(2, 10), loss(3, 10), loss(4, 11), loss(5, 11)], NOW);
    expect(m).toMatchObject({ filled: 3, lossStreak: 3, state: "strict" });
    expect(m.reasons.map((r) => r.kind)).toEqual(["tilt-trade", "loss-streak"]);
    const stop = tiltMeter([loss(1, 9, { size: 100 })], NOW);
    expect(stop).toMatchObject({ filled: 5, state: "locked" });
    expect(stop.walkEndsAt).toBe(new Date(Y, M - 1, D + 1, 0, 0).getTime());
  });

  it("does not carry yesterday's tilt into today", () => {
    const yesterday = trade({ id: 1, tilt: true, entryTime: localIso(Y, M, D - 1, 9), exitTime: localIso(Y, M, D - 1, 10) });
    expect(tiltMeter([yesterday], NOW).filled).toBe(0);
  });

  it("stays locked through the walk, and after it until acknowledged", () => {
    const five = [1, 2, 3, 4, 5].map((id) => tilt(id, 11));
    const m = tiltMeter(five, NOW);
    const during = new Date(Y, M - 1, D, 11, 10);
    const after = new Date(Y, M - 1, D, 11, WALK_MINUTES + 1);
    expect(tiltLocked(m, new Set(), during)).toBe(true);
    expect(tiltLocked(m, new Set([m.lockKey!]), during)).toBe(true);
    expect(tiltLocked(m, new Set(), after)).toBe(true);
    expect(tiltLocked(m, new Set([m.lockKey!]), after)).toBe(false);
    // A calm meter is never locked, whatever was acknowledged.
    expect(tiltLocked(tiltMeter([], NOW), new Set(), after)).toBe(false);
  });

  it("keys a later sign differently, so one acknowledgement does not cover the next walk", () => {
    const five = [1, 2, 3, 4, 5].map((id) => tilt(id, 11));
    const six = [...five, tilt(6, 11, )].map((t, i) => (i === 5 ? { ...t, entryTime: at(11, 45) } : t));
    expect(tiltMeter(six, NOW).lockKey).not.toBe(tiltMeter(five, NOW).lockKey);
  });
});

describe("what tilt cost", () => {
  const ts = [
    today(1, 9), // +20, +2R
    today(2, 10, { exitPrice: 90 }), // −10, −1R
    today(3, 11, { tilt: true, exitPrice: 80 }), // −20, −2R
    today(4, 11, { tilt: true, initialStop: null, exitPrice: 105, fees: 3 }), // +2 net, no R
    today(5, 12, { tilt: true, status: "open", exitPrice: null, exitTime: null }),
  ];

  it("splits the closed trades into the plan and the tilt book", () => {
    const c = tiltCost(ts);
    expect(c.plan).toEqual({ count: 2, pnl: 10, r: 1, measured: 2, wins: 1 });
    expect(c.tilt).toEqual({ count: 2, pnl: -18, r: -2, measured: 1, wins: 1 });
  });

  it("nets fees and leaves a stop-less trade out of the R only", () => {
    expect(bookTotals([ts[3]])).toEqual({ count: 1, pnl: 2, r: 0, measured: 0, wins: 1 });
  });

  it("groups the tilt book by hour entered and by whose idea it was", () => {
    expect(tiltByHour(ts)).toEqual([
      { hour: 11, count: 2, pnl: -18 },
      { hour: 12, count: 1, pnl: 0 },
    ]);
    const bySrc = tiltBySource([...ts, today(6, 13, { tilt: true, source: "Severin", exitPrice: 90 })]);
    expect(bySrc).toEqual([
      { source: "", count: 3, pnl: -18 },
      { source: "Severin", count: 1, pnl: -10 },
    ]);
  });
});

describe("everything after this one was tilt", () => {
  it("names the trade and every later entry that day still in the plan", () => {
    const ts = [
      today(1, 9),
      today(2, 10),
      today(3, 11, { tilt: true }),
      today(4, 11),
      trade({ id: 5, entryTime: localIso(Y, M, D + 1, 9), exitTime: localIso(Y, M, D + 1, 10) }),
    ];
    expect(tiltFromHere(ts, 2)).toEqual([2, 4]);
    expect(tiltFromHere(ts, 4)).toEqual([4]);
    expect(tiltFromHere(ts, 99)).toEqual([]);
  });
});
