/**
 * The perp list, read off the archive bucket instead of the API.
 *
 * From a US host the futures API answers 451 and never anything else, and
 * the catalogue used to fall back to a written-down list for exactly that
 * reason. But the same archive that serves perp CANDLES from that host also
 * has a folder per perp: data.binance.vision is a plain S3 bucket, and S3 will
 * list one. That listing is every USD-M perpetual Binance has ever published
 * a bar for — a longer and more current list than anything written down.
 *
 * "Ever" is the catch. A folder outlives its contract. A perp delisted in
 * 2023 still has three years of files, and offering it in the picker as if it
 * traded would be exactly the confident wrong answer this journal is built
 * to avoid. So a name from the listing is only HALF an answer, and the other
 * half is asked per symbol: does this folder hold a daily file from the last
 * two weeks? A live perp always does. A dead one never will.
 *
 * Pure throughout — XML in, names out — so the reading can be tested against
 * a saved page while the bucket itself is unreachable from here.
 */
import type { BinanceSymbol } from "./binance";

/** Where the daily kline folders live, one per perp, in the bucket. */
export const LISTING_PREFIX = "data/futures/um/daily/klines/";

export interface ListingPage {
  symbols: string[];
  /** Where to resume when the bucket cut the page short; null when it did not. */
  nextMarker: string | null;
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

/**
 * One page of `?delimiter=/&prefix=<LISTING_PREFIX>`.
 *
 * With a delimiter, S3 answers folders as `<CommonPrefixes><Prefix>…/BTCUSDT/</Prefix>`,
 * and echoes the request prefix in a top-level `<Prefix>` of its own, which is
 * why a prefix equal to the request is skipped rather than read as a symbol.
 */
export function parseListingPage(xml: string): ListingPage {
  const symbols: string[] = [];
  const re = /<Prefix>([^<]*)<\/Prefix>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const p = decodeXml(m[1]);
    if (!p.startsWith(LISTING_PREFIX) || p === LISTING_PREFIX) continue;
    const name = p.slice(LISTING_PREFIX.length).replace(/\/$/, "");
    if (name && !name.includes("/")) symbols.push(name);
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const next = /<NextMarker>([^<]*)<\/NextMarker>/.exec(xml);
  const resume = next ? decodeXml(next[1]) : "";
  const nextMarker = truncated
    ? resume || (symbols.length ? `${LISTING_PREFIX}${symbols[symbols.length - 1]}/` : null)
    : null;
  return { symbols, nextMarker };
}

/**
 * Quote currencies a USD-M perp is written against. USDT for nearly all of
 * them, USDC for a few dozen, BUSD for the ones that predate its retirement.
 */
const PERP_QUOTES = ["USDT", "USDC", "BUSD"];

/**
 * A folder name as a catalogue row, or null when it is not a perpetual.
 *
 * Quarterlies live in the same bucket as `BTCUSDT_240329` — the underscore is
 * how they are told apart, and they are skipped for the same reason the API
 * path skips them: a different instrument at a different price.
 *
 * Status is TRADING, and that is an assumption rather than a fact: the
 * listing cannot tell a live folder from a dead one. The liveness probe
 * below is what turns the assumption into an answer, and a row that came
 * from here should be treated as provisional until it has run.
 */
export function perpFromListing(name: string): BinanceSymbol | null {
  const key = name.trim().toUpperCase();
  if (!/^[A-Z0-9]+$/.test(key)) return null;
  for (const q of PERP_QUOTES) {
    if (key.endsWith(q) && key.length > q.length) {
      return {
        symbol: key,
        baseAsset: key.slice(0, -q.length),
        quoteAsset: q,
        status: "TRADING",
        market: "futures",
      };
    }
  }
  return null;
}

/* ------------------------------ liveness ------------------------------ */

/** A perp with no daily file this many days back has stopped trading. */
export const LIVENESS_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const pad = (n: number) => String(n).padStart(2, "0");
/** UTC calendar day, the way the archive names its files. */
export const ymdUtc = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/**
 * The one-key listing that answers "is this perp still publishing bars?"
 *
 * S3 lists keys in order from a `marker`, so asking for the first key after
 * `<folder>/<SYM>-1d-<two weeks ago>` returns the earliest daily file on or
 * after that date — one small request, whatever the folder's size. An empty
 * answer means nothing has been published since, which is what delisted
 * looks like.
 */
export function livenessQuery(symbol: string, sinceYmd: string): string {
  const folder = `${LISTING_PREFIX}${symbol}/1d/`;
  const enc = encodeURIComponent;
  return `?prefix=${enc(folder)}&marker=${enc(`${folder}${symbol}-1d-${sinceYmd}`)}&max-keys=1`;
}

/** Read the probe: live when a key past the marker names a day on or after `sinceYmd`. */
export function readLiveness(xml: string, symbol: string, sinceYmd: string): boolean {
  const re = /<Key>([^<]*)<\/Key>/g;
  const dated = new RegExp(`/${symbol}-1d-(\\d{4}-\\d{2}-\\d{2})\\.zip`);
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const d = dated.exec(decodeXml(m[1]));
    if (d && d[1] >= sinceYmd) return true;
  }
  return false;
}
