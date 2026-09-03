/**
 * Reading the perp list off the archive bucket, and asking which are alive.
 *
 * Everything that decides what a folder name MEANS is in
 * shared/binance-listing.ts and pure. This file only fetches: one listing
 * for the names, and one tiny probe per name for whether it still trades.
 *
 * The probe is the part that has to be paced. Six hundred folders is six
 * hundred requests, and they run six at a time in the background after the
 * names have already been stored — nobody's chart waits on a census. A perp
 * whose probe fails is left as it was rather than marked dead: a timeout is
 * not a delisting, and the next daily refresh asks again.
 */
import { fetch as undiciFetch } from "undici";
import { egressFor } from "./egress";
import { settleAll } from "./pool";
import type { BinanceSymbol } from "@shared/binance";
import {
  LISTING_PREFIX,
  LIVENESS_WINDOW_MS,
  livenessQuery,
  parseListingPage,
  perpFromListing,
  readLiveness,
  ymdUtc,
} from "@shared/binance-listing";

/**
 * The bucket's own S3 endpoint rather than the data.binance.vision front,
 * which is a CDN for the files and does not answer listings. Overridable so
 * the whole path runs against a stub; the archive override is honoured too,
 * because a test that stubs the archive has stubbed the bucket.
 */
const LISTING_BASE = (
  process.env.BINANCE_LISTING_BASE ||
  process.env.BINANCE_ARCHIVE_BASE ||
  "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision"
).replace(/\/+$/, "");

export interface ListingStatus {
  lastTriedAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  /** Perp folders the last successful listing named. */
  symbols: number;
  /** When the liveness census last finished, and what it found. */
  probedAt: string | null;
  probedLive: number | null;
  probedDead: number | null;
  probedFailed: number | null;
}

const status: ListingStatus = {
  lastTriedAt: null,
  lastOkAt: null,
  lastError: null,
  symbols: 0,
  probedAt: null,
  probedLive: null,
  probedDead: null,
  probedFailed: null,
};
export const listingStatus = (): ListingStatus => ({ ...status });

async function getXml(query: string, timeoutMs = 15_000): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await undiciFetch(`${LISTING_BASE}${query}`, {
      signal: ctl.signal,
      dispatcher: egressFor(LISTING_BASE),
    } as any);
    if (!res.ok) {
      throw new Error(`${new URL(LISTING_BASE).hostname} → HTTP ${res.status} on the bucket listing`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every USD-M perp folder in the bucket, as provisional TRADING rows.
 *
 * Follows the bucket's paging, though one page has always been enough: the
 * cap is a thousand folders and there are around six hundred.
 */
export async function fetchListedPerps(): Promise<BinanceSymbol[]> {
  status.lastTriedAt = new Date().toISOString();
  try {
    const enc = encodeURIComponent;
    const out: BinanceSymbol[] = [];
    let marker: string | null = null;
    let pages = 0;
    do {
      const query =
        `?delimiter=${enc("/")}&prefix=${enc(LISTING_PREFIX)}&max-keys=1000` +
        (marker ? `&marker=${enc(marker)}` : "");
      const page = parseListingPage(await getXml(query));
      for (const name of page.symbols) {
        const row = perpFromListing(name);
        if (row) out.push(row);
      }
      marker = page.nextMarker;
      pages += 1;
    } while (marker && pages < 10);

    if (out.length === 0) throw new Error("the bucket listing named no perps");
    status.lastOkAt = new Date().toISOString();
    status.lastError = null;
    status.symbols = out.length;
    return out;
  } catch (err: any) {
    status.lastError = String(err?.message ?? err);
    throw err;
  }
}

export interface Census {
  live: string[];
  dead: string[];
  /** Could not be asked — left exactly as they were. */
  failed: string[];
}

/** Which of these perps have published a daily bar in the last two weeks. */
export async function probeListed(
  symbols: string[],
  now = Date.now(),
  concurrency = 6,
): Promise<Census> {
  const since = ymdUtc(now - LIVENESS_WINDOW_MS);
  const census: Census = { live: [], dead: [], failed: [] };
  const results = await settleAll(symbols, concurrency, (s) => getXml(livenessQuery(s, since), 10_000));
  results.forEach((r, i) => {
    const s = symbols[i];
    if (r.status === "rejected") census.failed.push(s);
    else (readLiveness(r.value, s, since) ? census.live : census.dead).push(s);
  });
  status.probedAt = new Date().toISOString();
  status.probedLive = census.live.length;
  status.probedDead = census.dead.length;
  status.probedFailed = census.failed.length;
  return census;
}
