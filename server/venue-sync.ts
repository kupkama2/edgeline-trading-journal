/**
 * Writing what a venue says into the journal — the part both venues share.
 *
 * Hyperliquid and Binance read their accounts differently and arrive at the
 * same thing: a list of positions from flat to flat, each with the id the
 * venue gave its first fill. From there the work is identical, and it is the
 * work that decides whether the record is true, so it lives once:
 *
 *   1. The id. A trade this sync wrote before is found by it and, if the
 *      position has since closed or grown, brought up to date — and only in
 *      the fields a person could not have typed.
 *
 *   2. The claim. A trade a PERSON wrote for the same position — entry
 *      rounded, time approximate, exit perhaps never logged — is found by
 *      resemblance (shared/claim.ts), stamped with the venue's id so it is
 *      found by name next time, and filled in where it was blank. Nothing
 *      they wrote is overwritten. Without this step the first sync after a
 *      month of hand-logging doubles the month.
 *
 *   3. Otherwise it is new, and it is written as a fact: a trade the venue
 *      created is a trade, not a draft to confirm.
 */
import { findClaim, type VenueTrade } from "@shared/claim";
import type { HlTrade } from "@shared/hyperliquid";
import type { InsertTrade, TradeWithTags } from "@shared/schema";
import type { storageFor } from "./storage";

export type Levels = { initialStop: number | null; initialTarget: number | null };
type Store = ReturnType<typeof storageFor>;

/**
 * One trade the sync wrote or changed, enough to read it back in a list and
 * open it. Counts say the sync did something; this says WHAT, which is the
 * part worth looking at afterwards — in particular which hand-logged trades
 * it decided were the venue's, because that is the one decision in here that
 * is a judgement rather than a fact.
 */
export interface WrittenTrade {
  id: number;
  symbol: string;
  direction: "long" | "short";
  status: "open" | "closed";
  entryPrice: number;
  exitPrice: number | null;
  entryTime: string;
  how: "created" | "claimed" | "updated";
}

export interface AccountSync {
  account: string;
  fills: number;
  created: number;
  updated: number;
  unchanged: number;
  /** Hand-logged trades recognised as the venue's and stamped, not duplicated. */
  claimed: number;
  /** Positions open before the fill history begins — not written. */
  unreconstructed: number;
  /** Every trade touched, in the order they were met. */
  written: WrittenTrade[];
  error?: string;
}

export const emptySync = (account: string): AccountSync => ({
  account,
  fills: 0,
  updated: 0,
  created: 0,
  unchanged: 0,
  claimed: 0,
  unreconstructed: 0,
  written: [],
});

const note = (row: AccountSync, t: TradeWithTags, how: WrittenTrade["how"]) =>
  row.written.push({
    id: t.id,
    symbol: t.symbol,
    direction: t.direction === "short" ? "short" : "long",
    status: t.status === "closed" ? "closed" : "open",
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    entryTime: t.entryTime,
    how,
  });

export interface SyncSummary {
  accounts: AccountSync[];
  /** When no account is set up for the venue, this says so instead of a silent nothing. */
  message?: string;
}

/** What a venue-written trade looks like in the journal's own terms. */
export function asInsert(
  t: HlTrade,
  account: string,
  levels: Levels,
  symbol: string = t.coin.toUpperCase(),
  /**
   * The book the trade was in, when the symbol alone cannot say. A coin on a
   * Hyperliquid builder DEX — "xyz:WTIOIL" — is written as WTIOIL, and the
   * book it trades on goes here, where the chart and the mark look first.
   */
  pricePair: string | null = null,
): InsertTrade {
  return {
    symbol,
    pricePair,
    direction: t.direction,
    size: t.size,
    sizeUnit: "base",
    pointValue: 1,
    entryPrice: t.entryPrice,
    entryTime: new Date(t.entryTime).toISOString(),
    initialStop: levels.initialStop,
    initialTarget: levels.initialTarget,
    status: t.status,
    exitPrice: t.exitPrice,
    exitTime: t.exitTime != null ? new Date(t.exitTime).toISOString() : null,
    // How it closed is not in the fills. "other" is the honest reading, and
    // the health panel lists it as an exit reason still to be given.
    exitReason: t.status === "closed" ? "other" : null,
    fees: t.fees,
    account,
    externalId: t.externalId,
  } as InsertTrade;
}

/**
 * What a re-sync may change on a trade it wrote before: the exit, when the
 * position has closed since; a stop or target the orders now reveal, when
 * the trade still has none. Never a field a person could have edited.
 */
