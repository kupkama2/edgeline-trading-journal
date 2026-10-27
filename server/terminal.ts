/**
 * The terminal: send a drawn plan to Binance, and keep the journal's copy of
 * it true as the venue acts on it.
 *
 * A trade sent from here is a journal trade from the first second — symbol,
 * direction, size, entry, stop and target exactly as drawn — with the venue's
 * order ids kept beside it. From then on the terminal reads those orders
 * back: a limit that filled makes the trade open at the fill's average, a
 * stop or target that fired closes it at the fills' average, a moved stop is
 * written to the stop log. Nothing has to be typed afterwards, and the plan
 * as drawn is never overwritten by what happened to it.
 *
 * WHO. Only the emails in TERMINAL_EMAILS, checked on every call; to anyone
 * else these routes do not exist. Signing in is not enough for a thing that
 * can open a position. Every call that could move money is logged with what
 * was asked and what the venue said.
 */
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { storageFor, terminalUsers, tradingAccountsEverywhere, type DatabaseStorage } from "./storage";
import { openUserStream, worthAReadBack, type StreamHandle } from "./binance-stream";
import { oneAtATime } from "./venue-sync";
import { fetch as undiciFetch } from "undici";
import { egressFor } from "./egress";
import { open } from "./secrets";
import { futuresBase, signedCall, type BinanceEnv, type Creds } from "./binance-account";
import { fetchCandles, type Interval } from "./binance";
import {
  addToPosition,
  algoOrderById,
  cancelBracket,
  cancelOrder,
  closeAtMarket,
  enableHedgeMode,
  exchangeRules,
  fillsSince,
  hedgeMode,
  openOrders,
  orderById,
  placeBrackets,
  placeOrder,
  placePlan,
  positions,
  rulesFor,
  setLeverage,
  usdBalance,
  type Venue,
  type VenueOrder,
} from "./binance-trade";
import {
  addNote,
  advancePlanWatch,
  bracketAt,
  formatTerminalRef,
  fmtPrice,
  fmtQty,
  ideaOf,
  managementBrief,
  managementReviewPrompt,
  ordersForPlan,
  parseManagementReview,
  parseTerminalRef,
  partialNote,
  planTouches,
  planVerdictOf,
  rAt,
  reconcilePatch,
  sizePlan,
  MAX_TARGETS,
  type MoveKind,
  type TerminalMove,
  type TerminalPlan,
  type TerminalRef,
  type VenueSnapshot,
} from "@shared/terminal";
import { addStopMove, currentStop, formatStopMoves } from "@shared/stops";
import { computeMetrics } from "@shared/metrics";
import { parseNoteRead } from "@shared/note-read";
import { USD_COMMISSION } from "@shared/binance-account";
import type { AccountSettings, TradeWithTags } from "@shared/schema";

