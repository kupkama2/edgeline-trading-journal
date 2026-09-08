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
  /** Epoch ms the price was read. */
  at: number;
  venue: "binance" | "hyperliquid";
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
    initialTarget: number | null;
    size: number;
    sizeUnit: string;
    pointValue: number;
  },
  price: number,
): Standing {
  const sign = t.direction === "short" ? -1 : 1;
  const risk = t.initialStop != null ? Math.abs(t.entryPrice - t.initialStop) : 0;
  const qty = t.sizeUnit === "quote" ? (t.entryPrice > 0 ? t.size / t.entryPrice : 0) : t.size;
  const perPoint = qty * (t.pointValue || 1);
  const move = sign * (price - t.entryPrice);

  const currentR = risk > 0 ? move / risk : null;
  const pnl = Number.isFinite(perPoint) && perPoint > 0 ? move * perPoint : null;
  const toStopR = risk > 0 && t.initialStop != null ? (sign * (price - t.initialStop)) / risk : null;
  const toTargetR =
    risk > 0 && t.initialTarget != null ? (sign * (t.initialTarget - price)) / risk : null;
  const crossedStop =
    t.initialStop != null && (sign > 0 ? price <= t.initialStop : price >= t.initialStop);
  const crossedTarget =
    t.initialTarget != null && (sign > 0 ? price >= t.initialTarget : price <= t.initialTarget);

  return { currentR, pnl, toStopR, toTargetR, crossedStop, crossedTarget };
}
