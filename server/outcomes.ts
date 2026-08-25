/**
 * Letting the market close the loop on trades you took off by hand.
 *
 * A parked trade asks one question — left alone, would price have hit the
 * target or the stop first? — and for crypto the answer is public. This walks
 * the trades still asking it, reads the candles from the ENTRY onward, and
 * writes back only the verdicts it is certain of.
 *
 * Three rules keep it from being worse than nothing:
 *
 *   It never overwrites a human answer. `outcomeUnknown` is true only for a
 *   blank or a parked "undetermined", so a trade you have already settled is
 *   not visited at all.
 *
 *   It never guesses. An unmatched symbol, a bar that touched both levels, a
 *   feed that is down — all leave the trade exactly as it was. A blank is
 *   visibly missing; a wrong answer in noManagementOutcome silently poisons
 *   potentialR and managementDeltaR and looks like your own judgement forever.
 *
 *   It records that it was the one who answered. outcomeSource is the only
 *   thing that can tell "the market said so" from "I said so" after the fact.
 */
import {
  binanceSymbolForTrade,
  firstTouch,
  listedAsPerp,
  pathExtremes,
  scanWindow,
  SEED_CATALOGUE,
  type BinanceSymbol,
  type PairRef,
} from "@shared/binance";
import { outcomeUnknown } from "@shared/aftermath";
import type { TradeWithTags } from "@shared/schema";
import { fetchCandles, fetchCatalogue, intervalFor, readCandles } from "./binance";
import { catalogue, collapsePairSymbolsOnce, storageFor } from "./storage";

/** How stale the pair list may get. Listings are daily news at most. */
const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Except when a whole book is missing from it, which is not staleness but a
 * refusal — and one that heals on its own the moment egress changes. Waiting a
 * full day to notice would mean a region change fixing nothing until tomorrow.
 */
const PARTIAL_TTL_MS = 60 * 60 * 1000;
/** Don't re-read the same unresolved trade more than once an hour. */
const RECHECK_MS = 60 * 60 * 1000;
/** Work cap per call, so a first run on a long history stays polite. */
const MAX_PER_RUN = 25;

export interface Resolved {
  tradeId: number;
  symbol: string;
  pair: string;
  verdict: "target_first" | "stop_first";
  /** ISO instant the level was reached. */
  hitAt: string;
}

/** Path fields filled in on this run, for the summary line. */
export interface Measured {
  tradeId: number;
  symbol: string;
  fields: string[];
}

export interface CheckSummary {
  checked: number;
  resolved: Resolved[];
  /** Still waiting: neither level reached yet, or the feed could not say. */
  pending: number;
  /** Closed trades this cannot speak for at all — index futures, unlisted tickers. */
  unmatched: number;
  /** Trades whose MAE/MFE or aftermath prices were filled in from the candles. */
  measured: Measured[];
  /** Set when the price feed itself failed; the caller should say so quietly. */
  error?: string;
}

/**
 * Historical pair symbols are folded into their coin the first time a
 * catalogue exists to fold them with — once per process, and idempotent, so
 * a restart costs one no-op scan rather than a wrong answer.
 */
let backfilled = false;

/** Refresh the cached pair list when it is missing or a day old. */
export async function ensureCatalogue(force = false): Promise<BinanceSymbol[]> {
  const last = await catalogue.lastFetchedAt();
  const partial = (await catalogue.list()).every((r) => r.market !== "futures");
  const ttl = partial ? PARTIAL_TTL_MS : CATALOGUE_TTL_MS;
  const stale = force || !last || Date.now() - new Date(last).getTime() > ttl;
  if (stale) {
    try {
      const rows = await fetchCatalogue();
      if (rows.length) await catalogue.replace(rows);
    } catch {
      // A failed refresh falls back to whatever is cached. An out-of-date
      // catalogue costs at worst a coin listed this week going unmatched,
      // which is the same as the honest "don't know" this returns anyway.
    }
  }
  const stored = (await catalogue.list()).map((r) => ({
    symbol: r.symbol,
    baseAsset: r.baseAsset,
    quoteAsset: r.quoteAsset,
    status: r.status,
    market: r.market === "futures" ? ("futures" as const) : ("spot" as const),
  }));

  /*
   * Fall back to the written-down list when the venue could not be reached.
   *
   * Knowing that "ZROUSDT" means ZRO, and offering real coins in the picker,
   * are not market-data questions and should not fail because a market is
   * unreachable. Prices still will — that part genuinely needs the venue, and
   * says so.
   *
   * Never written to the database: the cache stays a record of what was
   * actually fetched, so a successful fetch replaces it cleanly and the seed
   * disappears the moment it is no longer needed.
   */
  const cat = stored.length > 0 ? stored : SEED_CATALOGUE;

  if (!backfilled && cat.length > 0) {
    backfilled = true;
    try {
      await collapsePairSymbolsOnce(cat);
    } catch {
      // A failed fold leaves the old split symbols in place, which is where
      // they already were. It is not worth failing a price lookup over.
    }
  }
  return cat;
}

