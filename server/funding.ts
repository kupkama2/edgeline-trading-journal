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

async function binanceFunding(
  symbol: string,
  entryMs: number,
  exitMs: number,
): Promise<{ events: FundingEvent[]; complete: boolean }> {
  const out: FundingEvent[] = [];
  let complete = true;
  for (const month of fundingMonths(entryMs, exitMs)) {
    const url = `${ARCHIVE_BASE}/data/futures/um/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${month}.zip`;
    try {
      out.push(...parseBinanceFundingCsv(await fetchArchiveText(url)));
    } catch {
      // A month not published yet — the current one, usually — or a read
      // that failed. Either way the hold is not fully covered.
      complete = false;
    }
  }
  return { events: out, complete };
}

export interface FundingRead {
  /** Net as it hit the account: positive received, negative paid. */
  funding: number;
  /** Settlements the estimate rests on. Zero means nothing was readable. */
  events: number;
  /**
   * Every settlement in the hold was readable. A figure from part of the
   * hold — a month not published yet, a file that failed — is not written:
   * once a trade has funding it is never asked again, so a partial figure
   * written now would stand for good.
   */
  complete: boolean;
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

  const read =
    pair.venue === "hyperliquid"
      ? { events: await fetchHlFunding(pair.symbol, entryMs, exitMs), complete: true }
      : await binanceFunding(pair.symbol, entryMs, exitMs);
  const est = estimateFunding({ direction: t.direction, notional, entryMs, exitMs }, read.events);
  return est ? { ...est, complete: read.complete } : null;
}
