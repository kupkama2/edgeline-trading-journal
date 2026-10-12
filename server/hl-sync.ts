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
 *
 * The writing itself — by id, by resemblance to a hand-logged trade, or new —
 * is shared with the Binance sync; see venue-sync.ts.
 */
import { levelsFromOrders, splitHlAsset, tradesFromFills } from "@shared/hyperliquid";
import { formatPricePair } from "@shared/price-pair";
import { fetchHistoricalOrders, fetchUserFills } from "./hyperliquid";
import { storageFor } from "./storage";
import { emptySync, writeVenueTrades, type AccountSync, type SyncSummary } from "./venue-sync";

export type { AccountSync, SyncSummary } from "./venue-sync";
export { closingPatch } from "./venue-sync";

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
    const row = emptySync(acct.name);
    try {
      const fills = await fetchUserFills(acct.wallet!);
      row.fills = fills.length;
      const read = tradesFromFills(fills, "hl");
      row.unreconstructed = read.unreconstructed.reduce((n, u) => n + u.fills, 0);
      // The order history is a nicety: a trade without a stop is still a trade.
      const orders = await fetchHistoricalOrders(acct.wallet!).catch(() => []);
      await writeVenueTrades(store, row, read.trades, {
        /*
         * A builder-book coin arrives as "xyz:WTIOIL". The journal's symbol is
         * WTIOIL — upper-casing the whole thing wrote "XYZ:WTIOIL", a name no
         * chart could resolve and no hand-logged WTIOIL would ever match —
         * and the book it trades on is kept, in the venue's own spelling, as
         * the trade's price pair, which is where the chart and the mark look
         * first. The venue's own coins have no dex and get no pair.
         */
        symbolOf: (coin) => splitHlAsset(coin).coin.toUpperCase(),
        levelsFor: (t) => levelsFromOrders(t, orders),
        pairFor: (t) =>
          splitHlAsset(t.coin).dex
            ? formatPricePair({ venue: "hyperliquid", market: "futures", symbol: t.coin })
            : null,
      });
    } catch (err: any) {
      row.error = String(err?.message ?? err);
    }
    out.push(row);
  }
  return { accounts: out };
}
