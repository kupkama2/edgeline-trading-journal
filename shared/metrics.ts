import type { Trade, TradeWithTags } from "./schema";

export interface TradeMetrics {
  risk: number; // per-unit risk in price terms
  riskDollars: number; // 1R in $
  actualR: number | null;
  actualPnL: number | null;
  mfeR: number | null;
  maeR: number | null;
  potentialR: number | null;
  potentialPnL: number | null;
  managementDeltaR: number | null;
  managementDeltaDollars: number | null;
  captureRatio: number | null; // raw
  captureRatioClipped: number | null; // clipped to [0,1]
  rLeftOnTable: number | null;
  dollarsLeftOnTable: number | null;
}

export function computeMetrics(t: Trade): TradeMetrics {
  const sign = t.direction === "long" ? 1 : -1;
  const risk = Math.abs(t.entryPrice - t.initialStop);
  const riskDollars = risk * t.size;
  const safe = risk > 0;

  const actualR =
    safe && t.exitPrice != null ? (sign * (t.exitPrice - t.entryPrice)) / risk : null;
  const actualPnL =
    t.exitPrice != null ? sign * (t.exitPrice - t.entryPrice) * t.size : null;
  const mfeR = safe && t.mfe != null ? (sign * (t.mfe - t.entryPrice)) / risk : null;
  const maeR = safe && t.mae != null ? (sign * (t.mae - t.entryPrice)) / risk : null;

  let potentialR: number | null = null;
  if (safe && t.noManagementOutcome === "target_first") {
    potentialR = (sign * (t.initialTarget - t.entryPrice)) / risk;
  } else if (t.noManagementOutcome === "stop_first") {
    potentialR = -1;
  }

  const managementDeltaR =
    actualR != null && potentialR != null ? actualR - potentialR : null;
  const captureRatio =
    actualR != null && mfeR != null && mfeR !== 0 ? actualR / mfeR : null;
  const rLeftOnTable = actualR != null && mfeR != null ? mfeR - actualR : null;

  return {
    risk,
    riskDollars,
    actualR,
    actualPnL,
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
  };
}

export function rToDollars(r: number, t: Trade): number {
  return r * Math.abs(t.entryPrice - t.initialStop) * t.size;
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
  profitFactor: number;
  avgCapture: number;
  totalR: number;
  totalPnL: number;
  totalDeltaR: number;
}

export function aggregate(trades: Trade[]): AggregateStats {
  const closed = trades.filter((t) => t.status === "closed" && t.exitPrice != null);
  const rows = closed.map((t) => ({ t, m: computeMetrics(t) }));
  const rs = rows.map((r) => r.m.actualR ?? 0);
  const pnls = rows.map((r) => r.m.actualPnL ?? 0);
  const winners = rs.filter((r) => r > 0);
  const losers = rs.filter((r) => r <= 0);
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
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgCapture: avg(captures),
    totalR: rs.reduce((a, b) => a + b, 0),
    totalPnL: pnls.reduce((a, b) => a + b, 0),
    totalDeltaR: deltas.reduce((a, b) => a + b, 0),
  };
}

export const EXIT_REASON_LABELS: Record<string, string> = {
  target: "Hit target",
  stop: "Stopped out",
  trailed: "Trailed out",
  manual_early: "Manual early",
  manual_late: "Manual late",
  breakeven: "Breakeven",
  other: "Other",
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
  return `${sign}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
