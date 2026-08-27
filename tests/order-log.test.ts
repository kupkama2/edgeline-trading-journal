import { describe, expect, it } from "vitest";
import {
  avgEntry,
  avgExit,
  logTime,
  tradesFromFills,
  tradesFromLog,
  type LoggedFill,
} from "../shared/order-log";

/**
 * Turning a filled-order log back into the trades it records.
 *
 * A fill log is a list of executions, not a list of trades. Three rows on one
 * symbol can be one trade scaled out of or three separate trades, and no
 * single row says which — only the running position does. So these tests are
 * mostly about the walk: where a trade starts, where it ends, and what the
 * rows in between mean.
 */

/** The Tradovate "Filled" tab from the request, exactly as it printed. */
const tradovate: LoggedFill[] = [
  // Sorted by symbol, newest first within each — deliberately not time order.
  { symbol: "MBTQ6", side: "buy", kind: "Stop", qty: 5, price: 79330, time: "2026-08-25 16:25:13", stopPrice: 79325 },
  { symbol: "MBTQ6", side: "buy", kind: "Stop", qty: 5, price: 78730, time: "2026-08-25 16:01:49", stopPrice: 78775 },
  { symbol: "MBTQ6", side: "buy", kind: "Limit", qty: 5, price: 78935, time: "2026-08-25 14:06:00" },
  { symbol: "MBTQ6", side: "sell", kind: "Limit", qty: 15, price: 79365, time: "2026-08-25 13:41:36" },
  { symbol: "MNQU6", side: "buy", kind: "Limit", qty: 1, price: 29152.25, time: "2026-08-25 16:30:39" },
  { symbol: "MNQU6", side: "buy", kind: "Limit", qty: 1, price: 29279, time: "2026-08-25 16:01:07" },
  { symbol: "MNQU6", side: "sell", kind: "Limit", qty: 2, price: 29389, time: "2026-08-25 15:46:42" },
  { symbol: "MNQU6", side: "buy", kind: "Stop Loss", qty: 2, price: 29353.75, time: "2026-08-25 15:32:21", stopPrice: 29353.75 },
  { symbol: "MNQU6", side: "sell", kind: "Limit", qty: 2, price: 29326, time: "2026-08-25 14:47:25" },
];

describe("the log that prompted this", () => {
  const { trades, problems } = tradesFromFills(tradovate);

  it("finds three trades in nine filled orders", () => {
    // One on Bitcoin, two on Nasdaq. Row by row it is nine; as a position it
    // is three, and only the position reading is ever right.
    expect(trades).toHaveLength(3);
    expect(trades.map((t) => t.symbol)).toEqual(["MBTQ6", "MNQU6", "MNQU6"]);
    expect(problems).toEqual([]);
  });

  it("reads the Bitcoin short as one trade scaled out of in three", () => {
    const btc = trades[0];
    expect(btc.direction).toBe("short");
    expect(btc.size).toBe(15);
    expect(btc.entryPrice).toBe(79365);
    expect(btc.entryTime).toBe("2026-08-25T13:41:36");
    // Two clips banked, the last one carried by the trade's own exit.
    expect(btc.partials).toEqual([
      { price: 78935, size: 5, time: "2026-08-25T14:06:00" },
      { price: 78730, size: 5, time: "2026-08-25T16:01:49" },
    ]);
    expect(btc.exitPrice).toBe(79330);
    expect(btc.stillOpen).toBe(false);
  });

  it("refuses to call a trailing stop the planned stop", () => {
    /*
     * The trade covered on two stop orders, at 78,775 and 79,325 — both BELOW
     * a short entered at 79,365, so both were trails locking in profit, not
     * the risk that was originally accepted. Taking either as the stop would
     * set 1R from a number that was never the plan, and 1R is the denominator
     * of every R this trade ever contributes.
     */
    expect(trades[0].initialStop).toBeNull();
    expect(trades[0].exitReason).toBeNull();
  });

  it("reads the first Nasdaq short as stopped out, and takes its stop", () => {
    const stopped = trades[1];
    expect(stopped.direction).toBe("short");
    expect(stopped.entryPrice).toBe(29326);
    expect(stopped.exitPrice).toBe(29353.75);
    expect(stopped.partials).toEqual([]);
    // Above a short's entry, so this one really is the risk that was taken.
    expect(stopped.initialStop).toBe(29353.75);
    expect(stopped.exitReason).toBe("stop");
  });

  it("reads the second Nasdaq short as a separate trade, scaled out of", () => {
    const scaled = trades[2];
    expect(scaled.entryPrice).toBe(29389);
    expect(scaled.entryTime).toBe("2026-08-25T15:46:42");
    expect(scaled.partials).toEqual([{ price: 29279, size: 1, time: "2026-08-25T16:01:07" }]);
    expect(scaled.exitPrice).toBe(29152.25);
  });

  it("averages the legs the way the broker would print them", () => {
    // (78,935 + 78,730 + 79,330) / 3 across equal clips.
    expect(avgExit(trades[0])).toBeCloseTo(78998.333, 2);
    expect(avgEntry(trades[0])).toBe(79365);
  });
});