const TERMINAL_EMAILS = (process.env.TERMINAL_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

/** A ceiling on one order's notional, in dollars. Unset means none. */
const MAX_NOTIONAL = Number(process.env.TERMINAL_MAX_NOTIONAL_USD ?? "0") || 0;

/** How long after its exit a trade's original levels are still watched for. */
const PLAN_HORIZON_MS = 7 * 24 * 60 * 60_000;
/** How long a finished trade waits for the plan's answer before it is reviewed without one. */
const REVIEW_WAIT_MS = 3 * 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
/** How often a live trade's tape is read for the original levels. One klines call each. */
const PLAN_WATCH_GAP_MS = Number(process.env.TERMINAL_PLAN_WATCH_GAP_MS ?? "30000");

/**
 * The model, lent by the routes module: one function from a prompt to its
 * text. Kept out of here so the terminal does not depend on how the keys
 * and the fallbacks are arranged over there.
 */
let llm: ((prompt: string) => Promise<string>) | null = null;

/** Whether this person may see the terminal at all. */
export function terminalAllowed(email: string | null | undefined): boolean {
  const e = (email ?? "").trim().toLowerCase();
  return Boolean(e) && TERMINAL_EMAILS.includes(e);
}

const store = (req: Request) => {
  if (!req.userId) throw new Error("no account on request — auth middleware missing");
  return storageFor(req.userId);
};

const INTERVALS: Interval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
const BAR_MS: Record<Interval, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

const planSchema = z.object({
  symbol: z.string().min(1).max(30),
  side: z.enum(["long", "short"]),
  entryType: z.enum(["market", "limit"]),
  entryPrice: z.number().positive(),
  stop: z.number().positive(),
  targets: z.array(z.number().positive()).max(MAX_TARGETS),
  riskDollars: z.number().positive().nullable().optional(),
  qty: z.number().positive().nullable().optional(),
  leverage: z.number().int().min(1).max(125),
});

const sendSchema = z.object({ account: z.string().min(1), plan: planSchema });
const priceSchema = z.object({ price: z.number().positive() });
const accountSchema = z.object({ account: z.string().min(1) });

/** A client order id the venue accepts (≤36 of [A-Za-z0-9_-]) that is recognisably ours. */
const newTag = () => `edg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

interface Armed {
  venue: Venue;
  acct: AccountSettings;
}

/** The account's key, opened for the length of one request. */
async function arm(s: DatabaseStorage, accountName: string): Promise<Armed> {
  const acct = (await s.listAccountSettings()).find((a) => a.name === accountName);
  if (!acct) throw httpError(404, `No account called ${accountName}.`);
  if (!acct.binanceKey || !acct.binanceSecret) throw httpError(400, `${acct.name} holds no Binance key.`);
  if (!acct.binanceTrade) throw httpError(400, `${acct.name}'s key is read-only. Save a trading key on it in Settings.`);
  const secret = open(acct.binanceSecret);
  if (!secret) throw httpError(500, "The stored key could not be opened — SESSION_SECRET changed since it was saved. Save the key again.");
  const creds: Creds = { key: acct.binanceKey, secret };
  return { venue: { creds, env: (acct.binanceEnv === "testnet" ? "testnet" : "live") as BinanceEnv }, acct };
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

const said = (err: any) => String(err?.message ?? err).slice(0, 400);

/** Writes to the venue are logged whatever happens; `run` is the call itself. */
async function logged<T>(
  s: DatabaseStorage,
  action: string,
  account: string,
  tradeId: number | null,
  request: unknown,
  run: () => Promise<T>,
): Promise<T> {
  try {
    const out = await run();
    await s.logTerminal({ at: new Date().toISOString(), account, action, tradeId, request: JSON.stringify(request), response: JSON.stringify(out ?? null).slice(0, 4000), ok: true });
    return out;
  } catch (err) {
    await s.logTerminal({ at: new Date().toISOString(), account, action, tradeId, request: JSON.stringify(request), response: said(err), ok: false });
    throw err;
  }
}

const refOf = (t: TradeWithTags): TerminalRef => {
  const ref = parseTerminalRef(t.terminal);
  if (!ref) throw httpError(400, "That trade was not sent from the terminal.");
  return ref;
};

/* ------------------------------ reconcile ------------------------------ */

/**
 * Read one terminal trade back from the venue and write what changed.
 *
 * Fills are taken by order id — the entry's, the brackets', any close sent
 * from here — so a second trade on the same symbol and side cannot leak into
 * this one's average. A trade with no stop resting is flagged `unprotected`,
 * which the terminal shows in red; the position is still real.
 */
/** A public read off the venue: no key, no signature. */
async function publicGet(base: string, path: string): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await undiciFetch(`${base}${path}`, { headers: { accept: "application/json" }, signal: ctl.signal, dispatcher: egressFor(base) } as any);
    if (!res.ok) throw new Error(`${new URL(base).hostname} → HTTP ${res.status} on ${path.split("?")[0]}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** The mark on this position side now, or nothing when the venue holds none. */
async function markOf(v: Venue, ref: TerminalRef): Promise<number | null> {
  try {
    const pos = (await positions(v)).find((p) => p.symbol === ref.symbol && p.positionSide === ref.positionSide);
    return pos?.markPrice ?? null;
  } catch {
    return null;
  }
}

/** A management event with the mark and the open R it was made at. */
function moveAt(t: TradeWithTags, ref: TerminalRef, kind: MoveKind, mark: number | null, fields: Omit<TerminalMove, "at" | "kind" | "mark" | "r"> = {}): TerminalMove {
  const idea = ideaOf(t, ref);
  return { at: new Date().toISOString(), kind, ...fields, mark, r: rAt(mark, t.entryPrice, idea.stop, t.direction) };
}

/** The JSON object in a model's answer, fenced or bare. */
function jsonIn(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("the model returned no JSON object");
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * The original stop and target, watched on the tape.
 *
 * The question every managed trade leaves open is what the untouched plan
 * would have done, and for a perpetual the answer is public: the minute
 * bars from the entry on. So each live trade's tape is read forward on
 * every pass, from where the last read stopped, and the first original
 * level it reaches is written down — while the trade is still on, which is
 * when knowing it matters, and for a week after it closes, so a trade taken
 * off early still gets its answer. Nothing is guessed: both levels inside
 * one minute stays "ambiguous", and a verdict somebody typed by hand is
 * never overwritten.
 */
async function watchPlan(
  s: DatabaseStorage,
  t: TradeWithTags,
  ref: TerminalRef,
): Promise<{ ref: TerminalRef; patch: Record<string, unknown>; news: ("stop" | "target")[] }> {
  const none = { ref, patch: {}, news: [] as ("stop" | "target")[] };
  if (t.status !== "open" && t.status !== "closed") return none;
  const idea = ideaOf(t, ref);
  const target = idea.targets[0] ?? null;
  if (idea.stop == null && target == null) return none;
  const w = ref.planWatch;
  if (w?.first) return none;
  const now = Date.now();
  const entryMs = new Date(t.entryTime).getTime();
  if (!Number.isFinite(entryMs)) return none;
  if (t.status === "closed") {
    const exitMs = t.exitTime ? new Date(t.exitTime).getTime() : entryMs;
    if (now - exitMs > PLAN_HORIZON_MS) return none;
  }
  const gap = t.status === "closed" ? HOUR_MS : PLAN_WATCH_GAP_MS;
  if (w?.checkedAt && now - new Date(w.checkedAt).getTime() < gap) return none;
  const from = Math.max(w?.coveredTo ?? 0, entryMs - 60_000);
  const bars = await fetchCandles({ symbol: ref.symbol, market: "futures" }, "1m", from, now, 1500);
  // The entry's own minute counts only from the entry: a print before the fill is not a touch.
  const after = bars.filter((c) => c.t + 60_000 > entryMs);
  const touches = planTouches(after, { direction: t.direction, stop: idea.stop, target });
  // A touch inside the entry's own minute is stamped at the entry, not at the minute's open.
  if (touches.stop) touches.stop.at = Math.max(touches.stop.at, entryMs);
  if (touches.target) touches.target.at = Math.max(touches.target.at, entryMs);
  const last = bars.length ? bars[bars.length - 1].t : from;
  // The bar still forming is read again next time.
  const coveredTo = Math.max(from, Math.min(last, now - 60_000));
  const { next, news } = advancePlanWatch(w, touches, coveredTo, new Date(now).toISOString());
  const patch: Record<string, unknown> = {};
  if (next.first === "stop" || next.first === "target") {
    const fromNote = t.noManagementOutcome != null && parseNoteRead(t.noteRead)?.set.noManagementOutcome === t.noManagementOutcome;
    const writable = t.noManagementOutcome == null || t.noManagementOutcome === "undetermined" || t.outcomeSource === "auto" || fromNote;
    if (writable) {
      patch.noManagementOutcome = next.first === "stop" ? "stop_first" : "target_first";
      patch.outcomeSource = "auto";
      patch.outcomeHitAt = next.firstAt;
    }
  }
  for (const kind of news) {
    const at = kind === "stop" ? next.stopHitAt : next.targetHitAt;
    const price = kind === "stop" ? next.stopHitPrice : next.targetHitPrice;
    await s.logTerminal({
      at: new Date().toISOString(),
      account: ref.account,
      action: "plan-hit",
      tradeId: t.id,
      request: JSON.stringify({ kind, price, at }),
      response: JSON.stringify({ first: next.first ?? null, status: t.status }),
      ok: true,
    });
  }
  return { ref: { ...ref, planWatch: next }, patch, news };
}

/**
 * The read on the management, once per finished trade: the whole timeline,
 * what the plan would have done, what was made — put to the model, and its
 * verdict kept on the record. Waits for the plan's answer, up to a few days;
 * a trade that has not reached either original level by then is read as it
 * stands.
 */
async function reviewIfDue(s: DatabaseStorage, t: TradeWithTags, ref: TerminalRef, force = false): Promise<TerminalRef> {
  if (!llm || t.status !== "closed" || t.exitPrice == null) return ref;
  if (ref.review && !force) return ref;
  const now = Date.now();
  if (!force && ref.reviewTriedAt && now - new Date(ref.reviewTriedAt).getTime() < HOUR_MS) return ref;
  const plan = planVerdictOf(t, ref);
  const exitMs = t.exitTime ? new Date(t.exitTime).getTime() : now;
  if (!force && !plan.verdict && now - exitMs < REVIEW_WAIT_MS) return ref;
  const actualR = computeMetrics(t).actualR;
  const brief = managementBrief(t, ref, actualR);
  const prompt = managementReviewPrompt(brief, { symbol: ref.symbol, direction: t.direction });
  try {
    const review = await logged(s, "review", ref.account, t.id, { brief }, async () =>
      parseManagementReview(jsonIn(await llm!(prompt)), { actualR, planR: plan.planR, planVerdict: plan.verdict }, new Date().toISOString()),
    );
    const { reviewTriedAt: _t, ...rest } = ref;
    return { ...rest, review };
  } catch {
    return { ...ref, reviewTriedAt: new Date().toISOString() };
  }
}

/** A finished trade's errands: the plan watched to its answer, then the review. */
async function afterClose(s: DatabaseStorage, t: TradeWithTags): Promise<void> {
  let ref = refOf(t);
  const watched = await watchPlan(s, t, ref);
  const reviewed = await reviewIfDue(s, t, watched.ref);
  const changed = formatTerminalRef(reviewed) !== formatTerminalRef(ref) || Object.keys(watched.patch).length > 0;
  if (changed) await s.updateTrade(t.id, { ...watched.patch, terminal: formatTerminalRef(reviewed) } as any);
}

async function reconcileOne(s: DatabaseStorage, t: TradeWithTags, armed: Armed): Promise<TradeWithTags> {
  let ref = refOf(t);
  const v = armed.venue;
  const entry = ref.entryOrderId != null ? await orderById(v, ref.symbol, ref.entryOrderId) : null;
  const since = new Date(t.entryTime).getTime() - 5 * 60_000;
  const resting = await openOrders(v, ref.symbol);
  /*
   * Brackets the record has lost track of but the book still holds — an
   * answer that would not parse, a restart mid-send — are recognised by the
   * tag every order from here carries, and taken back onto the record.
   */
  const tagged = resting.filter((o) => o.clientOrderId.startsWith(`${ref.tag}-`) && o.positionSide === ref.positionSide);
  const foundStop = tagged.find((o) => o.type === "STOP_MARKET");
  const foundTargets = tagged.filter((o) => o.type === "TAKE_PROFIT_MARKET");
  if (ref.stopOrderId == null && foundStop) ref = { ...ref, stopOrderId: foundStop.orderId };
  if (ref.targetOrderIds.length === 0 && foundTargets.length) ref = { ...ref, targetOrderIds: foundTargets.map((o) => o.orderId) };
  const mine = new Set(
    [ref.entryOrderId, ref.stopOrderId, ...ref.targetOrderIds, ...(ref.closeOrderIds ?? []), ...(ref.addOrderIds ?? [])].filter((x): x is number => x != null),
  );
  /*
   * A bracket that fired placed a plain order of its own, and the fills
   * carry THAT id. Each bracket is asked what it became, and its fills are
   * read back under the bracket's own id, so "the stop's fills" means what
   * it says whichever id the venue stamped on them.
   */
  const alias = new Map<number, number>();
  const brackets = [ref.stopOrderId, ...ref.targetOrderIds].filter((x): x is number => x != null);
  const fired: { algoId: number; side: "BUY" | "SELL"; at: number }[] = [];
  for (const id of brackets) {
    const a = await algoOrderById(v, id).catch(() => null);
    if (!a) continue;
    if (a.triggeredOrderId != null) {
      alias.set(a.triggeredOrderId, id);
      mine.add(a.triggeredOrderId);
    } else if (/TRIGGER|FINISHED|FILLED/.test(a.status)) {
      fired.push({ algoId: id, side: a.side, at: a.updateTime });
    }
  }
  const rows = await fillsSince(v, ref.symbol, since);
  const closeSide = ref.positionSide === "LONG" ? "SELL" : "BUY";
  const entryAt = new Date(t.entryTime).getTime();
  const fills = rows
    .filter((r) => {
      if (mine.has(r.orderId)) return true;
      if (!(r.positionSide === ref.positionSide || r.positionSide === "BOTH")) return false;
      // A fired bracket the venue did not name the order of: its fills are
      // the closing-side fills from the moment it fired.
      const f = fired.find((x) => x.side === closeSide && r.side === closeSide && r.time >= x.at - 5_000);
      if (f) {
        alias.set(r.orderId, f.algoId);
        return true;
      }
      // Anything else on the closing side after the entry went on: a close
      // made from the venue's own app. Kept, marked foreign; counted only if
      // it is the only thing that explains a flat position. Strictly after:
      // the trade before this one on the same symbol closed before it.
      return r.side === closeSide && r.time > entryAt;
    })
    .map((r) => ({
      tid: r.id,
      orderId: alias.get(r.orderId) ?? r.orderId,
      side: r.side,
      foreign: !mine.has(r.orderId) && !alias.has(r.orderId),
      price: r.price,
      qty: r.qty,
      time: r.time,
      commission: r.commission,
      commissionUsd: USD_COMMISSION.has(r.commissionAsset),
      realizedPnl: r.realizedPnl,
    }));
  const pos = (await positions(v)).find((p) => p.symbol === ref.symbol && p.positionSide === ref.positionSide);
  const snap: VenueSnapshot = {
    entry: entry ? { status: entry.status, avgPrice: entry.avgPrice, executedQty: entry.executedQty, updateTime: entry.updateTime } : null,
    fills,
    positionAmt: pos?.amt ?? 0,
    openOrderIds: resting.map((o) => o.orderId),
  };
  const { patch: read, partials, adds } = reconcilePatch(t, ref, snap);
  const patch = read ?? {};
  // A target that took its share while the rest stayed on, a take from here,
  // an add: rows in the ledger, once each, by the venue's fill id.
  const already = new Set((t.fills ?? []).map((f) => f.note ?? ""));
  for (const f of partials) {
    if (already.has(partialNote(f.tid))) continue;
    await s.addFill(t.id, { kind: "partial", price: f.price, size: f.qty, time: new Date(f.time).toISOString(), note: partialNote(f.tid) });
  }
  for (const f of adds) {
    if (already.has(addNote(f.tid))) continue;
    await s.addFill(t.id, { kind: "add", price: f.price, size: f.qty, time: new Date(f.time).toISOString(), note: addNote(f.tid) });
  }
  const nowOpen = (patch.status ?? t.status) === "open";
  /*
   * The resting entry has filled: the brackets it was drawn with go on now,
   * while the position is seconds old. Refusals are kept on the record and
   * shown in red; the position is real either way.
   */
  let withBrackets: TerminalRef = ref;
  if (ref.armOnFill && nowOpen && Math.abs(snap.positionAmt) > 1e-9) {
    const brackets = ref.armOnFill;
    const placed = await logged(s, "arm-brackets", ref.account, t.id, brackets, () => placeBrackets(v, brackets));
    const { armOnFill: _done, ...rest } = ref;
    withBrackets = { ...rest, stopOrderId: placed.stop?.orderId ?? null, targetOrderIds: placed.targets.map((o) => o.orderId) };
    if (placed.stop) snap.openOrderIds.push(placed.stop.orderId);
  }
  const stopResting = withBrackets.stopOrderId != null && snap.openOrderIds.includes(withBrackets.stopOrderId);
  let nextRef: TerminalRef = { ...withBrackets, unprotected: nowOpen && !stopResting, checkedAt: new Date().toISOString() };
  // The original levels, watched while the trade is on. A feed that is down costs the watch, not the read-back.
  const watched = await watchPlan(s, { ...t, ...(patch as any) }, nextRef).catch(() => ({ ref: nextRef, patch: {} as Record<string, unknown>, news: [] as ("stop" | "target")[] }));
  nextRef = watched.ref;
  Object.assign(patch, watched.patch);
  const before = refOf(t);
  const quiet = (r: TerminalRef) => formatTerminalRef({ ...r, checkedAt: undefined, planWatch: r.planWatch ? { ...r.planWatch, checkedAt: "", coveredTo: 0 } : undefined });
  const changed = Object.keys(patch).length > 0 || partials.length > 0 || adds.length > 0 || quiet(nextRef) !== quiet(before);
  if (!changed && before.checkedAt && Date.now() - new Date(before.checkedAt).getTime() < 60_000) return t;
  const after = await s.updateTrade(t.id, { ...patch, terminal: formatTerminalRef(nextRef) } as any);
  return after ?? t;
}

/**
 * Every live terminal trade of one person, read back. What the page polls,
 * the watch runs, and a stream event triggers. One pass at a time per person:
 * two passes seeing the same fresh fill would both arm its brackets.
 */
function reconcileAll(s: DatabaseStorage, userId: number): Promise<{ id: number; status: string; error?: string }[]> {
  return oneAtATime(`terminal:${userId}`, () => reconcilePass(s));
}

async function reconcilePass(s: DatabaseStorage): Promise<{ id: number; status: string; error?: string }[]> {
  const trades = await s.listTerminalTrades();
  const armedBy = new Map<string, Armed>();
  const out: { id: number; status: string; error?: string }[] = [];
  for (const t of trades) {
    if (t.status === "closed") {
      // Finished, but still owed the plan's answer and the review.
      try {
        await afterClose(s, t);
      } catch (err) {
        out.push({ id: t.id, status: t.status, error: said(err) });
      }
      continue;
    }
    try {
      const ref = refOf(t);
      let armed = armedBy.get(ref.account);
      if (!armed) {
        armed = await arm(s, ref.account);
        armedBy.set(ref.account, armed);
      }
      const after = await reconcileOne(s, t, armed);
      out.push({ id: t.id, status: after.status });
    } catch (err) {
      out.push({ id: t.id, status: t.status, error: said(err) });
    }
  }
  return out;
}

/**
 * The watch: the journal stays true with the tab closed.
 *
 * A stop that fires at four in the morning closes the position whether or
 * not anybody is looking, and a journal that only learns of it when the
 * page is next opened is wrong for the hours between. So the server reads
 * every live terminal trade back on its own, every twenty seconds, for
 * every person who has one. One pass at a time; a slow venue delays the
 * next pass rather than stacking a second on top of it.
 */
let watching = false;
let watchTimer: NodeJS.Timeout | null = null;
let streamsOn = false;
/** One user-data stream per trading account, keyed so a changed key reopens it. */
const streams = new Map<string, StreamHandle>();
const readBackTimers = new Map<number, NodeJS.Timeout>();

/** A read-back for this person, shortly — several events in a burst are one pass. */
function readBackSoon(userId: number): void {
  const pending = readBackTimers.get(userId);
  if (pending) clearTimeout(pending);
  const t = setTimeout(() => {
    readBackTimers.delete(userId);
    void reconcileAll(storageFor(userId), userId)
      .then((out) => {
        for (const o of out) if (o.error) console.error(`[terminal] stream read-back trade #${o.id}: ${o.error}`);
      })
      .catch((err) => console.error("[terminal] stream read-back:", said(err)));
  }, 250);
  t.unref?.();
  readBackTimers.set(userId, t);
}

