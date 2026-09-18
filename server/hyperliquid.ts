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
import {
  parseAllMids,
  parseCandleSnapshot,
  parseFundingHistory,
  parseHistoricalOrders,
  parseHyperliquidMeta,
  parsePerpDexs,
  parseUserFills,
  perpsFromMids,
  hlAsset,
  type HlFill,
  type HlOrder,
  type HyperliquidPerp,
} from "@shared/hyperliquid";
import type { Candle } from "@shared/binance";
import type { CandleRead, Interval } from "./binance";
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
  /** Builder-deployed perp DEXs the last refresh found beyond the main one. */
  dexes: number;
  /** How many of `perps` came from those books rather than the coin universe. */
  builderPerps: number;
  /** How many the per-book listings missed and the price feed supplied. */
  fromMids: number;
  /**
   * Why there are no builder books, when there are none for a reason. Null
   * both when they loaded and when the venue simply has none — those two are
   * fine, and only a refusal is worth printing.
   */
  dexError: string | null;
}

const status: HyperliquidStatus = {
  lastTriedAt: null,
  lastOkAt: null,
  lastError: null,
  perps: 0,
  dexes: 0,
  builderPerps: 0,
  fromMids: 0,
  dexError: null,
};
export const hyperliquidStatus = (): HyperliquidStatus => ({ ...status });

const host = () => new URL(BASE).hostname;

/**
 * One question to the venue. Everything Hyperliquid answers — the universe,
 * a wallet's fills, a coin's candles or funding, every mid at once — is a
 * POST to /info with a `type`, and this is the only place the request is
 * written.
 */
