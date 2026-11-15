/**
 * A Lulo deposit, as Lulo's own public API states it for a wallet.
 *
 * Lulo holds deposits in two pools: Protected, and Boosted (which its API
 * calls "regular"). For a wallet it gives the dollars in each, and the
 * interest earned so far in each. What was put in is the difference: the
 * value less the interest.
 */

export interface LuloAccount {
  valueUsd: number;
  protectedUsd: number;
  boostedUsd: number;
  interestUsd: number;
  protectedInterestUsd: number;
  boostedInterestUsd: number;
  /** What went in: the value less the interest earned. */
  depositedUsd: number;
}

export interface LuloRates {
  /** Current yearly rates, in percent. */
  protected: number | null;
  boosted: number | null;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The account answer read; null when it is not one (an error body, a changed shape). */
export function parseLuloAccount(raw: unknown): LuloAccount | null {
  const r = raw as any;
  if (!r || typeof r !== "object" || typeof r.totalUsdValue !== "number") return null;
  const valueUsd = n(r.totalUsdValue);
  const interestUsd = n(r.totalInterestEarned);
  return {
    valueUsd,
    protectedUsd: n(r.pusdUsdBalance),
    boostedUsd: n(r.lusdUsdBalance),
    interestUsd,
    protectedInterestUsd: n(r.protectedInterestEarned),
    boostedInterestUsd: n(r.regularInterestEarned),
    depositedUsd: Math.max(0, valueUsd - interestUsd),
  };
}

export function parseLuloRates(raw: unknown): LuloRates {
  const r = raw as any;
  const cur = (x: any) => (typeof x?.CURRENT === "number" && Number.isFinite(x.CURRENT) ? x.CURRENT : null);
  return { protected: cur(r?.protected), boosted: cur(r?.regular) };
}

/** Several wallets' deposits as one. */
export function sumLulo(accounts: LuloAccount[]): LuloAccount {
  const z: LuloAccount = { valueUsd: 0, protectedUsd: 0, boostedUsd: 0, interestUsd: 0, protectedInterestUsd: 0, boostedInterestUsd: 0, depositedUsd: 0 };
  for (const a of accounts) for (const k of Object.keys(z) as (keyof LuloAccount)[]) z[k] += a[k];
  return z;
}

/** The yearly rate the deposit is earning now: each pool's rate, weighted by what is in it. Null when it cannot be said. */
export function blendedRate(a: LuloAccount, rates: LuloRates): number | null {
  const parts: [number, number][] = [];
  if (a.protectedUsd > 0 && rates.protected != null) parts.push([a.protectedUsd, rates.protected]);
  if (a.boostedUsd > 0 && rates.boosted != null) parts.push([a.boostedUsd, rates.boosted]);
  const total = parts.reduce((s, p) => s + p[0], 0);
  return total > 0 ? parts.reduce((s, p) => s + p[0] * p[1], 0) / total : null;
}
