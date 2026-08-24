/**
 * Letting the market close the loop on trades you took off by hand.
 *
 * A parked trade asks one question — left alone, would price have hit the
 * target or the stop first? — and for crypto the answer is public. This walks
 * the trades still asking it, reads the candles since their exit, and writes
 * back only the verdicts it is certain of.
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
import { binanceSymbolForTrade, firstTouch, type BinanceSymbol } from "@shared/binance";
import { outcomeUnknown } from "@shared/aftermath";
import type { TradeWithTags } from "@shared/schema";
import { fetchCandles, fetchCatalogue, intervalFor } from "./binance";
import { catalogue, storageFor } from "./storage";

/** How stale the pair list may get. Listings are daily news at most. */
const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000;
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

export interface CheckSummary {
  checked: number;
  resolved: Resolved[];
  /** Still waiting: neither level reached yet, or the feed could not say. */
  pending: number;
  /** Closed trades this cannot speak for at all — futures, unlisted tickers. */
  unmatched: number;
  /** Set when the price feed itself failed; the caller should say so quietly. */
  error?: string;
}

/** Refresh the cached pair list when it is missing or a day old. */
export async function ensureCatalogue(force = false): Promise<BinanceSymbol[]> {
  const last = await catalogue.lastFetchedAt();
  const stale =
    force || !last || Date.now() - new Date(last).getTime() > CATALOGUE_TTL_MS;
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
  return (await catalogue.list()).map((r) => ({
    symbol: r.symbol,
    baseAsset: r.baseAsset,
    quoteAsset: r.quoteAsset,
    status: r.status,
  }));
}

/**
 * Read the aftermath of every parked trade that has one, and settle what can
 * be settled.
 */
export async function checkOutcomes(userId: number): Promise<CheckSummary> {
  const store = storageFor(userId);
  const out: CheckSummary = { checked: 0, resolved: [], pending: 0, unmatched: 0 };

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

  for (const t of due.slice(0, MAX_PER_RUN)) {
    const pair = binanceSymbolForTrade(t, cat);
    if (!pair) {
      out.unmatched++;
      continue;
    }
    try {
      const settled = await settleOne(t, pair);
      out.checked++;
      const stamp = new Date().toISOString();
      if (settled) {
        await store.updateTrade(t.id, {
          noManagementOutcome: settled.verdict,
          outcomeSource: "auto",
          outcomeCheckedAt: stamp,
          outcomeHitAt: settled.hitAt,
        } as any);
        out.resolved.push({
          tradeId: t.id,
          symbol: t.symbol,
          pair,
          verdict: settled.verdict,
          hitAt: settled.hitAt,
        });
      } else {
        // Nothing to say yet — but record that we looked, so the next run
        // spends its budget on trades nobody has read.
        await store.updateTrade(t.id, { outcomeCheckedAt: stamp } as any);
        out.pending++;
      }
    } catch (err: any) {
      // One bad symbol must not abandon the rest of the run.
      out.error ??= String(err?.message ?? err);
    }
  }
  return out;
}

/**
 * One trade: fetch its aftermath and read the verdict off it.
 *
 * Returns null for every shade of "cannot say" — still running, both levels in
 * one bar even at minute resolution, no candles. The caller writes nothing in
 * that case beyond the timestamp saying it looked.
 */
async function settleOne(
  t: TradeWithTags,
  pair: string,
): Promise<{ verdict: "target_first" | "stop_first"; hitAt: string } | null> {
  const from = new Date(t.exitTime ?? t.entryTime).getTime();
  const to = Date.now();
  if (!isFinite(from) || to <= from) return null;

  const plan = { direction: t.direction, stop: t.initialStop, target: t.initialTarget };
  const coarse = intervalFor(to - from);
  const bars = await fetchCandles(pair, coarse, from, to);
  let touch = firstTouch(bars, plan);

  if (touch.verdict === "ambiguous") {
    /*
     * One bar held both levels, so their order is not knowable at this width.
     * Drill into that bar alone at one minute — which is usually enough, since
     * a single minute containing a full stop-to-target round trip is a genuine
     * wick event rather than ordinary movement.
     */
    const span = barSpanMs(coarse);
    const fine = await fetchCandles(pair, "1m", touch.at, touch.at + span);
    touch = firstTouch(fine, plan);
    // Still both inside one minute: unknowable from candles. Leave it parked
    // rather than pick the flattering one.
    if (touch.verdict === "ambiguous") return null;
  }

  if (touch.verdict === "target_first" || touch.verdict === "stop_first") {
    return { verdict: touch.verdict, hitAt: new Date(touch.at).toISOString() };
  }
  return null;
}

const barSpanMs = (i: string) =>
  i === "1m" ? 60_000 : i === "5m" ? 300_000 : i === "15m" ? 900_000 : i === "1h" ? 3_600_000 : i === "4h" ? 14_400_000 : 86_400_000;
