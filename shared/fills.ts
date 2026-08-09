/**
 * The position ledger — what a trade's fills add up to.
 *
 * A trade with fills is one idea executed in pieces: the entry, maybe adds,
 * maybe partials, then the close. This module walks those pieces in time
 * order and answers the questions the flat trade row no longer can on its
 * own: what is the average entry now, how much is still on, and how much is
 * already banked.
 *
 * Two conventions, chosen deliberately and used everywhere:
 *
 *  - Adds move the WEIGHTED AVERAGE entry, and partials realise against that
 *    average — cash-flow accounting, the same maths the broker uses.
 *  - R stays measured against the ORIGINAL planned risk: entry-to-stop on
 *    the size you opened with. Scaling in raises exposure, but "how many R
 *    did this make" keeps meaning "against what I first agreed to lose".
 *    An add that doubles the position does not quietly halve every R.
 */
import { parseExtraTargets, type Trade, type TradeFill } from "./schema";

/** A trade whose fills came along for the ride (TradeWithTags satisfies this). */
export type TradeWithFills = Trade & { fills?: TradeFill[] };

/** Convert a size in the trade's unit into base units (contracts/coins). */
function baseQty(size: number, unit: string, price: number): number {
  if (unit === "quote") return price > 0 ? size / price : 0;
  return size;
}

export interface PositionLedger {
  /** Weighted average entry across the opening fill and every add. */
  avgEntry: number;
  /** Base-unit quantity still open after all partials. */
  openQty: number;
  /** Base-unit quantity of the original entry alone. */
  initialQty: number;
  /** P&L already banked by partials, in dollars. */
  realizedPnL: number;
  /** Count of each kind, for the UI's little chips. */
  adds: number;
  partials: number;
}

/**
 * Walk the fills in time order and produce the ledger.
 *
 * A partial larger than what is open is clamped rather than driven negative —
 * the journal records what happened, and "sold more than you had" is a data
 * entry slip, not a short position materialising mid-trade.
 */
export function positionLedger(t: TradeWithFills): PositionLedger {
  const sign = t.direction === "long" ? 1 : -1;
  const pv = t.pointValue ?? 1;
  const initialQty = baseQty(t.size, t.sizeUnit, t.entryPrice);

  let qty = initialQty;
  let avgEntry = t.entryPrice;
  let realized = 0;
  let adds = 0;
  let partials = 0;

  const ordered = [...(t.fills ?? [])].sort((a, b) => a.time.localeCompare(b.time));
  for (const f of ordered) {
    const fq = baseQty(f.size, t.sizeUnit, f.price);
    if (f.kind === "add") {
      // New average = total cost / total quantity.
      avgEntry = qty + fq > 0 ? (avgEntry * qty + f.price * fq) / (qty + fq) : avgEntry;
      qty += fq;
      adds += 1;
    } else {
      const closing = Math.min(fq, qty);
      realized += sign * (f.price - avgEntry) * closing * pv;
      qty -= closing;
      partials += 1;
    }
  }

  return { avgEntry, openQty: qty, initialQty, realizedPnL: realized, adds, partials };
}

/**
 * Total P&L for a closed trade with fills: everything the partials banked,
 * plus the remainder settled at the exit price.
 */
export function totalPnLWithFills(t: TradeWithFills): number | null {
  if (t.exitPrice == null) return null;
  const sign = t.direction === "long" ? 1 : -1;
  const led = positionLedger(t);
  return led.realizedPnL + sign * (t.exitPrice - led.avgEntry) * led.openQty * (t.pointValue ?? 1);
}

/**
 * Flatten a scaled trade back into a single entry and a single exit.
 *
 * Sometimes the scaling is noise: you took three pieces, the broker reports
 * one average, and you would rather the journal said the same. This computes
 * the one-in/one-out trade that settles for EXACTLY the same money — total
 * quantity, the volume-weighted average of everything bought, and the
 * volume-weighted average of everything sold.
 *
 * That equality is not an approximation. Once a position is flat, P&L is
 * cash-flow: proceeds minus cost. Average-cost bookkeeping and a single
 * averaged round trip agree on both sides of that subtraction, so collapsing
 * the fills cannot move the number — only the story of how it got there.
 *
 * R is a different matter, and only when the trade was scaled IN. This app
 * measures R against the original planned risk — entry-to-stop on the size
 * you opened with — so folding adds into the entry and size necessarily
 * rebases the denominator: a trade that risked $20 by plan and became a $60
 * position reports the same dollars against a larger 1R. Collapsing a trade
 * that was only scaled OUT touches neither entry nor size, so its R is
 * untouched too. Callers should say so before doing it to a scaled-in trade.
 *
 * Returns null when there is nothing to collapse (no fills, or the trade has
 * not been closed, so there is no final sell to average against).
 */
