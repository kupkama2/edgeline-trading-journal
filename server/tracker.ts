/**
 * The tracker: the journal follows what an account does on its venue.
 *
 * A trade sent from the terminal is known from the first second. A trade
 * made anywhere else — the venue's own app, another terminal — is known
 * only to the venue, and the venue will say, to anyone with the key or the
 * address: the positions it holds, the orders resting against them, the
 * fills that made them. So every account somebody asked the journal to
 * watch is read each pass, and:
 *
 *   - a position with no trade behind it becomes one, from the fills that
 *     opened it where the window holds them, from the position itself where
 *     it does not; the stop and the target resting against it are its idea;
 *   - a tracked trade is read back like a sent one (server/terminal.ts):
 *     opening fills are adds, closing fills takes or the exit, a stop or a
 *     target at a new price is a move, with the mark and the R at the time;
 *   - a position that is gone closes the trade, and the plan watch and the
 *     review follow as for any trade.
 *
 * Read-only throughout. Binance needs a key with reading on; Hyperliquid
 * needs the wallet address and nothing else.
 */
import type { AccountSettings, TradeWithTags } from "@shared/schema";
import { tradesFromFills, type HlFill, type HlOpenOrder, type HlTrade } from "@shared/hyperliquid";
import { cutAtFlat, formatTerminalRef, parseTerminalRef, type Brackets, type TerminalRef, type VenueSnapshot } from "@shared/terminal";
import { USD_COMMISSION, type BinanceUserTrade } from "@shared/binance-account";
import { storageFor, trackedAccountsEverywhere, type DatabaseStorage } from "./storage";
import { open } from "./secrets";
import { credsFor, type BinanceEnv, type Creds } from "./binance-account";
import { relayConnected } from "./relay";
import { fillsSince, positions, rulesFor, type Venue } from "./binance-trade";
import { fetchAllMids, fetchClearinghouseState, fetchFrontendOpenOrders, fetchUserFillsSince } from "./hyperliquid";
import { oneAtATime } from "./venue-sync";
import { applySnapshot, newTag, noteFullRead, reconcileOne, refOf, restingOnStream, type PassMode } from "./terminal";

/** How far back the fills are read to find a position's opening. Binance serves seven days of userTrades. */
const WINDOW_MS = 7 * 24 * 60 * 60_000;
const ZERO = 1e-9;

export interface TrackSummary {
  account: string;
  venue: "binance" | "hyperliquid";
  opened: number[];
  read: number;
  error?: string;
}

const said = (err: any) => String(err?.message ?? err).slice(0, 300);

/** One person's watched accounts, read under the same lock as their terminal pass. */
export async function trackUser(userId: number): Promise<TrackSummary[]> {
  const s = storageFor(userId);
  const accounts = (await s.listAccountSettings()).filter((a) => a.track);
  if (accounts.length === 0) return [];
  return oneAtATime(`terminal:${userId}`, async () => {
    const out: TrackSummary[] = [];
    for (const a of accounts) out.push(await trackAccount(s, a));
    return out;
  });
}

/** The last thing said about each account, so a venue that is down is logged once, not every pass. */
const lastSaid = new Map<string, string>();

/**
 * Every watched account of everyone, for the server's watch. A light pass
 * leaves a Binance account alone while its user-data stream is open and a
 * full read is recent — the stream says when something happens, and the
 * read it triggers is full. Hyperliquid has no stream here and is read each
 * time; its public API has no ban to spend.
 */