/**
 * Streams for every account that may trade: opened for new ones, closed for
 * ones whose key is gone. A fill, a cancel or a bracket firing on any of
 * them runs that person's read-back within the second — which is what puts
 * a limit's stop on the book the moment it fills, tab open or not.
 */
export async function ensureStreams(): Promise<void> {
  if (!streamsOn) return;
  const wanted = new Set<string>();
  for (const a of await tradingAccountsEverywhere()) {
    if (!a.binanceKey || !a.binanceSecret) continue;
    const secret = open(a.binanceSecret);
    if (!secret) continue;
    const env: BinanceEnv = a.binanceEnv === "testnet" ? "testnet" : "live";
    const id = `${a.userId}:${a.name}:${env}:${a.binanceKey.slice(-8)}`;
    wanted.add(id);
    if (streams.has(id)) continue;
    const userId = a.userId;
    streams.set(
      id,
      openUserStream({
        creds: { key: a.binanceKey, secret },
        env,
        label: `${a.name} (${env})`,
        onEvent: (msg) => {
          if (worthAReadBack(msg)) readBackSoon(userId);
        },
      }),
    );
  }
  for (const [id, h] of Array.from(streams.entries())) {
    if (wanted.has(id)) continue;
    h.close();
    streams.delete(id);
  }
}

