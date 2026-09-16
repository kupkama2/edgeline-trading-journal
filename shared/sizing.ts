/**
 * Position sizing from risk.
 *
 * The trader decides two things before size: where the stop goes, and how many
 * dollars the idea is allowed to cost. Size is then arithmetic, not judgement —
 * and doing that arithmetic in your head at the moment of entry is how "Bet Too
 * Large" happens. The numbers here are the same ones the metrics engine uses,
 * so the suggested size produces exactly the 1R the risk field promised.
 */
import { contractFor, pointValueFor } from "./symbols";

export interface SizeSuggestion {
  /** The size to enter, in the unit the trade will be logged in. */
  size: number;
  sizeUnit: "base" | "quote";
  /** What the suggested size actually risks — differs from the ask for
      contracts, which only come in integers. */
  actualRiskDollars: number;
  /** Dollars of risk per one contract/coin at this stop distance. */
  perUnitRisk: number;
}

/**
 * Suggest a size for a planned trade.
 *
 * Futures round DOWN to whole contracts: rounding up would quietly risk more
 * than the number the trader typed, which defeats the entire point. Zero
 * contracts is a legitimate answer — it means the stop is too far for the risk
 * budget, and saying so beats suggesting one contract of overexposure.
 */
export function suggestSize(input: {
  symbol: string;
  entryPrice: number;
  initialStop: number;
  riskDollars: number;
  sizeUnit: "base" | "quote";
  /**
   * The resolved dollars-per-point, when the caller already knows it — a
   * contract taught by hand has no entry in the table, and sizing it from the
   * table's 1.0 default would suggest a position a hundred times too large.
   */
  pointValue?: number | null;
}): SizeSuggestion | null {
  const { symbol, entryPrice, initialStop, riskDollars, sizeUnit } = input;
  if (!isFinite(entryPrice) || !isFinite(initialStop) || !isFinite(riskDollars)) return null;
  if (riskDollars <= 0 || entryPrice <= 0) return null;

  const stopDistance = Math.abs(entryPrice - initialStop);
  if (stopDistance <= 0) return null;

  if (sizeUnit === "quote") {
    // Notional N at entry E with stop distance D risks N·D/E. Solve for N.
    const notional = (riskDollars * entryPrice) / stopDistance;
    return {
      size: Math.round(notional * 100) / 100,
      sizeUnit: "quote",
      actualRiskDollars: riskDollars,
      perUnitRisk: stopDistance / entryPrice, // risk per $1 of notional
    };
  }

  const per =
    input.pointValue != null && isFinite(input.pointValue) && input.pointValue > 0
      ? input.pointValue
      : pointValueFor(symbol);
  const perContract = stopDistance * per;
  const contracts = Math.floor(riskDollars / perContract);
  return {
    size: contracts,
    sizeUnit: "base",
    actualRiskDollars: contracts * perContract,
    perUnitRisk: perContract,
  };
}

/* ------------------------------ the other unit ------------------------------ */

/** "ETHUSDT" → "ETH", "BTC-PERP" → "BTC", "1000PEPEUSDT" → "1000PEPE". */
export function coinOf(symbol: string | null | undefined): string {
  let s = (symbol ?? "").trim().toUpperCase();
  for (let i = 0; i < 2; i++) s = s.replace(/[-_/]?(USDT|USDC|BUSD|USD|PERP)$/, "");
  return s;
}

const fmtDollars = (v: number) =>
  "$" + v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 0 : 2 });
const fmtQty = (v: number) => {
  const dp = v >= 100 ? 0 : v >= 1 ? 2 : v >= 0.01 ? 4 : 6;
  const fixed = v.toFixed(dp);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
};

/**
 * The size in the unit you did not type, at the entry price.
 *
 * Typed in coins, a position is also so many dollars; typed in dollars, it
 * is also so many coins. Both are true at once, and the one you did not
 * type is the one you are about to misjudge — so the form says it. Futures
 * are bought in contracts and have no notional to convert; they get the
 * contract's exposure instead (exposureOf), and this says nothing.
 */
export function notionalReadout(input: {
  size: number;
  sizeUnit: "base" | "quote";
  entryPrice: number;
  symbol: string | null | undefined;
}): string | null {
  const { size, sizeUnit, entryPrice } = input;
  if (contractFor(input.symbol)) return null;
  if (!isFinite(size) || size <= 0 || !isFinite(entryPrice) || entryPrice <= 0) return null;
  const coin = coinOf(input.symbol) || "units";
  return sizeUnit === "base"
    ? `${fmtQty(size)} ${coin} ≈ ${fmtDollars(size * entryPrice)} at entry`
    : `${fmtDollars(size)} ≈ ${fmtQty(size / entryPrice)} ${coin} at entry`;
}
