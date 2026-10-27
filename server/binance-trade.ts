/**
 * Placing and tending orders on Binance Futures — the half that talks to the
 * venue.
 *
 * What to send is decided in shared/terminal.ts; this file sends it, in the
 * order that keeps the account safe at every step. The stop goes on the book
 * BEFORE the entry, so there is no instant in which a position exists
 * without one. If the entry is then refused, the stop is taken back off. If a
 * target is refused after the entry stands, that is said — the position is
 * real and protected, and a missing target is a thing to fix, not to hide.
 *
 * Everything here runs against whichever host the account's key belongs to:
 * the live venue or its testnet, which are different machines with different
 * keys and, on the testnet, different money.
 */
import { BinanceError, futuresBase, signedCall, type BinanceEnv, type Creds } from "./binance-account";
import { parseUserTrades, type BinanceUserTrade } from "@shared/binance-account";
import { rulesFromExchangeInfo, type OrderParams, type SymbolRules } from "@shared/terminal";
import { fetch as undiciFetch } from "undici";
import { egressFor } from "./egress";

const RULES_TTL_MS = 60 * 60 * 1000;
const rulesCache = new Map<string, { at: number; rules: SymbolRules[] }>();

/** Each symbol's tick, step and minimums, from the host the key belongs to. */
export async function exchangeRules(env: BinanceEnv, force = false): Promise<SymbolRules[]> {
  const base = futuresBase(env);
  const hit = rulesCache.get(base);
  if (hit && !force && Date.now() - hit.at < RULES_TTL_MS) return hit.rules;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await undiciFetch(`${base}/fapi/v1/exchangeInfo`, {
      signal: ctl.signal,
      dispatcher: egressFor(base),
    } as any);
    if (!res.ok) throw new Error(`${new URL(base).hostname} → HTTP ${res.status} on /fapi/v1/exchangeInfo`);
    const rules = rulesFromExchangeInfo(await res.json());
    if (rules.length === 0) throw new Error(`${new URL(base).hostname} listed no tradable perpetuals`);
    rulesCache.set(base, { at: Date.now(), rules });
    return rules;
  } finally {
    clearTimeout(timer);
  }
}

export async function rulesFor(env: BinanceEnv, symbol: string): Promise<SymbolRules> {
  const all = await exchangeRules(env);
  const r = all.find((x) => x.symbol === symbol.toUpperCase());
  if (!r) throw new Error(`${symbol} is not a tradable perpetual on this host.`);
  return r;
}

/* ------------------------------ the account ------------------------------ */

export interface Venue {
  creds: Creds;
  env: BinanceEnv;
}

const call = (v: Venue, method: "GET" | "POST" | "PUT" | "DELETE", path: string, params: Record<string, string | number | undefined> = {}) =>
  signedCall(method, futuresBase(v.env), path, params, v.creds);

/** Hedge mode on, or not. The terminal sends every order with a position side, which one-way mode refuses. */
export async function hedgeMode(v: Venue): Promise<boolean> {
  const j: any = await call(v, "GET", "/fapi/v1/positionSide/dual");
  return j?.dualSidePosition === true || j?.dualSidePosition === "true";
}

/**
 * Switch the account to hedge mode. The venue refuses while any position or
 * open order exists, and its message says so; that is passed on as-is.
 */
export async function enableHedgeMode(v: Venue): Promise<void> {
  try {
    await call(v, "POST", "/fapi/v1/positionSide/dual", { dualSidePosition: "true" });
  } catch (err) {
    // -4059: "No need to change position side." — it was already on.
    if (err instanceof BinanceError && err.code === -4059) return;
    throw err;
  }
}

export async function setLeverage(v: Venue, symbol: string, leverage: number): Promise<number> {
  const j: any = await call(v, "POST", "/fapi/v1/leverage", { symbol, leverage });
  const got = Number(j?.leverage);
  return Number.isFinite(got) ? got : leverage;
}

export interface VenuePosition {
  symbol: string;
  positionSide: "LONG" | "SHORT" | "BOTH";
  /** Signed: negative for a short. */
  amt: number;
  entryPrice: number;
  markPrice: number;
  unrealized: number;
  leverage: number;
  liquidationPrice: number | null;
}

const n = (x: unknown): number | null => {
  const v = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
  return Number.isFinite(v) ? v : null;
};