/**
 * Read the aftermath of every parked trade that has one, and settle what can
 * be settled.
 */
export async function checkOutcomes(userId: number): Promise<CheckSummary> {
  const store = storageFor(userId);
  const out: CheckSummary = { checked: 0, resolved: [], pending: 0, unmatched: 0, measured: [] };

  let cat: BinanceSymbol[];
  try {
    cat = await ensureCatalogue();
  } catch (err: any) {
    return { ...out, error: String(err?.message ?? err) };
  }
  if (cat.length === 0) return { ...out, error: "No Binance pair list available yet." };

  const all = await store.listTrades();
  const now = Date.now();
  const due = all
    .filter(outcomeUnknown)
    .filter((t) => {
      const at = (t as any).outcomeCheckedAt as string | null | undefined;
      return !at || now - new Date(at).getTime() > RECHECK_MS;
    })
    // Newest exit first: the trade you can still picture is the one worth
    // spending the call budget on when there are more than fit in one run.
    .sort((a, b) => (b.exitTime ?? b.entryTime).localeCompare(a.exitTime ?? a.entryTime));

  /*
   * Resolve the pair BEFORE the per-run cap, not inside the loop.
   *
   * Unmatched trades are never marked as checked — there is nothing to check —
   * so they stay at the head of this list forever. Capping first meant a
   * handful of recent futures trades could eat the entire budget every run and
   * no crypto trade would ever be read. Nothing would look broken; the feature
   * would just quietly never work.
   */
  /*
   * A catalogue with no perpetuals in it means the perp book REFUSED, not that
   * there are none — and a coin on the written-down list has a perp whether or
   * not this server is allowed to ask about it. Those trades are pointed back
   * at the perpetual, and the reader finds the bars where it can: the public
   * file archive serves them from a host that is not geo-restricted, a day in
   * arrears.
   *
   * Late and right beats prompt and wrong. Settling a perp trade from spot
   * candles would answer "did my stop get hit" with the price on a market the
   * order was never resting in — basis moves the two apart and a liquidation
   * cascade wicks the perp through levels spot never prints, so it would be
   * wrong exactly at the level that decides the answer. If the archive cannot
   * be reached either, the read fails and the trade is left where it was.
   */
  const perpsMissing = cat.every((s) => s.market !== "futures");

  const matched: { trade: TradeWithTags; pair: PairRef }[] = [];
  for (const t of due) {
    let pair = binanceSymbolForTrade(t, cat);
    if (perpsMissing && (!pair || pair.market === "spot") && listedAsPerp(t.symbol)) {
      pair = binanceSymbolForTrade(t, SEED_CATALOGUE) ?? pair;
    }
    if (pair) matched.push({ trade: t, pair });
    else out.unmatched++;
  }

  for (const { trade: t, pair } of matched.slice(0, MAX_PER_RUN)) {
    try {
      const read = await readTrade(t, pair);
      out.checked++;
      const stamp = new Date().toISOString();
      const patch: Record<string, unknown> = { outcomeCheckedAt: stamp };

      if (read.settled) {
        patch.noManagementOutcome = read.settled.verdict;
        patch.outcomeSource = "auto";
        patch.outcomeHitAt = read.settled.hitAt;
        out.resolved.push({
          tradeId: t.id,
          symbol: t.symbol,
          pair: pair.symbol,
          verdict: read.settled.verdict,
          hitAt: read.settled.hitAt,
        });
      } else {
        out.pending++;
      }

      /*
       * The path numbers, filled in only where the trade has nothing.
       *
       * Never overwriting is the whole rule here. These are fields a trader
       * reads off a chart by hand, and a hand-read value is a judgement about
       * which wick counted — replacing it with a machine's would silently
       * rewrite the record and there is no provenance column to tell them
       * apart afterwards. A blank has nothing to lose.
       */
      const filled: string[] = [];
      for (const [field, value] of [
        ["mae", read.path.mae],
        ["mfe", read.path.mfe],
        ["postExitPeak", read.path.postExitPeak],
        ["postExitAdverse", read.path.postExitAdverse],
      ] as const) {
        if (value != null && (t as any)[field] == null) {
          patch[field] = value;
          filled.push(field);
        }
      }
      if (filled.length) out.measured.push({ tradeId: t.id, symbol: t.symbol, fields: filled });

      await store.updateTrade(t.id, patch as any);
    } catch (err: any) {
      // One bad symbol must not abandon the rest of the run.
      out.error ??= String(err?.message ?? err);
    }
  }
  return out;
}

