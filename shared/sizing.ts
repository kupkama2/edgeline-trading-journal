/**
 * Position sizing from risk.
 *
 * The trader decides two things before size: where the stop goes, and how many
 * dollars the idea is allowed to cost. Size is then arithmetic, not judgement —
 * and doing that arithmetic in your head at the moment of entry is how "Bet Too
 * Large" happens. The numbers here are the same ones the metrics engine uses,
 * so the suggested size produces exactly the 1R the risk field promised.
 */
import { pointValueFor } from "./symbols";

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