describe("what the walk has to get right", () => {
  const f = (
    side: "buy" | "sell",
    qty: number,
    price: number,
    time: string,
    kind = "Limit",
    stopPrice?: number,
  ): LoggedFill => ({ symbol: "ES", side, kind, qty, price, time, stopPrice });

  it("keeps two symbols' positions apart", () => {
    const { trades } = tradesFromFills([
      { ...f("buy", 1, 100, "2026-08-25 10:00"), symbol: "A" },
      { ...f("buy", 1, 200, "2026-08-25 10:01"), symbol: "B" },
      { ...f("sell", 1, 110, "2026-08-25 10:02"), symbol: "A" },
      { ...f("sell", 1, 190, "2026-08-25 10:03"), symbol: "B" },
    ]);
    expect(trades).toHaveLength(2);
    expect(trades.map((t) => t.symbol)).toEqual(["A", "B"]);
    expect(trades[1].exitPrice).toBe(190);
  });

  it("treats scaling in as adds on the same trade, not a new one", () => {
    const { trades } = tradesFromFills([
      f("buy", 2, 100, "2026-08-25 10:00"),
      f("buy", 2, 98, "2026-08-25 10:05"),
      f("sell", 4, 105, "2026-08-25 11:00"),
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0].size).toBe(2);
    expect(trades[0].adds).toEqual([{ price: 98, size: 2, time: "2026-08-25T10:05:00" }]);
    expect(avgEntry(trades[0])).toBe(99);
  });

  it("splits a reversal into the two trades it is", () => {
    /*
     * A sell of six against a long of two is not one trade and it is not a
     * clamped four either: it closes the long and opens a short with what is
     * left. Dropping the surplus would lose a position the log plainly shows.
     */
    const { trades } = tradesFromFills([
      f("buy", 2, 100, "2026-08-25 10:00"),
      f("sell", 6, 105, "2026-08-25 11:00"),
      f("buy", 4, 103, "2026-08-25 12:00"),
    ]);
    expect(trades).toHaveLength(2);
    expect(trades[0]).toMatchObject({ direction: "long", size: 2, exitPrice: 105 });
    expect(trades[1]).toMatchObject({ direction: "short", size: 4, entryPrice: 105, exitPrice: 103 });
  });

  it("comes back to flat on sizes that do not divide cleanly", () => {
    /*
     * 0.1 + 0.2 - 0.3 is 5.6e-17, not zero, and crypto positions are routinely
     * fractional. Comparing the running position to zero exactly left a
     * fifty-quadrillionth of a coin open, so a closed trade came out as still
     * running with its exit discarded — the one part of a closed trade that
     * cannot be reconstructed from anywhere else.
     */
    const { trades, problems } = tradesFromFills([
      f("buy", 0.1, 100, "2026-08-25 10:00"),
      f("buy", 0.2, 100, "2026-08-25 10:05"),
      f("sell", 0.3, 110, "2026-08-25 11:00"),
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0].stillOpen).toBe(false);
    expect(trades[0].exitPrice).toBe(110);
    expect(problems).toEqual([]);
  });

  it("does not open a phantom trade out of the same residue", () => {
    // The other half: a residue left behind would make the NEXT fill look
    // like an add to a position that is not there.
    const { trades } = tradesFromFills([
      f("buy", 0.1, 100, "2026-08-25 10:00"),
      f("buy", 0.2, 100, "2026-08-25 10:05"),
      f("sell", 0.3, 110, "2026-08-25 11:00"),
      f("buy", 1, 120, "2026-08-25 12:00"),
      f("sell", 1, 130, "2026-08-25 13:00"),
    ]);
    expect(trades).toHaveLength(2);
    expect(trades[1]).toMatchObject({ size: 1, entryPrice: 120, exitPrice: 130 });
  });

  it("says a position that never comes back to flat is still running", () => {
    const { trades, problems } = tradesFromFills([
      f("buy", 3, 100, "2026-08-25 10:00"),
      f("sell", 1, 105, "2026-08-25 11:00"),
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0].stillOpen).toBe(true);
    expect(problems[0]).toMatch(/still running/i);
  });

  it("reads the log in time order however the rows are sorted", () => {
    // The whole reason this exists: the screenshot arrives sorted by symbol,
    // newest first, so as printed the cover comes before the entry.
    const asPrinted = tradesFromFills([
      f("sell", 1, 110, "2026-08-25 11:00"),
      f("buy", 1, 100, "2026-08-25 10:00"),
    ]);
    expect(asPrinted.trades).toHaveLength(1);
    expect(asPrinted.trades[0]).toMatchObject({ direction: "long", entryPrice: 100, exitPrice: 110 });
  });

  it("takes a long's stop only from below the entry", () => {
    const { trades } = tradesFromFills([
      f("buy", 1, 100, "2026-08-25 10:00"),
      f("sell", 1, 95, "2026-08-25 11:00", "Stop Loss", 95),
    ]);
    expect(trades[0].initialStop).toBe(95);
    expect(trades[0].exitReason).toBe("stop");
  });

  it("leaves out a row it cannot place, and says so", () => {
    const { trades, problems } = tradesFromFills([
      f("buy", 1, 100, "not a time"),
      f("buy", 1, 100, "2026-08-25 10:00"),
      f("sell", 1, 110, "2026-08-25 11:00"),
    ]);
    expect(trades).toHaveLength(1);
    expect(problems.some((p) => /no readable time/i.test(p))).toBe(true);
  });
});

