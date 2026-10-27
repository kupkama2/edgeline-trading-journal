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
  /**
   * The idea, pinned the moment it was sent and never edited: the entry,
   * stop and targets as drawn, the size, the dollars at risk. Everything
   * that happens afterwards is measured against this.
   */
  idea?: TerminalIdea;
  /**
   * Everything done to the trade while it was on, in order: a level moved, a
   * take, an add, a close — each with the mark and the open R at that
   * moment, so "moved the stop to breakeven at +1.4R" is on the record, not
   * reconstructed.
   */
  moves?: TerminalMove[];
  /** The original stop and target, watched on the tape: which was touched first, and when. */
  planWatch?: PlanWatch;
  /** The read on the management, once the trade is over and the plan's answer is in. */
  review?: ManagementReview;
  /** When a review was last attempted and failed, so it is retried on a clock rather than every pass. */
  reviewTriedAt?: string;
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

export interface TerminalIdea {
  entry: number;
  stop: number | null;
  targets: number[];
  qty: number;
  riskDollars: number | null;
  at: string;
}

export type MoveKind = "stop" | "target" | "entry" | "reduce" | "add" | "close";

export interface TerminalMove {
  at: string;
  kind: MoveKind;
  /** For a level: what it was and what it became. */
  from?: number | null;
  to?: number | null;
  /** For a take, an add or a close: how much, at what (null = at market). */
  qty?: number;
  price?: number | null;
  /** The mark when it was done, and the trade's open R at that mark against the original risk. */
  mark?: number | null;
  r?: number | null;
}

export interface PlanWatch {
  /** The tape has been read up to here (ms). The next read starts here. */
  coveredTo: number;
  checkedAt: string;
  stopHitAt?: string;
  stopHitPrice?: number;
  targetHitAt?: string;
  targetHitPrice?: number;
  /** Which original level the tape reached first. "ambiguous": both inside one minute. */
  first?: "stop" | "target" | "ambiguous";
  firstAt?: string;
}