export async function trackEverywhere(mode: PassMode = "full"): Promise<void> {
  const byUser = new Map<number, AccountSettings[]>();
  for (const a of await trackedAccountsEverywhere()) byUser.set(a.userId, [...(byUser.get(a.userId) ?? []), a]);
  for (const [userId, accounts] of Array.from(byUser.entries())) {
    const s = storageFor(userId);
    await oneAtATime(`terminal:${userId}`, async () => {
      for (const a of accounts) {
        if (mode === "light" && !a.wallet && restingOnStream(userId, a, "tracker")) continue;
        const r = await trackAccount(s, a);
        const key = `${userId}:${a.name}`;
        if (r.error) {
          if (lastSaid.get(key) !== r.error) console.error(`[tracker] ${a.name}: ${r.error}`);
          lastSaid.set(key, r.error);
        } else if (lastSaid.has(key)) {
          console.error(`[tracker] ${a.name}: reading again`);
          lastSaid.delete(key);
        }
      }
    });
  }
}

/** One account, one pass: new positions adopted, tracked trades read back. */
export async function trackAccount(s: DatabaseStorage, acct: AccountSettings): Promise<TrackSummary> {
  if (acct.wallet) return trackHyperliquid(s, acct).catch((err) => ({ account: acct.name, venue: "hyperliquid" as const, opened: [], read: 0, error: said(err) }));
  if (acct.relayToken || (acct.binanceKey && acct.binanceSecret)) return trackBinance(s, acct).catch((err) => ({ account: acct.name, venue: "binance" as const, opened: [], read: 0, error: said(err) }));
  return { account: acct.name, venue: "binance", opened: [], read: 0, error: "No key, relay or wallet on the account." };
}

/** This account's tracked trades still on. */
async function trackedOpen(s: DatabaseStorage, account: string): Promise<{ t: TradeWithTags; ref: TerminalRef }[]> {
  return (await s.listTerminalTrades())
    .map((t) => ({ t, ref: parseTerminalRef(t.terminal)! }))
    .filter((x) => x.ref?.tracked && x.ref.account === account && x.t.status === "open");
}

/* ------------------------------- the opening ------------------------------- */

interface Opening {
  venue: "binance" | "hyperliquid";
  env: "live" | "testnet";
  account: string;
  /** The venue's symbol ("BTCUSDT", "kPEPE") and the journal's ("BTC", "KPEPE"). */
  symbol: string;
  journalSymbol: string;
  positionSide: "LONG" | "SHORT";
  size: number;
  entryPrice: number;
  entryTime: number;
  entryOrderId: number | null;
  addOrderIds: number[];
  leverage: number;
  externalId: string | null;
  brackets: Brackets;
  paper: boolean;
}

/** A trade written for a position the journal did not have, as the tracker first sees it. */
async function openTracked(s: DatabaseStorage, o: Opening): Promise<TradeWithTags> {
  const at = new Date(o.entryTime).toISOString();
  const ref: TerminalRef = {
    venue: o.venue,
    env: o.env,
    account: o.account,
    symbol: o.symbol,
    positionSide: o.positionSide,
    tag: newTag().replace(/^edg-/, "trk-"),
    leverage: o.leverage || 1,
    qty: o.size,
    entryOrderId: o.entryOrderId,
    stopOrderId: o.brackets.stopId,
    targetOrderIds: o.brackets.targetIds,
    closeOrderIds: [],
    addOrderIds: o.addOrderIds,
    tracked: true,
    unprotected: o.brackets.stopId == null,
    idea: {
      entry: o.entryPrice,
      stop: o.brackets.stopPrice,
      targets: o.brackets.targetPrices,
      qty: o.size,
      riskDollars: o.brackets.stopPrice != null ? Math.abs(o.entryPrice - o.brackets.stopPrice) * o.size : null,
      at,
    },
    seen: { stop: o.brackets.stopPrice, targets: o.brackets.targetPrices },
  };
  const trade = await s.createTrade({
    symbol: o.journalSymbol,
    direction: o.positionSide === "LONG" ? "long" : "short",
    size: o.size,
    sizeUnit: "base",
    pointValue: 1,
    entryPrice: o.entryPrice,
    initialStop: o.brackets.stopPrice,
    initialTarget: o.brackets.targetPrices[0] ?? null,
    extraTargets: o.brackets.targetPrices.length > 1 ? JSON.stringify(o.brackets.targetPrices.slice(1)) : null,
    entryTime: at,
    status: "open",
    account: o.account,
    riskAmount: ref.idea!.riskDollars,
    externalId: o.externalId,
    terminal: formatTerminalRef(ref),
    paper: o.paper,
  } as any);
  await s.logTerminal({
    at: new Date().toISOString(),
    account: o.account,
    action: "track-open",
    tradeId: trade.id,
    request: JSON.stringify({ venue: o.venue, symbol: o.symbol, positionSide: o.positionSide, size: o.size, entryPrice: o.entryPrice, from: o.externalId ? "fills" : "position" }),
    response: JSON.stringify({ tradeId: trade.id, stop: o.brackets.stopPrice, targets: o.brackets.targetPrices }),
    ok: true,
  });
  return trade;
}

