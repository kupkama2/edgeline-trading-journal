/**
 * The terminal, the half that can be wrong without a venue.
 *
 * Sending a drawn plan to Binance is three or four orders with rules attached:
 * the size must land on the symbol's step, the prices on its tick, the stop
 * on the losing side of the entry and the targets on the winning side, and
 * every bracket must be told which position it belongs to, because the
 * account runs in hedge mode and a close-position order without a side
 * closes nothing or the wrong thing. All of that is arithmetic on numbers
 * the venue publishes, so it lives here, where a test can hand it a plan and
 * read back exactly what would be sent.
 *
 * The other direction is here too: what the venue says about the orders it
 * was sent, turned into what the journal should now say about the trade.
 */
import type { KeyRestrictions } from "./binance-account";

/* ------------------------------ the rules ------------------------------ */

/** What one symbol will accept, read off /fapi/v1/exchangeInfo. */
export interface SymbolRules {
  symbol: string;
  baseAsset: string;
  tickSize: number;
  stepSize: number;
  minQty: number;
  /** Smallest notional (price × qty) an order may carry. */
  minNotional: number;
  pricePrecision: number;
  quantityPrecision: number;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function rulesFromExchangeInfo(json: unknown): SymbolRules[] {
  const list = (json as any)?.symbols;
  if (!Array.isArray(list)) return [];
  const out: SymbolRules[] = [];
  for (const s of list) {
    if (s?.status !== "TRADING" || s?.contractType !== "PERPETUAL") continue;
    const symbol = typeof s.symbol === "string" ? s.symbol : "";
    if (!symbol) continue;
    const filters: any[] = Array.isArray(s.filters) ? s.filters : [];
    const f = (type: string) => filters.find((x) => x?.filterType === type) ?? {};
    const tickSize = num(f("PRICE_FILTER").tickSize) ?? 0;
    const lot = f("LOT_SIZE");
    const stepSize = num(lot.stepSize) ?? 0;
    if (tickSize <= 0 || stepSize <= 0) continue;
    out.push({
      symbol,
      baseAsset: typeof s.baseAsset === "string" ? s.baseAsset : symbol.replace(/USDT$|USDC$/, ""),
      tickSize,
      stepSize,
      minQty: num(lot.minQty) ?? stepSize,
      minNotional: num(f("MIN_NOTIONAL").notional) ?? 0,
      pricePrecision: num(s.pricePrecision) ?? decimalsOf(tickSize),
      quantityPrecision: num(s.quantityPrecision) ?? decimalsOf(stepSize),
    });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** How many decimals a step like 0.001 carries. */
export function decimalsOf(step: number): number {
  if (step >= 1) return 0;
  const s = step.toExponential();
  const m = s.match(/e-(\d+)$/);
  const mantissaDigits = (s.split("e")[0].split(".")[1] ?? "").length;
  return (m ? Number(m[1]) : 0) + mantissaDigits;
}

/** A price snapped to the tick, written the way the venue wants it. */
export function fmtPrice(price: number, r: SymbolRules): string {
  const ticks = Math.round(price / r.tickSize);
  return (ticks * r.tickSize).toFixed(decimalsOf(r.tickSize));
}

/** A quantity rounded DOWN to the step: never a bigger position than asked for. */
export function fmtQty(qty: number, r: SymbolRules): string {
  const steps = Math.floor(qty / r.stepSize + 1e-9);
  return (steps * r.stepSize).toFixed(decimalsOf(r.stepSize));
}

/* ------------------------------ the plan ------------------------------ */

export interface TerminalPlan {
  symbol: string;
  side: "long" | "short";
  entryType: "market" | "limit";
  /** Required for a limit; for a market entry, the price the size was worked out at. */
  entryPrice: number;
  stop: number;
  /** In the order they should fill. Empty is allowed: a trade with a stop and no target. */
  targets: number[];
  /** One of the two decides the size. */
  riskDollars?: number | null;
  qty?: number | null;
  leverage: number;
}

export const MAX_TARGETS = 3;

/** What is wrong with a plan, in words, before any of it is sent. */
export function planProblems(p: TerminalPlan): string[] {
  const out: string[] = [];
  const long = p.side === "long";
  if (!(p.entryPrice > 0)) out.push("An entry price is needed, even for a market order — the size is worked out from it.");
  if (!(p.stop > 0)) out.push("A stop is needed. The terminal does not send a position without one.");
  if (p.entryPrice > 0 && p.stop > 0) {
    if (long && p.stop >= p.entryPrice) out.push("A long's stop has to be below the entry.");
    if (!long && p.stop <= p.entryPrice) out.push("A short's stop has to be above the entry.");
  }
  if (p.targets.length > MAX_TARGETS) out.push(`At most ${MAX_TARGETS} targets.`);
  for (const t of p.targets) {
    if (!(t > 0)) out.push("A target has to be a price.");
    else if (long && t <= p.entryPrice) out.push("A long's targets have to be above the entry.");
    else if (!long && t >= p.entryPrice) out.push("A short's targets have to be below the entry.");
  }
  if (!Number.isInteger(p.leverage) || p.leverage < 1 || p.leverage > 125) out.push("Leverage is a whole number from 1 to 125.");
  const byRisk = p.riskDollars != null && p.riskDollars > 0;
  const byQty = p.qty != null && p.qty > 0;
  if (!byRisk && !byQty) out.push("Say how big: dollars at risk, or a quantity.");
  return out;
}

export interface SizedPlan {
  qty: string;
  qtyNumber: number;
  notional: number;
  riskDollars: number;
  /** Initial margin at the plan's leverage. */
  margin: number;
  problems: string[];
}

/** The size, from the risk or the quantity, on the symbol's step. */
export function sizePlan(p: TerminalPlan, r: SymbolRules): SizedPlan {
  const problems = planProblems(p);
  const dist = Math.abs(p.entryPrice - p.stop);
  let raw = p.qty != null && p.qty > 0 ? p.qty : dist > 0 && p.riskDollars ? p.riskDollars / dist : 0;
  const qty = fmtQty(raw, r);
  const qtyNumber = Number(qty);
  const notional = qtyNumber * p.entryPrice;
  if (problems.length === 0) {
    if (qtyNumber < r.minQty || qtyNumber <= 0)
      problems.push(`That is below ${r.symbol}'s smallest size (${r.minQty}). Risk more, or move the stop closer.`);
    else if (r.minNotional > 0 && notional < r.minNotional)
      problems.push(`${r.symbol} needs at least ${r.minNotional} USDT of notional; this is ${notional.toFixed(2)}.`);
  }
  return {
    qty,
    qtyNumber,
    notional,
    riskDollars: qtyNumber * dist,
    margin: p.leverage > 0 ? notional / p.leverage : notional,
    problems,
  };
}

/* ------------------------------ the orders ------------------------------ */

/** One order as POST /fapi/v1/order takes it. Strings, because the venue signs strings. */
export type OrderParams = Record<string, string>;

export interface PlannedOrders {
  stop: OrderParams;
  entry: OrderParams;
  targets: OrderParams[];
  positionSide: "LONG" | "SHORT";
  qty: string;
}

/**
 * The orders a plan becomes, in the order they are sent: the stop FIRST, so
 * the position is never on the book without one; then the entry; then the
 * targets. Every bracket closes the whole position side (closePosition) —
 * a stop that reduces by a quantity is wrong the moment the size changes.
 * With several targets, the earlier ones take their share by quantity and
 * the last one closes whatever is left.
 *
 * `tag` prefixes every client order id, so the journal can tell its own
 * orders from ones placed elsewhere and tie fills back to the trade.
 */
export function ordersForPlan(p: TerminalPlan, r: SymbolRules, qty: string, tag: string): PlannedOrders {
  const long = p.side === "long";
  const positionSide = long ? "LONG" : "SHORT";
  const open = long ? "BUY" : "SELL";
  const close = long ? "SELL" : "BUY";
  const base = { symbol: r.symbol, positionSide };

  const entry: OrderParams =
    p.entryType === "market"
      ? { ...base, side: open, type: "MARKET", quantity: qty, newClientOrderId: `${tag}-e` }
      : {
          ...base,
          side: open,
          type: "LIMIT",
          timeInForce: "GTC",
          quantity: qty,
          price: fmtPrice(p.entryPrice, r),
          newClientOrderId: `${tag}-e`,
        };

  const stop: OrderParams = {
    ...base,
    side: close,
    type: "STOP_MARKET",
    stopPrice: fmtPrice(p.stop, r),
    closePosition: "true",
    workingType: "MARK_PRICE",
    priceProtect: "TRUE",
    newClientOrderId: `${tag}-s`,
  };

  const n = p.targets.length;
  const each = n > 1 ? fmtQty(Number(qty) / n, r) : qty;
  const targets: OrderParams[] = p.targets.map((price, i) => {
    const last = i === n - 1;
    return {
      ...base,
      side: close,
      type: "TAKE_PROFIT_MARKET",
      stopPrice: fmtPrice(price, r),
      workingType: "MARK_PRICE",
      priceProtect: "TRUE",
      newClientOrderId: `${tag}-t${i + 1}`,
      // No reduceOnly: hedge mode refuses it, and a SELL on the LONG side
      // can only reduce anyway.
      ...(last ? { closePosition: "true" } : { quantity: each }),
    };
  });

  return { stop, entry, targets, positionSide, qty };
}

/** A replacement bracket at a new price, same shape as the one it replaces. */
export function bracketAt(kind: "stop" | "target", price: number, r: SymbolRules, side: "long" | "short", tag: string): OrderParams {
  const long = side === "long";
  return {
    symbol: r.symbol,
    positionSide: long ? "LONG" : "SHORT",
    side: long ? "SELL" : "BUY",
    type: kind === "stop" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET",
    stopPrice: fmtPrice(price, r),
    closePosition: "true",
    workingType: "MARK_PRICE",
    priceProtect: "TRUE",
    newClientOrderId: tag,
  };
}

/* ------------------------------ the key ------------------------------ */

/**
 * What a key that TRADES must and must not be able to do, on the live venue.
 *
 * It needs futures trading, obviously. It must not withdraw or transfer:
 * nothing this journal does moves money off the account, so a key that can
 * is a liability with no upside. And it must be locked to the server's IP,
 * because a trading key that works from anywhere is one database read away
 * from being somebody else's trading key. The testnet has no money and no
 * permissions endpoint, so it is not asked.
 */
export function tradingKeyRefusal(r: KeyRestrictions, allowUnlocked = false): string | null {
  if (r.enableWithdrawals) return "This key can withdraw. A trading key must not — turn Enable Withdrawals off.";
  if (r.enableInternalTransfer || r.permitsUniversalTransfer) return "This key can transfer between accounts. Turn that off on a trading key.";
  if (!r.enableFutures) return "This key cannot trade futures. Turn Enable Futures on, or save it as a read-only key.";
  if (!r.ipRestrict && !allowUnlocked)
    return "This key works from any IP. A trading key must be restricted to trusted IPs — add the server's outbound IP on Binance and try again. (A host with no fixed IP can set TERMINAL_ALLOW_UNLOCKED_KEY=1 to accept this, and the terminal will say so in red.)";
  return null;
}

/* ------------------------------ the record ------------------------------ */

/** What the journal remembers about the orders behind a terminal trade. */
export interface TerminalRef {
  venue: "binance" | "hyperliquid";
  env: "live" | "testnet";
  account: string;
  symbol: string;
  positionSide: "LONG" | "SHORT";
  tag: string;
  leverage: number;
  qty: number;
  entryOrderId: number | null;
  stopOrderId: number | null;
  targetOrderIds: number[];
  /** Market closes and partial takes sent from the terminal, so their fills count as this trade's. */
  closeOrderIds?: number[];
  /** Adds sent from the terminal: fills on these grow the position and go to the ledger as adds. */
  addOrderIds?: number[];
  /** Every level moved from the terminal: what it was, what it became, when. */
  moves?: { at: string; kind: "stop" | "target" | "entry"; from: number | null; to: number }[];
  /**
   * Brackets waiting for a resting entry to fill. The venue will not hold a
   * close-position order for a position that does not exist, so the stop
   * and targets of a limit plan are kept here and placed by the read-back
   * the moment the fill is seen.
   */
  armOnFill?: { stop: OrderParams; targets: OrderParams[] };
  /** Brackets that were asked for and refused — the trade is on the book without them. */
  unprotected?: boolean;
  /** When the terminal last read this trade back from the venue. */
  checkedAt?: string;
}

export function parseTerminalRef(raw: string | null | undefined): TerminalRef | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    return j && (j.venue === "binance" || j.venue === "hyperliquid") && typeof j.symbol === "string" ? (j as TerminalRef) : null;
  } catch {
    return null;
  }
}

export const formatTerminalRef = (ref: TerminalRef): string => JSON.stringify(ref);

/** What the venue says now, in the terms the reconcile reads. */
export interface VenueSnapshot {
  entry: { status: string; avgPrice: number; executedQty: number; updateTime: number } | null;
  /**
   * This position side's fills on the symbol since the trade was sent. Fills
   * from orders this terminal did not place — a close from the venue's own
   * app — are marked `foreign`: they count only when they are the only
   * explanation for a position that has gone flat.
   */
  fills: { tid: number; orderId: number; price: number; qty: number; time: number; commission: number; commissionUsd: boolean; realizedPnl: number; side?: "BUY" | "SELL"; foreign?: boolean }[];
  /** The quantity the venue holds on this position side now. */
  positionAmt: number;
  openOrderIds: number[];
}

export interface ReconcilePatch {
  status?: "pending" | "open" | "closed" | "cancelled";
  entryPrice?: number;
  size?: number;
  entryTime?: string;
  exitPrice?: number | null;
  exitTime?: string | null;
  exitReason?: string;
  fees?: number | null;
  cancelReason?: string;
}

/** A closing fill that took some of the position off before the rest went: a partial, for the ledger. */
export interface Partial {
  tid: number;
  orderId: number;
  price: number;
  qty: number;
  time: number;
}

/** Fills logged as partials carry the venue's fill id in the note, so a re-read never logs one twice. */
export const partialNote = (tid: number) => `terminal · fill ${tid}`;

/**
 * How the trade ended, read off which order's fills closed it.
 *
 *   the stop            "stop" — unless it had been moved: to the entry is
 *                       "breakeven", past it on the winning side "trailed"
 *   a target            "target"
 *   a close from here   "discretion"
 */
export function exitReasonFor(
  ref: TerminalRef,
  trade: { direction: string; entryPrice: number; stopMoves?: string | null },
  exitFills: { orderId: number; price: number }[],
): string | null {
  if (exitFills.length === 0) return null;
  const last = exitFills[exitFills.length - 1];
  if ((ref.closeOrderIds ?? []).includes(last.orderId)) return "discretion";
  if (ref.targetOrderIds.includes(last.orderId)) return "target";
  if (last.orderId !== ref.stopOrderId && !(ref.moves ?? []).some((m) => m.kind === "stop")) return null;
  const moved = !!trade.stopMoves && trade.stopMoves !== "[]" && trade.stopMoves !== "null";
  if (!moved) return "stop";
  const sign = trade.direction === "short" ? -1 : 1;
  const edge = (sign * (last.price - trade.entryPrice)) / trade.entryPrice;
  if (Math.abs(edge) <= 0.0005) return "breakeven";
  return edge > 0 ? "trailed" : "stop";
}

const wavg = (xs: { price: number; qty: number }[]) => {
  const q = xs.reduce((s, x) => s + x.qty, 0);
  return q > 0 ? xs.reduce((s, x) => s + x.price * x.qty, 0) / q : 0;
};

/**
 * What the trade should say, given what the venue says.
 *
 * A pending limit whose entry filled is open, at the fill's average. An
 * open trade whose position side is flat again is closed, at the average of
 * the fills that closed it. A pending limit cancelled on the venue is
 * cancelled here. Nothing else is touched: the stop and target the person
 * drew are the plan, whatever the brackets did since.
 */
export function reconcilePatch(
  trade: { status: string; entryPrice: number; size: number; fees: number | null; direction?: string; stopMoves?: string | null; exitReason?: string | null },
  ref: TerminalRef,
  snap: VenueSnapshot,
): { patch: ReconcilePatch | null; partials: Partial[]; adds: Partial[] } {
  const partials: Partial[] = [];
  const patch: ReconcilePatch = {};
  const own = snap.fills.filter((f) => !f.foreign);
  const addIds = new Set(ref.addOrderIds ?? []);
  const entryFills = own.filter((f) => f.orderId === ref.entryOrderId);
  // Adds grow the position: the ledger takes them, the walk below counts them as held.
  const adds: Partial[] = own
    .filter((f) => addIds.has(f.orderId))
    .map((f) => ({ tid: f.tid, orderId: f.orderId, price: f.price, qty: f.qty, time: f.time }));
  const byTime = (a: { time: number; tid: number }, b: { time: number; tid: number }) => a.time - b.time || a.tid - b.tid;
  const closing = own.filter((f) => f.orderId !== ref.entryOrderId && !addIds.has(f.orderId)).sort(byTime);
  const foreignClosing = snap.fills.filter((f) => f.foreign).sort(byTime);
  const feesKnown = own.every((f) => f.commissionUsd);
  const fees = feesKnown ? own.reduce((s, f) => s + f.commission, 0) : null;

  const filledQty = entryFills.reduce((s, f) => s + f.qty, 0);
  const entryDone = snap.entry?.status === "FILLED" || (snap.entry?.status === "PARTIALLY_FILLED" && filledQty > 0);

  if (trade.status === "pending") {
    if (snap.entry && (snap.entry.status === "CANCELED" || snap.entry.status === "EXPIRED" || snap.entry.status === "REJECTED") && filledQty === 0) {
      return { patch: { status: "cancelled", cancelReason: "not_filled" }, partials, adds };
    }
    if (!entryDone) return { patch: null, partials, adds };
    patch.status = "open";
    patch.entryPrice = entryFills.length ? wavg(entryFills) : snap.entry!.avgPrice;
    patch.size = filledQty || snap.entry!.executedQty;
    patch.entryTime = new Date(entryFills[0]?.time ?? snap.entry!.updateTime).toISOString();
  } else if (trade.status === "open") {
    // The average entry follows the fills, as a sync-written trade's does.
    if (entryFills.length && Math.abs(wavg(entryFills) - trade.entryPrice) > 1e-9) patch.entryPrice = wavg(entryFills);
    if (filledQty > 0 && Math.abs(filledQty - trade.size) > 1e-9) patch.size = filledQty;
  } else {
    return { patch: null, partials, adds };
  }

  /*
   * Which closing fills were partials and which were the exit. Walking the
   * fills in time order against the size that went on — the entry plus any
   * adds: everything that still left some position standing is a partial (a
   * target taking its share, a take from the terminal) and the fills that
   * brought it to flat are the exit. The ledger takes the partials; the exit
   * price is the average of the rest.
   *
   * A position that is flat without this terminal's fills explaining it was
   * closed somewhere else — the venue's own app. Then, and only then, the
   * fills from orders this terminal never placed are taken as the rest of
   * the story, and the trade closes "by hand".
   */
  const flat = Math.abs(snap.positionAmt) < 1e-9;
  const held = (filledQty || patch.size || trade.size) + adds.reduce((s, a) => s + a.qty, 0);
  let gone = 0;
  const exitFills: typeof closing = [];
  let closedElsewhere = false;
  const walk = (list: typeof closing, untilCovered = false) => {
    for (const f of list) {
      if (untilCovered && gone >= held - 1e-9) break;
      const after = gone + f.qty;
      if (after < held - 1e-9) partials.push({ tid: f.tid, orderId: f.orderId, price: f.price, qty: f.qty, time: f.time });
      else exitFills.push(f);
      gone = after;
    }
  };
  walk(closing);
  if (flat && gone < held - 1e-9 && foreignClosing.length > 0) {
    closedElsewhere = true;
    walk(foreignClosing, true);
  }

  if ((trade.status === "open" || patch.status === "open") && flat && exitFills.length > 0) {
    patch.status = "closed";
    patch.exitPrice = wavg(exitFills);
    patch.exitTime = new Date(Math.max(...exitFills.map((f) => f.time))).toISOString();
    if (!trade.exitReason || trade.exitReason === "other") {
      const why = closedElsewhere
        ? "discretion"
        : exitReasonFor(ref, { direction: trade.direction ?? (ref.positionSide === "SHORT" ? "short" : "long"), entryPrice: patch.entryPrice ?? trade.entryPrice, stopMoves: trade.stopMoves }, exitFills);
      if (why) patch.exitReason = why;
    }
  }
  if (fees != null && Math.abs(fees - (trade.fees ?? 0)) > 1e-9) patch.fees = fees;
  return { patch: Object.keys(patch).length ? patch : null, partials, adds };
}

/** An add logged from the terminal carries the venue's fill id, as a partial does. */
export const addNote = (tid: number) => `terminal · add ${tid}`;
