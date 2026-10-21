import type { Mark } from "@shared/marks";

/**
 * A Binance perp priced from the browser, when the server could not.
 *
 * Binance's futures API answers by location: a 451 to a US address, a price
 * to most others. The journal's server may sit on the wrong side of that
 * line while the trader, who holds the position, plainly does not — so a
 * mark the server could only give from spot (or from yesterday's archive)
 * names its perp, and this asks the perp's own book from here.
 *
 * Only ever an upgrade. Any failure — a refusal, a timeout, a browser that
 * will not make the request — leaves the server's mark exactly as it was,
 * labelled as what it is.
 */

const HOSTS = ["https://fapi.binance.com", "https://fapi1.binance.com", "https://fapi2.binance.com"];
const FRESH_MS = 20_000;
/** After a refusal, stop asking for a while: a blocked book stays blocked. */
const BACKOFF_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;

let held: { at: number; prices: Record<string, number> } | null = null;
let refusedAt: number | null = null;

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

async function perpPrices(fetchImpl: Fetch, now: number): Promise<Record<string, number> | null> {
  if (held && now - held.at < FRESH_MS) return held.prices;
  if (refusedAt != null && now - refusedAt < BACKOFF_MS) return null;
  for (const host of HOSTS) {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
    try {
      const res = await fetchImpl(`${host}/fapi/v1/ticker/price`, ctl ? { signal: ctl.signal } : undefined);
      if (!res.ok) continue;
      const rows = await res.json();
      const prices: Record<string, number> = {};
      for (const r of Array.isArray(rows) ? (rows as any[]) : []) {
        const p = Number(r?.price);
        if (typeof r?.symbol === "string" && Number.isFinite(p) && p > 0) prices[r.symbol] = p;
      }
      if (Object.keys(prices).length === 0) continue;
      held = { at: now, prices };
      return prices;
    } catch {
      // Refused, blocked or timed out: try the next host.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  refusedAt = now;
  return null;
}

export async function withBrowserPerpMarks(
  marks: Record<number, Mark>,
  fetchImpl: Fetch = (u, i) => fetch(u, i),
  now = Date.now(),
): Promise<Record<number, Mark>> {
  const wanted = Object.values(marks).some((m) => m.perp);
  if (!wanted) return marks;
  const prices = await perpPrices(fetchImpl, now);
  if (!prices) return marks;
  const out: Record<number, Mark> = { ...marks };
  for (const [id, m] of Object.entries(marks)) {
    const p = m.perp ? prices[m.perp] : undefined;
    if (p) out[Number(id)] = { ...m, price: p, at: now, book: "perp", stale: false, fromBrowser: true };
  }
  return out;
}

/** For tests: forget what was held and refused. */
export function resetPerpMarks() {
  held = null;
  refusedAt = null;
}