/** A sync-written or hand-logged trade for the same position, taken under watch instead of written twice. */
async function adoptExisting(s: DatabaseStorage, t: TradeWithTags, o: Opening): Promise<TradeWithTags> {
  const ref: TerminalRef = {
    venue: o.venue,
    env: o.env,
    account: o.account,
    symbol: o.symbol,
    positionSide: o.positionSide,
    tag: newTag().replace(/^edg-/, "trk-"),
    leverage: o.leverage || 1,
    qty: t.size,
    entryOrderId: o.entryOrderId,
    stopOrderId: o.brackets.stopId,
    targetOrderIds: o.brackets.targetIds,
    closeOrderIds: [],
    addOrderIds: o.addOrderIds,
    tracked: true,
    unprotected: o.brackets.stopId == null,
    idea: { entry: t.entryPrice, stop: t.initialStop ?? o.brackets.stopPrice, targets: t.initialTarget != null ? [t.initialTarget] : o.brackets.targetPrices, qty: t.size, riskDollars: t.riskAmount ?? null, at: t.entryTime },
    seen: { stop: o.brackets.stopPrice, targets: o.brackets.targetPrices },
  };
  // The brackets resting now stand in for a stop and a target the trade never had.
  const levels: Record<string, unknown> = {};
  if (t.initialStop == null && o.brackets.stopPrice != null) {
    levels.initialStop = o.brackets.stopPrice;
    if (t.riskAmount == null) levels.riskAmount = Math.abs(t.entryPrice - o.brackets.stopPrice) * t.size;
  }
  if (t.initialTarget == null && o.brackets.targetPrices.length) levels.initialTarget = o.brackets.targetPrices[0];
  const after = await s.updateTrade(t.id, { ...levels, terminal: formatTerminalRef(ref), status: "open", exitPrice: null, exitTime: null } as any);
  await s.logTerminal({ at: new Date().toISOString(), account: o.account, action: "track-adopt", tradeId: t.id, request: JSON.stringify({ venue: o.venue, symbol: o.symbol }), response: null, ok: true });
  return after ?? t;
}

/* -------------------------------- Binance -------------------------------- */

const readCreds = (a: AccountSettings): { creds: Creds; env: BinanceEnv } | null => {
  const creds = credsFor(a, open);
  if (!creds) return null;
  return { creds, env: a.binanceEnv === "testnet" ? "testnet" : "live" };
};

/**
 * A position side's fills, as the position reader wants them: opening fills
 * add, closing fills take away, the running size before each one noted.
 * Only trusted when the running size lands on what the venue holds now —
 * otherwise the position began before the window, and its entry is not in
 * the record.
 */