export function startTerminalWatch(intervalMs = 20_000): void {
  if (TERMINAL_EMAILS.length === 0) return;
  streamsOn = true;
  const tick = async () => {
    if (watching) return;
    watching = true;
    try {
      await ensureStreams().catch((err) => console.error("[terminal] streams:", said(err)));
      for (const userId of await terminalUsers()) {
        const s = storageFor(userId);
        const out = await reconcileAll(s, userId).catch((err) => {
          console.error("[terminal] watch:", said(err));
          return [] as { id: number; status: string; error?: string }[];
        });
        for (const o of out) if (o.error) console.error(`[terminal] watch trade #${o.id}: ${o.error}`);
      }
    } finally {
      watching = false;
    }
  };
  watchTimer = setInterval(() => void tick(), intervalMs);
  watchTimer.unref();
  void tick();
}

/** Everything the watch holds open, let go — for tests and a clean shutdown. */
export function stopTerminalWatch(): void {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
  streamsOn = false;
  for (const h of Array.from(streams.values())) h.close();
  streams.clear();
  for (const t of Array.from(readBackTimers.values())) clearTimeout(t);
  readBackTimers.clear();
}

/* ------------------------------ the routes ------------------------------ */

export function registerTerminalRoutes(app: Express, deps: { llm?: (prompt: string) => Promise<string> } = {}): void {
  if (deps.llm) llm = deps.llm;
  // To anyone not on the list, none of this exists.
  app.use("/api/terminal", (req: Request, res: Response, next: NextFunction) => {
    if (!terminalAllowed(req.account?.email)) return res.status(404).json({ message: "Not found" });
    next();
  });

  const wrap =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) =>
      fn(req, res).catch((err) => {
        const status = typeof err?.status === "number" ? err.status : 502;
        if (status >= 500) console.error(`[terminal] ${req.method} ${req.path}:`, said(err));
        res.status(status).json({ message: said(err) });
      });

  app.get(
    "/api/terminal/status",
    wrap(async (req, res) => {
      const all = (await store(req).listAccountSettings()).filter((a) => a.binanceKey && a.binanceTrade);
      const accounts = await Promise.all(
        all.map(async (a) => {
          const row: Record<string, unknown> = {
            name: a.name,
            env: a.binanceEnv,
            keyHint: `…${a.binanceKey!.slice(-4)}`,
            host: new URL(futuresBase(a.binanceEnv)).hostname,
            // False is the loud one: a live key that works from any IP.
            ipLocked: a.binanceEnv === "live" ? a.binanceIpLocked : null,
          };
          try {
            const { venue } = await arm(store(req), a.name);
            const [hedge, balance] = await Promise.all([hedgeMode(venue), usdBalance(venue)]);
            row.hedgeMode = hedge;
            row.balance = balance.find((b) => b.asset === "USDT") ?? balance[0] ?? null;
          } catch (err) {
            row.error = said(err);
          }
          return row;
        }),
      );
      res.json({ enabled: true, maxNotional: MAX_NOTIONAL || null, accounts });
    }),
  );

  app.post(
    "/api/terminal/hedge-mode",
    wrap(async (req, res) => {
      const { account } = accountSchema.parse(req.body);
      const { venue } = await arm(store(req), account);
      await logged(store(req), "hedge-mode", account, null, {}, () => enableHedgeMode(venue));
      res.json({ ok: true, hedgeMode: await hedgeMode(venue) });
    }),
  );

  app.get(
    "/api/terminal/symbols",
    wrap(async (req, res) => {
      const { acct } = await arm(store(req), String(req.query.account ?? ""));
      res.json(await exchangeRules(acct.binanceEnv as BinanceEnv));
    }),
  );

  /*
   * Bars for a symbol, from the live market whichever host the key is on:
   * the testnet's own book is thin and its history is noise, and the plan
   * is drawn against the real price either way.
   */
  app.get(
    "/api/terminal/candles",
    wrap(async (req, res) => {
      const symbol = String(req.query.symbol ?? "").toUpperCase();
      if (!symbol) throw httpError(400, "Which symbol?");
      const asked = String(req.query.interval ?? "15m");
      const interval = (INTERVALS as string[]).includes(asked) ? (asked as Interval) : "15m";
      const before = Number(req.query.before);
      const to = Number.isFinite(before) && before > 0 ? before : Date.now();
      const from = to - BAR_MS[interval] * 600;
      const candles = await fetchCandles({ symbol, market: "futures" }, interval, from, to, 1200);
      res.json({ pair: symbol, interval, candles });
    }),
  );

  app.get(
    "/api/terminal/book",
    wrap(async (req, res) => {
      const { venue } = await arm(store(req), String(req.query.account ?? ""));
      const [pos, orders, balance] = await Promise.all([positions(venue), openOrders(venue), usdBalance(venue)]);
      res.json({ positions: pos, orders, balance });
    }),
  );

  /**
   * What the venue literally answers, for a human to read. The order
   * endpoints have moved before, and the only way to see a new shape from
   * here is to ask for it raw. Truncated hard; nothing secret in it.
   */
  app.get(
    "/api/terminal/probe",
    wrap(async (req, res) => {
      const { venue } = await arm(store(req), String(req.query.account ?? ""));
      const symbol = String(req.query.symbol ?? "").toUpperCase() || undefined;
      const algoId = Number(req.query.algoId);
      const ask = async (method: "GET", path: string, params: Record<string, string | number | undefined>) => {
        try {
          const j = await signedCall(method, futuresBase(venue.env), path, params, venue.creds);
          return JSON.stringify(j).slice(0, 1500);
        } catch (err) {
          return `ERROR ${said(err)}`;
        }
      };
      res.json({
        host: new URL(futuresBase(venue.env)).hostname,
        openOrders: await ask("GET", "/fapi/v1/openOrders", symbol ? { symbol } : {}),
        openAlgoOrders: await ask("GET", "/fapi/v1/openAlgoOrders", symbol ? { symbol } : {}),
        algoOrder: Number.isFinite(algoId) && algoId > 0 ? await ask("GET", "/fapi/v1/algoOrder", { algoId }) : null,
        positionRisk: await ask("GET", "/fapi/v2/positionRisk", symbol ? { symbol } : {}),
      });
    }),
  );

  app.get(
    "/api/terminal/log",
    wrap(async (req, res) => {
      res.json(await store(req).listTerminalLog(100));
    }),
  );

  /**
   * A plan onto the book and into the journal.
   *
   * Refusals that mean "nothing happened" are 4xx with the reason; once the
   * entry stands, the answer is 201 with the trade, and anything the venue
   * refused after that is in `refused` for the terminal to shout about.
   */
  app.post(
    "/api/terminal/send",
    wrap(async (req, res) => {
      const parsed = sendSchema.safeParse(req.body);
      if (!parsed.success) throw httpError(400, parsed.error.issues.map((i) => i.message).join("; "));
      const { account, plan } = parsed.data;
      const { venue, acct } = await arm(store(req), account);
      const rules = await rulesFor(venue.env, plan.symbol);
      const sized = sizePlan(plan as TerminalPlan, rules);
      if (sized.problems.length) throw httpError(400, sized.problems.join(" "));
      if (MAX_NOTIONAL > 0 && sized.notional > MAX_NOTIONAL)
        throw httpError(400, `That is $${sized.notional.toFixed(0)} of notional; the terminal's ceiling is $${MAX_NOTIONAL}.`);
      if (!(await hedgeMode(venue)))
        throw httpError(409, "The account is in one-way mode. The terminal needs hedge mode — switch it on the terminal's status bar, with no positions or orders open.");

      const tag = newTag();
      const orders = ordersForPlan(plan as TerminalPlan, rules, sized.qty, tag);
      await logged(store(req), "leverage", account, null, { symbol: rules.symbol, leverage: plan.leverage }, () =>
        setLeverage(venue, rules.symbol, plan.leverage),
      );
      const rests = plan.entryType === "limit";
      const placed = await logged(store(req), "send", account, null, orders, () => placePlan(venue, orders, rests));

      const ref: TerminalRef = {
        venue: "binance",
        env: venue.env,
        account,
        symbol: rules.symbol,
        positionSide: orders.positionSide,
        tag,
        leverage: plan.leverage,
        qty: sized.qtyNumber,
        entryOrderId: placed.entry.orderId,
        stopOrderId: placed.stop?.orderId ?? null,
        targetOrderIds: placed.targets.map((o) => o.orderId),
        // A resting entry has no position to protect yet; its brackets wait.
        unprotected: !rests && !placed.stop,
        closeOrderIds: [],
        idea: { entry: plan.entryPrice, stop: plan.stop, targets: plan.targets, qty: sized.qtyNumber, riskDollars: sized.riskDollars, at: new Date().toISOString() },
        ...(rests ? { armOnFill: { stop: orders.stop, targets: orders.targets } } : {}),
      };
      const [first, ...rest] = plan.targets;
      const trade = await store(req).createTrade({
        symbol: rules.baseAsset,
        direction: plan.side,
        size: sized.qtyNumber,
        sizeUnit: "base",
        pointValue: 1,
        entryPrice: plan.entryPrice,
        initialStop: plan.stop,
        initialTarget: first ?? null,
        extraTargets: rest.length ? JSON.stringify(rest) : null,
        entryTime: new Date().toISOString(),
        status: plan.entryType === "market" ? "open" : "pending",
        account: acct.name,
        riskAmount: sized.riskDollars,
        terminal: formatTerminalRef(ref),
        // A testnet fill is practice: kept for the terminal, left out of the journal.
        paper: venue.env === "testnet",
      } as any);
      await store(req).logTerminal({
        at: new Date().toISOString(),
        account,
        action: "journal",
        tradeId: trade.id,
        request: JSON.stringify(plan),
        response: JSON.stringify({ tradeId: trade.id, placed: ref }),
        ok: true,
      });
      // The account's stream, if it is not open yet, so this trade's fill is heard at once.
      void ensureStreams().catch(() => {});
      res.status(201).json({ trade, placed: ref, refused: placed.refused, sized });
    }),
  );

  /** The strip over the chart: last, mark, the day's change and range, funding. Public data, from the account's own host. */
  app.get(
    "/api/terminal/ticker",
    wrap(async (req, res) => {
      const { account, symbol } = z.object({ account: z.string().min(1), symbol: z.string().min(1) }).parse(req.query);
      const acct = (await store(req).listAccountSettings()).find((a) => a.name === account);
      if (!acct) throw httpError(404, "No such account");
      const base = futuresBase(acct.binanceEnv);
      const sym = symbol.toUpperCase();
      const n = (x: unknown) => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));
      const [day, prem] = await Promise.all([
        publicGet(base, `/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(sym)}`).catch(() => null),
        publicGet(base, `/fapi/v1/premiumIndex?symbol=${encodeURIComponent(sym)}`).catch(() => null),
      ]);
      if (!day && !prem) throw httpError(502, "The venue did not answer for that symbol.");
      res.json({
        symbol: sym,
        last: n(day?.lastPrice),
        change: n(day?.priceChange),
        changePct: n(day?.priceChangePercent),
        high: n(day?.highPrice),
        low: n(day?.lowPrice),
        volume: n(day?.volume),
        quoteVolume: n(day?.quoteVolume),
        mark: n(prem?.markPrice),
        index: n(prem?.indexPrice),
        fundingRate: n(prem?.lastFundingRate),
        nextFundingTime: n(prem?.nextFundingTime),
      });
    }),
  );

  /** Every trade this terminal has a record of, paper included — the journal's own list leaves those out. */
  app.get(
    "/api/terminal/trades",
    wrap(async (req, res) => {
      res.json(await store(req).listTerminalTrades());
    }),
  );

  /**
   * A position the terminal has no record of — its journal trade deleted, or
   * opened elsewhere — taken under management: a trade is written from the
   * venue's own figures, with whatever brackets rest on that side adopted
   * as its stop and target. The idea is pinned as of now; what came before
   * is not known.
   */
  app.post(
    "/api/terminal/adopt",
    wrap(async (req, res) => {
      const { account, symbol, positionSide } = z
        .object({ account: z.string().min(1), symbol: z.string().min(1), positionSide: z.enum(["LONG", "SHORT"]) })
        .parse(req.body);
      const s = store(req);
      const { venue, acct } = await arm(s, account);
      const rules = await rulesFor(venue.env, symbol);
      const pos = (await positions(venue)).find((p) => p.symbol === rules.symbol && p.positionSide === positionSide);
      if (!pos || Math.abs(pos.amt) <= 0) throw httpError(409, "The venue holds no position on that side.");
      const already = (await s.listTerminalTrades()).find((t) => {
        const r = parseTerminalRef(t.terminal);
        return t.status === "open" && r?.account === account && r.symbol === rules.symbol && r.positionSide === positionSide;
      });
      if (already) throw httpError(409, `Trade #${already.id} already manages that position.`);
      const closeSide = positionSide === "LONG" ? "SELL" : "BUY";
      // Newest first: a close-position bracket can outlive the position it was
      // for, so the ones placed last are the ones that belong to this position.
      const resting = (await openOrders(venue, rules.symbol))
        .filter((o) => o.positionSide === positionSide && o.side === closeSide)
        .sort((x, y) => y.time - x.time);
      const stop = resting.find((o) => o.type === "STOP_MARKET") ?? null;
      const newestTarget = resting.find((o) => o.type === "TAKE_PROFIT_MARKET" && o.stopPrice != null) ?? null;
      const anchor = stop?.time ?? newestTarget?.time ?? 0;
      // One plan's brackets go on within seconds of each other: the targets that belong with this stop are the ones placed with or after it.
      const targets = resting.filter((o) => o.type === "TAKE_PROFIT_MARKET" && o.stopPrice != null && o.time >= anchor);
      const size = Math.abs(pos.amt);
      const stopPrice = stop?.stopPrice ?? null;
      const now = new Date().toISOString();
      const ref: TerminalRef = {
        venue: "binance",
        env: venue.env,
        account,
        symbol: rules.symbol,
        positionSide,
        tag: newTag(),
        leverage: pos.leverage || 1,
        qty: size,
        entryOrderId: null,
        stopOrderId: stop?.orderId ?? null,
        targetOrderIds: targets.map((o) => o.orderId),
        closeOrderIds: [],
        unprotected: !stop,
        idea: { entry: pos.entryPrice, stop: stopPrice, targets: targets.map((o) => o.stopPrice!), qty: size, riskDollars: stopPrice != null ? Math.abs(pos.entryPrice - stopPrice) * size : null, at: now },
      };
      const trade = await s.createTrade({
        symbol: rules.baseAsset,
        direction: positionSide === "LONG" ? "long" : "short",
        size,
        sizeUnit: "base",
        pointValue: 1,
        entryPrice: pos.entryPrice,
        initialStop: stopPrice,
        initialTarget: targets[0]?.stopPrice ?? null,
        extraTargets: targets.length > 1 ? JSON.stringify(targets.slice(1).map((o) => o.stopPrice)) : null,
        entryTime: now,
        status: "open",
        account: acct.name,
        riskAmount: ref.idea!.riskDollars,
        terminal: formatTerminalRef(ref),
        paper: venue.env === "testnet",
      } as any);
      await s.logTerminal({
        at: now,
        account,
        action: "adopt",
        tradeId: trade.id,
        request: JSON.stringify({ symbol: rules.symbol, positionSide, size, entryPrice: pos.entryPrice }),
        response: JSON.stringify({ tradeId: trade.id, stopOrderId: ref.stopOrderId, targetOrderIds: ref.targetOrderIds }),
        ok: true,
      });
      res.status(201).json({ trade });
    }),
  );

  /** A new stop: the old bracket off, a new one on, and the move in the stop log. */
  app.post(
    "/api/terminal/trades/:id/stop",
    wrap(async (req, res) => {
      const { price } = priceSchema.parse(req.body);
      const s = store(req);
      const t = await s.getTrade(Number(req.params.id));
      if (!t) throw httpError(404, "Trade not found");
      const ref = refOf(t);
      if (t.status !== "open" && t.status !== "pending") throw httpError(400, "That trade is finished.");
      const { venue } = await arm(store(req), ref.account);
      const rules = await rulesFor(venue.env, ref.symbol);
      const side = ref.positionSide === "LONG" ? "long" : "short";
      const at = new Date().toISOString();
      // Brackets still waiting for the fill are moved on paper; nothing is on the book to replace.
      if (ref.armOnFill) {
        const to = Number(fmtPrice(price, rules));
        const moves = addStopMove(t.stopMoves, to, at, "terminal");
        const after = await s.updateTrade(t.id, {
          stopMoves: formatStopMoves(moves),
          terminal: formatTerminalRef({
            ...ref,
            armOnFill: { ...ref.armOnFill, stop: { ...ref.armOnFill.stop, stopPrice: fmtPrice(price, rules) } },
            moves: [...(ref.moves ?? []), { at, kind: "stop", from: currentStop(t), to }],
          }),
        } as any);
        return res.json({ trade: after, order: null });
      }
      const mark = await markOf(venue, ref);
      const next = await logged(store(req), "move-stop", ref.account, t.id, { price }, async () => {
        if (ref.stopOrderId != null) await cancelBracket(venue, ref.symbol, ref.stopOrderId);
        return placeOrder(venue, bracketAt("stop", price, rules, side, `${ref.tag}-s${Date.now().toString(36)}`));
      });
      const to = Number(next.stopPrice ?? price);
      const moves = addStopMove(t.stopMoves, to, at, "terminal");
      const after = await s.updateTrade(t.id, {
        stopMoves: formatStopMoves(moves),
        terminal: formatTerminalRef({
          ...ref,
          stopOrderId: next.orderId,
          unprotected: false,
          moves: [...(ref.moves ?? []), moveAt(t, ref, "stop", mark, { from: currentStop(t), to })],
        }),
      } as any);
      res.json({ trade: after, order: next });
    }),
  );

  /** A new target: every resting target off, one close-position target on. */
  app.post(
    "/api/terminal/trades/:id/target",
    wrap(async (req, res) => {
      const { price } = priceSchema.parse(req.body);
      const s = store(req);
      const t = await s.getTrade(Number(req.params.id));
      if (!t) throw httpError(404, "Trade not found");
      const ref = refOf(t);
      if (t.status !== "open" && t.status !== "pending") throw httpError(400, "That trade is finished.");
      const { venue } = await arm(store(req), ref.account);
      const rules = await rulesFor(venue.env, ref.symbol);
      const side = ref.positionSide === "LONG" ? "long" : "short";
      if (ref.armOnFill) {
        const to = Number(fmtPrice(price, rules));
        const lastTarget = [...(ref.moves ?? [])].reverse().find((m) => m.kind === "target")?.to ?? t.initialTarget ?? null;
        const after = await s.updateTrade(t.id, {
          terminal: formatTerminalRef({
            ...ref,
            armOnFill: { ...ref.armOnFill, targets: [bracketAt("target", price, rules, side, `${ref.tag}-t1`)] },
            moves: [...(ref.moves ?? []), { at: new Date().toISOString(), kind: "target", from: lastTarget, to }],
          }),
        } as any);
        return res.json({ trade: after, order: null });
      }
      const mark = await markOf(venue, ref);
      const next = await logged(store(req), "move-target", ref.account, t.id, { price }, async () => {
        for (const id of ref.targetOrderIds) await cancelBracket(venue, ref.symbol, id);
        return placeOrder(venue, bracketAt("target", price, rules, side, `${ref.tag}-t${Date.now().toString(36)}`));
      });
      const to = Number(next.stopPrice ?? price);
      const lastTarget = [...(ref.moves ?? [])].reverse().find((m) => m.kind === "target")?.to ?? t.initialTarget ?? null;
      const after = await s.updateTrade(t.id, {
        terminal: formatTerminalRef({
          ...ref,
          targetOrderIds: [next.orderId],
          moves: [...(ref.moves ?? []), moveAt(t, ref, "target", mark, { from: lastTarget, to })],
        }),
      } as any);
      res.json({ trade: after, order: next });
    }),
  );

  /**
   * A partial take-profit, resting: a take-profit order for part of the
   * position at a price, beside whatever target already rests. Its fill is
   * a partial in the ledger like any target that takes its share.
   */
  app.post(
    "/api/terminal/trades/:id/take",
    wrap(async (req, res) => {
      const body = z.object({ qty: z.number().positive(), price: z.number().positive() }).parse(req.body);
      const s = store(req);
      const t = await s.getTrade(Number(req.params.id));
      if (!t) throw httpError(404, "Trade not found");
      const ref = refOf(t);
      if (t.status !== "open") throw httpError(400, "Only an open position can have a take resting.");
      const { venue } = await arm(s, ref.account);
      const rules = await rulesFor(venue.env, ref.symbol);
      const pos = (await positions(venue)).find((p) => p.symbol === ref.symbol && p.positionSide === ref.positionSide);
      if (!pos || Math.abs(pos.amt) <= 0) throw httpError(409, "The venue holds no position on this side.");
      const qty = fmtQty(Math.min(body.qty, Math.abs(pos.amt)), rules);
      if (Number(qty) <= 0) throw httpError(400, `That rounds to nothing at ${ref.symbol}'s step.`);
      const long = ref.positionSide === "LONG";
      if (long ? body.price <= pos.markPrice : body.price >= pos.markPrice) throw httpError(400, `A take has to sit on the profit side of the mark (${pos.markPrice}).`);
      const side = long ? "long" : "short";
      const order = { ...bracketAt("target", body.price, rules, side, `${ref.tag}-t${Date.now().toString(36)}`), quantity: qty };
      delete (order as any).closePosition;
      const placed = await logged(s, "take-at", ref.account, t.id, { qty, price: body.price }, () => placeOrder(venue, order));
      const nextRef: TerminalRef = {
        ...ref,
        targetOrderIds: [...ref.targetOrderIds, placed.orderId],
        moves: [...(ref.moves ?? []), moveAt(t, ref, "target", pos.markPrice, { to: Number(placed.stopPrice ?? body.price), qty: Number(qty) })],
      };
      const after = await s.updateTrade(t.id, { terminal: formatTerminalRef(nextRef) } as any);
      res.json({ trade: after, order: placed });
    }),
  );

  /**
   * One order off the book, whatever it is — a leftover bracket, a resting
   * add, something placed from the venue's app. A trade that was counting
   * on it is told: its stop gone means it is unprotected, its target or
   * add gone means the list no longer names it.
   */
  app.post(
    "/api/terminal/orders/cancel",
    wrap(async (req, res) => {
      const { account, symbol, orderId } = z.object({ account: z.string().min(1), symbol: z.string().min(1), orderId: z.number().int() }).parse(req.body);
      const s = store(req);
      const { venue } = await arm(s, account);
      const sym = symbol.toUpperCase();
      await logged(s, "cancel-order", account, null, { symbol: sym, orderId }, async () => {
        await cancelBracket(venue, sym, orderId);
        return { cancelled: true };
      });
      const touched: number[] = [];
      for (const t of await s.listTerminalTrades()) {
        const ref = parseTerminalRef(t.terminal);
        if (!ref || ref.account !== account || ref.symbol !== sym) continue;
        const had = ref.stopOrderId === orderId || ref.targetOrderIds.includes(orderId) || (ref.addOrderIds ?? []).includes(orderId) || ref.entryOrderId === orderId;
        if (!had) continue;
        const next: TerminalRef = {
          ...ref,
          stopOrderId: ref.stopOrderId === orderId ? null : ref.stopOrderId,
          unprotected: ref.stopOrderId === orderId && t.status === "open" ? true : ref.unprotected,
          targetOrderIds: ref.targetOrderIds.filter((id) => id !== orderId),
          addOrderIds: (ref.addOrderIds ?? []).filter((id) => id !== orderId),
        };
        // A resting entry pulled by hand: the trade is cancelled, as the cancel route would.
        const patch: Record<string, unknown> = { terminal: formatTerminalRef(next) };
        if (ref.entryOrderId === orderId && t.status === "pending") Object.assign(patch, { status: "cancelled", cancelReason: "pulled" });
        await s.updateTrade(t.id, patch as any);
        touched.push(t.id);
      }
      res.json({ cancelled: orderId, trades: touched });
    }),
  );

  /** A resting limit that never filled: every order off, the trade cancelled. */
  app.post(
    "/api/terminal/trades/:id/cancel",
    wrap(async (req, res) => {
      const s = store(req);
      const t = await s.getTrade(Number(req.params.id));
      if (!t) throw httpError(404, "Trade not found");
      const ref = refOf(t);
      if (t.status !== "pending") throw httpError(400, "Only a resting order can be cancelled. An open position is closed.");
      const { venue, acct } = await arm(store(req), ref.account);
      await logged(store(req), "cancel", ref.account, t.id, {}, async () => {
        if (ref.entryOrderId != null) await cancelOrder(venue, ref.symbol, ref.entryOrderId);
        for (const id of [ref.stopOrderId, ...ref.targetOrderIds]) if (id != null) await cancelBracket(venue, ref.symbol, id);
        return { cancelled: true };
      });
      /*
       * The entry may have filled in the moment before the cancel reached it
       * — a cancel of a filled order is refused quietly above. The venue's
       * word on the entry decides: filled means the trade is open and the
       * ordinary read-back writes it so; otherwise it was pulled, by hand.
       */
      const entry = ref.entryOrderId != null ? await orderById(venue, ref.symbol, ref.entryOrderId) : null;
      if (entry && entry.executedQty > 0) return res.json({ trade: await reconcileOne(store(req), t, { venue, acct }) });
      const after = await s.updateTrade(t.id, { status: "cancelled", cancelReason: "pulled" } as any);
      res.json({ trade: after });
    }),
  );

  /** Out at market: the position side flattened, the brackets taken off. */
  app.post(
    "/api/terminal/trades/:id/close",
    wrap(async (req, res) => {
      const s = store(req);
      const t = await s.getTrade(Number(req.params.id));
      if (!t) throw httpError(404, "Trade not found");
      const ref = refOf(t);
      if (t.status !== "open") throw httpError(400, "Only an open position can be closed.");
      const { venue, acct } = await arm(store(req), ref.account);
      const rules = await rulesFor(venue.env, ref.symbol);
      const pos = (await positions(venue)).find((p) => p.symbol === ref.symbol && p.positionSide === ref.positionSide);
      let closeOrder: VenueOrder | null = null;
      const mark = pos?.markPrice ?? null;
      if (pos && Math.abs(pos.amt) > 0) {
        closeOrder = await logged(store(req), "close", ref.account, t.id, { qty: Math.abs(pos.amt) }, () =>
          closeAtMarket(venue, ref.symbol, ref.positionSide, fmtQty(Math.abs(pos.amt), rules), `${ref.tag}-x${Date.now().toString(36)}`),
        );
      }
      await logged(store(req), "cancel-brackets", ref.account, t.id, {}, async () => {
        for (const id of [ref.stopOrderId, ...ref.targetOrderIds]) if (id != null) await cancelBracket(venue, ref.symbol, id);
        // A resting add would reopen the side after the close.
        for (const id of ref.addOrderIds ?? []) await cancelOrder(venue, ref.symbol, id);
        return { cancelled: true };
      });
      const nextRef: TerminalRef = {
        ...ref,
        closeOrderIds: [...(ref.closeOrderIds ?? []), ...(closeOrder ? [closeOrder.orderId] : [])],
        ...(closeOrder ? { moves: [...(ref.moves ?? []), moveAt(t, ref, "close", mark, { qty: Math.abs(pos!.amt) })] } : {}),
      };
      const stamped = (await s.updateTrade(t.id, { terminal: formatTerminalRef(nextRef) } as any)) ?? t;
      res.json({ trade: await reconcileOne(store(req), stamped, { venue, acct }) });
    }),
  );

  /** Some of it off at market: a take. The fill lands in the ledger as a partial. */
  app.post(
    "/api/terminal/trades/:id/reduce",
    wrap(async (req, res) => {
      const body = z.object({ qty: z.number().positive().optional(), fraction: z.number().gt(0).lte(1).optional() }).parse(req.body);
      const s = store(req);
      const t = await s.getTrade(Number(req.params.id));
      if (!t) throw httpError(404, "Trade not found");
      const ref = refOf(t);
      if (t.status !== "open") throw httpError(400, "Only an open position can be reduced.");
      const { venue, acct } = await arm(store(req), ref.account);
      const rules = await rulesFor(venue.env, ref.symbol);
      const pos = (await positions(venue)).find((p) => p.symbol === ref.symbol && p.positionSide === ref.positionSide);
      if (!pos || Math.abs(pos.amt) <= 0) throw httpError(409, "The venue holds no position on this side.");
      const want = body.qty ?? Math.abs(pos.amt) * (body.fraction ?? 0.5);
      const qty = fmtQty(Math.min(want, Math.abs(pos.amt)), rules);
      if (Number(qty) <= 0) throw httpError(400, `That rounds to nothing at ${ref.symbol}'s step.`);
      const order = await logged(store(req), "reduce", ref.account, t.id, { qty }, () =>
        closeAtMarket(venue, ref.symbol, ref.positionSide, qty, `${ref.tag}-r${Date.now().toString(36)}`),
      );
      const nextRef: TerminalRef = {
        ...ref,
        closeOrderIds: [...(ref.closeOrderIds ?? []), order.orderId],
        moves: [...(ref.moves ?? []), moveAt(t, ref, "reduce", pos.markPrice, { qty: Number(qty) })],
      };
      const stamped = (await s.updateTrade(t.id, { terminal: formatTerminalRef(nextRef) } as any)) ?? t;
      res.json({ trade: await reconcileOne(s, stamped, { venue, acct }), order });
    }),
  );

  /** More on: at market, or resting at a price. The fill lands in the ledger as an add. */
  app.post(
    "/api/terminal/trades/:id/add",
    wrap(async (req, res) => {
      const body = z.object({ qty: z.number().positive(), price: z.number().positive().nullable().optional() }).parse(req.body);
      const s = store(req);
      const t = await s.getTrade(Number(req.params.id));
      if (!t) throw httpError(404, "Trade not found");
      const ref = refOf(t);
      if (t.status !== "open") throw httpError(400, "Only an open position can be added to.");
      const { venue, acct } = await arm(store(req), ref.account);
      const rules = await rulesFor(venue.env, ref.symbol);
      const qty = fmtQty(body.qty, rules);
      if (Number(qty) <= 0) throw httpError(400, `That rounds to nothing at ${ref.symbol}'s step.`);
      const price = body.price != null ? fmtPrice(body.price, rules) : null;
      if (MAX_NOTIONAL > 0 && Number(qty) * (body.price ?? t.entryPrice) > MAX_NOTIONAL)
        throw httpError(400, `That add is over the terminal's ceiling of $${MAX_NOTIONAL} of notional.`);
      const order = await logged(store(req), "add", ref.account, t.id, { qty, price }, () =>
        addToPosition(venue, ref.symbol, ref.positionSide, qty, price, `${ref.tag}-a${Date.now().toString(36)}`),
      );
      const nextRef: TerminalRef = {
        ...ref,
        addOrderIds: [...(ref.addOrderIds ?? []), order.orderId],
        moves: [...(ref.moves ?? []), moveAt(t, ref, "add", await markOf(venue, ref), { qty: Number(qty), price: price != null ? Number(price) : null })],
      };
      const stamped = (await s.updateTrade(t.id, { terminal: formatTerminalRef(nextRef) } as any)) ?? t;
      res.json({ trade: await reconcileOne(s, stamped, { venue, acct }), order });
    }),
  );

  /** A resting entry moved: the old limit off, a new one on at the price, the plan's entry with it. */
  app.post(
    "/api/terminal/trades/:id/entry",
    wrap(async (req, res) => {
      const { price } = priceSchema.parse(req.body);
      const s = store(req);
      const t = await s.getTrade(Number(req.params.id));
      if (!t) throw httpError(404, "Trade not found");
      const ref = refOf(t);
      if (t.status !== "pending") throw httpError(400, "Only a resting entry can be moved.");
      const { venue, acct } = await arm(store(req), ref.account);
      const rules = await rulesFor(venue.env, ref.symbol);
      const current = ref.entryOrderId != null ? await orderById(venue, ref.symbol, ref.entryOrderId) : null;
      // Filled in the meantime: the ordinary read-back opens it, and there is nothing to move.
      if (current && current.executedQty > 0) return res.json({ trade: await reconcileOne(s, t, { venue, acct }), order: null });
      const next = await logged(store(req), "move-entry", ref.account, t.id, { price }, async () => {
        if (ref.entryOrderId != null) await cancelOrder(venue, ref.symbol, ref.entryOrderId);
        return placeOrder(venue, {
          symbol: ref.symbol,
          positionSide: ref.positionSide,
          side: ref.positionSide === "LONG" ? "BUY" : "SELL",
          type: "LIMIT",
          timeInForce: "GTC",
          quantity: fmtQty(ref.qty, rules),
          price: fmtPrice(price, rules),
          newClientOrderId: `${ref.tag}-e${Date.now().toString(36)}`,
        });
      });
      const to = Number(next.price ?? price);
      const stop = ref.armOnFill ? Number(ref.armOnFill.stop.stopPrice) : (t.initialStop ?? null);
      const after = await s.updateTrade(t.id, {
        entryPrice: to,
        ...(stop != null ? { riskAmount: Math.abs(to - stop) * ref.qty } : {}),
        terminal: formatTerminalRef({
          ...ref,
          entryOrderId: next.orderId,
          moves: [...(ref.moves ?? []), { at: new Date().toISOString(), kind: "entry", from: t.entryPrice, to }],
        }),
      } as any);
      res.json({ trade: after, order: next });
    }),
  );

  /** The management read on one finished trade, now — again, if it was read before. */
  app.post(
    "/api/terminal/trades/:id/review",
    wrap(async (req, res) => {
      const s = store(req);
      const t = await s.getTrade(Number(req.params.id));
      if (!t) throw httpError(404, "Trade not found");
      if (t.status !== "closed") throw httpError(400, "A trade is reviewed once it is over.");
      if (!llm) throw httpError(503, "No model is configured on this server.");
      const ref = refOf(t);
      const watched = await watchPlan(s, t, ref).catch(() => ({ ref, patch: {} as Record<string, unknown> }));
      const reviewed = await reviewIfDue(s, t, watched.ref, true);
      if (!reviewed.review) throw httpError(502, "The model did not answer. The trade is unchanged.");
      const after = await s.updateTrade(t.id, { ...watched.patch, terminal: formatTerminalRef(reviewed) } as any);
      res.json({ trade: after, review: reviewed.review });
    }),
  );

  /** Every live terminal trade, read back from its venue. The terminal calls this while open. */
  app.post(
    "/api/terminal/reconcile",
    wrap(async (req, res) => {
      res.json({ checked: await reconcileAll(store(req), req.userId!) });
    }),
  );
}
