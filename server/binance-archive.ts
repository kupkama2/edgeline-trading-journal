/**
 * Binance's public data archive — the way to read perpetuals from a US host.
 *
 * fapi.binance.com answers 451 to a US IP, and there is no mirror for it the
 * way data-api.binance.vision mirrors spot. But Binance also publishes every
 * kline it has ever printed as flat files on data.binance.vision, and that
 * host is on the same unrestricted domain as the spot mirror — which makes it
 * the one path to real perp candles from a server that the API refuses.
 *
 *   https://data.binance.vision/data/futures/um/daily/klines/BTCUSDT/1h/BTCUSDT-1h-2026-08-24.zip
 *
 * It is strictly retrospective. A day's file appears after that day closes in
 * UTC, so the archive can never answer "what is price doing now" — which is
 * fine for the question it is here to answer. "Would this have hit the target
 * or the stop, left alone?" is a question about the past, and a trade closed
 * today gets its answer tomorrow.
 *
 * THE PREFIX RULE, which is the only thing here that can produce a wrong
 * answer if it is got wrong: bars are gathered in time order and gathering
 * STOPS at the first file that cannot be read. A contiguous run starting at
 * the entry can only ever yield the right verdict or "not yet" — the scan
 * walks forward and stops at the first level touched, so missing the tail
 * costs a day's delay. A HOLE is different in kind: skip the third day and
 * read the tenth, and a stop that was hit on day three becomes a target hit
 * on day ten. That is a confident wrong answer, and never returning one is
 * the whole contract this module lives under.
 */
import { unzipSync, strFromU8 } from "fflate";
import { fetch as undiciFetch } from "undici";
import type { Candle, Market } from "@shared/binance";
import { egressFor } from "./egress";
import { settleAll } from "./pool";

/** Overridable so the whole path can be driven against a local stub. */
const ARCHIVE_BASE = (process.env.BINANCE_ARCHIVE_BASE || "https://data.binance.vision").replace(
  /\/+$/,
  "",
);

/**
 * How many files one window may cost.
 *
 * Sized to cover the longest window the resolver ever asks for — entry to
 * thirty days past the exit — because a cap SHORTER than that is not a
 * safeguard, it is a trade that can never settle: the scan would stop at the
 * same day on every run, and a level reached after it would stay unread
 * forever while the trade was re-checked every hour.
 *
 * Whole completed months collapse to one file each, so this is only ever
 * reached by a window ending in the current month, and the files at these
 * intervals are a few hundred bytes. The cap remains for the pathological
 * case, and thanks to the prefix rule stopping early is late rather than
 * wrong.
 */
const MAX_FILES = 35;

/** Parsed files, kept for the run. Overlapping trades share days constantly. */
const cache = new Map<string, Candle[]>();
const CACHE_MAX = 32;

const DAY_MS = 86_400_000;

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const ym = (ms: number) => ymd(ms).slice(0, 7);
const startOfDay = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;
const startOfMonth = (ms: number) => Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), 1);
const startOfNextMonth = (ms: number) =>
  Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth() + 1, 1);

/** futures/um for the USD-M perpetuals; spot for the spot book. */
const section = (m: Market) => (m === "futures" ? "futures/um" : "spot");

interface Piece {
  url: string;
  /** Last instant this file can contain, so coverage is knowable. */
  through: number;
}

/**
 * Which files cover a window, in time order.
 *
 * Whole completed months are taken as one file where the window contains them
 * — a month of hourly bars is one small request instead of thirty — and
 * everything else falls back to days. The current month never has a monthly
 * file, because it has not finished.
 */
export function archivePlan(
  symbol: string,
  market: Market,
  interval: string,
  startMs: number,
  endMs: number,
  now = Date.now(),
): Piece[] {
  const out: Piece[] = [];
  const base = `${ARCHIVE_BASE}/data/${section(market)}`;
  let cursor = startOfDay(startMs);
  const thisMonth = ym(now);

  while (cursor <= endMs && out.length < MAX_FILES) {
    const monthEnd = startOfNextMonth(cursor) - 1;
    const wholeMonth =
      cursor === startOfMonth(cursor) && endMs >= monthEnd && ym(cursor) < thisMonth;
    if (wholeMonth) {
      out.push({
        url: `${base}/monthly/klines/${symbol}/${interval}/${symbol}-${interval}-${ym(cursor)}.zip`,
        through: monthEnd,
      });
      cursor = monthEnd + 1;
    } else {
      out.push({
        url: `${base}/daily/klines/${symbol}/${interval}/${symbol}-${interval}-${ymd(cursor)}.zip`,
        through: cursor + DAY_MS - 1,
      });
      cursor += DAY_MS;
    }
  }
  return out;
}

