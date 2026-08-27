import type { Trade, TradeFill, TradeWithTags } from "./schema";
import { totalPnLWithFills } from "./fills";

export interface TradeMetrics {
  risk: number; // per-unit risk in price terms
  riskDollars: number; // 1R in $
  /** NET of fees when fees are recorded — the R that actually hit the account. */
  actualR: number | null;
  /** NET of fees when fees are recorded. */
  actualPnL: number | null;
  /** What the price action alone made, before fees. Equal to actualPnL when no fees. */
  grossPnL: number | null;
  /** Dollars paid in commission on this trade; 0 when not recorded. */
  fees: number;
  mfeR: number | null;
  maeR: number | null;
  potentialR: number | null;
  potentialPnL: number | null;
  managementDeltaR: number | null;
  managementDeltaDollars: number | null;
  captureRatio: number | null; // raw
  captureRatioClipped: number | null; // clipped to [0,1]
  /**
   * The LATE cost: in-trade peak minus exit, in R. What was reached while you
   * were in and then handed back. mfe is strictly in-trade, so this can no
   * longer be inflated by a run that happened after you were out.
   */
  rLeftOnTable: number | null;
  dollarsLeftOnTable: number | null;
  /**
   * The EARLY cost: post-exit peak minus exit, in R, clamped ≥ 0. What the
   * move did after you left, before your stop level broke. The other half of
   * "it went higher" — the half you were not in for.
   */
  leftBehindR: number | null;
  dollarsLeftBehind: number | null;
  /**
   * R the exit AVOIDED — how much further it went against you once you were
   * out, measured from the exit. ≥ 0, null when the aftermath wasn't recorded.
   *
   * The only figure here that can come out in an exit's favour. On a stop-out
   * it is what the stop saved you, which is the other half of "was my stop
   * too tight" — without it every measurement in this file prices the cost of
   * getting out and none prices the cost of staying in.
   */
  avoidedR: number | null;
  dollarsAvoided: number | null;
}

/**
 * Position size in base units (contracts or coins), whatever unit it was
 * entered in. A crypto trade sized as "4,655 USDT" holds 4655/entry coins, and
 * every P&L and risk figure below is per-unit-of-price — so they all need base
 * units, not the number the user typed.
 */
export function positionQty(t: Trade): number {
  if (t.sizeUnit === "quote") {
    return t.entryPrice > 0 ? t.size / t.entryPrice : 0;
  }
  return t.size;
}

/**
 * What one point of price movement is worth across the whole position, in
 * dollars. Futures need their contract multiplier here — 2 MNQ contracts move
 * $4 a point, 2 NQ move $40 — while crypto and equities have a point value of
 * 1 and reduce to plain quantity.
 */
function dollarsPerPoint(t: Trade): number {
  return positionQty(t) * (t.pointValue ?? 1);
}