function sideFills(rows: BinanceUserTrade[], symbol: string, side: "LONG" | "SHORT", heldNow: number): HlFill[] | null {
  const openSide = side === "LONG" ? "BUY" : "SELL";
  const mine = rows
    .filter((r) => r.symbol === symbol && (r.positionSide === side || r.positionSide === "BOTH"))
    .sort((a, b) => a.time - b.time || a.id - b.id);
  let pos = 0;
  const out: HlFill[] = [];
  for (const r of mine) {
    const sign = side === "LONG" ? 1 : -1;
    out.push({
      coin: symbol,
      px: r.price,
      sz: r.qty,
      side: r.side === "BUY" ? "B" : "A",
      time: r.time,
      startPosition: pos * sign,
      dir: "",
      closedPnl: r.realizedPnl,
      fee: USD_COMMISSION.has(r.commissionAsset) ? r.commission : Number.NaN,
      tid: r.id,
      oid: r.orderId,
    });
    pos += r.side === openSide ? r.qty : -r.qty;
  }
  return Math.abs(pos - heldNow) <= Math.max(ZERO, heldNow * 1e-6) ? out : null;
}

/**
 * The entry as the opening fills say it: every leg of the entry ORDER — a
 * market order sweeping two levels fills twice under one id — summed and
 * averaged, and the opening orders beyond it as adds. Without the fills,
 * the position itself.
 */
function entryOf(
  open: HlTrade | null,
  orderOf: (tid: number) => number | null,
  fallback: { size: number; price: number; time: number },
): { size: number; entryPrice: number; entryTime: number; entryOrderId: number | null; addOrderIds: number[] } {
  if (!open || open.opens.length === 0) return { size: fallback.size, entryPrice: fallback.price, entryTime: fallback.time, entryOrderId: null, addOrderIds: [] };
  const entryOrderId = orderOf(open.opens[0].tid);
  const legs = entryOrderId != null ? open.opens.filter((l) => orderOf(l.tid) === entryOrderId) : [open.opens[0]];
  const size = legs.reduce((s, l) => s + l.sz, 0);
  const entryPrice = legs.reduce((s, l) => s + l.px * l.sz, 0) / size;
  const addOrderIds = Array.from(new Set(open.opens.map((l) => orderOf(l.tid)).filter((x): x is number => x != null && x !== entryOrderId)));
  return { size, entryPrice, entryTime: open.entryTime, entryOrderId, addOrderIds };
}

/** The open position from a side's fills, when the window reaches its opening. */
function openFrom(fills: HlFill[] | null, venue: string): HlTrade | null {
  if (!fills || fills.length === 0) return null;
  return tradesFromFills(fills, venue).trades.find((t) => t.status === "open") ?? null;
}

function bracketsOnBinance(
  orders: { orderId: number; side: string; positionSide: string; type: string; stopPrice: number | null; price: number | null; time: number }[],
  side: "LONG" | "SHORT",
): Brackets {
  const closeSide = side === "LONG" ? "SELL" : "BUY";
  const mine = orders.filter((o) => (o.positionSide === side || o.positionSide === "BOTH") && o.side === closeSide);
  const stop = mine.filter((o) => /STOP/.test(o.type) && o.stopPrice != null).sort((a, b) => b.time - a.time)[0] ?? null;
  const targets = mine
    .filter((o) => (/TAKE_PROFIT/.test(o.type) && o.stopPrice != null) || (o.type === "LIMIT" && o.price != null))
    .map((o) => ({ id: o.orderId, price: (o.stopPrice ?? o.price)! }))
    .sort((a, b) => (side === "LONG" ? a.price - b.price : b.price - a.price));
  return { stopId: stop?.orderId ?? null, stopPrice: stop?.stopPrice ?? null, targetIds: targets.map((x) => x.id), targetPrices: targets.map((x) => x.price) };
}

