/**
 * Reading a Binance Futures account — the pure half.
 *
 * Everything here turns the venue's JSON into the journal's terms and makes
 * the decisions that can be wrong; the signing and the fetching live next
 * door in server/binance-account.ts, where they cannot be unit-tested without
 * a venue. Three things are decided here:
 *
 *   WHETHER A KEY IS ALLOWED IN. The key gives this server the account's
 *   history, which is what the sync needs, and nothing else is needed. A key
 *   that can also withdraw, or trade, is a key whose theft costs money, and
 *   the journal refuses to be the place it is stolen from — it is turned
 *   away before it is stored, with the reason.
 *
 *   WHAT A FILL IS. userTrades rows carry the same facts as Hyperliquid's
 *   fills under other names, and are mapped onto the shared fill shape so the
 *   position reader exists once. One fact is missing: Binance does not say
 *   what the position was before each fill. It is reconstructed as a running
 *   sum, which is only right if the history begins from flat — so the sum is
 *   checked, at the end, against the position the venue says is open NOW.
 *   Where they disagree the symbol's fills are set aside unread. That is the
 *   same rule Hyperliquid's ledger enforces per fill, applied per symbol,
 *   and it is what stops a window that opens mid-trade from inventing an
 *   entry.
 *
 *   WHAT THE STOP WAS. Open conditional orders — STOP_MARKET, TAKE_PROFIT —
 *   on the same symbol, reduce-only or close-position, on the right side of
 *   the entry. Only the orders resting NOW are available without a key that
 *   can read order history per symbol, so a closed trade's levels are not
 *   recovered; an open one's are.
 */
import type { HlFill } from "./hyperliquid";

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/* ----------------------------- permissions ----------------------------- */

export interface KeyRestrictions {
  enableReading: boolean;
  enableFutures: boolean;
  enableWithdrawals: boolean;
  enableSpotAndMarginTrading: boolean;
  enableInternalTransfer: boolean;
  ipRestrict: boolean;
}

/** Read `/sapi/v1/account/apiRestrictions`. Anything missing reads as off. */
export function parseRestrictions(json: unknown): KeyRestrictions {
  const j = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const on = (k: string) => j[k] === true;
  return {
    enableReading: on("enableReading"),
    enableFutures: on("enableFutures"),
    enableWithdrawals: on("enableWithdrawals"),
    enableSpotAndMarginTrading: on("enableSpotAndMarginTrading"),
    enableInternalTransfer: on("enableInternalTransfer"),
    ipRestrict: on("ipRestrict"),
  };
}

/**
 * Why a key may not be kept, or null when it may.
 *
 * Withdrawals and transfers are refused outright — a stolen key must not be
 * able to move money. Spot trading is refused too: the sync has no use for
 * it and a key that can place orders is a key that can lose money. Futures
 * has to be ON, because the futures endpoints answer nothing without it, and
 * a key that cannot read futures would be stored only to fail.
 */
export function keyRefusal(r: KeyRestrictions): string | null {
  if (r.enableWithdrawals) return "This key can withdraw. Make a read-only key — the journal will not keep one that can move money.";
  if (r.enableInternalTransfer) return "This key can transfer between accounts. Make a read-only key.";
  if (r.enableSpotAndMarginTrading) return "This key can place spot orders. The sync only reads — make a key with trading off.";
  if (!r.enableFutures) return "This key cannot read Futures. Turn on Futures (reading) when you create it.";
  return null;
}

/* -------------------------------- fills -------------------------------- */

/** One row of `/fapi/v1/userTrades`, as far as the sync reads it. */
export interface BinanceUserTrade {
  symbol: string;
  id: number;
  orderId: number;
  side: "BUY" | "SELL";
  price: number;
  qty: number;
  realizedPnl: number;
  commission: number;
  time: number;
}

export function parseUserTrades(json: unknown): BinanceUserTrade[] {
  if (!Array.isArray(json)) return [];
  const out: BinanceUserTrade[] = [];
  for (const r of json as Array<Record<string, unknown>>) {
    const symbol = typeof r?.symbol === "string" ? r.symbol.trim().toUpperCase() : "";
    const id = num(r?.id);
    const price = num(r?.price);
    const qty = num(r?.qty);
    const time = num(r?.time);
    if (!symbol || id == null || price == null || qty == null || time == null) continue;
    if (r.side !== "BUY" && r.side !== "SELL") continue;
    out.push({
      symbol,
      id,
      orderId: num(r.orderId) ?? 0,
      side: r.side,
      price,
      qty,
      realizedPnl: num(r.realizedPnl) ?? 0,
      commission: num(r.commission) ?? 0,
      time,
    });
  }
  return out.sort((a, b) => a.time - b.time || a.id - b.id);
}