/** Every non-flat position, one row per side. */
export async function positions(v: Venue): Promise<VenuePosition[]> {
  const j = await call(v, "GET", "/fapi/v2/positionRisk");
  if (!Array.isArray(j)) return [];
  const out: VenuePosition[] = [];
  for (const r of j as any[]) {
    const amt = n(r?.positionAmt) ?? 0;
    if (Math.abs(amt) < 1e-12) continue;
    const ps = r.positionSide === "LONG" || r.positionSide === "SHORT" ? r.positionSide : "BOTH";
    out.push({
      symbol: String(r.symbol ?? "").toUpperCase(),
      positionSide: ps,
      amt,
      entryPrice: n(r.entryPrice) ?? 0,
      markPrice: n(r.markPrice) ?? 0,
      unrealized: n(r.unRealizedProfit) ?? 0,
      leverage: n(r.leverage) ?? 0,
      liquidationPrice: (n(r.liquidationPrice) ?? 0) > 0 ? n(r.liquidationPrice) : null,
    });
  }
  return out;
}

export interface VenueOrder {
  symbol: string;
  /** The order id — or, for a conditional order, its algo id. */
  orderId: number;
  /** A conditional order that has fired spawns a plain order; this is its id. */
  triggeredOrderId?: number | null;
  /** The venue's record as sent, kept for the log when the shape is new to us. */
  raw?: unknown;
  clientOrderId: string;
  side: "BUY" | "SELL";
  positionSide: "LONG" | "SHORT" | "BOTH";
  type: string;
  status: string;
  price: number | null;
  stopPrice: number | null;
  origQty: number;
  executedQty: number;
  avgPrice: number;
  closePosition: boolean;
  reduceOnly: boolean;
  time: number;
  updateTime: number;
}

export function parseOrder(r: any): VenueOrder | null {
  const orderId = n(r?.orderId);
  if (orderId == null || typeof r?.symbol !== "string") return null;
  return {
    symbol: r.symbol.toUpperCase(),
    orderId,
    clientOrderId: String(r.clientOrderId ?? ""),
    side: r.side === "SELL" ? "SELL" : "BUY",
    positionSide: r.positionSide === "LONG" || r.positionSide === "SHORT" ? r.positionSide : "BOTH",
    type: String(r.type ?? "").toUpperCase(),
    status: String(r.status ?? "").toUpperCase(),
    price: (n(r.price) ?? 0) > 0 ? n(r.price) : null,
    stopPrice: (n(r.stopPrice) ?? 0) > 0 ? n(r.stopPrice) : null,
    origQty: n(r.origQty) ?? 0,
    executedQty: n(r.executedQty) ?? 0,
    avgPrice: n(r.avgPrice) ?? 0,
    closePosition: r.closePosition === true || r.closePosition === "true",
    reduceOnly: r.reduceOnly === true || r.reduceOnly === "true",
    time: n(r.time) ?? n(r.updateTime) ?? 0,
    updateTime: n(r.updateTime) ?? n(r.time) ?? 0,
  };
}

/*
 * Conditional orders — a stop, a take-profit — live on the venue's Algo
 * Order endpoints, not on /fapi/v1/order, which answers -4120 to them. They
 * carry an algoId rather than an orderId, trigger at `triggerPrice`, and once
 * fired place an ordinary order whose id is the one the fills then carry.
 * Everything below reads them back into the same shape as a plain order,
 * with the algo id in `orderId`, so the rest of the terminal need not care.
 */
const ALGO_TYPES = new Set(["STOP_MARKET", "TAKE_PROFIT_MARKET", "STOP", "TAKE_PROFIT", "TRAILING_STOP_MARKET"]);
export const isAlgoType = (type: string | undefined) => ALGO_TYPES.has(String(type ?? "").toUpperCase());

