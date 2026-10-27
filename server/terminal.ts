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
import { storageFor, terminalUsers, type DatabaseStorage } from "./storage";
import { open } from "./secrets";
import { futuresBase, signedCall, type BinanceEnv, type Creds } from "./binance-account";
import { fetchCandles, type Interval } from "./binance";
import {
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
  bracketAt,
  formatTerminalRef,
  fmtQty,
  ordersForPlan,
  parseTerminalRef,
  partialNote,
  reconcilePatch,
  sizePlan,
  MAX_TARGETS,
  type TerminalPlan,
  type TerminalRef,
  type VenueSnapshot,
} from "@shared/terminal";
import { addStopMove, currentStop, formatStopMoves } from "@shared/stops";
import { USD_COMMISSION } from "@shared/binance-account";
import type { AccountSettings, TradeWithTags } from "@shared/schema";

const TERMINAL_EMAILS = (process.env.TERMINAL_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

/** A ceiling on one order's notional, in dollars. Unset means none. */
const MAX_NOTIONAL = Number(process.env.TERMINAL_MAX_NOTIONAL_USD ?? "0") || 0;

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
async function reconcileOne(s: DatabaseStorage, t: TradeWithTags, armed: Armed): Promise<TradeWithTags> {
  const ref = refOf(t);
  const v = armed.venue;
  const entry = ref.entryOrderId != null ? await orderById(v, ref.symbol, ref.entryOrderId) : null;
  const since = new Date(t.entryTime).getTime() - 5 * 60_000;
  const mine = new Set([ref.entryOrderId, ref.stopOrderId, ...ref.targetOrderIds, ...(ref.closeOrderIds ?? [])].filter((x): x is number => x != null));
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
    } else if (/TRIGGERED|FILLED/.test(a.status)) {
      fired.push({ algoId: id, side: a.side, at: a.updateTime });
    }
  }
  const rows = await fillsSince(v, ref.symbol, since);
  const closeSide = ref.positionSide === "LONG" ? "SELL" : "BUY";
  const fills = rows
    .filter((r) => {
      if (mine.has(r.orderId)) return true;
      // A fired bracket the venue did not name the order of: its fills are
      // the closing-side fills from the moment it fired.
      const f = fired.find((x) => x.side === closeSide && r.side === closeSide && r.time >= x.at - 5_000);
      if (f && (r.positionSide === ref.positionSide || r.positionSide === "BOTH")) {
        alias.set(r.orderId, f.algoId);
        return true;
      }
      return false;
    })
    .map((r) => ({
      tid: r.id,
      orderId: alias.get(r.orderId) ?? r.orderId,
      price: r.price,
      qty: r.qty,
      time: r.time,
      commission: r.commission,
      commissionUsd: USD_COMMISSION.has(r.commissionAsset),
      realizedPnl: r.realizedPnl,
    }));
  const pos = (await positions(v)).find((p) => p.symbol === ref.symbol && p.positionSide === ref.positionSide);
  const resting = await openOrders(v, ref.symbol);
  const snap: VenueSnapshot = {
    entry: entry ? { status: entry.status, avgPrice: entry.avgPrice, executedQty: entry.executedQty, updateTime: entry.updateTime } : null,
    fills,
    positionAmt: pos?.amt ?? 0,
    openOrderIds: resting.map((o) => o.orderId),
  };
  const { patch: read, partials } = reconcilePatch(t, ref, snap);
  const patch = read ?? {};
  // A target that took its share while the rest stayed on: a partial in the
  // ledger, once, by the venue's fill id.
  const logged = new Set((t.fills ?? []).map((f) => f.note ?? ""));
  for (const f of partials) {
    if (logged.has(partialNote(f.tid))) continue;
    await s.addFill(t.id, { kind: "partial", price: f.price, size: f.qty, time: new Date(f.time).toISOString(), note: partialNote(f.tid) });
  }
  const stopResting = ref.stopOrderId != null && snap.openOrderIds.includes(ref.stopOrderId);
  const nowOpen = (patch.status ?? t.status) === "open";
  const nextRef: TerminalRef = { ...ref, unprotected: nowOpen && !stopResting, checkedAt: new Date().toISOString() };
  const changed = Object.keys(patch).length > 0 || partials.length > 0 || formatTerminalRef(nextRef) !== formatTerminalRef({ ...ref, checkedAt: nextRef.checkedAt });
  if (!changed && ref.checkedAt && Date.now() - new Date(ref.checkedAt).getTime() < 60_000) return t;
  const after = await s.updateTrade(t.id, { ...patch, terminal: formatTerminalRef(nextRef) } as any);
  return after ?? t;
}