/** One row of `/fapi/v2/positionRisk`: the signed size open now, by symbol. */
export function parsePositions(json: unknown): Map<string, { amt: number; entryPrice: number }> {
  const out = new Map<string, { amt: number; entryPrice: number }>();
  if (!Array.isArray(json)) return out;
  for (const r of json as Array<Record<string, unknown>>) {
    const symbol = typeof r?.symbol === "string" ? r.symbol.trim().toUpperCase() : "";
    const amt = num(r?.positionAmt);
    if (!symbol || amt == null) continue;
    // Hedge mode reports LONG and SHORT rows separately; one-way reports BOTH.
    // Summed, so either mode gives the net the fills have to add up to.
    const prev = out.get(symbol);
    out.set(symbol, {
      amt: (prev?.amt ?? 0) + amt,
      entryPrice: num(r.entryPrice) ?? prev?.entryPrice ?? 0,
    });
  }
  return out;
}

/** `/fapi/v1/income?incomeType=REALIZED_PNL`: which symbols closed something in the window. */
export function symbolsFromIncome(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  const seen = new Set<string>();
  for (const r of json as Array<Record<string, unknown>>) {
    const symbol = typeof r?.symbol === "string" ? r.symbol.trim().toUpperCase() : "";
    if (symbol) seen.add(symbol);
  }
  return Array.from(seen);
}

export interface FillsFromTrades {
  fills: HlFill[];
  /**
   * Symbols whose fills do not add up to what the venue says is open now,
   * so the window must have opened with a position already on. Nothing
   * honest can be written for them from this record.
   */
  unreconstructable: { symbol: string; fills: number }[];
}

const ZERO = 1e-9;

/**
 * userTrades rows into fills, with the position before each one worked out.
 *
 * Per symbol, in time order, the running sum starts from zero — which is a
 * claim about the window, not a fact from the venue. The claim is checked:
 * when the last fill has been applied the sum must equal the position the
 * venue reports open now, within a hair. If it does not, every fill of that
 * symbol is set aside, because somewhere in them is a position whose entry
 * this window never saw, and the reader downstream would write that entry
 * as whichever fill it met first.
 */
export function fillsFromUserTrades(
  rows: BinanceUserTrade[],
  openNow: Map<string, { amt: number; entryPrice: number }>,
): FillsFromTrades {
  const bySymbol = new Map<string, BinanceUserTrade[]>();
  for (const r of rows) {
    const list = bySymbol.get(r.symbol) ?? [];
    list.push(r);
    bySymbol.set(r.symbol, list);
  }
  const fills: HlFill[] = [];
  const unreconstructable: { symbol: string; fills: number }[] = [];

  for (const [symbol, list] of Array.from(bySymbol.entries())) {
    list.sort((a, b) => a.time - b.time || a.id - b.id);
    let pos = 0;
    const mine: HlFill[] = [];
    for (const r of list) {
      mine.push({
        coin: symbol,
        px: r.price,
        sz: r.qty,
        side: r.side === "BUY" ? "B" : "A",
        time: r.time,
        startPosition: pos,
        dir: "",
        closedPnl: r.realizedPnl,
        fee: r.commission,
        tid: r.id,
        oid: r.orderId,
      });
      pos += r.side === "BUY" ? r.qty : -r.qty;
    }
    const venueSays = openNow.get(symbol)?.amt ?? 0;
    if (Math.abs(pos - venueSays) > ZERO) {
      unreconstructable.push({ symbol, fills: mine.length });
      continue;
    }
    fills.push(...mine);
  }
  return { fills: fills.sort((a, b) => a.time - b.time || a.tid - b.tid), unreconstructable };
}

/* -------------------------------- orders -------------------------------- */

/** One row of `/fapi/v1/openOrders`, as far as levels are read from it. */
export interface BinanceOpenOrder {
  symbol: string;
  orderId: number;
  side: "BUY" | "SELL";
  type: string;
  stopPrice: number | null;
  reduceOnly: boolean;
  closePosition: boolean;
  time: number;
}

