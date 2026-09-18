/**
 * Hyperliquid, read without a network.
 *
 * Hyperliquid is the other venue these trades happen on, and it is a simpler
 * one to describe than Binance: there is no spot pair sharing a name with the
 * perp, no quote currency to choose, no quarterly to skip. The universe is a
 * flat list of coins, one perp each, and the coin IS the instrument.
 *
 * Everything here is pure: the venue's JSON in, the journal's shapes out. The
 * fetching lives in server/hyperliquid.ts. That split is the point — what a
 * fill MEANS for a trade, which order was the stop, how much funding a hold
 * cost: these are the readings that must be right, and they must be testable
 * against a saved answer while the venue itself is out of reach.
 *
 * Two things are kept exactly as the venue says them, on purpose.
 *
 *   The name. Hyperliquid writes a thousand-lot with a k — kPEPE is what the
 *   exchange calls a thousand PEPE, and it is what the trader saw on the
 *   order ticket. Rewriting it to 1000PEPE (Binance's spelling) would offer a
 *   name in the picker that appears on no screen they trade from.
 *
 *   The delisted flag. A delisted coin is not dropped, because an old trade
 *   on it still has to be recognised as a Hyperliquid perp; it is flagged, so
 *   the picker can leave it out of what it offers for a NEW trade.
 */
import type { Candle } from "./binance";

export interface HyperliquidPerp {
  /** The coin as Hyperliquid names it: "BTC", "kPEPE". */
  name: string;
  maxLeverage: number | null;
  delisted: boolean;
  /**
   * Which perp DEX lists it. Null is the venue's own universe — the coin
   * perps — and a string is a builder-deployed one, which is where the
   * equity and commodity perps live.
   *
   * It has to be carried rather than flattened away, because two DEXs can
   * list the same ticker. A bare "GOLD" is not an asset; it is a ticker that
   * some book somewhere uses, and reading candles for the wrong one would
   * answer "did my stop get hit" against a market the order was never in.
   */
  dex?: string | null;
}

/**
 * How a coin is addressed once the DEX matters: "BTC" on the main universe,
 * "vntls:NVDA" on a builder-deployed one. This is the string that goes to the
 * venue for candles and comes back as a key in the mids.
 */
export function hlAsset(p: { name: string; dex?: string | null }): string {
  return p.dex ? `${p.dex}:${p.name}` : p.name;
}

/** The DEX and coin back out of a qualified name. */
export function splitHlAsset(asset: string): { dex: string | null; coin: string } {
  const i = asset.indexOf(":");
  if (i < 0) return { dex: null, coin: asset };
  return { dex: asset.slice(0, i), coin: asset.slice(i + 1) };
}

/**
 * Read the venue's `perpDexs` answer: the deployed perp DEXs, of which the
 * first entry is null — that is the venue's own universe, which is fetched
 * without a name and must not be requested as if it had one.
 *
 * Anything not shaped like a list means no builder DEXs, which is exactly
 * today's behaviour: the main universe alone. A guess here would be worse
 * than nothing, because it would send meta requests naming a DEX that does
 * not exist and the failures would look like the venue being down.
 */
