/**
 * Bars read by the browser, when the server could not.
 *
 * Binance answers by address. The journal's server may be refused — a US
 * host gets a 451, a host whose outbound IP it shares with strangers gets
 * rate-banned for their sins — while the trader's own browser, on their
 * own connection, is refused nothing. The venue's public market data
 * allows a browser to ask directly, so when the server's answer carries no
 * bars (or only yesterday's archive) the browser asks for the same window
 * itself. Only ever an upgrade: any failure leaves the server's answer as
 * it was, labelled as what it is.
 */
export type Candle = { t: number; o: number; h: number; l: number; c: number };

const FUTURES_HOSTS = ["https://fapi.binance.com", "https://fapi1.binance.com", "https://fapi2.binance.com"];
const SPOT_HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"];
const TIMEOUT_MS = 6_000;
/** After a refusal, the book is left alone for a while: a blocked book stays blocked. */
const BACKOFF_MS = 5 * 60_000;
const refusedAt: Record<string, number> = {};

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

async function page(fetchImpl: Fetch, host: string, path: string): Promise<any[] | null> {
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  try {
    const res = await fetchImpl(`${host}${path}`, ctl ? { signal: ctl.signal } : undefined);
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The bars of a window, from the venue's own public book. Empty when it would not answer. */
export async function browserCandles(
  market: "futures" | "spot",
  symbol: string,
  interval: string,
  fromMs: number,
  toMs: number,
  maxBars = 1200,
  fetchImpl: Fetch = (u, i) => fetch(u, i),
  now = Date.now(),
): Promise<Candle[]> {
  const key = market;
  if (refusedAt[key] != null && now - refusedAt[key] < BACKOFF_MS) return [];
  const hosts = market === "futures" ? FUTURES_HOSTS : SPOT_HOSTS;
  const path = market === "futures" ? "/fapi/v1/klines" : "/api/v3/klines";
  for (const host of hosts) {
    const out: Candle[] = [];
    let cursor = Math.floor(fromMs);
    let failed = false;
    while (cursor < toMs && out.length < maxBars) {
      const rows = await page(fetchImpl, host, `${path}?symbol=${encodeURIComponent(symbol)}&interval=${interval}&startTime=${cursor}&endTime=${Math.floor(toMs)}&limit=1000`);
      if (!rows) {
        failed = true;
        break;
      }
      if (rows.length === 0) break;
      for (const k of rows) out.push({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]) });
      const last = Number(rows[rows.length - 1][0]);
      if (!Number.isFinite(last) || last < cursor) break;
      cursor = last + 1;
      if (rows.length < 1000) break;
    }
    if (!failed) return out.slice(0, maxBars);
  }
  refusedAt[key] = now;
  return [];
}

/** For tests: forget what was refused. */
export function resetBrowserCandles(): void {
  for (const k of Object.keys(refusedAt)) delete refusedAt[k];
}