describe("the timestamps a log might print", () => {
  it("keeps the seconds", () => {
    // Fills of one order share a minute; rounding them together would leave
    // their order down to however the rows happened to arrive.
    expect(logTime("2026-08-25 16:25:13")).toBe("2026-08-25T16:25:13");
    expect(logTime("2026-08-25T16:25:13.000Z")).toBe("2026-08-25T16:25:13");
  });

  it("reads the American ordering too", () => {
    expect(logTime("8/25/2026 9:05:44")).toBe("2026-08-25T09:05:44");
  });

  it("fills in a missing seconds field rather than failing", () => {
    expect(logTime("2026-08-25 16:25")).toBe("2026-08-25T16:25:00");
  });

  it("returns nothing for something that is not a time", () => {
    expect(logTime("Day")).toBeNull();
    expect(logTime("")).toBeNull();
  });
});

/**
 * The same account, screenshotted with the CANCELLED rows showing.
 *
 * This is the half of a log a position walk has to throw away, and the only
 * half that carries the plan: a take profit placed and then cancelled when
 * the position closed is the target as it stood, and no amount of fill data
 * contains it. Two Nasdaq shorts — the first stopped out, the second scaled
 * out of behind a stop that was trailed down twice.
 */
const withBrackets: LoggedFill[] = [
  { symbol: "MNQU6", side: "buy", kind: "Stop", qty: 1, price: 0, stopPrice: 29254.75, time: "2026-08-25 16:30:48", status: "cancelled" },
  { symbol: "MNQU6", side: "buy", kind: "Limit", qty: 1, price: 29152.25, time: "2026-08-25 16:30:39", status: "filled" },
  { symbol: "MNQU6", side: "buy", kind: "Limit", qty: 1, price: 29279, time: "2026-08-25 16:01:07", status: "filled" },
  { symbol: "MNQU6", side: "sell", kind: "Limit", qty: 2, price: 29389, time: "2026-08-25 15:46:42", status: "filled" },
  { symbol: "MNQU6", side: "buy", kind: "Stop Loss", qty: 2, price: 0, stopPrice: 29344.75, time: "2026-08-25 16:01:17", status: "cancelled" },
  { symbol: "MNQU6", side: "buy", kind: "Take Profit", qty: 2, price: 0, limitPrice: 29212.25, time: "2026-08-25 15:58:02", status: "cancelled" },
  { symbol: "MNQU6", side: "sell", kind: "Limit", qty: 2, price: 29326, time: "2026-08-25 14:47:25", status: "filled" },
  { symbol: "MNQU6", side: "buy", kind: "Take Profit", qty: 2, price: 0, limitPrice: 28946.75, time: "2026-08-25 15:32:21", status: "cancelled" },
  { symbol: "MNQU6", side: "buy", kind: "Stop Loss", qty: 2, price: 29353.75, stopPrice: 29353.75, time: "2026-08-25 15:32:21", status: "filled" },
];

