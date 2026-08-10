/**
 * The five numbers that say whether the trading is any good — and one score
 * that says it in a word.
 *
 * Every journal shows win rate. On its own it is the most misleading figure in
 * trading: 80% wins with a 0.3 payoff is a losing system, and 35% wins with a
 * 4.0 payoff is a very good one. So win rate never appears here without its
 * partner, and the score below refuses to reward either in isolation.
 *
 * WHAT THE SCORE IS. Four components, 25 points each, chosen because they are
 * the four ways a trading record can be good — and because a record can look
 * good on any one of them while being bad:
 *
 *   Edge         expectancy per trade, in R. The thing that compounds.
 *   Consistency  SQN — expectancy divided by its own volatility, scaled by
 *                sample size. A +0.4R average from steady trades scores far
 *                above the same average produced by one lucky outlier, which
 *                is exactly the distinction expectancy alone cannot make.
 *   Discipline   the share of trades that were logged like a professional:
 *                a written why, a named exit, no demons. The only component
 *                you control completely, and the only one that can be perfect
 *                during a losing month.
 *   Management   how much of the move you kept, against how far it ran.
 *
 * Deliberately NOT in the score: total P&L, streaks, and anything else that
 * rewards size or luck. The score should be unchanged by trading the same
 * edge twice as large.
 *
 * Below ~20 closed trades the numbers are noise, and the score says so rather
 * than flattering a good week.
 */
import type { TradeWithTags } from "./schema";
import { closedTrades, computeMetrics } from "./metrics";
import { parseHighlights } from "./highlights";

/** Under this many closed trades, the figures are not yet evidence. */
export const SCORE_MIN_SAMPLE = 20;

export interface Scorecard {
  count: number;
  winRate: number;
  /** Average winner ÷ average loser, in R. The other half of win rate. */
  payoff: number;
  /** Mean R per trade. */
  expectancyR: number;
  /** Gross profit ÷ gross loss, in dollars. */
  profitFactor: number;
  /** Van Tharp's System Quality Number: mean/σ × √n, n capped at 100. */
  sqn: number;
  /** Total realised R and dollars, net of fees. */
  totalR: number;
  totalPnL: number;
  /** Cumulative R after each closed trade, oldest first — the sparkline. */
  curve: number[];
  /** 0–100, plus the four parts it came from. Null below the sample floor. */
  score: number | null;
  parts: { label: string; points: number; max: number; hint: string }[];
  /** One line naming the binding constraint. */
  verdict: string;
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function stdev(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

/** Map a value onto 0..max, saturating at `good`. */
const band = (v: number, good: number, max: number) =>
  Math.max(0, Math.min(max, (v / good) * max));

export function scorecard(trades: TradeWithTags[]): Scorecard {
  const closed = closedTrades(trades)
    .slice()
    .sort((a, b) => (a.exitTime ?? a.entryTime).localeCompare(b.exitTime ?? b.entryTime));
  const rows = closed.map((t) => ({ t, m: computeMetrics(t) }));
  const rs = rows.map((r) => r.m.actualR ?? 0);
  const pnls = rows.map((r) => r.m.actualPnL ?? 0);

  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const grossWin = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0));
  const avgWin = mean(wins);
  const avgLoss = Math.abs(mean(losses));

  const expectancyR = mean(rs);
  const sd = stdev(rs);
  // Zero variance is perfect consistency, not the absence of it: a record of
  // identical results should score top marks if those results are positive.
  // Guarding with 0 would have handed the most consistent possible book the
  // worst possible consistency score.
  const sqn =
    sd > 0
      ? (expectancyR / sd) * Math.sqrt(Math.min(rs.length, 100))
      : expectancyR > 0
        ? 99
        : 0;

  let cum = 0;
  const curve = rs.map((r) => (cum += r));

  // Discipline: judged on what the log itself can verify.
  const disciplined = rows.filter(
    ({ t }) =>
      Boolean(t.rationale?.trim()) && Boolean(t.exitReason) && t.mistakeTagIds.length === 0,
  ).length;
  const disciplineRate = rows.length ? disciplined / rows.length : 0;

  const captures = rows
    .map((r) => r.m.captureRatioClipped)
    .filter((c): c is number => c != null);

  const parts = [
    {
      label: "Edge",
      points: band(expectancyR, 0.5, 25),
      max: 25,
      hint: `${expectancyR >= 0 ? "+" : ""}${expectancyR.toFixed(2)}R per trade`,
    },
    {
      label: "Consistency",
      points: band(sqn, 3, 25),
      max: 25,
      hint: `SQN ${sqn.toFixed(1)}`,
    },
    {
      label: "Discipline",
      points: band(disciplineRate, 0.9, 25),
      max: 25,
      hint: `${Math.round(disciplineRate * 100)}% logged clean`,
    },
    {
      label: "Management",
      points: captures.length ? band(mean(captures), 0.6, 25) : 0,
      max: 25,
      hint: captures.length
        ? `kept ${Math.round(mean(captures) * 100)}% of the move`
        : "no MAE/MFE logged",
    },
  ].map((p) => ({ ...p, points: Math.round(p.points) }));

  const enough = closed.length >= SCORE_MIN_SAMPLE;
  const score = enough ? parts.reduce((a, p) => a + p.points, 0) : null;

  return {
    count: closed.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    payoff: avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0,
    expectancyR,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    sqn,
    totalR: rs.reduce((a, b) => a + b, 0),
    totalPnL: pnls.reduce((a, b) => a + b, 0),
    curve,
    score,
    parts,
    verdict: verdictFor(closed.length, expectancyR, parts),
  };
}

/**
 * Name the binding constraint — the lowest-scoring part — because "78/100" is
 * a grade and what a grade is for is knowing what to work on next.
 */
function verdictFor(
  n: number,
  expectancyR: number,
  parts: { label: string; points: number; max: number }[],
): string {
  if (n < SCORE_MIN_SAMPLE) {
    return `${SCORE_MIN_SAMPLE - n} more closed ${
      SCORE_MIN_SAMPLE - n === 1 ? "trade" : "trades"
    } before these numbers mean anything.`;
  }
  const worst = parts.reduce((a, b) => (b.points < a.points ? b : a));
  const total = parts.reduce((a, p) => a + p.points, 0);
  const lead =
    total >= 75
      ? "This is a good record."
      : total >= 50
        ? "The record is working."
        : expectancyR > 0
          ? "Marginally profitable."
          : "Not profitable yet.";
  const fix: Record<string, string> = {
    Edge: "The average trade barely pays — the setups themselves are the constraint.",
    Consistency: "Results swing hard around that average; the edge is not repeatable yet.",
    Discipline: "The weak link is the logging: rationale, named exits, demons left untagged.",
    Management: "You are giving back most of what the moves offer — exits are the constraint.",
  };
  return `${lead} ${fix[worst.label]}`;
}
