/**
 * A broker's filled-order log, turned back into the trades it records.
 *
 * A fill log is not a list of trades. It is a list of executions, and the
 * trades are implicit in them: three rows on one symbol can be one trade
 * scaled out of, or three separate trades, and nothing in any single row says
 * which. What decides it is the running position — a trade begins when the
 * position leaves flat and ends when it comes back to it — so that is what
 * this walks.
 *
 * The nine filled orders that prompted this are three trades: fifteen micro
 * Bitcoin sold at once and bought back in three clips, and two Nasdaq shorts,
 * the first stopped out and the second scaled out of. Read row by row that is
 * nine trades, or two, or nothing at all. Read as a position it is unambiguous.
 *
 * Two rules keep it from being worse than typing:
 *
 *   The log's row order is not time order. This one arrives sorted by symbol,
 *   with each symbol's rows newest first; walking it as printed would have the
 *   position going short before the entry that opened it.
 *
 *   A stop that fired is only the PLANNED stop if it sits on the losing side
 *   of the entry. A trailing stop is also a stop order and also fires, and
 *   taking its trigger as the initial risk would rewrite 1R — and therefore
 *   every R the trade ever contributes — from a number that was never the plan.
 */

/** One row of the log, filled or not. */
export interface LoggedFill {
  symbol: string;
  side: "buy" | "sell";
  /** The order type as printed: "Limit", "Stop", "Stop Loss", "Take Profit", … */
  kind: string | null;
  qty: number;
  /** The average fill price. Zero or absent on a row that never filled. */
  price: number;
  /** Naive local time — no timezone, the way the log shows it. */
  time: string;
  /** A stop order's trigger level, where the log prints one. */
  stopPrice?: number | null;
  /** A resting order's limit level — where a take-profit leg keeps its price. */
  limitPrice?: number | null;
  /** Absent means filled: the older shape only ever carried fills. */
  status?: "filled" | "cancelled" | "working" | "other";
}

/**
 * A bracket leg the broker had live during a trade.
 *
 * These are the rows a position walk must ignore — an order that never traded
 * moved nothing — and they are the only rows that carry the PLAN. A take
 * profit that was placed and then cancelled when the position closed is the
 * target as it stood; no amount of fill data contains it.
 */
export interface Bracket {
  kind: "stop" | "target";
  level: number;
  time: string;
  /** True for the stop that actually fired — the one that is also the exit. */
  filled: boolean;
}

/** A leg of a reconstructed trade beyond its first fill. */
export interface Leg {
  price: number;
  size: number;
  time: string;
}

export interface ReconstructedTrade {
  symbol: string;
  direction: "long" | "short";
  /** The opening fill's quantity; adds are carried separately, as fills. */
  size: number;
  entryPrice: number;
  entryTime: string;
  /** Same-direction fills after the first — scaling in. */
  adds: Leg[];
  /** Closing fills before the last — scaling out. */
  partials: Leg[];
  /** The final closing fill, which is what the trade's own exit fields hold. */
  exitPrice: number | null;
  exitTime: string | null;
  /**
   * The planned stop, but only where the log PROVES it was the original.
   *
   * That proof is narrow on purpose: the trade ended because a stop fired, and
   * that stop sat on the losing side of the entry. A stop in profit is a trail
   * — it was moved, so it is evidence of management and not of the plan — and
   * a stop that was cancelled rather than hit was replaced by something this
   * screenshot may not even show. Null is the common answer and the honest one.
   */
  initialStop: number | null;
  /**
   * The planned target, under the same proof: only where the trade was stopped
   * out, so the bracket that died with it was still the one first set.
   */
  planTarget: number | null;
  /** Every bracket level seen during the trade, in time order. Shown, never applied. */
  brackets: Bracket[];
  exitReason: "stop" | null;
  /** Never came back to flat in this log, so it is still running. */
  stillOpen: boolean;
}

export interface Reconstruction {
  trades: ReconstructedTrade[];
  /** Rows that could not be accounted for, said out loud rather than dropped. */
  problems: string[];
}

/**
 * Normalise the timestamps a log might print into something sortable.
 *
 * Seconds are kept. Fills of one order land in the same minute, and rounding
 * them together would leave their order down to however the rows happened to
 * arrive — which is exactly the thing this module cannot rely on.
 */