export function closingPatch(existing: TradeWithTags, t: HlTrade, levels: Levels): Partial<InsertTrade> | null {
  const patch: Record<string, unknown> = {};
  if (existing.status === "open" && t.status === "closed") {
    patch.status = "closed";
    patch.exitPrice = t.exitPrice;
    patch.exitTime = t.exitTime != null ? new Date(t.exitTime).toISOString() : null;
    patch.exitReason = existing.exitReason ?? "other";
    patch.fees = t.fees;
    // An add while open moves the average entry; the record follows the fills.
    patch.size = t.size;
    patch.entryPrice = t.entryPrice;
  } else if (existing.status === "open" && t.status === "open") {
    if (Math.abs(existing.size - t.size) > 1e-9) {
      patch.size = t.size;
      patch.entryPrice = t.entryPrice;
      patch.fees = t.fees;
    }
  }
  if (existing.initialStop == null && levels.initialStop != null) patch.initialStop = levels.initialStop;
  if (existing.initialTarget == null && levels.initialTarget != null) patch.initialTarget = levels.initialTarget;
  return Object.keys(patch).length ? (patch as Partial<InsertTrade>) : null;
}

/**
 * What a claim writes onto a hand-logged trade: the id, and the blanks.
 *
 * The person's entry, size and time stand — they are the reason the claim
 * matched. What they could not have known precisely, or did not log at all,
 * is taken from the venue: the fees if none were typed, the exit if the
 * trade was left open, a stop or target the orders show if they left those
 * blank. The exit reason, if the venue supplies one, is "other": the venue
 * knows the price and not the decision.
 */
export function claimPatch(
  existing: TradeWithTags,
  t: HlTrade,
  levels: Levels,
  pricePair: string | null = null,
): Partial<InsertTrade> {
  const patch: Record<string, unknown> = { externalId: t.externalId };
  if (existing.fees == null) patch.fees = t.fees;
  // A hand-logged WTIOIL had no way of saying which book it was on; the
  // venue just said. Only where nothing was chosen by hand already.
  if (!existing.pricePair && pricePair) patch.pricePair = pricePair;
  if (existing.status === "open" && t.status === "closed") {
    patch.status = "closed";
    patch.exitPrice = t.exitPrice;
    patch.exitTime = t.exitTime != null ? new Date(t.exitTime).toISOString() : null;
    patch.exitReason = existing.exitReason ?? "other";
  }
  if (existing.initialStop == null && levels.initialStop != null) patch.initialStop = levels.initialStop;
  if (existing.initialTarget == null && levels.initialTarget != null) patch.initialTarget = levels.initialTarget;
  return patch as Partial<InsertTrade>;
}

const asVenueTrade = (t: HlTrade, symbol: string): VenueTrade => ({
  symbol,
  direction: t.direction,
  entryTime: t.entryTime,
  entryPrice: t.entryPrice,
  size: t.size,
  status: t.status,
  exitTime: t.exitTime,
  closedPnl: t.closedPnl,
});

/**
 * Write one account's venue trades. `symbolOf` turns the venue's name for a
 * market into the journal's — Hyperliquid's "BTC" is already that, Binance's
 * "BTCUSDT" is not — and `levelsFor` reads the stop and target off whatever
 * order record the venue keeps.
 */
export async function writeVenueTrades(
  store: Store,
  row: AccountSync,
  trades: HlTrade[],
  opts: {
    symbolOf: (venueSymbol: string) => string;
    levelsFor: (t: HlTrade) => Levels;
    /** The stored price pair for a venue trade, where the symbol alone cannot name the book. */
    pairFor?: (t: HlTrade) => string | null;
  },
): Promise<void> {
  // The hand-logged trades on this account, fetched once: candidates for a
  // claim are every unstamped trade here, and a sync of forty positions must
  // not read the journal forty times to find them.
  const candidates = (await store.listTrades()).filter(
    (t) => (t.account ?? "") === row.account && !t.externalId,
  );
  const claimedIds = new Set<number>();

  for (const t of trades) {
    const symbol = opts.symbolOf(t.coin);
    const levels = opts.levelsFor(t);
    const pair = opts.pairFor?.(t) ?? null;

    const existing = await store.tradeByExternalId(t.externalId);
    if (existing) {
      const patch = closingPatch(existing, t, levels);
      if (patch) {
        const after = await store.updateTrade(existing.id, patch);
        row.updated += 1;
        note(row, after ?? existing, "updated");
      } else {
        row.unchanged += 1;
      }
      continue;
    }

    const mine = findClaim(
      asVenueTrade(t, symbol),
      candidates.filter((c) => !claimedIds.has(c.id)),
      opts.symbolOf,
    );
    if (mine) {
      claimedIds.add(mine.id);
      const after = await store.updateTrade(mine.id, claimPatch(mine, t, levels, pair));
      row.claimed += 1;
      note(row, after ?? mine, "claimed");
      continue;
    }

    const made = await store.createTrade(asInsert(t, row.account, levels, symbol, pair));
    row.created += 1;
    note(row, made, "created");
  }
}