async function trackBinance(s: DatabaseStorage, acct: AccountSettings): Promise<TrackSummary> {
  const out: TrackSummary = { account: acct.name, venue: "binance", opened: [], read: 0 };
  if (acct.relayToken && !relayConnected(acct.userId, acct.name)) return { ...out, error: "The relay is not connected. Start it on your machine." };
  const rc = readCreds(acct);
  if (!rc) return { ...out, error: "The stored key could not be opened — the server's SESSION_SECRET has changed since it was saved (a new server, say). Enter the key again in Settings." };
  const v: Venue = { creds: rc.creds, env: rc.env };
  const { openOrders } = await import("./binance-trade");
  const held = (await positions(v)).filter((p) => p.positionSide === "LONG" || p.positionSide === "SHORT" || p.positionSide === "BOTH");
  const tracked = await trackedOpen(s, acct.name);
  const now = Date.now();

  for (const p of held) {
    const side: "LONG" | "SHORT" = p.positionSide === "BOTH" ? (p.amt > 0 ? "LONG" : "SHORT") : p.positionSide;
    if (tracked.some((x) => x.ref.symbol === p.symbol && x.ref.positionSide === side)) continue;
    const rows = await fillsSince(v, p.symbol, now - WINDOW_MS);
    const fromFills = openFrom(sideFills(rows, p.symbol, side, Math.abs(p.amt)), "binance");
    const resting = await openOrders(v, p.symbol);
    const brackets = bracketsOnBinance(resting, side);
    const rules = await rulesFor(v.env, p.symbol).catch(() => null);
    const opening: Opening = {
      venue: "binance",
      env: v.env,
      account: acct.name,
      symbol: p.symbol,
      journalSymbol: rules?.baseAsset ?? p.symbol.replace(/USDT$|USDC$|BUSD$|FDUSD$/, ""),
      positionSide: side,
      ...entryOf(fromFills, (tid) => rows.find((r) => r.id === tid)?.orderId ?? null, { size: Math.abs(p.amt), price: p.entryPrice, time: now }),
      leverage: p.leverage,
      externalId: fromFills ? fromFills.externalId : null,
      brackets,
      paper: v.env === "testnet",
    };
    // The same position already written by the sync or by hand: taken under watch, not written twice.
    const existing = opening.externalId ? await s.tradeByExternalId(opening.externalId) : undefined;
    const made = existing && !parseTerminalRef(existing.terminal) ? await adoptExisting(s, existing, opening) : existing ? existing : await openTracked(s, opening);
    out.opened.push(made.id);
    tracked.push({ t: made, ref: refOf(made) });
  }

  for (const { t } of tracked) {
    await reconcileOne(s, t, { venue: v, acct });
    out.read += 1;
  }
  noteFullRead(acct.userId, acct.name, "tracker");
  return out;
}

/* ------------------------------ Hyperliquid ------------------------------ */

function bracketsOnHl(orders: HlOpenOrder[], coin: string, long: boolean): Brackets {
  const closeSide = long ? "A" : "B";
  const mine = orders.filter((o) => o.coin === coin && o.side === closeSide);
  const type = (o: HlOpenOrder) => o.orderType.toLowerCase();
  const stop = mine.filter((o) => o.isTrigger && o.triggerPx != null && type(o).includes("stop")).sort((a, b) => b.timestamp - a.timestamp)[0] ?? null;
  const targets = mine
    .filter((o) => (o.isTrigger && o.triggerPx != null && type(o).includes("take profit")) || (!o.isTrigger && o.reduceOnly && o.limitPx != null))
    .map((o) => ({ id: o.oid, price: (o.isTrigger ? o.triggerPx : o.limitPx)! }))
    .sort((a, b) => (long ? a.price - b.price : b.price - a.price));
  return { stopId: stop?.oid ?? null, stopPrice: stop?.triggerPx ?? null, targetIds: targets.map((x) => x.id), targetPrices: targets.map((x) => x.price) };
}

