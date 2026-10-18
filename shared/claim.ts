import type { TradeWithTags } from "./schema";

/**
 * Is this the same trade, written twice?
 *
 * A venue sync arrives with the position as the venue saw it. The journal may
 * already hold the same position as a person typed it — the entry rounded to
 * where the order sat, the time to when they got round to it, the P&L to what
 * the screen said. Written as two rows that is one trade counted twice, and
 * every number above it is wrong by that trade.
 *
 * So before the venue's version is written, the hand-written one is looked
 * for and, if found, CLAIMED: stamped with the venue's id so the next sync
 * finds it by name, and filled in where it was blank. Nothing a person wrote
 * is overwritten — their entry stays their entry — because the point of the
 * claim is that they already told the truth, approximately.
 *
 * "Approximately" has to be a number, and these are the numbers:
 *
 *   the same account, symbol and direction, always. Two directions are two
 *   trades whatever else agrees
 *
 *   entered within two hours of each other. A person logging after the fact
 *   writes the time they noticed, not the time it filled, and on a swing the
 *   difference is the gap between the alert and the desk
 *
 *   and then at least one of the figures agrees: the entry price within half
 *   a percent, the size within a percent, or — when both are closed — the
 *   realised P&L within five percent or a couple of dollars, whichever is
 *   kinder. A trade that matches on time alone is a coincidence, and the
 *   journal does not merge on coincidence
 *
 * Where several hand-written trades qualify, the nearest entry time wins. The
 * venue's trade may claim a hand-written one that is still OPEN when the
 * venue says it has closed — that is the common case, an entry logged and an
 * exit forgotten, and the sync fills the exit in. It may not claim one the
 * person has already closed when the venue says it is still open: that is
 * not the same trade, that is a different one on the same coin.
 */

/** The venue's reading of a position, in the terms the match is made in. */
export interface VenueTrade {
  symbol: string;
  direction: "long" | "short";
  entryTime: number;
  entryPrice: number;
  size: number;
  status: "open" | "closed";
  exitTime: number | null;
  closedPnl: number;
}

/** Two hours, in milliseconds. */
export const CLAIM_TIME_MS = 2 * 60 * 60 * 1000;
export const CLAIM_PRICE_PCT = 0.005;
export const CLAIM_SIZE_PCT = 0.01;
export const CLAIM_PNL_PCT = 0.05;
export const CLAIM_PNL_ABS = 2;

const within = (a: number, b: number, pct: number) =>
  Math.abs(a - b) <= pct * Math.max(Math.abs(a), Math.abs(b), 1e-12);

/**
 * A hand-logged trade's own P&L, where it has one.
 *
 * Read off the prices rather than the metrics module, which this file must
 * not pull in: the match wants the gross figure the venue reports, and gross
 * on a single round trip is just the move times the quantity.
 */
function manualPnl(t: TradeWithTags): number | null {
  // A scalp first: it is closed with no exit price by design, so the price
  // check below used to return before its typed result was ever read.
  if (t.status === "closed" && t.scalp) return t.netPnl ?? null;
  if (t.status !== "closed" || t.exitPrice == null) return null;
  const qty = t.sizeUnit === "quote" ? (t.entryPrice > 0 ? t.size / t.entryPrice : 0) : t.size;
  const sign = t.direction === "short" ? -1 : 1;
  return sign * (t.exitPrice - t.entryPrice) * qty * (t.pointValue || 1);
}

/** The size a hand-logged trade holds, in base units, for comparing with the venue's. */
function manualQty(t: TradeWithTags): number {
  return t.sizeUnit === "quote" ? (t.entryPrice > 0 ? t.size / t.entryPrice : 0) : t.size;
}

export function claimable(v: VenueTrade, t: TradeWithTags, symbolOf: (s: string) => string): boolean {
  if (t.externalId) return false;
  if (t.status === "cancelled" || t.status === "pending") return false;
  if (symbolOf(t.symbol) !== symbolOf(v.symbol)) return false;
  if (t.direction !== v.direction) return false;
  // A closed hand-written trade is not the venue's still-open one.
  if (t.status === "closed" && v.status === "open") return false;

  const when = new Date(t.entryTime).getTime();
  if (!Number.isFinite(when) || Math.abs(when - v.entryTime) > CLAIM_TIME_MS) return false;

  const priceClose = t.entryPrice > 0 && within(t.entryPrice, v.entryPrice, CLAIM_PRICE_PCT);
  const sizeClose = within(manualQty(t), v.size, CLAIM_SIZE_PCT);
  const pnl = manualPnl(t);
  const pnlClose =
    v.status === "closed" &&
    pnl != null &&
    (within(pnl, v.closedPnl, CLAIM_PNL_PCT) || Math.abs(pnl - v.closedPnl) <= CLAIM_PNL_ABS);
  return priceClose || sizeClose || pnlClose;
}

/**
 * The hand-logged trade this venue trade is, or null.
 *
 * `symbolOf` is how each caller spells a symbol the same way on both sides:
 * Hyperliquid says "BTC", Binance says "BTCUSDT", the journal says "BTC".
 */
export function findClaim(
  v: VenueTrade,
  candidates: TradeWithTags[],
  symbolOf: (s: string) => string = (s) => s.toUpperCase(),
): TradeWithTags | null {
  let best: TradeWithTags | null = null;
  let gap = Infinity;
  for (const t of candidates) {
    if (!claimable(v, t, symbolOf)) continue;
    const d = Math.abs(new Date(t.entryTime).getTime() - v.entryTime);
    if (d < gap) {
      gap = d;
      best = t;
    }
  }
  return best;
}
