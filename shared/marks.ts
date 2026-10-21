import { currentStop } from "./stops";
/**
 * Where an open trade stands against its plan, right now.
 *
 * An open row used to show the entry, the stop and the target — the plan —
 * and nothing about the market since. Whether the position is up two R or
 * a hair from its stop was a question for the exchange tab. Worse, a trade
 * whose stop had already been taken could sit in the open list for a week,
 * still "open", its loss missing from every number, because nobody had
 * come back to say so.
 *
 * One price fixes both: the current R, the distance to each level, and a
 * flag when price is already through one. The flag is deliberately a
 * question — "still open?" — because a level being crossed on a mid price
 * is strong evidence of a fill, not proof of one, and the journal writes
 * nothing on evidence alone.
 */

export interface Mark {
  price: number;
  /** Epoch ms the price is FOR — now for a live quote, the candle's time otherwise. */
  at: number;
  venue: "binance" | "hyperliquid";
  /** Which of the venue's books quoted it — they are not the same market. */
  book: "perp" | "spot";
  /**
   * The last price the journal could read rather than the price right now.
   *
   * Some books cannot be quoted live from where this runs — Binance's
   * perpetual API refuses some hosts outright and has no open mirror, while
   * its candle archive answers from anywhere, a day in arrears. A trade on
   * one of those had no P&L at all: two dashes beside a chart drawn from the
   * very prices that would have filled them in.
   *
   * So the last readable close stands in, and every figure built on it says
   * so. A day-old number labelled as a day old is useful; the same number
   * presented as live is the one thing this journal must never do.
   */
  stale?: boolean;
  /**
   * The Binance perp this trade is in, when the server could not price it
   * live — the browser asks that book itself (client/src/lib/perp-marks.ts).
   */
  perp?: string;
  /** Priced by the browser from the perp's own book rather than by the server. */
  fromBrowser?: boolean;
}

/**
 * How a mark should be read: the word beside the price, and the whole story.
 *
 * Three surfaces show a live price and all three have to say the same thing
 * about it, because the thing they have to say is a caveat. A perp marked
 * from spot is within basis; a perp marked from the archive is yesterday.
 * Neither is wrong to show and both are wrong to show silently, so the
 * wording lives here rather than three times over in three components.
 *
 * `when` is the caller's own formatting of `mark.at` — the locale belongs to
 * the browser, not to this file.
 */
export function markNote(
  mark: Pick<Mark, "book" | "stale" | "fromBrowser">,
  when: string,
): { badge: string | null; title: string } {
  if (mark.stale)
    return {
      badge: "last read",
      title: `Nothing will quote this book from here, so this is the last close the journal could read — ${when}. The figures beside it are as of then.`,
    };
  if (mark.book === "spot")
    return {
      // "spot price", not "spot": the word sits beside the trade, and on its
      // own it reads as what the trade is rather than where its price came from.
      badge: "spot price",
      title:
        "Priced on the spot book because the perpetual's own price could not be read — within basis of it, not its own print.",
    };
  // Live, from the book the position is actually in. Nothing to warn about,
  // so nothing is said — a badge on every row is a badge nobody reads.
  return {
    badge: null,
    title: mark.fromBrowser
      ? `Live from the perpetual's own book, read by this browser — ${when}`
      : `Live — ${when}`,
  };
}

export interface Standing {
  /** Signed, in R of the original stop. Null without a stop. */
  currentR: number | null;
  /** Unrealised, in the quote currency. */
  pnl: number | null;
  /** How far the stop still is, in R. Negative once price is through it. */
  toStopR: number | null;
  /** How far the target still is, in R. Negative once price is through it. */
  toTargetR: number | null;
  crossedStop: boolean;
  crossedTarget: boolean;
}

/**
 * The plan measured against one price.
 *
 * Crossing is inclusive — price AT the stop is the stop being hit, the same
 * reading the candle scan uses — and it is judged on the price given, which
 * is a mid or a last trade, not a wick. So it can miss a touch that a wick
 * made and reversed; it cannot invent one.
 */
export function standingOf(
  t: {
    direction: string;
    entryPrice: number;
    initialStop: number | null;
    /** Moves of the stop since entry; the last one is the stop in force. */
    stopMoves?: string | null;
    initialTarget: number | null;
    size: number;
    sizeUnit: string;
    pointValue: number;
  },
  price: number,
): Standing {
  /*
   * R is measured against the ORIGINAL stop — it is the denominator, and a
   * stop pulled up does not change what the trade risked. But whether the
   * stop has been reached, and how far away it is, are questions about the
   * stop in force now. A long at 100 with its stop moved to 105 and price at
   * 103 has been stopped out, whatever the plan said.
   */
  const stopNow = currentStop(t);
  const sign = t.direction === "short" ? -1 : 1;
  const risk = t.initialStop != null ? Math.abs(t.entryPrice - t.initialStop) : 0;
  const qty = t.sizeUnit === "quote" ? (t.entryPrice > 0 ? t.size / t.entryPrice : 0) : t.size;
  const perPoint = qty * (t.pointValue || 1);
  const move = sign * (price - t.entryPrice);

  const currentR = risk > 0 ? move / risk : null;
  const pnl = Number.isFinite(perPoint) && perPoint > 0 ? move * perPoint : null;
  const toStopR = risk > 0 && stopNow != null ? (sign * (price - stopNow)) / risk : null;
  const toTargetR =
    risk > 0 && t.initialTarget != null ? (sign * (t.initialTarget - price)) / risk : null;
  const crossedStop = stopNow != null && (sign > 0 ? price <= stopNow : price >= stopNow);
  const crossedTarget =
    t.initialTarget != null && (sign > 0 ? price >= t.initialTarget : price <= t.initialTarget);

  return { currentR, pnl, toStopR, toTargetR, crossedStop, crossedTarget };
}
