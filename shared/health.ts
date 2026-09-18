/**
 * What the journal is missing, listed so it gets filled in.
 *
 * Every statistic here rests on fields somebody typed, and a field left
 * blank does not fail loudly — the trade quietly drops out of whichever
 * number needed it. A trade with no stop has no R and vanishes from every
 * expectancy figure. A trade with no account is in nobody's book. A trade
 * still marked open three weeks into a style that holds for hours is
 * probably closed, and its P&L is missing from the month.
 *
 * So the gaps are named, counted, and put above the log where they cannot
 * be scrolled past. Each one is a small errand; the panel's job is to make
 * sure the errand is visible, not to nag — nothing here is a rule, and a
 * gap that is meant (a trade genuinely still open) costs one glance.
 */
import type { TradeWithTags } from "./schema";

export type HealthKind =
  | "no-stop"
  | "stale-open"
  | "no-exit-reason"
  | "no-fee"
  | "no-target"
  | "no-account"
  | "path-unmeasured";

export interface HealthIssue {
  kind: HealthKind;
  trades: TradeWithTags[];
}

export const HEALTH_LABELS: Record<HealthKind, { title: string; why: string }> = {
  "no-stop": {
    title: "no stop",
    why: "Without a stop there is no 1R, so these count towards nothing — not expectancy, not the sizing read, not the cohorts.",
  },
  "stale-open": {
    title: "open far longer than this style holds",
    why: "Probably closed and never logged. Until it is, the month's P&L is missing a trade.",
  },
  "no-exit-reason": {
    title: "closed without saying how",
    why: "Stop, target, trailed or a decision — the exit reason is what splits managed trades from ones left alone.",
  },
  "no-fee": {
    title: "closed without a fee",
    why: "The account has a fee schedule, but this trade carries none — so it counts as if it traded free in every net figure. Pick a chip on its close.",
  },
  "no-target": {
    title: "no target",
    why: "No target means no planned R:R and no answer to whether leaving it alone would have paid.",
  },
  "no-account": {
    title: "no account",
    why: "In nobody's book: the per-account figures and the venue read both skip it.",
  },
  "path-unmeasured": {
    title: "price path never measured",
    why: "Closed days ago and the archive should have it by now — ask the market again from the trade.",
  },
};

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

const live = (t: TradeWithTags) => t.status === "open" || t.status === "closed";
const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);
const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * How long a style usually holds, from its own closed trades.
 *
 * Three times the median, and never less than a week: a scalping style
 * with a median hold of forty minutes should not flag a position at two
 * hours, and a swing style with a few samples should not be judged on
 * them. Under five closed trades there is no norm, only the week.
 */
export function staleAfterMs(trades: TradeWithTags[], styleId: number | null): number {
  const holds = trades
    .filter((t) => t.status === "closed" && t.styleId === styleId && t.exitTime)
    .map((t) => ms(t.exitTime) - ms(t.entryTime))
    .filter((h) => Number.isFinite(h) && h > 0);
  const m = holds.length >= 5 ? median(holds) : null;
  return Math.max(WEEK, m != null ? 3 * m : 0);
}

/**
 * The gaps, most consequential first. Kinds with nothing in them are left out.
 *
 * `feeAccounts` names the accounts with a fee schedule, lower-cased. Only a
 * trade on one of those is flagged for carrying no fee — an account with no
 * schedule has nothing to have been clicked.
 */
export function journalHealth(
  trades: TradeWithTags[],
  now = Date.now(),
  feeAccounts: ReadonlySet<string> = new Set(),
): HealthIssue[] {
  const byKind: Record<HealthKind, TradeWithTags[]> = {
    "no-stop": [],
    "stale-open": [],
    "no-exit-reason": [],
    "no-fee": [],
    "no-target": [],
    "no-account": [],
    "path-unmeasured": [],
  };

  for (const t of trades) {
    if (t.status === "cancelled") continue;
    // A scalp is a result, not a plan: it has no levels to be missing, no
    // exit reason beyond the number, and no price path to measure.
    if (t.scalp) continue;
    // A tilt trade owes no levels: it is logged to be counted, not measured.
    if (live(t) && !t.tilt && t.initialStop == null) byKind["no-stop"].push(t);
    if (live(t) && !t.tilt && t.initialTarget == null) byKind["no-target"].push(t);
    if (!t.account?.trim()) byKind["no-account"].push(t);
    if (t.status === "closed" && !t.exitReason) byKind["no-exit-reason"].push(t);
    if (
      t.status === "closed" &&
      t.fees == null &&
      feeAccounts.has((t.account ?? "").trim().toLowerCase())
    ) {
      byKind["no-fee"].push(t);
    }
    if (t.status === "open") {
      const age = now - ms(t.entryTime);
      if (Number.isFinite(age) && age > staleAfterMs(trades, t.styleId)) byKind["stale-open"].push(t);
    }
    if (
      t.status === "closed" &&
      !t.contract &&
      t.exitTime &&
      now - ms(t.exitTime) > 3 * DAY &&
      (t.mae == null || t.mfe == null)
    ) {
      byKind["path-unmeasured"].push(t);
    }
  }

  const order: HealthKind[] = [
    "no-stop",
    "stale-open",
    "no-exit-reason",
    "no-fee",
    "no-target",
    "no-account",
    "path-unmeasured",
  ];
  return order
    .filter((k) => byKind[k].length > 0)
    .map((k) => ({
      kind: k,
      trades: byKind[k].slice().sort((a, b) => b.entryTime.localeCompare(a.entryTime)),
    }));
}
