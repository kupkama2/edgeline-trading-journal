/**
 * Hyperliquid's perp universe, fetched and cached.
 *
 * One public endpoint, no key: `POST /info {"type":"meta"}` answers with
 * every perp the venue lists, delisted ones flagged. Reading it is in
 * shared/hyperliquid.ts and pure; this file asks, remembers, and reports.
 *
 * The universe is refreshed once a day and read from the database between
 * refreshes, the same way the Binance catalogue is. A venue that cannot be
 * reached is an empty universe with a reason attached, never a thrown error:
 * the picker losing one column of suggestions is not a broken journal.
 */
import { fetch as undiciFetch } from "undici";
import { egressFor } from "./egress";
import { parseHyperliquidMeta, type HyperliquidPerp } from "@shared/hyperliquid";
import { hyperliquid as universe } from "./storage";

const BASE = (process.env.HYPERLIQUID_BASE || "https://api.hyperliquid.xyz").replace(/\/+$/, "");

const TTL_MS = 24 * 60 * 60 * 1000;
/**
 * How long a failed fetch is left alone before it is tried again.
 *
 * Without this an empty cache is "stale" on every request, and every open of
 * the trade form would wait out a twelve-second timeout against a venue that
 * refused a minute ago.
 */
const RETRY_MS = 10 * 60 * 1000;

export interface HyperliquidStatus {
  lastTriedAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  /** Perps the last successful fetch returned, delisted ones included. */
  perps: number;
}

const status: HyperliquidStatus = { lastTriedAt: null, lastOkAt: null, lastError: null, perps: 0 };
export const hyperliquidStatus = (): HyperliquidStatus => ({ ...status });

export async function fetchHyperliquidPerps(): Promise<HyperliquidPerp[]> {
  status.lastTriedAt = new Date().toISOString();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12_000);
  const host = new URL(BASE).hostname;
  try {
    const res = await undiciFetch(`${BASE}/info`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ type: "meta" }),
      signal: ctl.signal,
      dispatcher: egressFor(BASE),
    } as any);
    if (!res.ok) throw new Error(`${host} → HTTP ${res.status} on /info`);
    const perps = parseHyperliquidMeta(await res.json());
    if (perps.length === 0) throw new Error(`${host} answered /info without a universe`);
    status.lastOkAt = new Date().toISOString();
    status.lastError = null;
    status.perps = perps.length;
    return perps;
  } catch (err: any) {
    status.lastError = String(err?.message ?? err);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** The cached universe, refreshed when missing or a day old. Never throws. */
export async function ensureHyperliquid(force = false): Promise<HyperliquidPerp[]> {
  const last = await universe.lastFetchedAt();
  const stale = force || !last || Date.now() - new Date(last).getTime() > TTL_MS;
  const triedRecently =
    status.lastTriedAt != null && Date.now() - new Date(status.lastTriedAt).getTime() < RETRY_MS;
  if (stale && (force || !triedRecently)) {
    try {
      const perps = await fetchHyperliquidPerps();
      if (perps.length) await universe.replace(perps);
    } catch {
      // The cache, or nothing. The status endpoint carries the reason.
    }
  }
  return universe.list();
}