/** Tolerant on purpose: the field names are read from the venue's answer, with the plain-order names as fallbacks. */
export function parseAlgoOrder(r: any): VenueOrder | null {
  const algoId = n(r?.algoId) ?? n(r?.orderId);
  if (algoId == null || typeof r?.symbol !== "string") return null;
  const triggered = n(r.orderId);
  return {
    symbol: r.symbol.toUpperCase(),
    orderId: algoId,
    triggeredOrderId: triggered != null && triggered !== algoId ? triggered : null,
    clientOrderId: String(r.clientAlgoId ?? r.clientOrderId ?? ""),
    side: r.side === "SELL" ? "SELL" : "BUY",
    positionSide: r.positionSide === "LONG" || r.positionSide === "SHORT" ? r.positionSide : "BOTH",
    type: String(r.type ?? r.orderType ?? "").toUpperCase(),
    status: String(r.algoStatus ?? r.status ?? "").toUpperCase(),
    price: (n(r.price) ?? 0) > 0 ? n(r.price) : null,
    stopPrice: (n(r.triggerPrice) ?? n(r.stopPrice) ?? 0) > 0 ? (n(r.triggerPrice) ?? n(r.stopPrice)) : null,
    origQty: n(r.quantity) ?? n(r.origQty) ?? 0,
    executedQty: n(r.executedQty) ?? 0,
    avgPrice: n(r.avgPrice) ?? 0,
    closePosition: r.closePosition === true || r.closePosition === "true",
    reduceOnly: r.reduceOnly === true || r.reduceOnly === "true",
    time: n(r.bookTime) ?? n(r.time) ?? n(r.updateTime) ?? 0,
    updateTime: n(r.updateTime) ?? n(r.triggerTime) ?? n(r.bookTime) ?? 0,
    raw: r,
  };
}

/** Plain orders and resting conditional orders together, as one list. */
export async function openOrders(v: Venue, symbol?: string): Promise<VenueOrder[]> {
  const j = await call(v, "GET", "/fapi/v1/openOrders", symbol ? { symbol } : {});
  const plain = Array.isArray(j) ? (j.map(parseOrder).filter(Boolean) as VenueOrder[]) : [];
  let algo: VenueOrder[] = [];
  try {
    const a = await call(v, "GET", "/fapi/v1/openAlgoOrders", symbol ? { symbol } : {});
    const list = Array.isArray(a) ? a : Array.isArray((a as any)?.orders) ? (a as any).orders : [];
    algo = list.map(parseAlgoOrder).filter(Boolean) as VenueOrder[];
  } catch (err) {
    // A host without the algo endpoints answers 404; the plain list is still right.
    if (!(err instanceof BinanceError && err.status === 404)) throw err;
  }
  return [...plain, ...algo];
}

/** One conditional order by its algo id, or null once the venue has forgotten it. */
export async function algoOrderById(v: Venue, algoId: number): Promise<VenueOrder | null> {
  try {
    return parseAlgoOrder(await call(v, "GET", "/fapi/v1/algoOrder", { algoId }));
  } catch (err) {
    if (err instanceof BinanceError && (err.code === -2013 || err.status === 404 || err.status === 400)) return null;
    throw err;
  }
}

export async function orderById(v: Venue, symbol: string, orderId: number): Promise<VenueOrder | null> {
  try {
    return parseOrder(await call(v, "GET", "/fapi/v1/order", { symbol, orderId }));
  } catch (err) {
    // -2013: "Order does not exist." — gone from the venue's recent record.
    if (err instanceof BinanceError && err.code === -2013) return null;
    throw err;
  }
}

/**
 * The fills behind the trade's orders on one symbol, since it was sent.
 *
 * The venue refuses a window longer than seven days, so a trade held longer
 * is read over the last week: its entry fill is already on the record, and
 * the fills that matter now are the ones closing it.
 */
export async function fillsSince(v: Venue, symbol: string, sinceMs: number): Promise<BinanceUserTrade[]> {
  const floor = Date.now() - (7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000);
  const j = await call(v, "GET", "/fapi/v1/userTrades", { symbol, startTime: Math.max(sinceMs, floor), limit: 1000 });
  return parseUserTrades(j);
}

export async function usdBalance(v: Venue): Promise<{ asset: string; balance: number; available: number }[]> {
  const j = await call(v, "GET", "/fapi/v2/balance");
  if (!Array.isArray(j)) return [];
  return (j as any[])
    .map((r) => ({ asset: String(r.asset ?? ""), balance: n(r.balance) ?? 0, available: n(r.availableBalance) ?? 0 }))
    .filter((r) => r.balance !== 0 || r.available !== 0 || r.asset === "USDT");
}

/* ------------------------------ the orders ------------------------------ */