export interface ManagementReview {
  at: string;
  verdict: "helped" | "hurt" | "neutral" | "unknown";
  summary: string;
  lesson?: string | null;
  /** The numbers the read was given, so it can be judged later. */
  basis: { actualR: number | null; planR: number | null; planVerdict: string | null };
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

/* ------------------------------ the idea, watched ------------------------------ */

/** The original levels, from the pin when there is one, from the trade's own fields when not. */
export function ideaOf(
  t: { entryPrice: number; initialStop?: number | null; initialTarget?: number | null; size: number; riskAmount?: number | null; entryTime: string },
  ref: TerminalRef,
): TerminalIdea {
  return (
    ref.idea ?? {
      entry: t.entryPrice,
      stop: t.initialStop ?? null,
      targets: t.initialTarget != null ? [t.initialTarget] : [],
      qty: t.size,
      riskDollars: t.riskAmount ?? null,
      at: t.entryTime,
    }
  );
}

/** The open R at a mark: distance from the entry over the original risk, signed by the side. */
export function rAt(mark: number | null | undefined, entry: number, stop: number | null | undefined, direction: string): number | null {
  if (mark == null || stop == null) return null;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  const sign = direction === "short" ? -1 : 1;
  return (sign * (mark - entry)) / risk;
}

export interface Touches {
  stop?: { at: number; price: number };
  target?: { at: number; price: number };
  /** Both levels inside one bar, with no earlier touch of either: the order is not knowable at this width. */
  sameBar?: boolean;
}

/**
 * The first bar to reach the original stop and the first to reach the
 * original target, over the bars given. Touch means the wick: a stop is
 * taken by the low, a target by the high (reversed for a short). The bars
 * are the tape after the entry; what came before is the caller's to cut.
 */
export function planTouches(
  bars: { t: number; h: number; l: number }[],
  plan: { direction: string; stop: number | null; target: number | null },
): Touches {
  const long = plan.direction !== "short";
  const out: Touches = {};
  for (const c of bars) {
    const hitStop = plan.stop != null && (long ? c.l <= plan.stop : c.h >= plan.stop);
    const hitTarget = plan.target != null && (long ? c.h >= plan.target : c.l <= plan.target);
    if (hitStop && !out.stop) out.stop = { at: c.t, price: plan.stop! };
    if (hitTarget && !out.target) out.target = { at: c.t, price: plan.target! };
    if (hitStop && hitTarget && out.stop!.at === c.t && out.target!.at === c.t) out.sameBar = true;
    if (out.stop && out.target) break;
  }
  return out;
}

/**
 * The watch, advanced by one read of the tape. Earlier touches are kept —
 * bars only go forward — and the first level reached is settled the moment
 * one is known without the other, or both are known.
 */
export function advancePlanWatch(
  prev: PlanWatch | undefined,
  touches: Touches,
  coveredTo: number,
  now: string,
): { next: PlanWatch; news: ("stop" | "target")[] } {
  const next: PlanWatch = { ...(prev ?? { coveredTo }), coveredTo: Math.max(prev?.coveredTo ?? 0, coveredTo), checkedAt: now };
  const news: ("stop" | "target")[] = [];
  if (touches.stop && !next.stopHitAt) {
    next.stopHitAt = new Date(touches.stop.at).toISOString();
    next.stopHitPrice = touches.stop.price;
    news.push("stop");
  }
  if (touches.target && !next.targetHitAt) {
    next.targetHitAt = new Date(touches.target.at).toISOString();
    next.targetHitPrice = touches.target.price;
    news.push("target");
  }
  if (!next.first) {
    const s = next.stopHitAt ? new Date(next.stopHitAt).getTime() : null;
    const g = next.targetHitAt ? new Date(next.targetHitAt).getTime() : null;
    if (s != null && g != null) {
      if (s === g) next.first = "ambiguous";
      else next.first = s < g ? "stop" : "target";
      next.firstAt = new Date(Math.min(s, g)).toISOString();
    } else if (s != null || g != null) {
      // One reached, the other not yet: the one reached came first.
      next.first = s != null ? "stop" : "target";
      next.firstAt = new Date((s ?? g)!).toISOString();
    }
  }
  return { next, news };
}

/* ------------------------------ idea against management ------------------------------ */

export interface PlanVerdict {
  verdict: "target_first" | "stop_first" | null;
  /** Where the verdict came from: the terminal's own watch, the trade's recorded answer, or nothing yet. */
  source: "watch" | "trade" | null;
  at: string | null;
  /** What the idea would have made left alone, gross, in R. */
  planR: number | null;
}

/** Which original level came first, and what that was worth left alone. */
export function planVerdictOf(
  t: { direction: string; entryPrice: number; noManagementOutcome?: string | null; outcomeHitAt?: string | null },
  ref: TerminalRef,
): PlanVerdict {
  const idea = ideaOf(t as any, ref);
  const target = idea.targets[0] ?? null;
  const risk = idea.stop != null ? Math.abs(idea.entry - idea.stop) : 0;
  const targetR = target != null && risk > 0 ? Math.abs(target - idea.entry) / risk : null;
  const w = ref.planWatch;
  if (w?.first === "stop" || w?.first === "target") {
    const verdict = w.first === "stop" ? "stop_first" : "target_first";
    return { verdict, source: "watch", at: w.firstAt ?? null, planR: verdict === "stop_first" ? -1 : targetR };
  }
  if (t.noManagementOutcome === "stop_first" || t.noManagementOutcome === "target_first") {
    return {
      verdict: t.noManagementOutcome,
      source: "trade",
      at: t.outcomeHitAt ?? null,
      planR: t.noManagementOutcome === "stop_first" ? -1 : targetR,
    };
  }
  return { verdict: null, source: null, at: null, planR: null };
}

export interface TimelineRow {
  at: string;
  kind: MoveKind | "entry-fill" | "exit" | "plan-hit";
  /** One line, in the trader's words. */
  text: string;
  mark?: number | null;
  r?: number | null;
}

const fmtN = (v: number | null | undefined) => (v == null ? "—" : String(Number(v.toFixed(6))));
const fmtR = (v: number | null | undefined) => (v == null ? "" : ` (${v >= 0 ? "+" : ""}${v.toFixed(2)}R)`);

/**
 * The life of the trade, as one list: the idea, every move with the R it
 * was made at, every take and add from the ledger, the original levels being
 * reached, the exit. The card draws it; the review reads it.
 */
export function managementTimeline(
  t: {
    direction: string;
    status: string;
    entryPrice: number;
    entryTime: string;
    size: number;
    exitPrice?: number | null;
    exitTime?: string | null;
    exitReason?: string | null;
    initialStop?: number | null;
    initialTarget?: number | null;
    riskAmount?: number | null;
    fills?: { kind: string; price: number; size: number; time: string; note?: string | null }[];
  },
  ref: TerminalRef,
): TimelineRow[] {
  const idea = ideaOf(t, ref);
  const rows: TimelineRow[] = [];
  const target = idea.targets[0] ?? null;
  const rr = idea.stop != null && target != null && Math.abs(idea.entry - idea.stop) > 0 ? Math.abs(target - idea.entry) / Math.abs(idea.entry - idea.stop) : null;
  rows.push({
    at: idea.at,
    kind: "entry-fill",
    text: `Idea: ${t.direction} ${fmtN(idea.qty)} at ${fmtN(idea.entry)}, stop ${fmtN(idea.stop)}, target ${fmtN(target)}${rr != null ? ` (${rr.toFixed(1)}R)` : ""}${idea.targets.length > 1 ? `, then ${idea.targets.slice(1).map(fmtN).join(", ")}` : ""}`,
  });
  if (Math.abs(t.entryPrice - idea.entry) > 1e-9 && t.status !== "pending") {
    rows.push({ at: t.entryTime, kind: "entry-fill", text: `Filled at ${fmtN(t.entryPrice)}` });
  }
  for (const m of ref.moves ?? []) {
    let text: string;
    switch (m.kind) {
      case "stop":
        text = `Stop ${fmtN(m.from)} → ${fmtN(m.to)}${idea.entry != null && m.to != null && Math.abs(m.to - idea.entry) < 1e-9 ? " (breakeven)" : ""}`;
        break;
      case "target":
        text = `Target ${fmtN(m.from)} → ${fmtN(m.to)}`;
        break;
      case "entry":
        text = `Resting entry ${fmtN(m.from)} → ${fmtN(m.to)}`;
        break;
      case "reduce":
        text = `Took ${fmtN(m.qty)} off at market`;
        break;
      case "add":
        text = m.price != null ? `Added ${fmtN(m.qty)}, resting at ${fmtN(m.price)}` : `Added ${fmtN(m.qty)} at market`;
        break;
      case "close":
        text = `Closed at market`;
        break;
    }
    rows.push({ at: m.at, kind: m.kind, text: `${text}${m.mark != null ? ` · mark ${fmtN(m.mark)}` : ""}${fmtR(m.r)}`, mark: m.mark, r: m.r });
  }
  const w = ref.planWatch;
  if (w?.stopHitAt) rows.push({ at: w.stopHitAt, kind: "plan-hit", text: `Tape reached the original stop ${fmtN(w.stopHitPrice)}` });
  if (w?.targetHitAt) rows.push({ at: w.targetHitAt, kind: "plan-hit", text: `Tape reached the original target ${fmtN(w.targetHitPrice)}` });
  for (const f of t.fills ?? []) {
    if (!(f.note ?? "").startsWith("terminal")) continue;
    // Every R here is against the same footing as the moves: the fill, over the original risk.
    const r = rAt(f.price, t.entryPrice, idea.stop, t.direction);
    rows.push({ at: f.time, kind: f.kind === "add" ? "add" : "reduce", text: `${f.kind === "add" ? "Add filled" : "Partial filled"}: ${fmtN(f.size)} at ${fmtN(f.price)}${fmtR(r)}`, mark: f.price, r });
  }
  if (t.status === "closed" && t.exitPrice != null && t.exitTime) {
    const r = rAt(t.exitPrice, t.entryPrice, idea.stop, t.direction);
    rows.push({ at: t.exitTime, kind: "exit", text: `Exit at ${fmtN(t.exitPrice)}${t.exitReason ? ` — ${t.exitReason}` : ""}${fmtR(r)}`, mark: t.exitPrice, r });
  }
  // In time order, the exit last among anything stamped the same second.
  const rank = (r: TimelineRow) => (r.kind === "exit" ? 1 : 0);
  return rows.sort((a, b) => a.at.localeCompare(b.at) || rank(a) - rank(b));
}

/** The timeline and the comparison, as the text a reader — human or model — gets. */
export function managementBrief(
  t: Parameters<typeof managementTimeline>[0] & { noManagementOutcome?: string | null; outcomeHitAt?: string | null },
  ref: TerminalRef,
  actualR: number | null,
): string {
  const rows = managementTimeline(t, ref);
  const plan = planVerdictOf(t, ref);
  const lines = rows.map((r) => `${r.at.slice(0, 16).replace("T", " ")}  ${r.text}`);
  lines.push("");
  lines.push(
    plan.verdict
      ? `Left alone, the original plan would have hit the ${plan.verdict === "stop_first" ? "stop" : "target"} first${plan.at ? ` (${plan.at.slice(0, 16).replace("T", " ")})` : ""}: ${plan.planR != null ? `${plan.planR >= 0 ? "+" : ""}${plan.planR.toFixed(2)}R` : "unknown R"}.`
      : "Left alone, the original plan has not reached either level yet.",
  );
  lines.push(actualR != null ? `As managed, the trade made ${actualR >= 0 ? "+" : ""}${actualR.toFixed(2)}R.` : "The trade is still open.");
  if (actualR != null && plan.planR != null) {
    const d = actualR - plan.planR;
    lines.push(`Management ${d >= 0 ? "added" : "cost"} ${Math.abs(d).toFixed(2)}R against set-and-forget.`);
  }
  return lines.join("\n");
}

/** The question put to the model about one finished trade's management. */
export function managementReviewPrompt(brief: string, ctx: { symbol: string; direction: string }): string {
  return `You are a trading coach reading the full record of one ${ctx.direction} trade in ${ctx.symbol}, sent from the trader's own terminal. The record has the idea as it was drawn, every change the trader made while the trade was on — with the open R at the moment of each change — and what the untouched plan would have done.

Judge the MANAGEMENT only: the decisions after the entry. Not whether the idea was good, not the result on its own. A move that lost money can be right and a move that made money can be wrong; say which this was and why, from the record. Be specific: name the move and the R it was made at.

Return ONLY a JSON object with exactly these keys:
- verdict: "helped" if the management beat leaving the plan alone, "hurt" if leaving it alone would have paid more, "neutral" if it made no material difference (under 0.1R either way), "unknown" if the plan's own outcome is not known yet.
- summary: one or two plain sentences on what the trader did and what it was worth, in the second person.
- lesson: one sentence the trader can act on next time, or null if there is nothing to change.

The record:
"""
${brief.slice(0, 4000)}
"""`;
}

/** A model's answer, taken only as far as it fits. */
export function parseManagementReview(raw: unknown, basis: ManagementReview["basis"], at: string): ManagementReview {
  const j = (raw ?? {}) as any;
  const v = String(j.verdict ?? "").toLowerCase();
  const verdict = v === "helped" || v === "hurt" || v === "neutral" ? v : "unknown";
  return {
    at,
    verdict,
    summary: String(j.summary ?? "").slice(0, 600),
    lesson: j.lesson == null ? null : String(j.lesson).slice(0, 300),
    basis,
  };
}