describe("a log that shows the cancelled orders too", () => {
  const { trades } = tradesFromLog(withBrackets);

  it("keeps the cancelled rows out of the position walk", () => {
    // An order that never traded moved nothing. Counting one would make the
    // position wrong for every row after it.
    expect(trades).toHaveLength(2);
    expect(trades[0]).toMatchObject({ entryPrice: 29326, exitPrice: 29353.75 });
    expect(trades[1]).toMatchObject({ entryPrice: 29389, exitPrice: 29152.25 });
  });

  it("takes the plan from the trade that ran into its stop", () => {
    /*
     * Nothing was moved on this one: the stop fired and the bracket died with
     * the position, so what was live at the end is what was set at the start.
     * This is the only case where a log proves the plan rather than merely
     * recording how the trade was managed.
     */
    expect(trades[0].initialStop).toBe(29353.75);
    expect(trades[0].planTarget).toBe(28946.75);
    expect(trades[0].exitReason).toBe("stop");
  });

  it("refuses the plan on the trade that was managed", () => {
    /*
     * The second short exited on limits, behind a stop trailed from 29,344.75
     * to 29,254.75 — both BELOW a short entered at 29,389, so both were
     * locking in profit rather than defining risk. The target was cancelled
     * mid-trade and may have been replaced by one this screenshot never shows.
     * Every one of those is evidence about management, not about the plan.
     */
    expect(trades[1].initialStop).toBeNull();
    expect(trades[1].planTarget).toBeNull();
    expect(trades[1].exitReason).toBeNull();
  });

  it("still shows what the broker had, so the levels are not simply lost", () => {
    const seen = trades[1].brackets.map((b) => `${b.kind} ${b.level}`);
    expect(seen).toEqual(["target 29212.25", "stop 29344.75", "stop 29254.75"]);
  });

  it("keeps a bracket cancelled just after the exit", () => {
    // The broker pulls its own bracket a moment AFTER the position flattens —
    // nine seconds here. Ending the window at the exit would orphan it.
    expect(trades[1].brackets.some((b) => b.level === 29254.75)).toBe(true);
  });

  it("does not let one trade's grace period reach into the next", () => {
    const [first, second] = trades;
    expect(first.brackets.map((b) => b.level)).toEqual([28946.75, 29353.75]);
    expect(second.brackets.every((b) => b.time > first.exitTime!)).toBe(true);
  });

  it("ignores a cancelled row whose type says nothing", () => {
    // A bare "Limit" that never filled could be a resting entry, a target, or
    // an order pulled before it mattered. Attaching it would put a plan level
    // on a trade off an order that may never have been part of it.
    const { trades: t } = tradesFromLog([
      ...withBrackets,
      { symbol: "MNQU6", side: "buy", kind: "Limit", qty: 2, price: 0, limitPrice: 29100, time: "2026-08-25 15:00:00", status: "cancelled" },
    ]);
    expect(t[0].brackets.some((b) => b.level === 29100)).toBe(false);
  });
});

describe("a stop that held while the target moved", () => {
  /*
   * Being stopped out proves the STOP was never touched. It proves nothing
   * about the target — a trader can leave the risk alone and walk the target
   * in all afternoon — and the log says so plainly, because a moved target
   * leaves two cancelled legs in the window rather than one.
   */
  const base: LoggedFill[] = [
    { symbol: "ES", side: "buy", kind: "Limit", qty: 1, price: 100, time: "2026-08-25 10:00:00", status: "filled" },
    { symbol: "ES", side: "sell", kind: "Stop Loss", qty: 1, price: 95, stopPrice: 95, time: "2026-08-25 12:00:00", status: "filled" },
  ];

  it("takes the target when there is only one", () => {
    const { trades } = tradesFromLog([
      ...base,
      { symbol: "ES", side: "sell", kind: "Take Profit", qty: 1, price: 0, limitPrice: 130, time: "2026-08-25 12:00:00", status: "cancelled" },
    ]);
    expect(trades[0].initialStop).toBe(95);
    expect(trades[0].planTarget).toBe(130);
  });

  it("claims none of them when the target was walked", () => {
    const { trades } = tradesFromLog([
      ...base,
      { symbol: "ES", side: "sell", kind: "Take Profit", qty: 1, price: 0, limitPrice: 130, time: "2026-08-25 11:00:00", status: "cancelled" },
      { symbol: "ES", side: "sell", kind: "Take Profit", qty: 1, price: 0, limitPrice: 118, time: "2026-08-25 12:00:00", status: "cancelled" },
    ]);
    // The stop is still proved; the target is a history, not a plan.
    expect(trades[0].initialStop).toBe(95);
    expect(trades[0].planTarget).toBeNull();
    expect(trades[0].brackets.map((b) => b.level)).toEqual([130, 118, 95]);
  });
});
