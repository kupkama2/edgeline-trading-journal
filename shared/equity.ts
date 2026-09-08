/**
 * Risk as a share of the account, not only as dollars.
 *
 * "$103" means one thing on a $5,000 account and another on $50,000, and
 * the sizing read — do the small trades lose? — cannot tell them apart
 * without knowing which. A balance is a snapshot somebody logged: deposits,
 * withdrawals and the venue's own accounting move it in ways the journal
 * cannot see, so it is never computed here, only looked up.
 *
 * The lookup is strict about time. The equity behind a trade is the latest
 * balance logged BEFORE it; a balance logged afterwards says nothing about
 * what was at risk then, and a trade from before the first snapshot has no
 * percentage at all — a blank rather than a number borrowed from later.
 */

export interface BalanceRow {
  account: string;
  /** ISO instant. */
  at: string;
  balance: number;
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/** The latest balance logged for the account at or before `atIso`. */
export function equityAt(
  rows: BalanceRow[],
  account: string | null | undefined,
  atIso?: string | null,
): number | null {
  if (!account?.trim()) return null;
  const cutoff = atIso ? new Date(atIso).getTime() : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(cutoff) && atIso) return null;
  let best: BalanceRow | null = null;
  for (const r of rows) {
    if (!same(r.account, account)) continue;
    const t = new Date(r.at).getTime();
    if (!Number.isFinite(t) || t > cutoff) continue;
    if (!best || t >= new Date(best.at).getTime()) best = r;
  }
  return best ? best.balance : null;
}

/** The account's balance as of now. */
export const latestEquity = (rows: BalanceRow[], account: string | null | undefined) =>
  equityAt(rows, account, null);

/** Risk over equity, as a percentage. Null when either is unknown or zero. */
export function riskPercent(riskDollars: number | null | undefined, equity: number | null): number | null {
  if (riskDollars == null || !Number.isFinite(riskDollars) || equity == null || !(equity > 0)) return null;
  return (riskDollars / equity) * 100;
}

/**
 * A risk budget typed either way.
 *
 * "103" is dollars. "1%" is a share of the account, and becomes dollars only
 * when the account's balance is known — otherwise the percent is kept and
 * the dollars stay null, so the caller can say what is missing instead of
 * sizing to nothing.
 */
export function parseRiskBudget(
  text: string,
  equity: number | null,
): { dollars: number | null; percent: number | null } {
  const s = text.trim();
  if (!s) return { dollars: null, percent: null };
  const pct = /^(\d+(?:\.\d+)?)\s*%$/.exec(s);
  if (pct) {
    const percent = Number(pct[1]);
    return {
      percent,
      dollars: equity != null && equity > 0 ? (equity * percent) / 100 : null,
    };
  }
  const n = Number(s.replace(/^\$/, ""));
  return Number.isFinite(n) && n > 0 ? { dollars: n, percent: null } : { dollars: null, percent: null };
}

/** "0.9%" — one decimal, two when it is under a tenth of a percent. */
export function fmtPercent(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "—";
  return `${p.toFixed(p < 0.1 ? 2 : 1)}%`;
}