export function computeMetrics(t: Trade & { fills?: TradeFill[] }): TradeMetrics {
  const sign = t.direction === "long" ? 1 : -1;
  const perPoint = dollarsPerPoint(t);
  // A pending trade has no stop yet, so it has no 1R. Guard explicitly: without
  // this, null coerces to 0 and every R figure silently becomes entry-relative
  // nonsense rather than being reported as unknown.
  const risk = t.initialStop == null ? 0 : Math.abs(t.entryPrice - t.initialStop);
  const riskDollars = risk * perPoint;
  const safe = risk > 0;

  /*
   * A trade with fills settles by the cash-flow ledger: partials banked P&L on
   * the way, adds moved the average entry, and the close settles the rest.
   * R divides that total by the ORIGINAL planned risk (entry-to-stop on the
   * opening size), so scaling in raises exposure without quietly re-basing
   * every R the journal reports. With no fills this is the plain single-fill
   * arithmetic it always was — same numbers to the last bit.
   */
  const hasFills = (t.fills?.length ?? 0) > 0;
  const filledPnL = hasFills ? totalPnLWithFills(t) : null;

  // Fees only bite once the trade has actually settled — an open trade has
  // nothing to deduct from. When zero (all history), every branch below is
  // bit-identical to the pre-fee arithmetic.
  const fees = t.exitPrice != null ? (t.fees ?? 0) : 0;

  const grossPnL =
    filledPnL != null
      ? filledPnL
      : t.exitPrice != null
        ? sign * (t.exitPrice - t.entryPrice) * perPoint
        : null;
  const actualPnL = grossPnL != null ? grossPnL - fees : null;
  const actualR =
    safe && t.exitPrice != null
      ? filledPnL != null && riskDollars > 0
        ? (filledPnL - fees) / riskDollars
        : fees !== 0 && riskDollars > 0
          ? (sign * (t.exitPrice - t.entryPrice) * perPoint - fees) / riskDollars
          : (sign * (t.exitPrice - t.entryPrice)) / risk
      : null;
  const mfeR = safe && t.mfe != null ? (sign * (t.mfe - t.entryPrice)) / risk : null;
  const maeR = safe && t.mae != null ? (sign * (t.mae - t.entryPrice)) / risk : null;

  let potentialR: number | null = null;
  if (safe && t.noManagementOutcome === "target_first") {
    if (t.initialTarget != null) {
      potentialR = (sign * (t.initialTarget - t.entryPrice)) / risk;
    }
  } else if (t.noManagementOutcome === "stop_first") {
    potentialR = -1;
  }

  const managementDeltaR =
    actualR != null && potentialR != null ? actualR - potentialR : null;
  const captureRatio =
    actualR != null && mfeR != null && mfeR !== 0 ? actualR / mfeR : null;
  const rLeftOnTable = actualR != null && mfeR != null ? mfeR - actualR : null;
  // Clamped: a post-exit peak on the wrong side of the exit means the move
  // died the moment you left, which is zero cost, not negative cost.
  const leftBehindR =
    safe && t.postExitPeak != null && t.exitPrice != null
      ? Math.max(0, (sign * (t.postExitPeak - t.exitPrice)) / risk)
      : null;
  // The mirror, clamped the same way: an "adverse" print on the favourable
  // side of the exit means nothing was avoided, not that leaving cost you.
  const avoidedR =
    safe && t.postExitAdverse != null && t.exitPrice != null
      ? Math.max(0, (sign * (t.exitPrice - t.postExitAdverse)) / risk)
      : null;

  return {
    risk,
    riskDollars,
    actualR,
    actualPnL,
    grossPnL,
    fees,
    mfeR,
    maeR,
    potentialR,
    potentialPnL: potentialR != null ? potentialR * riskDollars : null,
    managementDeltaR,
    managementDeltaDollars:
      managementDeltaR != null ? managementDeltaR * riskDollars : null,
    captureRatio,
    captureRatioClipped:
      captureRatio != null ? Math.max(0, Math.min(1, captureRatio)) : null,
    rLeftOnTable,
    dollarsLeftOnTable: rLeftOnTable != null ? rLeftOnTable * riskDollars : null,
    leftBehindR,
    dollarsLeftBehind: leftBehindR != null ? leftBehindR * riskDollars : null,
    avoidedR,
    dollarsAvoided: avoidedR != null ? avoidedR * riskDollars : null,
  };
}

/* --------------------------- exit timing read --------------------------- */

/** A cost below this is noise, not a verdict. Half an R is real money. */
export const EXIT_TIMING_MEANINGFUL_R = 0.5;

export interface ExitTimingRead {
  verdict: "early" | "late" | "clean";
  /** Given back: in-trade peak to exit, ≥ 0. Null when MFE wasn't recorded. */
  giveBackR: number | null;
  /** Left behind: exit to post-exit peak, ≥ 0. Null when not recorded. */
  leftBehindR: number | null;
}

/**
 * What the numbers say the exit was — the arithmetic counterpart to the
 * self-reported exit grade, from the two halves of "it went higher":
 *
 *   gave back    reached WHILE IN, closed below it   -> late
 *   left behind  ran on AFTER the exit               -> early
 *
 * The larger meaningful cost wins; both under the threshold is a clean exit.
 * Null when neither leg was recorded — no data is not a verdict, and a trade
 * with only one leg measured is judged on the leg it has.
 *
 * This exists because the grade is filled in by hand and the fields can be
 * mislogged in exactly the way that inverts the story (a post-exit run typed
 * into MFE turns "early" into "late"). Showing the arithmetic reading beside
 * the grade catches the disagreement at entry time instead of in next month's
 * stats.
 */
export function exitTimingRead(m: TradeMetrics): ExitTimingRead | null {
  return exitTimingVerdict(
    m.rLeftOnTable != null ? Math.max(0, m.rLeftOnTable) : null,
    m.leftBehindR,
  );
}

