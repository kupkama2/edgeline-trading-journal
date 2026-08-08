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
import type { Trade, TradeFill } from "./schema";

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