export function parseOpenOrders(json: unknown): BinanceOpenOrder[] {
  if (!Array.isArray(json)) return [];
  const out: BinanceOpenOrder[] = [];
  for (const r of json as Array<Record<string, unknown>>) {
    const symbol = typeof r?.symbol === "string" ? r.symbol.trim().toUpperCase() : "";
    const orderId = num(r?.orderId);
    const time = num(r?.time) ?? num(r?.updateTime);
    if (!symbol || orderId == null || time == null) continue;
    if (r.side !== "BUY" && r.side !== "SELL") continue;
    out.push({
      symbol,
      orderId,
      side: r.side,
      type: typeof r.type === "string" ? r.type.toUpperCase() : "",
      stopPrice: num(r.stopPrice),
      reduceOnly: r.reduceOnly === true,
      closePosition: r.closePosition === true,
      time,
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

/**
 * The stop and target resting on an open position.
 *
 * A reduce-only or close-position conditional order on the same symbol, on
 * the side that would flatten the trade, with a trigger on the adverse side
 * of the entry is the stop; on the favourable side, the target. The earliest
 * of each is the plan. A stop at or past the entry — a trade already moved
 * to breakeven — is still the current stop, but it is not the ORIGINAL one,
 * and initialStop is the R denominator: it is taken only when it still sits
 * on the losing side of the entry, and otherwise left blank for the person
 * to fill in from memory, which is honest and the alternative is not.
 */
export function levelsFromOpenOrders(
  t: { coin: string; direction: "long" | "short"; entryPrice: number },
  orders: BinanceOpenOrder[],
): { initialStop: number | null; initialTarget: number | null } {
  const long = t.direction === "long";
  const closes = long ? "SELL" : "BUY";
  const mine = orders.filter(
    (o) =>
      o.symbol === t.coin &&
      o.stopPrice != null &&
      o.stopPrice > 0 &&
      o.side === closes &&
      (o.reduceOnly || o.closePosition),
  );
  const stop = mine.find(
    (o) => o.type.includes("STOP") && (long ? o.stopPrice! < t.entryPrice : o.stopPrice! > t.entryPrice),
  );
  const target = mine.find(
    (o) =>
      o.type.includes("TAKE_PROFIT") &&
      (long ? o.stopPrice! > t.entryPrice : o.stopPrice! < t.entryPrice),
  );
  return { initialStop: stop?.stopPrice ?? null, initialTarget: target?.stopPrice ?? null };
}

/* ------------------------------- symbols ------------------------------- */

const QUOTES = ["USDT", "USDC", "FDUSD", "BUSD", "BTC", "ETH", "BNB"];

/**
 * The journal's name for a Binance market: the base asset.
 *
 * The catalogue knows it exactly when it has the pair; failing that the quote
 * is stripped off the end, longest first so "BTCUSDT" does not lose only its
 * "BTC". Leveraged-token style prefixes ("1000PEPE") are left as the venue
 * writes them — they are a different contract from PEPE, a thousand times
 * the size, and renaming it would make a chart of the wrong price.
 */
export function baseAssetOf(symbol: string, catalogue: { symbol: string; baseAsset: string }[] = []): string {
  const s = symbol.trim().toUpperCase();
  const hit = catalogue.find((c) => c.symbol === s);
  if (hit) return hit.baseAsset.toUpperCase();
  for (const q of [...QUOTES].sort((a, b) => b.length - a.length)) {
    // Two characters of base at least. "WBTC" ends in BTC and is not a
    // BTC-quoted pair of the token W — and W is a real token, so the claim
    // would merge wrapped bitcoin onto Wormhole given the hour and the side.
    if (s.length >= q.length + 2 && s.endsWith(q)) return s.slice(0, -q.length);
  }
  return s;
}

/* ------------------------------- signing ------------------------------- */

/**
 * The query string a signed request carries, in a fixed order.
 *
 * Binance signs the exact bytes of the query, so the string that is signed
 * must be the string that is sent; building it once here and handing the
 * same value to both the signer and the URL is what guarantees that.
 */
export function signedQuery(params: Record<string, string | number | undefined>, timestamp: number, recvWindow = 10_000): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  parts.push(`recvWindow=${recvWindow}`, `timestamp=${timestamp}`);
  return parts.join("&");
}
