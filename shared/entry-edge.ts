/**
 * Limit entries against market entries: is the difference real?
 *
 * The question a trader asks is "do my limits beat my market entries?", and
 * two averages side by side answer it badly in two ways.
 *
 * Small samples. Twelve limit trades at +0.6R and thirty market trades at
 * +0.1R look decisive and are often one good week. So each side carries
 * the spread of its own results, and the gap is set against the noise two
 * samples that size would show by chance (a Welch comparison of the mean
 * R). "Clear" means the gap is more than twice that noise; it is not a
 * proof, and the page says so.
 *
 * The trades a limit never got. A limit only fills when price comes back to
 * it, and the moves that never came back are not in the record as trades —
 * they are plans cancelled as "not filled". A limit record that looks
 * better partly because the runners left without it is a real effect, and
 * one the averages cannot show. So the orders that never filled are counted
 * beside it, with how many of them would have reached the target.
 */
import type { TradeWithTags } from "./schema";
import { closedTrades, computeMetrics, outcomeOf } from "./metrics";
import { ENTRY_TYPE_LABEL, isEntryType, type EntryType } from "./entry-type";

export interface EntrySide {
  type: EntryType;
  label: string;
  count: number;
  /** Of `count`, the trades with an R. */
  measured: number;
  wins: number;
  winRate: number;
  expectancyR: number;
  totalR: number;
  totalPnL: number;
  /** Average net P&L per trade; fees are already out of it. */
  avgPnL: number;
  totalFees: number;
  /** Standard deviation of R across the measured trades. */
  sdR: number;
  /** Ratio of R won to R lost; null with no losing R. */
  profitFactor: number | null;
}

export type EntryVerdict =
  /** One side has fewer measured trades than a comparison can rest on. */
  | "too-few"
  /** The gap is more than twice the noise. */
  | "clear"
  /** Between one and two times the noise: worth watching, not yet a finding. */
  | "leaning"
  /** Within the noise. */
  | "no-difference";

export interface EntryEdge {
  limit: EntrySide;
  market: EntrySide;
  /** Settled trades with no entry type recorded. */
  unknown: number;
  /** limit − market, in R per trade. */
  diffR: number;
  /** The standard error of that difference. */
  seDiffR: number;
  verdict: EntryVerdict;
  /** Which side the gap favours; null with no gap. */
  better: EntryType | null;
  /** Limit orders that were placed and never filled. */
  unfilled: number;
  /** Of those, the ones checked against the market afterwards. */
  unfilledResolved: number;
  /** Of those, the ones that would have reached the target. */
  unfilledWouldHaveWon: number;
}

/** Fewer measured trades than this on either side and no verdict is given. */
export const MIN_PER_SIDE = 8;

function side(type: EntryType, trades: TradeWithTags[]): EntrySide {
  const rs: number[] = [];
  let pnl = 0;
  let fees = 0;
  let wins = 0;
  for (const t of trades) {
    const m = computeMetrics(t);
    pnl += m.actualPnL ?? 0;
    fees += m.fees;
    const o = outcomeOf(m);
    if (o === "unmeasured") continue;
    rs.push(m.actualR as number);
    if (o === "win") wins += 1;
  }
  const n = rs.length;
  const totalR = rs.reduce((a, r) => a + r, 0);
  const mean = n ? totalR / n : 0;
  const variance = n > 1 ? rs.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1) : 0;
  const won = rs.filter((r) => r > 0).reduce((a, r) => a + r, 0);
  const lost = -rs.filter((r) => r < 0).reduce((a, r) => a + r, 0);
  return {
    type,
    label: ENTRY_TYPE_LABEL[type],
    count: trades.length,
    measured: n,
    wins,
    winRate: n ? wins / n : 0,
    expectancyR: mean,
    totalR,
    totalPnL: pnl,
    avgPnL: trades.length ? pnl / trades.length : 0,
    totalFees: fees,
    sdR: Math.sqrt(variance),
    profitFactor: lost > 0 ? won / lost : null,
  };
}

export function entryEdge(trades: TradeWithTags[]): EntryEdge {
  const settled = closedTrades(trades);
  const limit = side("limit", settled.filter((t) => t.entryType === "limit"));
  const market = side("market", settled.filter((t) => t.entryType === "market"));
  const unknown = settled.filter((t) => !isEntryType(t.entryType)).length;

  const diffR = limit.expectancyR - market.expectancyR;
  const se = (s: EntrySide) => (s.measured > 1 ? s.sdR ** 2 / s.measured : 0);
  const seDiffR = Math.sqrt(se(limit) + se(market));
  let verdict: EntryVerdict;
  if (limit.measured < MIN_PER_SIDE || market.measured < MIN_PER_SIDE) verdict = "too-few";
  else if (seDiffR === 0) verdict = diffR === 0 ? "no-difference" : "clear";
  else if (Math.abs(diffR) >= 2 * seDiffR) verdict = "clear";
  else if (Math.abs(diffR) >= seDiffR) verdict = "leaning";
  else verdict = "no-difference";

  // An order sent that never filled is a resting order by nature: a market order fills.
  const unfilled = trades.filter((t) => t.status === "cancelled" && t.cancelReason === "not_filled" && t.entryType !== "market");
  const resolved = unfilled.filter((t) => t.wouldHaveHitTarget != null);

  return {
    limit,
    market,
    unknown,
    diffR,
    seDiffR,
    verdict,
    better: diffR > 0 ? "limit" : diffR < 0 ? "market" : null,
    unfilled: unfilled.length,
    unfilledResolved: resolved.length,
    unfilledWouldHaveWon: resolved.filter((t) => t.wouldHaveHitTarget === true).length,
  };
}