async function info(body: Record<string, unknown>, timeoutMs = 12_000): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await undiciFetch(`${BASE}/info`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
      dispatcher: egressFor(BASE),
    } as any);
    if (!res.ok) throw new Error(`${host()} → HTTP ${res.status} on /info (${String(body.type)})`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How many builder-deployed DEXs are worth asking about in one refresh.
 *
 * Each is its own round trip and the list is open-ended — anybody can deploy
 * one. The universe is fetched once a day, so this is a ceiling on a daily
 * cost rather than a limit on anything a trader does, and a cap that is
 * plainly too low is better than a refresh that takes a minute.
 */
const MAX_DEXES = 40;

/**
 * Every perp the venue lists, across every book it lists them in.
 *
 * Hyperliquid's own universe is the coin perps. The equity and commodity
 * perps are deployed by builders (HIP-3) into SEPARATE perp DEXs, each with
 * its own universe, and none of them appear in the default answer — which is
 * why a trade on one used to match nothing, chart nothing, and settle never.
 *
 * The extra books are strictly a bonus. The main universe is fetched first
 * and its failure is still the failure; everything after it is best-effort,
 * so a builder DEX that is slow, renamed or gone leaves the journal exactly
 * where it was rather than taking the coin perps down with it.
 */
export async function fetchHyperliquidPerps(): Promise<HyperliquidPerp[]> {
  status.lastTriedAt = new Date().toISOString();
  try {
    const perps = parseHyperliquidMeta(await info({ type: "meta" }));
    if (perps.length === 0) throw new Error(`${host()} answered /info without a universe`);

    /*
     * The builder books, and WHY when there are none.
     *
     * Swallowing this made two very different situations identical from the
     * outside: a venue that genuinely has no builder-deployed books, and a
     * request that was refused. Both read "0 books, no error", and only one
     * of them is something to fix.
     */
    let dexes: string[] = [];
    let dexError: string | null = null;
    try {
      const answer = await info({ type: "perpDexs" }, 10_000);
      dexes = parsePerpDexs(answer).slice(0, MAX_DEXES);
      if (dexes.length === 0) {
        // Answered, but with nothing this could use. Say which, because a
        // list of one null is the venue saying "only my own book" while an
        // object is the shape having moved under us.
        dexError = Array.isArray(answer)
          ? answer.length <= 1
            ? null // just the venue's own universe — nothing wrong
            : `${host()} listed ${answer.length} perp dexes, none of them usable`
          : `${host()} answered /info (perpDexs) with ${typeof answer}, not a list`;
      }
    } catch (err: any) {
      dexError = String(err?.message ?? err);
    }

    let extra = 0;
    const refused: string[] = [];
    // A book that answers and yields nothing is its own failure, and the one
    // that actually happened: ten books, no perps, nothing thrown, nothing
    // said. Counted separately from a refusal because they are different
    // problems — one is the venue, one is us reading it wrong.
    const empty: string[] = [];
    for (const dex of dexes) {
      try {
        const listed = parseHyperliquidMeta(await info({ type: "meta", dex }, 10_000), dex);
        if (listed.length === 0) empty.push(dex);
        perps.push(...listed);
        extra += listed.length;
      } catch {
        // One book refusing says nothing about the others.
        refused.push(dex);
      }
    }
    if (refused.length && !dexError) {
      dexError = `${refused.length} of ${dexes.length} builder books did not answer (${refused.slice(0, 3).join(", ")})`;
    }

    /*
     * And the same question asked a completely different way.
     *
     * Every market the venue quotes shows up in allMids, and one in a builder
     * book is keyed with its book on the front. That is an independent census
     * of what exists: one request rather than ten, it cannot half-fail, and a
     * market that is being quoted is real whatever a catalogue says.
     *
     * It runs every time rather than only as a rescue, because the two
     * disagree in both directions — a book can list an asset the feed does
     * not quote, and the feed has repeatedly known about assets the per-book
     * listings did not hand over. Anything already found keeps its listing,
     * which is where the leverage comes from; the rest arrive with what the
     * feed knows, which is that they exist.
     */
    let fromMids = 0;
    const have = new Set(perps.map((p) => `${p.dex ?? ""}:${p.name.toUpperCase()}`));
    const take = (p: HyperliquidPerp) => {
      const key = `${p.dex ?? ""}:${p.name.toUpperCase()}`;
      if (have.has(key)) return;
      have.add(key);
      perps.push(p);
      extra++;
      fromMids++;
    };
    // Each book's own feed, named. This is the request that was missing: the
    // unnamed one answers for the coin universe alone.
    for (const dex of dexes) {
      try {
        for (const p of perpsFromMids(await fetchAllMids(dex), dex)) take(p);
      } catch {
        // One book's feed refusing says nothing about the others.
      }
    }
    // And the unnamed one, in case a venue ever does qualify keys in it.
    try {
      for (const p of perpsFromMids(await fetchAllMids())) take(p);
    } catch {
      // The listings, or nothing. Whatever they found still stands.
    }

    if (empty.length === dexes.length && dexes.length > 0 && extra === 0 && !dexError) {
      dexError = `all ${dexes.length} builder books answered with no perps, and none are quoted either (${empty.slice(0, 3).join(", ")})`;
    }
    status.fromMids = fromMids;
    status.dexError = dexError;

    status.lastOkAt = new Date().toISOString();
    status.lastError = null;
    status.perps = perps.length;
    status.dexes = dexes.length;
    status.builderPerps = extra;
    return perps;
  } catch (err: any) {
    status.lastError = String(err?.message ?? err);
    throw err;
  }
}

/**
 * The assets the venue lists, delisted included, from the cache — qualified
 * with their book where there is one, so "NVDA" on a builder DEX comes back
 * as "vntls:NVDA" and can never be read as the main universe's NVDA.
 */
export async function hyperliquidNames(): Promise<string[]> {
  return (await ensureHyperliquid()).map(hlAsset);
}

/**
 * When the stored catalogue was written.
 *
 * Distinct from `status.lastOkAt`, which is this process's memory of its own
 * fetches and reads null on every restart. What a reader wants to know is how
 * old the list they are searching actually is, and that is a property of the
 * rows rather than of the server that happens to be serving them.
 */
export async function hyperliquidFetchedAt(): Promise<string | null> {
  return universe.lastFetchedAt();
}

/* ------------------------------ a wallet ------------------------------ */

/** The most recent fills of a wallet — the venue keeps the last two thousand. */
export async function fetchUserFills(address: string): Promise<HlFill[]> {
  return parseUserFills(await info({ type: "userFills", user: address }, 20_000));
}

/** The wallet's order history, trigger orders included. */
export async function fetchHistoricalOrders(address: string): Promise<HlOrder[]> {
  return parseHistoricalOrders(await info({ type: "historicalOrders", user: address }, 20_000));
}

/* ------------------------------- prices ------------------------------- */

const SNAPSHOT_CAP = 5000;

/**
 * Candles for a window, following the venue's paging to the end of it.
 *
 * One snapshot caps at five thousand bars, and a swing left parked for a
 * month is more one-minute bars than that. Stopping at the cap would scan
 * the first stretch of the window and report "pending" for a trade whose
 * target was hit later — the same trap the Binance reader guards against.
 */
export async function readHlCandles(
  coin: string,
  interval: Interval,
  startMs: number,
  endMs: number,
  maxBars = SNAPSHOT_CAP,
): Promise<CandleRead> {
  const out: Candle[] = [];
  let cursor = startMs;
  while (cursor < endMs && out.length < maxBars) {
    const page = parseCandleSnapshot(
      await info({
        type: "candleSnapshot",
        req: { coin, interval, startTime: Math.floor(cursor), endTime: Math.floor(endMs) },
      }),
    );
    if (page.length === 0) break;
    for (const k of page) if (k.t > cursor - 1 && k.t <= endMs) out.push(k);
    const last = page[page.length - 1].t;
    if (!Number.isFinite(last) || last < cursor) break;
    cursor = last + 1;
    if (page.length < SNAPSHOT_CAP) break;
  }
  const truncated = out.length >= maxBars;
  return {
    candles: out.slice(0, maxBars),
    coveredTo: truncated ? out[out.length - 1].t : endMs,
    source: "api",
  };
}

/** Funding settlements for a coin across a window, hourly, paged. */
export async function fetchHlFunding(
  coin: string,
  startMs: number,
  endMs: number,
): Promise<{ time: number; rate: number }[]> {
  const out: { time: number; rate: number }[] = [];
  let cursor = startMs;
  for (let page = 0; page < 20 && cursor < endMs; page++) {
    const batch = parseFundingHistory(
      await info({ type: "fundingHistory", coin, startTime: Math.floor(cursor), endTime: Math.floor(endMs) }),
    );
    if (batch.length === 0) break;
    out.push(...batch.filter((e) => e.time >= cursor && e.time <= endMs));
    const last = batch[batch.length - 1].time;
    if (last < cursor) break;
    cursor = last + 1;
    if (batch.length < 500) break;
  }
  return out;
}

/**
 * Every mid in a book, now. One request for every open trade at once.
 *
 * `dex` is the whole story for builder-deployed books. Every info endpoint
 * here is scoped to ONE perp DEX, and asking without naming one answers for
 * the venue's own universe — the coin perps — and nothing else. So the
 * fallback that was meant to find equity and commodity markets in the price
 * feed was reading a feed those markets are not in, found no qualified keys,
 * and added nothing. Twice.
 */
export async function fetchAllMids(dex?: string): Promise<Record<string, number>> {
  return parseAllMids(await info(dex ? { type: "allMids", dex } : { type: "allMids" }, 8_000));
}

/**
 * What the venue literally answers, for a human to read.
 *
 * Three rounds of this feature were spent guessing at request shapes that
 * could not be tried from where the code was being written, each guess
 * looking identical to the last from the outside: a zero. This asks each
 * question and hands back the raw beginning of each answer, so the next
 * wrong guess costs one look instead of a deploy.
 *
 * Truncated hard — a universe is hundreds of entries and nobody needs them
 * all to see whether the shape is right.
 */
export async function probeHyperliquid(): Promise<Record<string, unknown>> {
  const head = (v: unknown, n = 8): unknown => {
    if (Array.isArray(v)) return v.slice(0, n);
    if (v && typeof v === "object") {
      const keys = Object.keys(v as object);
      const out: Record<string, unknown> = {};
      for (const k of keys.slice(0, n)) out[k] = (v as any)[k];
      return { __keys: keys.length, ...out };
    }
    return v;
  };
  const ask = async (label: string, body: Record<string, unknown>) => {
    try {
      return { [label]: head(await info(body, 10_000)) };
    } catch (err: any) {
      return { [label]: `ERROR ${String(err?.message ?? err)}` };
    }
  };

  const out: Record<string, unknown> = { host: host() };
  Object.assign(out, await ask("perpDexs", { type: "perpDexs" }));
  Object.assign(out, await ask("allMids (no dex)", { type: "allMids" }));

  // And the same two questions aimed at the first book the venue named.
  let first: string | null = null;
  try {
    first = parsePerpDexs(await info({ type: "perpDexs" }, 10_000))[0] ?? null;
  } catch {
    /* already reported above */
  }
  out.firstBook = first;
  if (first) {
    Object.assign(out, await ask(`meta dex=${first}`, { type: "meta", dex: first }));
    Object.assign(out, await ask(`allMids dex=${first}`, { type: "allMids", dex: first }));
  }
  return out;
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