/** The core rule, on raw R values, so a form can ask before a trade is saved. */
export function exitTimingVerdict(
  giveBackR: number | null,
  leftBehindR: number | null,
): ExitTimingRead | null {
  if (giveBackR == null && leftBehindR == null) return null;
  const gb = giveBackR ?? 0;
  const lb = leftBehindR ?? 0;
  const verdict =
    lb >= EXIT_TIMING_MEANINGFUL_R && lb > gb
      ? "early"
      : gb >= EXIT_TIMING_MEANINGFUL_R
        ? "late"
        : "clean";
  return { verdict, giveBackR, leftBehindR };
}

export function rToDollars(r: number, t: Trade): number {
  if (t.initialStop == null) return 0; // no stop yet ⇒ no defined 1R to scale by
  return r * Math.abs(t.entryPrice - t.initialStop) * dollarsPerPoint(t);
}

/** $ cost attributable to poor management / left-on-table for a single trade. */
export function tradeMistakeCost(t: Trade): number {
  const m = computeMetrics(t);
  const fromDelta =
    m.managementDeltaDollars != null && m.managementDeltaDollars < 0
      ? -m.managementDeltaDollars
      : 0;
  const fromTable =
    m.dollarsLeftOnTable != null && m.dollarsLeftOnTable > 0
      ? m.dollarsLeftOnTable
      : 0;
  return Math.max(fromDelta, fromTable);
}

/** Rank mistake tags by total $ cost, splitting each trade's cost evenly across its tags. */
export function mistakeCostLeaderboard(
  trades: TradeWithTags[],
  tagNames: Record<number, string>,
): { tagId: number; name: string; cost: number; trades: number }[] {
  const acc: Record<number, { cost: number; trades: number }> = {};
  for (const t of trades) {
    if (t.status !== "closed" || t.mistakeTagIds.length === 0) continue;
    const cost = tradeMistakeCost(t);
    if (cost <= 0) continue;
    const per = cost / t.mistakeTagIds.length;
    for (const id of t.mistakeTagIds) {
      if (!acc[id]) acc[id] = { cost: 0, trades: 0 };
      acc[id].cost += per;
      acc[id].trades += 1;
    }
  }
  return Object.entries(acc)
    .map(([id, v]) => ({
      tagId: Number(id),
      name: tagNames[Number(id)] ?? "Unknown",
      cost: v.cost,
      trades: v.trades,
    }))
    .sort((a, b) => b.cost - a.cost);
}

export interface AggregateStats {
  count: number;
  wins: number;
  losses: number;
  winRate: number;
  expectancyR: number;
  avgWinnerR: number;
  avgLoserR: number;
  /**
   * The same three in dollars.
   *
   * Not conversions — each is the mean of the trades' own realised P&L, so a
   * flat expectancy in R beside a negative one in dollars says the losers
   * were the big positions. Multiplying an R average by "a typical 1R" would
   * produce a plausible number that hides exactly that.
   */
  expectancyPnL: number;
  avgWinnerPnL: number;
  avgLoserPnL: number;
  profitFactor: number;
  avgCapture: number;
  totalR: number;
  totalPnL: number;
  totalDeltaR: number;
}

/**
 * Trades with a realised outcome — the only ones any statistic may speak
 * about. A pending order has no result, and an open one has not finished
 * being wrong. Owned here because every consumer (aggregates, breakdowns,
 * simulations) must agree on it, and three inlined copies of the filter is
 * how they stop agreeing.
 */
export function closedTrades<T extends Trade>(trades: T[]): T[] {
  return trades.filter((t) => t.status === "closed" && t.exitPrice != null);
}

export function aggregate(trades: Trade[]): AggregateStats {
  const closed = closedTrades(trades);
  const rows = closed.map((t) => ({ t, m: computeMetrics(t) }));
  const rs = rows.map((r) => r.m.actualR ?? 0);
  const pnls = rows.map((r) => r.m.actualPnL ?? 0);
  const winners = rs.filter((r) => r > 0);
  const losers = rs.filter((r) => r <= 0);
  /* Split on the trade's own R so the dollar averages cover exactly the same
     trades as the R ones — splitting the dollars on their own sign would put
     a fee-negative scratch in a different bucket in one column than in the
     other. */
  const winnerPnls = rows.filter((r) => (r.m.actualR ?? 0) > 0).map((r) => r.m.actualPnL ?? 0);
  const loserPnls = rows.filter((r) => (r.m.actualR ?? 0) <= 0).map((r) => r.m.actualPnL ?? 0);
  const grossWin = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0));
  const captures = rows
    .map((r) => r.m.captureRatioClipped)
    .filter((c): c is number => c != null);
  const deltas = rows
    .map((r) => r.m.managementDeltaR)
    .filter((d): d is number => d != null);

  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

  return {
    count: closed.length,
    wins: winners.length,
    losses: losers.length,
    winRate: closed.length ? winners.length / closed.length : 0,
    expectancyR: avg(rs),
    avgWinnerR: avg(winners),
    avgLoserR: avg(losers),
    expectancyPnL: avg(pnls),
    avgWinnerPnL: avg(winnerPnls),
    avgLoserPnL: avg(loserPnls),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgCapture: avg(captures),
    totalR: rs.reduce((a, b) => a + b, 0),
    totalPnL: pnls.reduce((a, b) => a + b, 0),
    totalDeltaR: deltas.reduce((a, b) => a + b, 0),
  };
}