export function logTime(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (iso) {
    const [, y, mo, d, h, mi, se] = iso;
    return `${y}-${mo}-${d}T${h.padStart(2, "0")}:${mi}:${se ?? "00"}`;
  }
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[T\s,]+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (us) {
    const [, mo, d, y, h, mi, se] = us;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T${h.padStart(2, "0")}:${mi}:${se ?? "00"}`;
  }
  return null;
}

/** Is this order type one that fires at a level rather than resting at one? */
function isStop(kind: string | null): boolean {
  return !!kind && /stop/i.test(kind);
}

const avg = (legs: { price: number; size: number }[]) => {
  const size = legs.reduce((n, l) => n + l.size, 0);
  return size > 0 ? legs.reduce((n, l) => n + l.price * l.size, 0) / size : 0;
};

export function tradesFromFills(fills: LoggedFill[]): Reconstruction {
  const problems: string[] = [];
  const trades: ReconstructedTrade[] = [];

  const bySymbol = new Map<string, LoggedFill[]>();
  for (const f of fills) {
    // An order that never traded moved nothing. It must stay out of the walk
    // or every position count after it is wrong — but it is not junk either,
    // and attachBrackets reads it for the plan.
    if (f.status && f.status !== "filled") continue;
    if (!f.symbol || !(f.qty > 0) || !(f.price > 0)) {
      problems.push("A row was missing its symbol, size or price and was left out.");
      continue;
    }
    const at = logTime(f.time);
    if (!at) {
      problems.push(`A ${f.symbol} row had no readable time, so it could not be placed.`);
      continue;
    }
    const list = bySymbol.get(f.symbol) ?? [];
    list.push({ ...f, time: at });
    bySymbol.set(f.symbol, list);
  }

  for (const [symbol, rows] of Array.from(bySymbol.entries()).sort(([a], [b]) => (a < b ? -1 : 1))) {
    // Time order, not print order. A log sorted by symbol has each symbol's
    // rows newest first, which would put the cover before the entry.
    const ordered = rows
      .map((f, i) => ({ f, i }))
      .sort((a, b) => (a.f.time === b.f.time ? a.i - b.i : a.f.time < b.f.time ? -1 : 1))
      .map(({ f }) => f);

    /** The trade currently being built, or null while flat. */
    let open: {
      direction: "long" | "short";
      opens: (Leg & { fill: LoggedFill })[];
      closes: (Leg & { fill: LoggedFill })[];
    } | null = null;
    let pos = 0;

    const settle = () => {
      if (!open) return;
      const [first, ...adds] = open.opens;
      const closes = open.closes;
      const last = closes[closes.length - 1] ?? null;
      const entryPrice = first.price;

      /*
       * The stop, only where a fired stop order proves one. A trailing stop is
       * also a stop order and also fires; its trigger sits on the WINNING side
       * of the entry, and taking it as the planned risk would set 1R from a
       * number that was never the plan. So the side is checked, and when it is
       * the wrong one nothing is claimed.
       */
      let initialStop: number | null = null;
      let exitReason: "stop" | null = null;
      if (last && isStop(last.fill.kind)) {
        const level = last.fill.stopPrice ?? last.price;
        const losing = open.direction === "long" ? level < entryPrice : level > entryPrice;
        if (losing) {
          initialStop = level;
          exitReason = "stop";
        }
      }

      trades.push({
        symbol,
        direction: open.direction,
        size: first.size,
        entryPrice,
        entryTime: first.time,
        adds: adds.map(({ price, size, time }) => ({ price, size, time })),
        partials: closes.slice(0, -1).map(({ price, size, time }) => ({ price, size, time })),
        exitPrice: last?.price ?? null,
        exitTime: last?.time ?? null,
        initialStop,
        planTarget: null,
        brackets: [],
        exitReason,
        stillOpen: pos !== 0,
      });
      open = null;
    };

    for (const f of ordered) {
      const signed = f.side === "buy" ? f.qty : -f.qty;

      if (pos === 0) {
        open = { direction: signed > 0 ? "long" : "short", opens: [], closes: [] };
        open.opens.push({ price: f.price, size: f.qty, time: f.time, fill: f });
        pos = signed;
        continue;
      }

      const sameWay = Math.sign(signed) === Math.sign(pos);
      if (sameWay) {
        open!.opens.push({ price: f.price, size: f.qty, time: f.time, fill: f });
        pos += signed;
        continue;
      }

      // Closing, in whole or in part.
      const closing = Math.min(f.qty, Math.abs(pos));
      open!.closes.push({ price: f.price, size: closing, time: f.time, fill: f });
      const leftOver = f.qty - closing;
      pos += Math.sign(signed) * closing;

      if (pos === 0) {
        settle();
        /*
         * A fill larger than the position does not just close it, it turns it
         * around: the surplus is a new trade the other way. Clamping the
         * surplus away instead would silently lose a position the log plainly
         * records.
         */
        if (leftOver > 0) {
          open = { direction: signed > 0 ? "long" : "short", opens: [], closes: [] };
          open.opens.push({ price: f.price, size: leftOver, time: f.time, fill: f });
          pos = Math.sign(signed) * leftOver;
        }
      }
    }

    if (open) {
      // Never came back to flat. It is a running trade, not a broken one, and
      // guessing an exit for it would be inventing the only part that matters.
      settle();
      problems.push(
        `${symbol} does not come back to flat in this log — the last trade is still running.`,
      );
    }
  }

  return { trades, problems };
}

/** The average entry across the opening fill and any adds — for display. */
export function avgEntry(t: ReconstructedTrade): number {
  return avg([{ price: t.entryPrice, size: t.size }, ...t.adds]);
}

/** Everything that came off, averaged — the figure the broker would print. */
export function avgExit(t: ReconstructedTrade): number | null {
  const legs = [...t.partials];
  if (t.exitPrice != null) {
    const closed = legs.reduce((n, l) => n + l.size, 0);
    const total = t.size + t.adds.reduce((n, l) => n + l.size, 0);
    legs.push({ price: t.exitPrice, size: Math.max(total - closed, 0), time: t.exitTime ?? "" });
  }
  return legs.length ? avg(legs) : null;
}

/** Which leg of a bracket is this row? */
function bracketKind(kind: string | null): "stop" | "target" | null {
  if (!kind) return null;
  if (/take.?profit|profit.?target/i.test(kind)) return "target";
  if (/stop/i.test(kind)) return "stop";
  // A bare "Limit" that never filled could be anything — a resting entry, a
  // target, an order pulled before it mattered. Guessing would attach a plan
  // level to a trade off an order that was never part of it.
  return null;
}

/** Seconds of slack after the exit, for the broker cancelling its own bracket. */
const AUTOCANCEL_GRACE = 120;

const asSeconds = (t: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number) as unknown as number[];
  return Date.UTC(y, mo - 1, d, h, mi, se) / 1000;
};

/**
 * Attach the bracket legs to the trades they were live during.
 *
 * This is the half of the log a position walk has to throw away and the only
 * half that carries the PLAN: a take profit placed and then cancelled when
 * the position closed is the target as it stood, and no amount of fill data
 * contains it.
 *
 * What it will NOT do is call any of that the original plan. A level found
 * here is the level as it was at that moment, which is a different claim: a
 * stop in profit was moved, a target cancelled mid-trade was replaced. Both
 * are evidence about how the trade was MANAGED, and writing either into the
 * plan would put a number the trader never agreed to underneath every R the
 * trade produces.
 *
 * The one case where the log does prove the plan is the trade that ran into
 * its stop: nothing was moved, the bracket died with the position, and what
 * was live at the end is what was set at the start. Only there are the levels
 * offered as the plan; everywhere else they are shown and the trader types
 * what they actually intended.
 */
export function attachBrackets(
  trades: ReconstructedTrade[],
  rows: LoggedFill[],
): ReconstructedTrade[] {
  const legs = rows
    .filter((r) => r.status && r.status !== "filled")
    .map((r) => {
      const kind = bracketKind(r.kind);
      const level = kind === "stop" ? (r.stopPrice ?? r.limitPrice) : (r.limitPrice ?? r.stopPrice);
      const at = logTime(r.time);
      return kind && level && level > 0 && at && r.symbol
        ? { symbol: r.symbol, side: r.side, kind, level, time: at }
        : null;
    })
    .filter((b): b is NonNullable<typeof b> => b !== null);

  return trades.map((t, i) => {
    const from = asSeconds(t.entryTime);
    const exit = t.exitTime ? asSeconds(t.exitTime) : null;
    /*
     * The window runs from the entry to a little past the exit, because the
     * broker cancels its own bracket a moment AFTER the position flattens —
     * nine seconds, in the log that prompted this. It is clamped to the next
     * trade on the same symbol so the grace can never reach into one that had
     * already started.
     */
    const nextEntry = trades
      .slice(i + 1)
      .filter((o) => o.symbol === t.symbol)
      .map((o) => asSeconds(o.entryTime))
      .find((n) => n != null);
    let until = exit != null ? exit + AUTOCANCEL_GRACE : Infinity;
    if (nextEntry != null) until = Math.min(until, nextEntry);

    const mine = legs
      .filter((b) => {
        if (b.symbol !== t.symbol) return false;
        // A bracket closes the position, so it sits on the opposite side to it.
        if ((t.direction === "long") !== (b.side === "sell")) return false;
        const at = asSeconds(b.time);
        return at != null && from != null && at >= from && at <= until;
      })
      .sort((a, b) => (a.time < b.time ? -1 : 1))
      .map((b) => ({ kind: b.kind, level: b.level, time: b.time, filled: false }));

    // The stop that fired is a bracket too, and the most informative one.
    const brackets: Bracket[] =
      t.initialStop != null && t.exitTime
        ? [...mine, { kind: "stop" as const, level: t.initialStop, time: t.exitTime, filled: true }].sort(
            (a, b) => (a.time < b.time ? -1 : 1),
          )
        : mine;

    /*
     * Stopped out means nothing was moved, so the target still live at the end
     * is the one that was set at the start. Anywhere else the target is shown
     * but not claimed — it may be the third one the trader placed.
     */
    const winning = (level: number) =>
      t.direction === "long" ? level > t.entryPrice : level < t.entryPrice;
    const planTarget =
      t.exitReason === "stop"
        ? (mine.filter((b) => b.kind === "target" && winning(b.level)).pop()?.level ?? null)
        : null;

    return { ...t, brackets, planTarget };
  });
}

/** The whole log: the fills walked into trades, the rest read as their plan. */
export function tradesFromLog(rows: LoggedFill[]): Reconstruction {
  const walked = tradesFromFills(rows);
  return { ...walked, trades: attachBrackets(walked.trades, rows) };
}