export function collapseFills(
  t: TradeWithFills,
): { size: number; entryPrice: number; exitPrice: number } | null {
  if (!t.fills?.length || t.exitPrice == null) return null;

  let boughtQty = baseQty(t.size, t.sizeUnit, t.entryPrice);
  let boughtCost = boughtQty * t.entryPrice;
  let soldQty = 0;
  let soldProceeds = 0;

  for (const f of [...t.fills].sort((a, b) => a.time.localeCompare(b.time))) {
    const q = baseQty(f.size, t.sizeUnit, f.price);
    if (f.kind === "add") {
      boughtQty += q;
      boughtCost += q * f.price;
    } else {
      // Clamp for the same reason positionLedger does: a partial bigger than
      // the position is a typo, not a reversal.
      const closing = Math.min(q, boughtQty - soldQty);
      soldQty += closing;
      soldProceeds += closing * f.price;
    }
  }

  // Whatever is still open settles at the recorded exit.
  const rest = Math.max(0, boughtQty - soldQty);
  soldQty += rest;
  soldProceeds += rest * t.exitPrice;

  if (!(boughtQty > 0) || !(soldQty > 0)) return null;
  const entryPrice = boughtCost / boughtQty;
  const exitPrice = soldProceeds / soldQty;

  return {
    // Quote-sized trades store notional, and notional/entry must still give
    // back the same base quantity, so the size travels through the new entry.
    size: t.sizeUnit === "quote" ? boughtQty * entryPrice : boughtQty,
    entryPrice,
    exitPrice,
  };
}

/**
 * Convert a size typed in one unit into the trade's own unit, at the fill
 * price. Fills are STORED in the trade's unit — this exists so the dialog can
 * accept "take $2,750 off" on a coin-sized position (or "take 0.05 BTC" on a
 * notional-sized one) and hand the ledger the number it already speaks.
 * Crossing units needs a price; without one there is no conversion, so null.
 */
export function convertFillSize(
  size: number,
  from: "base" | "quote",
  to: "base" | "quote",
  price: number,
): number | null {
  if (!isFinite(size) || size <= 0) return null;
  if (from === to) return size;
  if (!isFinite(price) || price <= 0) return null;
  return to === "base" ? size / price : size * price;
}

/**
 * Equal-split suggestion for the next partial: what's still on, divided by
 * the planned TP levels not yet taken. Returned in the trade's own size unit
 * (USD for quote-sized trades, converted at the given price, falling back to
 * the next planned TP). Futures suggest whole contracts; coins split
 * fractionally.
 *
 * Null when no hint applies: one level (or none) left — that piece is the
 * exit and belongs to Close — or a position too small to split, like a 1-lot.
 * The last taker naturally inherits whatever rounding left behind, because
 * the suggestion is recomputed from what actually remains each time.
 */
export function suggestPartialSize(
  t: TradeWithFills,
  price?: number | null,
): number | null {
  const led = positionLedger(t);
  const tps = [t.initialTarget, ...parseExtraTargets(t.extraTargets)].filter(
    (x): x is number => x != null,
  );
  const remaining = tps.length - led.partials;
  if (remaining < 2 || led.openQty <= 0) return null;
  const base = led.openQty / remaining;

  if (t.sizeUnit === "quote") {
    const px = price && price > 0 ? price : (tps[led.partials] ?? t.entryPrice);
    const usd = Math.round(base * px);
    return usd > 0 ? usd : null;
  }
  const s =
    (t.pointValue ?? 1) !== 1
      ? Math.max(1, Math.round(base))
      : Math.round(base * 1e4) / 1e4;
  return s > 0 && s < led.openQty - 1e-9 ? s : null;
}

/**
 * Can this fill be applied? Returns an error message, or null when fine.
 *
 * A partial that would flatten the position entirely is refused on purpose:
 * the LAST piece is the exit, and it belongs in the close flow where the exit
 * reason, MAE/MFE and demons get recorded. Letting a partial zero the trade
 * would leave an "open" position of nothing, invisible to every closing ritual
 * the journal is built around.
 */
export function validateFill(
  t: TradeWithFills,
  fill: { kind: "add" | "partial"; price: number; size: number },
): string | null {
  if (t.status !== "open") return "Fills only apply to open trades.";
  if (!(fill.price > 0) || !(fill.size > 0)) return "Price and size must be positive.";

  if (fill.kind === "partial") {
    const led = positionLedger(t);
    const fq = baseQty(fill.size, t.sizeUnit, fill.price);
    if (fq >= led.openQty - 1e-9) {
      return "That would close the whole position — use Close instead, so the exit gets recorded properly.";
    }
  }
  return null;
}