/** Every live terminal trade of one person, read back. What the page polls and the watch runs. */
async function reconcileAll(s: DatabaseStorage): Promise<{ id: number; status: string; error?: string }[]> {
  const trades = await s.listTerminalTrades();
  const armedBy = new Map<string, Armed>();
  const out: { id: number; status: string; error?: string }[] = [];
  for (const t of trades) {
    if (t.status === "closed") continue;
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
export function startTerminalWatch(intervalMs = 20_000): void {
  if (TERMINAL_EMAILS.length === 0) return;
  const tick = async () => {
    if (watching) return;
    watching = true;
    try {
      for (const userId of await terminalUsers()) {
        const s = storageFor(userId);
        const out = await reconcileAll(s).catch((err) => {
          console.error("[terminal] watch:", said(err));
          return [] as { id: number; status: string; error?: string }[];
        });
        for (const o of out) if (o.error) console.error(`[terminal] watch trade #${o.id}: ${o.error}`);
      }
    } finally {
      watching = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
}

/* ------------------------------ the routes ------------------------------ */

export function registerTerminalRoutes(app: Express): void {
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
      const placed = await logged(store(req), "send", account, null, orders, () => placePlan(venue, orders));

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
        unprotected: !placed.stop,
        closeOrderIds: [],
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
      res.status(201).json({ trade, placed: ref, refused: placed.refused, sized });
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
      const next = await logged(store(req), "move-stop", ref.account, t.id, { price }, async () => {
        if (ref.stopOrderId != null) await cancelBracket(venue, ref.symbol, ref.stopOrderId);
        return placeOrder(venue, bracketAt("stop", price, rules, side, `${ref.tag}-s${Date.now().toString(36)}`));
      });
      const at = new Date().toISOString();
      const to = Number(next.stopPrice ?? price);
      const moves = addStopMove(t.stopMoves, to, at, "terminal");
      const after = await s.updateTrade(t.id, {
        stopMoves: formatStopMoves(moves),
        terminal: formatTerminalRef({
          ...ref,
          stopOrderId: next.orderId,
          unprotected: false,
          moves: [...(ref.moves ?? []), { at, kind: "stop", from: currentStop(t), to }],
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
          moves: [...(ref.moves ?? []), { at: new Date().toISOString(), kind: "target", from: lastTarget, to }],
        }),
      } as any);
      res.json({ trade: after, order: next });
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
      if (pos && Math.abs(pos.amt) > 0) {
        closeOrder = await logged(store(req), "close", ref.account, t.id, { qty: Math.abs(pos.amt) }, () =>
          closeAtMarket(venue, ref.symbol, ref.positionSide, fmtQty(Math.abs(pos.amt), rules), `${ref.tag}-x${Date.now().toString(36)}`),
        );
      }
      await logged(store(req), "cancel-brackets", ref.account, t.id, {}, async () => {
        for (const id of [ref.stopOrderId, ...ref.targetOrderIds]) if (id != null) await cancelBracket(venue, ref.symbol, id);
        return { cancelled: true };
      });
      const nextRef: TerminalRef = { ...ref, closeOrderIds: [...(ref.closeOrderIds ?? []), ...(closeOrder ? [closeOrder.orderId] : [])] };
      const stamped = (await s.updateTrade(t.id, { terminal: formatTerminalRef(nextRef) } as any)) ?? t;
      res.json({ trade: await reconcileOne(store(req), stamped, { venue, acct }) });
    }),
  );

  /** Every live terminal trade, read back from its venue. The terminal calls this while open. */
  app.post(
    "/api/terminal/reconcile",
    wrap(async (req, res) => {
      res.json({ checked: await reconcileAll(store(req)) });
    }),
  );
}