async function trackHyperliquid(s: DatabaseStorage, acct: AccountSettings): Promise<TrackSummary> {
  const out: TrackSummary = { account: acct.name, venue: "hyperliquid", opened: [], read: 0 };
  const address = acct.wallet!;
  const now = Date.now();
  const [held, orders, fills, mids] = await Promise.all([
    fetchClearinghouseState(address),
    fetchFrontendOpenOrders(address),
    fetchUserFillsSince(address, now - WINDOW_MS),
    fetchAllMids().catch(() => ({}) as Record<string, number>),
  ]);
  const tracked = await trackedOpen(s, acct.name);

  for (const p of held) {
    const long = p.szi > 0;
    const side: "LONG" | "SHORT" = long ? "LONG" : "SHORT";
    if (tracked.some((x) => x.ref.symbol === p.coin && x.ref.positionSide === side)) continue;
    const coinFills = fills.filter((f) => f.coin === p.coin);
    const fromFills = openFrom(coinFills.length ? coinFills : null, "hl");
    const brackets = bracketsOnHl(orders, p.coin, long);
    const opening: Opening = {
      venue: "hyperliquid",
      env: "live",
      account: acct.name,
      symbol: p.coin,
      journalSymbol: p.coin.toUpperCase(),
      positionSide: side,
      ...entryOf(fromFills, (tid) => coinFills.find((f) => f.tid === tid)?.oid || null, { size: Math.abs(p.szi), price: p.entryPx, time: now }),
      leverage: p.leverage,
      externalId: fromFills ? fromFills.externalId : null,
      brackets,
      paper: false,
    };
    const existing = opening.externalId ? await s.tradeByExternalId(opening.externalId) : undefined;
    const made = existing && !parseTerminalRef(existing.terminal) ? await adoptExisting(s, existing, opening) : existing ? existing : await openTracked(s, opening);
    out.opened.push(made.id);
    tracked.push({ t: made, ref: refOf(made) });
  }

  for (const { t, ref } of tracked) {
    const long = ref.positionSide === "LONG";
    const p = held.find((x) => x.coin === ref.symbol && (x.szi > 0) === long) ?? null;
    const entryAt = new Date(t.entryTime).getTime();
    const openSide = long ? "B" : "A";
    // This trade's fills: from the entry, up to where the position first went flat.
    const own = cutAtFlat(fills.filter((f) => f.coin === ref.symbol && f.time >= entryAt - 5_000).map((f) => ({ ...f, qty: f.sz })), openSide);
    const coinFills = own.fills;
    // Opening fills beyond the entry are adds; the ids are learned from the fills.
    const addIds = new Set(ref.addOrderIds ?? []);
    for (const f of coinFills) if (f.side === openSide && f.oid !== ref.entryOrderId && f.oid !== 0) addIds.add(f.oid);
    const entryFills = coinFills.filter((f) => f.oid === ref.entryOrderId && ref.entryOrderId != null);
    const snap: VenueSnapshot = {
      entry:
        ref.entryOrderId != null && entryFills.length
          ? {
              status: "FILLED",
              avgPrice: entryFills.reduce((a, f) => a + f.px * f.sz, 0) / entryFills.reduce((a, f) => a + f.sz, 0),
              executedQty: entryFills.reduce((a, f) => a + f.sz, 0),
              updateTime: entryFills[entryFills.length - 1].time,
            }
          : null,
      fills: coinFills.map((f) => ({
        tid: f.tid,
        orderId: f.oid,
        side: f.side === "B" ? "BUY" : "SELL",
        price: f.px,
        qty: f.sz,
        time: f.time,
        commission: Number.isFinite(f.fee) ? f.fee : 0,
        commissionUsd: Number.isFinite(f.fee),
        realizedPnl: f.closedPnl,
        foreign: false,
      })),
      positionAmt: own.cut ? 0 : p ? Math.abs(p.szi) : 0,
      openOrderIds: orders.filter((o) => o.coin === ref.symbol).map((o) => o.oid),
    };
    const brackets = bracketsOnHl(orders, ref.symbol, long);
    await applySnapshot(s, t, { ...ref, addOrderIds: Array.from(addIds) }, snap, { brackets, mark: mids[ref.symbol] ?? null });
    out.read += 1;
  }
  return out;
}
