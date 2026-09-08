/**
 * Fills into the journal.
 *
 * A wallet address is public, and so is everything it has done: every fill,
 * every order, with no key and no permission. So an account that names its
 * wallet can have its trades written by the venue instead of by hand —
 * entry, exit, size, fees, and the stop and target read off the trigger
 * orders that were resting at the time.
 *
 * What the venue writes is a FACT and is treated as one: a trade it creates
 * is a real trade, not a draft to confirm. What it cannot know it leaves
 * blank — the style, the rationale, a stop it never saw — and the health
 * panel points at the blanks. Nothing a person has since written on a
 * synced trade is touched; a re-sync only fills in an exit that was still
 * open last time.
 */
import { levelsFromOrders, tradesFromFills, type HlTrade } from "@shared/hyperliquid";
import type { InsertTrade, TradeWithTags } from "@shared/schema";
import { fetchHistoricalOrders, fetchUserFills } from "./hyperliquid";
import { storageFor } from "./storage";

export interface AccountSync {
  account: string;
  fills: number;
  created: number;
  updated: number;
  unchanged: number;
  /** Positions open before the fill history begins — not written. */
  unreconstructed: number;
  error?: string;
}

export interface SyncSummary {
  accounts: AccountSync[];
  /** When no account names a wallet, this says so instead of a silent nothing. */
  message?: string;
}

/** What a venue-written trade looks like in the journal's own terms. */
function asInsert(t: HlTrade, account: string, levels: { initialStop: number | null; initialTarget: number | null }): InsertTrade {
  return {
    symbol: t.coin.toUpperCase(),
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
 * Sync every account of one user that names a wallet.
 *
 * Idempotent by external id: a trade already written is left alone unless
 * it was open last time and the fills now close it, in which case the exit,
 * the fees and any stop the orders reveal are filled in — and only those.
 */
export async function syncHyperliquid(userId: number, onlyAccount?: string): Promise<SyncSummary> {
  const store = storageFor(userId);
  const accounts = (await store.listAccountSettings()).filter(
    (a) => a.wallet && (!onlyAccount || a.name === onlyAccount),
  );
  if (accounts.length === 0) {
    return {
      accounts: [],
      message: "No account names a Hyperliquid wallet yet — add one in Settings, next to the account's fees.",
    };
  }

  const out: AccountSync[] = [];
  for (const acct of accounts) {
    const row: AccountSync = { account: acct.name, fills: 0, created: 0, updated: 0, unchanged: 0, unreconstructed: 0 };
    try {
      const fills = await fetchUserFills(acct.wallet!);
      row.fills = fills.length;
      const read = tradesFromFills(fills);
      row.unreconstructed = read.unreconstructed.reduce((n, u) => n + u.fills, 0);
      // The order history is a nicety: a trade without a stop is still a trade.
      const orders = await fetchHistoricalOrders(acct.wallet!).catch(() => []);

      for (const t of read.trades) {
        const levels = levelsFromOrders(t, orders);
        const existing = await store.tradeByExternalId(t.externalId);
        if (!existing) {
          await store.createTrade(asInsert(t, acct.name, levels));
          row.created += 1;
          continue;
        }
        const patch = closingPatch(existing, t, levels);
        if (patch) {
          await store.updateTrade(existing.id, patch);
          row.updated += 1;
        } else {
          row.unchanged += 1;
        }
      }
    } catch (err: any) {
      row.error = String(err?.message ?? err);
    }
    out.push(row);
  }
  return { accounts: out };
}

/**
 * What a re-sync may change on a trade it wrote before: the exit, when the
 * position has closed since; a stop or target the orders now reveal, when
 * the trade still has none. Never a field a person could have edited.
 */
export function closingPatch(
  existing: TradeWithTags,
  t: HlTrade,
  levels: { initialStop: number | null; initialTarget: number | null },
): Partial<InsertTrade> | null {
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
