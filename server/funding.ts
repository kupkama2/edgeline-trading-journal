/**
 * Funding for one trade, from whichever venue it was on.
 *
 * The arithmetic is in shared/funding.ts and pure. This file only knows
 * where each venue keeps its rate history: Hyperliquid answers a coin's
 * settlements live, hourly; Binance publishes each month's settlements as
 * a file in the archive bucket, after the month has ended — which means
 * a trade closed this month has no Binance file to read yet, and the
 * honest answer for it is "not yet" rather than zero.
 */
import type { PairRef } from "@shared/binance";
import { estimateFunding, fundingMonths, parseBinanceFundingCsv, type FundingEvent } from "@shared/funding";
import type { TradeWithTags } from "@shared/schema";
import { ARCHIVE_BASE, fetchArchiveText } from "./binance-archive";
import { fetchHlFunding } from "./hyperliquid";

async function binanceFunding(symbol: string, entryMs: number, exitMs: number): Promise<FundingEvent[]> {
  const out: FundingEvent[] = [];
  for (const month of fundingMonths(entryMs, exitMs)) {
    const url = `${ARCHIVE_BASE}/data/futures/um/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${month}.zip`;
    try {
      out.push(...parseBinanceFundingCsv(await fetchArchiveText(url)));
    } catch {
      // A month not published yet — the current one, usually. The estimate
      // covers the settlements that exist and reports how many it rests on.
    }
  }
  return out;
}

export interface FundingRead {
  /** Net as it hit the account: positive received, negative paid. */
  funding: number;
  /** Settlements the estimate rests on. Zero means nothing was readable. */
  events: number;
}

/**
 * The funding a closed perp trade paid or earned over its hold.
 *
 * Null for anything that cannot have funding — spot, futures contracts, a
 * trade still running — and for a hold whose span is not a span. The
 * notional is the opening size at the entry price: what the record has,
 * and within a few percent of what the venue charged on the mark.
 */
export async function fundingForTrade(t: TradeWithTags, pair: PairRef): Promise<FundingRead | null> {
  if (pair.market !== "futures") return null;
  if (t.contract?.trim()) return null;
  if (!t.exitTime || t.exitPrice == null || t.status !== "closed") return null;
  const entryMs = Date.parse(t.entryTime);
  const exitMs = Date.parse(t.exitTime);
  if (!Number.isFinite(entryMs) || !Number.isFinite(exitMs) || exitMs <= entryMs) return null;

  const qty = t.sizeUnit === "quote" ? (t.entryPrice > 0 ? t.size / t.entryPrice : 0) : t.size;
  const notional = qty * t.entryPrice * (t.pointValue || 1);
  if (!(notional > 0)) return null;

  const events =
    pair.venue === "hyperliquid"
      ? await fetchHlFunding(pair.symbol, entryMs, exitMs)
      : await binanceFunding(pair.symbol, entryMs, exitMs);
  return estimateFunding({ direction: t.direction, notional, entryMs, exitMs }, events);
}