/**
 * One archive file, parsed.
 *
 * The CSV has changed shape over the years and both shapes are still served:
 * older files start straight in on data, newer ones carry a header row, and
 * timestamps moved from milliseconds to microseconds. All three are decided
 * per row rather than per file, because a wrong guess about which era a file
 * belongs to would put every bar in it a thousand years from now.
 */
export function parseArchiveCsv(csv: string): Candle[] {
  const out: Candle[] = [];
  for (const line of csv.split("\n")) {
    const row = line.trim();
    if (!row) continue;
    const f = row.split(",");
    if (f.length < 5) continue;
    let t = Number(f[0]);
    // A header row's first field is not a number; so is any stray line.
    if (!Number.isFinite(t)) continue;
    // Microsecond epochs are a thousand times too large to be milliseconds,
    // and no plausible millisecond timestamp reaches 1e14 (that is the year
    // 5138), so the magnitude is a safe discriminator.
    if (t > 1e14) t = Math.round(t / 1000);
    const [o, h, l, c] = [Number(f[1]), Number(f[2]), Number(f[3]), Number(f[4])];
    if (![o, h, l, c].every(Number.isFinite)) continue;
    out.push({ t, o, h, l, c });
  }
  return out;
}

async function fetchPiece(url: string): Promise<Candle[]> {
  const hit = cache.get(url);
  if (hit) return hit;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await undiciFetch(url, {
      signal: ctl.signal,
      dispatcher: egressFor(ARCHIVE_BASE),
    } as any);
    if (!res.ok) throw new Error(`archive → HTTP ${res.status} on ${new URL(url).pathname}`);
    const zip = new Uint8Array(await res.arrayBuffer());
    const entries = unzipSync(zip);
    const name = Object.keys(entries)[0];
    if (!name) throw new Error(`archive → empty zip at ${new URL(url).pathname}`);
    const bars = parseArchiveCsv(strFromU8(entries[name]));
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(url, bars);
    return bars;
  } finally {
    clearTimeout(timer);
  }
}

export interface ArchiveRead {
  candles: Candle[];
  /**
   * The last instant actually covered, which is NOT the same as the last bar.
   *
   * A caller deciding whether a window was fully read needs to know where the
   * files ran out, and the last bar cannot say: a quiet hour and a missing day
   * both end the series. Zero when nothing could be read at all.
   */
  coveredTo: number;
  /** Why gathering stopped early, when it did. */
  stoppedBecause?: string;
}

/**
 * Candles for a window, out of the archive, as far as the files go.
 *
 * Gathering stops at the first unreadable file — see the prefix rule at the
 * top of this file. That is the difference between an answer that is merely
 * late and one that is wrong.
 */
export async function archiveCandles(
  pair: { symbol: string; market: Market },
  interval: string,
  startMs: number,
  endMs: number,
): Promise<ArchiveRead> {
  const pieces = archivePlan(pair.symbol, pair.market, interval, startMs, endMs);
  const candles: Candle[] = [];
  let coveredTo = 0;
  let stoppedBecause: string | undefined;

  /*
   * Fetched a few at a time, read in order. The run still ends at the first
   * file that is not there — today's, usually, which is the ordinary case
   * and not an error — so the bars never skip a hole; the pieces past it
   * were merely downloaded for nothing, which costs a little bandwidth and
   * saves the sequential version's fifteen-second wait on a month of days.
   */
  const fetched = await settleAll(pieces, 6, (piece) => fetchPiece(piece.url));
  for (let i = 0; i < pieces.length; i++) {
    const r = fetched[i];
    if (r.status === "rejected") {
      stoppedBecause = String((r.reason as any)?.message ?? r.reason);
      break;
    }
    candles.push(...r.value);
    coveredTo = Math.min(pieces[i].through, endMs);
  }

  return {
    candles: candles.filter((c) => c.t >= startMs && c.t <= endMs).sort((a, b) => a.t - b.t),
    coveredTo,
    stoppedBecause,
  };
}