/**
 * One trade, one pass over its candles: the verdict AND the path numbers.
 *
 * Both from the same fetch, because they are answers to questions about the
 * same price path and fetching it twice would be two chances for them to
 * disagree — as well as twice the requests.
 */
async function readTrade(
  t: TradeWithTags,
  pair: PairRef,
): Promise<{
  settled: { verdict: "target_first" | "stop_first"; hitAt: string } | null;
  path: ReturnType<typeof pathExtremes>;
}> {
  const blank = { mae: null, mfe: null, postExitPeak: null, postExitAdverse: null };
  const window = scanWindow(t);
  if (!window) return { settled: null, path: blank };
  const { from, to } = window;

  const plan = { direction: t.direction, stop: t.initialStop, target: t.initialTarget };
  const coarse = intervalFor(to - from);
  const read = await readCandles(pair, coarse, from, to);
  const bars = read.candles;

  const exitMs = t.exitTime ? new Date(t.exitTime).getTime() : null;
  const path = pathExtremes(bars, {
    direction: t.direction,
    entryMs: from,
    exitMs,
    stop: t.initialStop,
  });

  /*
   * An excursion read off a window that stops early is not a small error, it
   * is the wrong number: the highest price in the first three days of a
   * five-day hold is not the highest price of the hold, and there is no
   * provenance column to mark it as provisional once written. So each pair of
   * fields is withheld until the data actually reaches the instant it is
   * measured over — MAE and MFE need the position closed, the aftermath needs
   * the whole window. Withheld means blank, and blank is asked again.
   */
  const grace = barSpanMs(coarse);
  if (exitMs != null && read.coveredTo < exitMs) {
    path.mae = null;
    path.mfe = null;
  }
  if (read.coveredTo < to - grace) {
    path.postExitPeak = null;
    path.postExitAdverse = null;
  }

  let touch = firstTouch(bars, plan);
  if (touch.verdict === "ambiguous") {
    /*
     * One bar held both levels, so their order is not knowable at this width.
     * Drill into that bar alone at one minute — usually enough, since a single
     * minute containing a full stop-to-target round trip is a genuine wick
     * event rather than ordinary movement.
     */
    const fine = await fetchCandles(pair, "1m", touch.at, touch.at + barSpanMs(coarse));
    touch = firstTouch(fine, plan);
    // Still both inside one minute: unknowable from candles. Leave it parked
    // rather than pick the flattering one.
    if (touch.verdict === "ambiguous") return { settled: null, path };
  }

  const settled =
    touch.verdict === "target_first" || touch.verdict === "stop_first"
      ? { verdict: touch.verdict, hitAt: new Date(touch.at).toISOString() }
      : null;
  return { settled, path };
}

const barSpanMs = (i: string) =>
  i === "1m" ? 60_000 : i === "5m" ? 300_000 : i === "15m" ? 900_000 : i === "1h" ? 3_600_000 : i === "4h" ? 14_400_000 : 86_400_000;