export function parsePerpDexs(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of json) {
    if (d == null) continue; // the venue's own universe
    const name = typeof (d as any)?.name === "string" ? (d as any).name.trim() : "";
    // A colon in a DEX name would make a qualified asset ambiguous to split.
    if (!name || name.includes(":") || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Read the venue's `meta` answer: `{ universe: [{ name, maxLeverage, isDelisted? }] }`.
 *
 * Shaped wrong means nothing, not a partial list — a caller that stores what
 * this returns must not be handed half a universe because one field moved.
 * Within a well-shaped answer, an entry without a usable name is skipped and
 * the rest kept; one bad entry is not a reason to forget two hundred coins.
 */
export function parseHyperliquidMeta(json: unknown, dex: string | null = null): HyperliquidPerp[] {
  const universe = (json as { universe?: unknown } | null)?.universe;
  if (!Array.isArray(universe)) return [];
  const out: HyperliquidPerp[] = [];
  const seen = new Set<string>();
  for (const u of universe as Array<Record<string, unknown>>) {
    const name = typeof u?.name === "string" ? u.name.trim() : "";
    // A coin whose own name contains a colon could not be told apart from a
    // DEX-qualified one, so it is dropped rather than stored ambiguously.
    if (!name || name.includes(":") || seen.has(name)) continue;
    seen.add(name);
    const lev = Number(u.maxLeverage);
    out.push({
      name,
      maxLeverage: Number.isFinite(lev) && lev > 0 ? lev : null,
      delisted: u.isDelisted === true,
      dex,
    });
  }
  return out;
}

/**
 * The coin to read candles for, given a ticker and everything the venue
 * lists — and null rather than a guess whenever the answer is not unique.
 *
 * The main universe wins outright: a journal entry saying "BTC" means the
 * coin perp, whatever some builder DEX has chosen to call its own market. A
 * ticker the main universe does NOT list resolves to a builder DEX only when
 * exactly one of them lists it. Two candidates is not a tie to be broken by
 * sort order; it is a question only the trader can answer, and the pair
 * picker is where they answer it.
 */
export function hlAssetFor(
  symbol: string | null | undefined,
  perps: { name: string; dex?: string | null }[],
): string | null {
  const main = hlCoinFor(symbol, perps.filter((p) => !p.dex).map((p) => p.name));
  if (main) return main;

  const key = (symbol ?? "").trim().toUpperCase();
  if (!key) return null;
  const hits = perps.filter((p) => p.dex && p.name.toUpperCase() === key);
  return hits.length === 1 ? hlAsset(hits[0]) : null;
}

/** Where a trade happens. Read off the account, which is where people write it. */
export type Venue = "binance" | "hyperliquid";

/**
 * Which venue an account name points at, or null when it does not say.
 *
 * Accounts here are free text — "Binance Futures", "Hyperliquid", "HL main"
 * — so this is a reading of the name, not a lookup. It ranks the picker and
 * chooses which venue's candles a trade is read against; a wrong read on the
 * picker costs a scroll, and on the candles it is caught by the coin not
 * existing on the venue the name pointed at.
 */
export function venueOfAccount(name: string | null | undefined): Venue | null {
  const n = (name ?? "").toLowerCase();
  if (!n) return null;
  if (/hyper|\bhl\b/.test(n)) return "hyperliquid";
  if (/binance|\bbn\b/.test(n)) return "binance";
  return null;
}

/** A wallet address as the venue writes one: 0x and forty hex characters. */
export const isWalletAddress = (s: string | null | undefined): boolean =>
  /^0x[0-9a-fA-F]{40}$/.test((s ?? "").trim());

/* ------------------------------- names ------------------------------- */

/**
 * The venue's spelling of a journal symbol, or null when it does not list it.
 *
 * "BTC" is "BTC"; "KPEPE" — which is how the journal stores it, upper-cased
 * like everything else — is "kPEPE"; and Binance's "1000PEPE" is the same
 * contract and finds "kPEPE" too. Anything the venue does not list is null,
 * not a guess: a trade on a coin Hyperliquid never had cannot be read
 * against Hyperliquid's candles, whatever the account name says.
 */
export function hlCoinFor(symbol: string | null | undefined, names: string[]): string | null {
  const key = (symbol ?? "").trim().toUpperCase();
  if (!key) return null;
  const byUpper = new Map(names.map((n) => [n.toUpperCase(), n] as const));
  const exact = byUpper.get(key);
  if (exact) return exact;
  if (/^1000[A-Z0-9]{2,}$/.test(key)) return byUpper.get(`K${key.slice(4)}`) ?? null;
  return null;
}

/* ------------------------------- fills ------------------------------- */

/** One fill as the venue reports it, numbers already read. */
export interface HlFill {
  coin: string;
  px: number;
  sz: number;
  /** B is a buy, A a sell — the venue's letters. */
  side: "B" | "A";
  /** Epoch ms. */
  time: number;
  /** Signed position BEFORE this fill: negative is short. The venue's own record. */
  startPosition: number;
  /** "Open Long", "Close Short", "Long > Short"… descriptive, not relied on. */
  dir: string;
  closedPnl: number;
  fee: number;
  /** Trade id, unique per fill. */
  tid: number;
  oid: number;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Read `userFills`. Malformed entries are skipped, the rest sorted by time
 * then by trade id, which is the order the venue executed them in.
 */
export function parseUserFills(json: unknown): HlFill[] {
  if (!Array.isArray(json)) return [];
  const out: HlFill[] = [];
  for (const f of json as Array<Record<string, unknown>>) {
    const coin = typeof f?.coin === "string" ? f.coin.trim() : "";
    const px = num(f?.px);
    const sz = num(f?.sz);
    const time = num(f?.time);
    const tid = num(f?.tid);
    const start = num(f?.startPosition);
    if (!coin || px == null || sz == null || time == null || tid == null || start == null) continue;
    if (f.side !== "B" && f.side !== "A") continue;
    out.push({
      coin,
      px,
      sz,
      side: f.side,
      time,
      startPosition: start,
      dir: typeof f.dir === "string" ? f.dir : "",
      closedPnl: num(f.closedPnl) ?? 0,
      fee: num(f.fee) ?? 0,
      tid,
      oid: num(f.oid) ?? 0,
    });
  }
  return out.sort((a, b) => a.time - b.time || a.tid - b.tid);
}

export interface HlLeg {
  px: number;
  sz: number;
  time: number;
  fee: number;
  tid: number;
}

/** A position from open to flat, as the journal understands a trade. */
export interface HlTrade {
  coin: string;
  direction: "long" | "short";
  /** Base units opened, summed over every adding fill. */
  size: number;
  /** Size-weighted average of the opening fills. */
  entryPrice: number;
  entryTime: number;
  /** Size-weighted average of the closing fills; null while still open. */
  exitPrice: number | null;
  exitTime: number | null;
  status: "open" | "closed";
  /** Every fee the position paid, both ways. */
  fees: number;
  /** The venue's own realised P&L over the closing fills. */
  closedPnl: number;
  /** "hl:<coin>:<first opening fill id>" — stable across syncs. */
  externalId: string;
  opens: HlLeg[];
  closes: HlLeg[];
}

export interface FillsRead {
  trades: HlTrade[];
  /**
   * Positions that were already open when the fill history begins, so their
   * entry is not in the record and nothing honest can be written for them.
   * Said out loud rather than guessed at.
   */
  unreconstructed: { coin: string; fills: number }[];
}

const ZERO = 1e-9;
const sign = (x: number) => (x > ZERO ? 1 : x < -ZERO ? -1 : 0);
const wavg = (legs: HlLeg[]) => {
  const sz = legs.reduce((a, l) => a + l.sz, 0);
  return sz > 0 ? legs.reduce((a, l) => a + l.px * l.sz, 0) / sz : 0;
};

/**
 * Fills into trades.
 *
 * A trade is a position from flat to flat. The venue reports the position
 * BEFORE each fill, and that number is trusted over any running sum here:
 * it is the venue's own ledger, and if it ever disagrees with what these
 * fills add up to, fills are missing from the window and the trade being
 * built cannot be finished honestly — it is set aside, not patched.
 *
 * A fill that crosses zero — "Long > Short" — is two things at once: it
 * closes the old position and opens the new one, and it is split that way,
 * fees pro rata. A fill that merely shrinks the position is a partial close;
 * one that grows it is an add. Entry and exit are size-weighted over their
 * legs, which is what the account actually paid and received.
 */
export function tradesFromFills(fills: HlFill[]): FillsRead {
  const byCoin = new Map<string, HlFill[]>();
  for (const f of fills) {
    const list = byCoin.get(f.coin) ?? [];
    list.push(f);
    byCoin.set(f.coin, list);
  }

  const trades: HlTrade[] = [];
  const unreconstructed: { coin: string; fills: number }[] = [];

  for (const [coin, list] of Array.from(byCoin.entries())) {
    list.sort((a, b) => a.time - b.time || a.tid - b.tid);
    let current: HlTrade | null = null;
    let expectedBefore: number | null = null;
    let lost = 0;

    const finish = (t: HlTrade, at: number) => {
      t.exitPrice = wavg(t.closes);
      t.exitTime = at;
      t.status = "closed";
      trades.push(t);
    };
    const open = (dir: 1 | -1, leg: HlLeg): HlTrade => ({
      coin,
      direction: dir > 0 ? "long" : "short",
      size: leg.sz,
      entryPrice: leg.px,
      entryTime: leg.time,
      exitPrice: null,
      exitTime: null,
      status: "open",
      fees: leg.fee,
      closedPnl: 0,
      externalId: `hl:${coin}:${leg.tid}`,
      opens: [leg],
      closes: [],
    });

    for (const f of list) {
      const before = f.startPosition;
      const delta = f.side === "B" ? f.sz : -f.sz;
      const after = before + delta;

      // The venue's ledger disagrees with ours: fills are missing. Whatever
      // was being built is not a trade any more.
      if (current && expectedBefore != null && Math.abs(expectedBefore - before) > ZERO) {
        lost += current.opens.length + current.closes.length;
        current = null;
      }

      const sb = sign(before);
      const sa = sign(after);
      const leg = (sz: number): HlLeg => ({
        px: f.px,
        sz,
        time: f.time,
        fee: f.sz > 0 ? (f.fee * sz) / f.sz : 0,
        tid: f.tid,
      });

      if (sb === 0) {
        // From flat. A zero-size fill opens nothing.
        if (sa !== 0) current = open(sa, leg(Math.abs(after)));
      } else if (!current) {
        // Open before the record starts: unreconstructable until it is flat.
        lost += 1;
        if (sa === 0) {
          unreconstructed.push({ coin, fills: lost });
          lost = 0;
        }
      } else if (sa === sb) {
        if (Math.abs(after) > Math.abs(before)) {
          const l = leg(Math.abs(after) - Math.abs(before));
          current.opens.push(l);
          current.size += l.sz;
          current.fees += l.fee;
          current.entryPrice = wavg(current.opens);
        } else {
          const l = leg(Math.abs(before) - Math.abs(after));
          current.closes.push(l);
          current.fees += l.fee;
          current.closedPnl += f.closedPnl;
        }
      } else if (sa === 0) {
        const l = leg(Math.abs(before));
        current.closes.push(l);
        current.fees += l.fee;
        current.closedPnl += f.closedPnl;
        finish(current, f.time);
        current = null;
      } else {
        // Crossed zero: close the old side in full, open the new side with the rest.
        const closing = leg(Math.abs(before));
        current.closes.push(closing);
        current.fees += closing.fee;
        current.closedPnl += f.closedPnl;
        finish(current, f.time);
        current = open(sa, leg(Math.abs(after)));
      }
      expectedBefore = after;
    }
    if (lost > 0) unreconstructed.push({ coin, fills: lost });
    if (current) trades.push(current);
  }

  return {
    trades: trades.sort((a, b) => a.entryTime - b.entryTime),
    unreconstructed,
  };
}

/* ------------------------------- orders ------------------------------- */

/** A trigger order as the venue's order history reports it. */
export interface HlOrder {
  coin: string;
  oid: number;
  side: "B" | "A";
  isTrigger: boolean;
  triggerPx: number | null;
  /** "Stop Market", "Take Profit Limit", "Limit"… the venue's words. */
  orderType: string;
  reduceOnly: boolean;
  isPositionTpsl: boolean;
  timestamp: number;
  status: string;
}

/** Read `historicalOrders`: `[{ order: {…}, status, statusTimestamp }]`. */
export function parseHistoricalOrders(json: unknown): HlOrder[] {
  if (!Array.isArray(json)) return [];
  const out: HlOrder[] = [];
  for (const row of json as Array<Record<string, unknown>>) {
    const o = (row?.order ?? row) as Record<string, unknown>;
    const coin = typeof o?.coin === "string" ? o.coin.trim() : "";
    const ts = num(o?.timestamp);
    const oid = num(o?.oid);
    if (!coin || ts == null || oid == null) continue;
    if (o.side !== "B" && o.side !== "A") continue;
    out.push({
      coin,
      oid,
      side: o.side,
      isTrigger: o.isTrigger === true,
      triggerPx: num(o.triggerPx),
      orderType: typeof o.orderType === "string" ? o.orderType : "",
      reduceOnly: o.reduceOnly === true,
      isPositionTpsl: o.isPositionTpsl === true,
      timestamp: ts,
      status: typeof row.status === "string" ? row.status : "",
    });
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * The stop and target a trade was placed with, read off its trigger orders.
 *
 * Fills do not carry a stop; the order book did. A reduce-only trigger on
 * the same coin, placed once the position existed and before it was flat,
 * on the adverse side of the entry with "Stop" in its type is the stop; on
 * the favourable side with "Take Profit" in its type is the target. The
 * EARLIEST of each is the plan — later ones are the trade being managed,
 * which is a different fact this journal records separately.
 *
 * Nothing qualifies, nothing is written. A trade without a stop is a gap
 * the health panel will point at; a stop guessed from the wrong order is a
 * wrong R on every statistic the trade touches.
 */
export function levelsFromOrders(
  t: Pick<HlTrade, "coin" | "direction" | "entryPrice" | "entryTime" | "exitTime">,
  orders: HlOrder[],
): { initialStop: number | null; initialTarget: number | null } {
  const long = t.direction === "long";
  const from = t.entryTime - 2 * 60 * 60 * 1000;
  const to = t.exitTime ?? Number.POSITIVE_INFINITY;
  const mine = orders.filter(
    (o) =>
      o.coin === t.coin &&
      o.isTrigger &&
      o.triggerPx != null &&
      o.timestamp >= from &&
      o.timestamp <= to &&
      (o.reduceOnly || o.isPositionTpsl || (long ? o.side === "A" : o.side === "B")),
  );
  const type = (o: HlOrder) => o.orderType.toLowerCase();
  const stop = mine.find(
    (o) => type(o).includes("stop") && (long ? o.triggerPx! < t.entryPrice : o.triggerPx! > t.entryPrice),
  );
  const target = mine.find(
    (o) =>
      type(o).includes("take profit") &&
      (long ? o.triggerPx! > t.entryPrice : o.triggerPx! < t.entryPrice),
  );
  return { initialStop: stop?.triggerPx ?? null, initialTarget: target?.triggerPx ?? null };
}

/* ------------------------------- prices ------------------------------- */

/** Read `candleSnapshot`: `[{ t, T, s, i, o, c, h, l, v, n }]`, prices as strings. */
export function parseCandleSnapshot(json: unknown): Candle[] {
  if (!Array.isArray(json)) return [];
  const out: Candle[] = [];
  for (const k of json as Array<Record<string, unknown>>) {
    const t = num(k?.t);
    const o = num(k?.o);
    const h = num(k?.h);
    const l = num(k?.l);
    const c = num(k?.c);
    if (t == null || o == null || h == null || l == null || c == null) continue;
    out.push({ t, o, h, l, c });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Read `fundingHistory`: `[{ coin, fundingRate, premium, time }]`, hourly. */
export function parseFundingHistory(json: unknown): { time: number; rate: number }[] {
  if (!Array.isArray(json)) return [];
  const out: { time: number; rate: number }[] = [];
  for (const e of json as Array<Record<string, unknown>>) {
    const time = num(e?.time);
    const rate = num(e?.fundingRate);
    if (time == null || rate == null) continue;
    out.push({ time, rate });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Read `allMids`: `{ "BTC": "110000.5", … }` — the mid of every book, now. */
export function parseAllMids(json: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!json || typeof json !== "object" || Array.isArray(json)) return out;
  for (const [coin, v] of Object.entries(json as Record<string, unknown>)) {
    const p = num(v);
    if (p != null && p > 0) out[coin] = p;
  }
  return out;
}