/**
 * What ended the position, stated as a fact.
 *
 * Whether the decision was any good is a separate column (exitGrade) and a
 * separate calculation (managementDeltaR) — see shared/grades.ts. The two
 * 'manual_*' entries are only here to render rows written before that split.
 */
export const EXIT_REASON_LABELS: Record<string, string> = {
  target: "Hit target",
  stop: "Stopped out",
  trailed: "Trailed out",
  breakeven: "Breakeven",
  discretion: "Closed by hand",
  invalidated: "Setup invalidated",
  time: "Out of time",
  other: "Other",
  manual_early: "Closed by hand",
  manual_late: "Closed by hand",
};

/* ===== Risk-guardrail config (carried over from the reference app) ===== */
export const DAILY_LOSS_ALERT = 300;
export const DAILY_LOSS_STOP = 500;
export const LOSS_STREAK_LIMIT = 3;
export const COOLDOWN_SECONDS = 60;

/* ===== Prestige tiers — now driven by mistake-tag hit counts ===== */
export interface PrestigeTier {
  name: string;
  minHits: number;
  color: string;
  bg: string;
  border: string;
}

export const PRESTIGE_TIERS: PrestigeTier[] = [
  { name: "Rookie", minHits: 0, color: "text-muted-foreground", bg: "bg-muted/40", border: "border-border" },
  { name: "Prestige I", minHits: 10, color: "text-amber-500", bg: "bg-amber-900/30", border: "border-amber-700/50" },
  { name: "Prestige II", minHits: 20, color: "text-slate-300", bg: "bg-slate-500/20", border: "border-slate-400/40" },
  { name: "Prestige III", minHits: 30, color: "text-yellow-400", bg: "bg-yellow-500/20", border: "border-yellow-500/40" },
  { name: "Prestige IV", minHits: 40, color: "text-cyan-400", bg: "bg-cyan-500/20", border: "border-cyan-400/40" },
  { name: "Prestige V", minHits: 50, color: "text-red-400", bg: "bg-red-500/25", border: "border-red-500/60" },
];

export function getPrestige(count: number) {
  let idx = 0;
  for (let i = PRESTIGE_TIERS.length - 1; i >= 0; i--) {
    if (count >= PRESTIGE_TIERS[i].minHits) {
      idx = i;
      break;
    }
  }
  const level = idx >= 5 ? count - 50 : count % 10;
  return { tier: PRESTIGE_TIERS[idx], level, prestigeNum: idx };
}

export function fmtR(v: number | null | undefined, digits = 2): string {
  if (v == null || !isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}R`;
}

export function fmtMoney(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return "—";
  const sign = v < 0 ? "-" : v > 0 ? "+" : "";
  return `${sign}${fmtAmount(v)}`;
}

/**
 * The same dollars without a sign, for figures whose direction is already in
 * the words around them — "$310 lost" must not render as "+$310 lost".
 */
export function fmtAmount(v: number | null | undefined, forceDigits?: 0 | 2): string {
  if (v == null || !isFinite(v)) return "—";
  const a = Math.abs(v);
  // Whole dollars once the figure is big enough that cents are noise, but
  // cents below that: a 3,000-unit position in a sub-penny token settles for
  // a few dollars, and rounding those to "$3" throws away most of the result.
  //
  // forceDigits overrides that for figures printed side by side, where the
  // rule would otherwise render one half of a ratio as "$246" and the other
  // as "$40.00" and make a matched pair look like a mistake.
  const digits = forceDigits ?? (a >= 100 ? 0 : 2);
  return `$${a.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

/**
 * Fees, formatted as the cost they are: unsigned, and to the cent — a $12.50
 * commission rounded to "+$13" by fmtMoney reads as a gain and loses the half
 * dollar that made it worth typing.
 */
export function fmtFees(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return "—";
  return `$${Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
