/**
 * Filling in how past trades were entered, from the venues.
 *
 * New trades get their entry type as they are written (server/venue-sync.ts,
 * server/tracker.ts, the terminal's send). This is for the ones written
 * before that: each still without one is looked up where the venue can say.
 *
 *   Binance: the entry order's own fills, by order id — the terminal and the
 *   tracker keep it on the trade — or, for a trade the sync wrote, by the id
 *   of its first fill, which is in the trade's external id and leads to the
 *   order. By id, not by time, so it reaches past the seven-day window.
 *
 *   Hyperliquid: the wallet's fill history, read once and rebuilt into
 *   positions; a trade is matched by its external id, or for a tracked one
 *   by its entry order.
 *
 * Only blanks are written, quietly. A trade a person marked keeps their mark.
 */
import { entryTypeOf, type EntryType } from "@shared/entry-type";
import { tradesFromFills, type HlFill } from "@shared/hyperliquid";
import { parseTerminalRef } from "@shared/terminal";
import type { AccountSettings, TradeWithTags } from "@shared/schema";
import { storageFor } from "./storage";
import { open } from "./secrets";
import { credsFor } from "./binance-account";
import { relayConnected } from "./relay";
import { orderFills, type Venue } from "./binance-trade";
import { fetchUserFillsSince } from "./hyperliquid";

export interface EntryBackfill {
  /** Trades without an entry type that some venue could be asked about. */
  asked: number;
  filled: number;
  /** Asked, and the venue's answer did not say (fills gone from its record, or no flag). */
  unanswered: number;
  /** Trades with no venue to ask: logged by hand on an account with no key or wallet. */
  noVenue: number;
  errors: string[];
}

/** At most this many venue lookups in one go; the rest wait for the next press. */
const MAX_LOOKUPS = 300;

const BINANCE_ID = /^binance:([A-Z0-9]+):(\d+)$/;

async function hlFillHistory(wallet: string): Promise<HlFill[]> {
  // Oldest first, two thousand a page; the venue keeps the last ten thousand.
  const out: HlFill[] = [];
  let from = 0;
  for (let page = 0; page < 6; page++) {
    const got = await fetchUserFillsSince(wallet, from);
    out.push(...got);
    if (got.length < 2000) break;
    const last = got[got.length - 1].time;
    if (!(last >= from)) break;
    from = last + 1;
  }
  return out;
}

export async function backfillEntryTypes(userId: number): Promise<EntryBackfill> {
  const s = storageFor(userId);
  const result: EntryBackfill = { asked: 0, filled: 0, unanswered: 0, noVenue: 0, errors: [] };
  const [all, settings] = await Promise.all([s.listTrades(), s.listAccountSettings()]);
  const todo = all.filter((t) => t.entryType == null && !t.paper && t.status !== "cancelled" && t.status !== "pending");
  const byAccount = new Map<string, TradeWithTags[]>();
  for (const t of todo) {
    const list = byAccount.get(t.account ?? "") ?? [];
    list.push(t);
    byAccount.set(t.account ?? "", list);
  }

  const write = async (t: TradeWithTags, type: EntryType | null) => {
    if (!type) {
      result.unanswered += 1;
      return;
    }
    await s.updateTrade(t.id, { entryType: type } as any, undefined, { quiet: true });
    result.filled += 1;
  };

  let lookups = 0;
  for (const [account, trades] of Array.from(byAccount.entries())) {
    const acct: AccountSettings | undefined = settings.find((a) => a.name === account);
    if (!acct) {
      result.noVenue += trades.length;
      continue;
    }
    try {
      if (acct.wallet) {
        const askable = trades.filter((t) => t.externalId?.startsWith("hl:") || parseTerminalRef(t.terminal)?.venue === "hyperliquid");
        result.noVenue += trades.length - askable.length;
        if (!askable.length) continue;
        result.asked += askable.length;
        const fills = await hlFillHistory(acct.wallet);
        const byId = new Map(tradesFromFills(fills, "hl").trades.map((x) => [x.externalId, entryTypeOf(x.opens)] as const));
        for (const t of askable) {
          const ref = parseTerminalRef(t.terminal);
          const fromId = t.externalId ? byId.get(t.externalId) : undefined;
          const fromOrder =
            ref?.entryOrderId != null ? entryTypeOf(fills.filter((f) => f.oid === ref.entryOrderId).map((f) => ({ sz: f.sz, maker: f.maker }))) : null;
          await write(t, fromId ?? fromOrder ?? null);
        }
        continue;
      }
      if (!acct.relayToken && !(acct.binanceKey && acct.binanceSecret)) {
        result.noVenue += trades.length;
        continue;
      }
      // What can be asked: an entry order id, or a synced trade's first fill id.
      const askable = trades
        .map((t) => {
          const ref = parseTerminalRef(t.terminal);
          if (ref?.venue === "binance" && ref.entryOrderId != null) return { t, symbol: ref.symbol, orderId: ref.entryOrderId as number | null, fromId: null as number | null };
          const m = t.externalId ? BINANCE_ID.exec(t.externalId) : null;
          return m ? { t, symbol: m[1], orderId: null, fromId: Number(m[2]) } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      result.noVenue += trades.length - askable.length;
      if (!askable.length) continue;
      if (acct.relayToken && !relayConnected(userId, acct.name)) {
        result.errors.push(`${acct.name}: the relay is not connected, so ${askable.length} ${askable.length === 1 ? "trade" : "trades"} could not be asked about.`);
        continue;
      }
      const creds = credsFor(acct, open);
      if (!creds) {
        result.errors.push(`${acct.name}: the stored key could not be opened.`);
        continue;
      }
      const v: Venue = { creds, env: acct.binanceEnv === "testnet" ? "testnet" : "live" };
      for (const a of askable) {
        if (lookups >= MAX_LOOKUPS) break;
        result.asked += 1;
        let orderId = a.orderId;
        if (orderId == null && a.fromId != null) {
          lookups += 1;
          const first = (await orderFills(v, a.symbol, { fromId: a.fromId }))[0];
          orderId = first && first.id === a.fromId ? first.orderId : null;
        }
        if (orderId == null) {
          result.unanswered += 1;
          continue;
        }
        lookups += 1;
        const legs = await orderFills(v, a.symbol, { orderId });
        await write(a.t, entryTypeOf(legs.map((r) => ({ sz: r.qty, maker: r.maker }))));
      }
    } catch (err: any) {
      result.errors.push(`${acct.name}: ${String(err?.message ?? err).slice(0, 160)}`);
    }
  }
  if (lookups >= MAX_LOOKUPS) result.errors.push(`Stopped after ${MAX_LOOKUPS} lookups; press again for the rest.`);
  return result;
}