export async function placeOrder(v: Venue, o: OrderParams): Promise<VenueOrder> {
  if (isAlgoType(o.type)) {
    // The same order in the algo endpoint's words: triggerPrice, clientAlgoId.
    const { stopPrice, newClientOrderId, ...rest } = o;
    const params: OrderParams = { ...rest, ...(stopPrice ? { triggerPrice: stopPrice } : {}), ...(newClientOrderId ? { clientAlgoId: newClientOrderId } : {}) };
    const got = parseAlgoOrder(await call(v, "POST", "/fapi/v1/algoOrder", params));
    if (!got) throw new Error("The venue accepted the conditional order but sent back nothing readable.");
    return got;
  }
  const got = parseOrder(await call(v, "POST", "/fapi/v1/order", o));
  if (!got) throw new Error("The venue accepted the order but sent back nothing readable.");
  return got;
}

/**
 * Take a bracket off the book. It is an algo order on any current host; a
 * trade sent before the venue moved them may still hold a plain one, so a
 * refusal from the algo endpoint falls through to the plain cancel.
 */
export async function cancelBracket(v: Venue, symbol: string, id: number): Promise<void> {
  try {
    await call(v, "DELETE", "/fapi/v1/algoOrder", { algoId: id });
    return;
  } catch (err) {
    if (!(err instanceof BinanceError)) throw err;
  }
  await cancelOrder(v, symbol, id);
}

export async function cancelOrder(v: Venue, symbol: string, orderId: number): Promise<void> {
  try {
    await call(v, "DELETE", "/fapi/v1/order", { symbol, orderId });
  } catch (err) {
    // Already gone — filled, or cancelled from the venue's own screen. The
    // outcome asked for is the outcome there is.
    if (err instanceof BinanceError && (err.code === -2011 || err.code === -2013)) return;
    throw err;
  }
}

export interface Placed {
  stop: VenueOrder | null;
  entry: VenueOrder;
  targets: VenueOrder[];
  /** Brackets the venue refused, with its words. The entry stands regardless. */
  refused: { which: string; reason: string }[];
}

/**
 * A plan onto the book, safest thing first.
 *
 *   1. the stop — it can rest before there is a position to protect
 *   2. the entry — if this is refused, the stop comes back off and the
 *      refusal is thrown: nothing happened
 *   3. the targets — refused ones are reported, not thrown: the position is
 *      on and protected, and throwing would hide that from the caller
 */
export async function placePlan(
  v: Venue,
  orders: { stop: OrderParams; entry: OrderParams; targets: OrderParams[] },
): Promise<Placed> {
  const refused: Placed["refused"] = [];
  let stop: VenueOrder | null = null;
  try {
    stop = await placeOrder(v, orders.stop);
  } catch (err: any) {
    /*
     * Some hosts refuse a close-position stop with no position behind it
     * ("ReduceOnly Order is rejected", -2022). The entry still goes in and
     * the stop is placed right after it; the window is one round trip.
     */
    if (!(err instanceof BinanceError && err.code === -2022)) throw err;
  }
  let entry: VenueOrder;
  try {
    entry = await placeOrder(v, orders.entry);
  } catch (err) {
    if (stop) await cancelOrder(v, stop.symbol, stop.orderId).catch(() => {});
    throw err;
  }
  if (!stop) {
    try {
      stop = await placeOrder(v, orders.stop);
    } catch (err: any) {
      refused.push({ which: "stop", reason: String(err?.message ?? err) });
    }
  }
  const targets: VenueOrder[] = [];
  for (let i = 0; i < orders.targets.length; i++) {
    const t = orders.targets[i];
    try {
      targets.push(await placeOrder(v, t));
    } catch (err: any) {
      refused.push({ which: `target ${i + 1}`, reason: String(err?.message ?? err) });
    }
  }
  return { stop, entry, targets, refused };
}

/** Flatten one position side at market, by the quantity the venue holds. */
export async function closeAtMarket(v: Venue, symbol: string, positionSide: "LONG" | "SHORT", qty: string, tag: string): Promise<VenueOrder> {
  return placeOrder(v, {
    symbol,
    positionSide,
    side: positionSide === "LONG" ? "SELL" : "BUY",
    type: "MARKET",
    quantity: qty,
    newClientOrderId: tag,
  });
}
