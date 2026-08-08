/**
 * Turning an account's fee schedule into a dollar suggestion for one trade.
 *
 * The schedule defines maker (limit) and taker (market) rates per side —
 * percent-of-notional for crypto, dollars-per-contract for futures. A trade
 * doesn't record which side used which order type, so instead of asking two
 * more questions at close time, the dialog offers the three realistic
 * combinations as one-click chips: market both ways (the scalp), limit both
 * ways (the patient fill), and limit in / market out (entered on a resting
 * order, exited in a hurry). Picking one just fills the fee field — the typed
 * number always wins.
 */
import type { AccountSettings } from "./schema";
import type { TradeWithFills } from "./fills";

export interface FeeSuggestion {
  key: string;
  label: string;
  dollars: number;
}

const toBase = (size: number, unit: string, price: number): number =>
  unit === "quote" ? (price > 0 ? size / price : 0) : size;

/**
 * Entry-side and exit-side volume for the whole trade, fills included:
 * everything bought (entry + adds) at the prices it was bought, everything
 * sold (partials + the close) at the prices it was sold. Notional in dollars
 * of underlying; quantity in base units.
 */
function sides(t: TradeWithFills, exitPrice: number) {
  const entryQty = toBase(t.size, t.sizeUnit, t.entryPrice);
  let inQty = entryQty;
  let inNotional = entryQty * t.entryPrice;
  let outQty = 0;
  let outNotional = 0;

  for (const f of t.fills ?? []) {
    const q = toBase(f.size, t.sizeUnit, f.price);
    if (f.kind === "add") {
      inQty += q;
      inNotional += q * f.price;
    } else {
      outQty += q;
      outNotional += q * f.price;
    }
  }
  // The remainder settles at the exit.
  const rest = Math.max(0, inQty - outQty);
  outQty += rest;
  outNotional += rest * exitPrice;
  return { inQty, inNotional, outQty, outNotional };
}

function feeFor(
  t: TradeWithFills,
  cfg: AccountSettings,
  exitPrice: number,
  inRate: number,
  outRate: number,
): number {
  const s = sides(t, exitPrice);
  const dollars =
    cfg.feeMode === "perContract"
      ? s.inQty * inRate + s.outQty * outRate
      : (s.inNotional * inRate + s.outNotional * outRate) / 100;
  return Math.round(dollars * 100) / 100;
}

/** The three order-type combinations worth offering, deduped when equal. */
export function suggestFees(
  t: TradeWithFills,
  cfg: AccountSettings | null | undefined,
  exitPrice: number | null | undefined,
): FeeSuggestion[] {
  if (!cfg || exitPrice == null || !(exitPrice > 0)) return [];
  if (cfg.makerFee === 0 && cfg.takerFee === 0) return [];

  const combos = [
    { key: "mm", label: "market in · out", inRate: cfg.takerFee, outRate: cfg.takerFee },
    { key: "lm", label: "limit in · market out", inRate: cfg.makerFee, outRate: cfg.takerFee },
    { key: "ll", label: "limit in · out", inRate: cfg.makerFee, outRate: cfg.makerFee },
  ];
  const out: FeeSuggestion[] = [];
  for (const c of combos) {
    const dollars = feeFor(t, cfg, exitPrice, c.inRate, c.outRate);
    if (dollars <= 0) continue;
    if (out.some((o) => o.dollars === dollars)) continue; // maker == taker → one chip
    out.push({ key: c.key, label: c.label, dollars });
  }
  // A flat schedule collapses to one number — order type stops mattering.
  if (out.length === 1 && cfg.makerFee === cfg.takerFee) {
    return [{ ...out[0], key: "flat", label: "entry + exit" }];
  }
  return out;
}
