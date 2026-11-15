/**
 * The owner's chat: a Claude model of their choosing, with read-only tools
 * over what the site already knows — the screener's latest run, the open
 * positions, the journal's trades and their statistics, the calendar.
 *
 * The model is never handed the data up front. It asks for what a question
 * needs through the tools below, each of which answers with the same
 * numbers the pages show, so an answer can be checked against the page it
 * came from. Nothing here places, changes or closes a trade: every tool
 * reads.
 *
 * One request is one turn: the question goes in, the model calls tools as
 * often as it needs (a few rounds at most), and the answer streams back as
 * server-sent events. A finished turn is written to the database whole —
 * the question, every tool call and result, the answer, and the model's own
 * thinking blocks exactly as they came — because the next request has to
 * send that history back unchanged. A turn that fails or is stopped writes
 * nothing, so a conversation is never left half-said.
 *
 * The system prompt and the tool list are fixed text, and the time is put
 * in the question rather than the prompt, so the cached prefix survives
 * from one turn to the next.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { chatStore, calendarStore, storageFor } from "./storage";
import { aggregate, closedTrades, computeMetrics } from "@shared/metrics";
import { parseTerminalRef, rAt } from "@shared/terminal";
import { splitHlAsset } from "@shared/hyperliquid";
import { cvdFor } from "@shared/flow";
import { sectorTable, TIMEFRAMES, type ScreenerRow, type Timeframe } from "@shared/screener";
import { sectorOf } from "@shared/sectors";
import type { TradeWithTags } from "@shared/schema";

import Beta = Anthropic.Beta;

/* ------------------------------- the models ------------------------------- */

/** The models offered, best first. All take adaptive thinking and an effort level, which is what the request sends. */
export const CHAT_MODELS = [
  { id: "claude-opus-5-5", label: "Opus 5.5", note: "The default: strong and quick" },
  { id: "claude-fable-5-2", label: "Fable 5.2", note: "The most capable; slower, and costs the most" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", note: "Fast and cheaper" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", note: "The fastest and cheapest" },
] as const;
export const DEFAULT_CHAT_MODEL = "claude-opus-5-5";
export const CHAT_EFFORTS = ["low", "medium", "high"] as const;
export type ChatEffort = (typeof CHAT_EFFORTS)[number];

/**
 * Models whose safety classifiers can decline a request, and for which the
 * API can re-run a declined one on another model inside the same call. With
 * it off a declined request simply stops.
 */
const WITH_FALLBACK = new Set(["claude-opus-5-5", "claude-fable-5-2", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** Set when the API refused the fallback parameter itself: it is then left off for the life of the process. */
let fallbackRefused = false;

let client: Anthropic | undefined;
const anthropic = (): Anthropic => (client ??= new Anthropic());
export const chatEnabled = (): boolean => !!process.env.ANTHROPIC_API_KEY;

const MODELS_TTL_MS = 60 * 60_000;
let modelsCache: { at: number; ids: Set<string> } | null = null;

/** The offered models this key can actually use: the list above, narrowed by what the API lists. The whole list when it cannot be asked. */
export async function availableModels(): Promise<{ id: string; label: string; note: string }[]> {
  const all = CHAT_MODELS.map((m) => ({ ...m }));
  if (!chatEnabled()) return all;
  if (!modelsCache || Date.now() - modelsCache.at > MODELS_TTL_MS) {
    try {
      const ids = new Set<string>();
      for await (const m of anthropic().models.list()) ids.add(m.id);
      modelsCache = { at: Date.now(), ids };
    } catch {
      return all;
    }
  }
  const mine = all.filter((m) => modelsCache!.ids.has(m.id));
  return mine.length ? mine : all;
}

/* ------------------------------- the tools ------------------------------- */

const r = (x: number | null | undefined, d = 3) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));
const PRAGUE = "Europe/Prague";
const pragueParts = (iso: string) => {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: PRAGUE, weekday: "short", hour: "2-digit", hour12: false, year: "numeric", month: "2-digit" }).formatToParts(d);
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  return { weekday: get("weekday"), hour: get("hour"), month: `${get("year")}-${get("month")}` };
};

/** A trade in a line: what was done and how it came out. Notes are cut short here; trade_detail has them whole. */
function tradeDigest(t: TradeWithTags, full = false) {
  const m = computeMetrics(t);
  const held = t.exitTime ? Math.round((new Date(t.exitTime).getTime() - new Date(t.entryTime).getTime()) / 60_000) : null;
  const cut = (s: string | null | undefined, n: number) => (s ? (full || s.length <= n ? s : `${s.slice(0, n)}…`) : null);
  return {
    id: t.id,
    symbol: t.symbol,
    direction: t.direction,
    status: t.status,
    account: t.account ?? null,
    entryTime: t.entryTime,
    exitTime: t.exitTime ?? null,
    heldMinutes: held,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice ?? null,
    size: t.size,
    sizeUnit: t.sizeUnit,
    stop: t.initialStop ?? null,
    target: t.initialTarget ?? null,
    riskDollars: r(m.riskDollars, 2),
    resultR: r(m.actualR, 2),
    pnl: r(m.actualPnL, 2),
    fees: r(m.fees, 2),
    bestReachR: r(m.mfeR, 2),
    worstDipR: r(m.maeR, 2),
    setAndForgetR: r(m.potentialR, 2),
    managementDeltaR: r(m.managementDeltaR, 2),
    managementDeltaDollars: r(m.managementDeltaDollars, 2),
    entryType: t.entryType ?? null,
    exitReason: t.exitReason ?? null,
    marks: [t.wellTraded && "traded well", t.tradedPoorly && "traded poorly", t.tilt && "tilt", t.scalp && "scalp"].filter(Boolean),
    adds: t.fills.filter((f) => f.kind === "add").length,
    takes: t.fills.filter((f) => f.kind === "partial").length,
    notes: cut(t.notes, 240),
    rationale: cut(t.rationale, 240),
    reviewNote: cut(t.reviewNote, 240),
  };
}

const inRange = (t: TradeWithTags, since?: string, until?: string) => {
  const at = t.exitTime ?? t.entryTime;
  if (since && at < since) return false;
  if (until && at > until) return false;
  return true;
};

const statsOf = (list: TradeWithTags[]) => {
  const a = aggregate(list);
  return {
    trades: a.count,
    wins: a.wins,
    losses: a.losses,
    winRate: r(a.winRate, 3),
    measuredInR: a.measured,
    expectancyR: r(a.expectancyR, 3),
    avgWinnerR: r(a.avgWinnerR, 2),
    avgLoserR: r(a.avgLoserR, 2),
    totalR: r(a.totalR, 2),
    totalPnl: r(a.totalPnL, 2),
    expectancyPnl: r(a.expectancyPnL, 2),
    profitFactor: r(a.profitFactor, 2),
    managementTotalR: r(a.totalDeltaR, 2),
    managementTotalDollars: r(a.totalDeltaDollars, 2),
  };
};

/** One screener row, compactly, on a timeframe: the same numbers the table shows. */
function rowBrief(x: ScreenerRow, tf: Timeframe) {
  const s = x.signals?.[tf];
  const c = cvdFor(x.flow, x.spot, tf);
  return {
    coin: x.coin,
    sector: sectorOf(x.coin),
    rs: r(x.tf[tf]?.rs),
    accel: x.tf[tf]?.accel ?? null,
    rvol: r(x.tf[tf]?.rvol, 2),
    rating: x.strength?.rating ?? null,
    ratingWeekAgo: x.strength?.ratingWas ?? null,
    alpha: r(x.price?.[tf]?.alpha),
    hold: r(x.strength?.capture, 2),
    score: s?.score ?? null,
    votes: s ? { momentum: s.momentum ?? 0, alpha: s.alpha ?? 0, resilience: s.resilience ?? 0, oi: s.oi, funding: s.funding, flow: s.cvd } : null,
    rsi: r(x.price?.[tf]?.rsi, 0),
    takerFlow: c ? { value: r(c.value), window: c.window, book: c.source } : null,
    oi24h: r(x.positioning?.oi1d),
    oiRead: x.positioning?.read ?? null,
    fundingAnnual: r(x.fundingAnnual, 2),
    volume24h: x.volume24h != null ? Math.round(x.volume24h) : null,
    largestAccountsNet: r(x.top?.net, 2),
    flags: [x.flags[tf]?.candidate && "candidate", x.flags[tf]?.movingFast && "moving fast", x.flags[tf]?.weakest && "weakest", x.leverageDriven && "leverage-driven", s?.divergence && `${s.divergence} divergence`].filter(Boolean),
  };
}

const tfEnum = z.enum(TIMEFRAMES as [Timeframe, ...Timeframe[]]);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "an ISO date, like 2026-11-01");

interface ChatTool<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  /** The same shape as `schema`, as the API takes it. */
  input_schema: Record<string, unknown>;
  run: (userId: number, input: z.infer<S>) => Promise<unknown>;
}
const tool = <S extends z.ZodTypeAny>(t: ChatTool<S>) => t;
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

export const CHAT_TOOLS = [
  tool({
    name: "screener_overview",
    description:
      "The relative-strength screener's latest run across the whole universe: when it ran, the breadth of the alt tape, BTC's own move, the sectors ranked, what stands out (anomalies), and the coins ranked by the reading asked for. Use it for any question about which coins are strong or weak, what is moving, or where to look for a setup. Each coin comes with RS against BTC on the timeframe, its 1–99 rating and where that stood a week ago, alpha (the move with BTC's beta taken out), hold (up capture minus down capture: positive is a coin that keeps its gains on BTC's red hours), the six-vote score, taker flow, open interest against price, funding and flags.",
    schema: z.object({
      timeframe: tfEnum.optional(),
      sort: z.enum(["rating", "score", "rs", "alpha", "hold", "flow", "volume"]).optional(),
      order: z.enum(["strongest", "weakest"]).optional(),
      filter: z.enum(["all", "candidates", "moving_fast", "weakest", "diverging"]).optional(),
      sector: z.string().max(24).optional(),
      limit: z.number().int().min(1).max(40).optional(),
    }),
    input_schema: obj({
      timeframe: { type: "string", enum: TIMEFRAMES, description: "The timeframe the readings are taken on. Default 1D." },
      sort: { type: "string", enum: ["rating", "score", "rs", "alpha", "hold", "flow", "volume"], description: "What to rank by. Default rating." },
      order: { type: "string", enum: ["strongest", "weakest"], description: "Top of the ranking or the bottom. Default strongest." },
      filter: { type: "string", enum: ["all", "candidates", "moving_fast", "weakest", "diverging"], description: "Only coins carrying this flag on the timeframe. Default all." },
      sector: { type: "string", description: "Only this sector's coins, by the name the sectors list uses (e.g. Meme, AI, L1, TradFi)." },
      limit: { type: "integer", minimum: 1, maximum: 40, description: "How many coins. Default 15." },
    }),
    run: async (_userId, input) => {
      const { latestScreenerRun } = await import("./screener");
      const run = await latestScreenerRun();
      if (!run) return { error: "The screener has not run yet. Refresh it on the Screener page." };
      const tf = input.timeframe ?? "1D";
      const key = input.sort ?? "rating";
      const val = (x: ScreenerRow): number | null =>
        key === "rating" ? (x.strength?.rating ?? null) : key === "score" ? (x.signals?.[tf]?.score ?? null) : key === "rs" ? x.tf[tf]?.rs : key === "alpha" ? (x.price?.[tf]?.alpha ?? null) : key === "hold" ? (x.strength?.capture ?? null) : key === "flow" ? (cvdFor(x.flow, x.spot, tf)?.value ?? null) : x.volume24h;
      const rows = run.rows.filter((x) => {
        if (x.error || val(x) == null) return false;
        if (input.sector && (sectorOf(x.coin) ?? "").toLowerCase() !== input.sector.toLowerCase()) return false;
        const f = x.flags[tf];
        if (input.filter === "candidates") return f?.candidate;
        if (input.filter === "moving_fast") return f?.movingFast;
        if (input.filter === "weakest") return f?.weakest;
        if (input.filter === "diverging") return x.signals?.[tf]?.divergence != null;
        return true;
      });
      rows.sort((a, b) => (input.order === "weakest" ? val(a)! - val(b)! : val(b)! - val(a)!));
      return {
        runAt: run.at,
        ageMinutes: Math.round((Date.now() - new Date(run.at).getTime()) / 60_000),
        barsTo: new Date(run.barsTo).toISOString(),
        universe: run.universe,
        breadth: r(run.breadth, 2),
        btc: { day: r(run.btc?.d1), week: r(run.btc?.w1) },
        takerFlow: { spot: run.spotStatus?.coins ? `read for ${run.spotStatus.coins} coins` : "not read this run", perp: run.flowStatus?.source === "relay" ? `read for ${run.flowStatus.coins} coins` : "not read this run (no relay connected)" },
        timeframe: tf,
        rankedBy: `${key}, ${input.order ?? "strongest"} first`,
        matching: rows.length,
        sectors: sectorTable(run.rows, tf, sectorOf).map((s) => ({ sector: s.sector, coins: s.coins, medianRs: r(s.rs), beatingBtc: r(s.breadth, 2), leader: s.leader })),
        anomalies: run.anomalies.filter((a) => a.severity >= 2).slice(0, 25).map((a) => ({ coin: a.coin, severity: a.severity, text: a.text })),
        coins: rows.slice(0, input.limit ?? 15).map((x) => rowBrief(x, tf)),
      };
    },
  }),
  tool({
    name: "screener_coin",
    description:
      "Everything the screener knows about up to five coins, on every timeframe at once: RS, acceleration, RSI, trend, alpha, efficiency, the score and its votes, divergences, beta and capture, taker flow on spot and perp, open interest and funding on Hyperliquid and Binance, the largest accounts' net position, where they would be liquidated, and the structure stop on each timeframe (the lowest low of the last candles: where a long is wrong). Works for any coin Hyperliquid lists, including ones outside the table; those are read from the venue now. Use it before suggesting a setup in a coin, or to explain why a coin is or is not strong.",
    schema: z.object({ coins: z.array(z.string().regex(/^[A-Za-z0-9:_-]{1,24}$/)).min(1).max(5) }),
    input_schema: obj({ coins: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" }, description: "Hyperliquid's names for the coins, e.g. [\"SOL\", \"kPEPE\", \"xyz:XYZ100\"]." } }, ["coins"]),
    run: async (_userId, input) => {
      const { scanCoin } = await import("./screener");
      const { coinDigest } = await import("./screener-ai");
      const out: unknown[] = [];
      for (const coin of input.coins) {
        try {
          const s = await scanCoin(coin);
          const row = s.row;
          const all = (f: (tf: Timeframe) => unknown) => Object.fromEntries(TIMEFRAMES.map((tf) => [tf, f(tf)]));
          out.push({
            ...coinDigest(row),
            source: s.source === "run" ? `the run at ${s.at}` : `read from the venue at ${s.at}; no Binance flow or largest-accounts read for a coin outside the run`,
            mark: row.mark,
            volume24h: row.volume24h != null ? Math.round(row.volume24h) : null,
            rsAllTimeframes: all((tf) => r(row.tf[tf]?.rs)),
            scoreAllTimeframes: all((tf) => row.signals?.[tf]?.score ?? null),
            alphaAllTimeframes: all((tf) => r(row.price?.[tf]?.alpha)),
            structureStop: all((tf) => (s.stops[tf]?.stop != null ? { stop: s.stops[tf].stop, distance: r(s.stops[tf].distance, 4) } : null)),
            atrPct: all((tf) => r(row.price?.[tf]?.atrPct, 4)),
            offHigh: all((tf) => r(row.price?.[tf]?.offHigh, 3)),
            liquidationBands: row.liq?.bands.filter((b) => Math.abs(b.at) <= 0.1).map((b) => ({ at: r(b.at, 2), price: Number(b.price.toPrecision(5)), usd: Math.round(b.usd) })) ?? null,
          });
        } catch (err: any) {
          out.push({ coin, error: String(err?.message ?? err).slice(0, 200) });
        }
      }
      return { coins: out };
    },
  }),
  tool({
    name: "screener_track_record",
    description: "Whether the screener's own flags have worked: what coins flagged as candidates, scored 4 or more, or rated 90 or more did against BTC one day, three days and a week after, over the last 30 days, with the weakest coins as a control. And how the AI read's own long, short and avoid calls did. Use it when asked how far to trust the screener, or which flag to lean on.",
    schema: z.object({}),
    input_schema: obj({}),
    run: async () => {
      const { flagTrackRecord } = await import("./screener");
      const { aiTrackRecord } = await import("./screener-ai");
      const [flags, ai] = await Promise.all([flagTrackRecord(), aiTrackRecord().catch(() => null)]);
      return {
        flags: flags.kinds.map((k) => ({ flag: k.label, logged: k.logged, afterDay: k.cells["24h"], afterThreeDays: k.cells["3d"], afterWeek: k.cells["1w"] })),
        note: "n is how many flagged coins could be priced at that horizon, beat how many of them beat BTC, avgRs the mean move against BTC. Small n proves nothing.",
        aiReadCalls: ai ? ai.summary : null,
      };
    },
  }),
  tool({
    name: "open_positions",
    description:
      "What is on right now: the journal's open trades (entry, size, the stop and targets resting now, the risk still on, how far the trade is in R at the mark), and what each watched Hyperliquid wallet actually holds on the venue (size, entry, mark, unrealised P&L, liquidation price, leverage). Use it for any question about current positions, exposure or risk.",
    schema: z.object({}),
    input_schema: obj({}),
    run: async (userId) => {
      const s = storageFor(userId);
      const [open, accounts] = await Promise.all([s.listOpenTrades(), s.listAccountSettings()]);
      const { fetchAllMids, fetchClearinghouseState } = await import("./hyperliquid");
      const wallets = accounts.filter((a) => a.wallet);
      // The books to ask: the venue's own, and any builder book an open trade is on.
      const books = Array.from(new Set(open.map((t) => splitHlAsset(parseTerminalRef(t.terminal)?.symbol ?? "").dex).filter((d): d is string => !!d)));
      const mids: Record<string, number> = {};
      const live: unknown[] = [];
      let liveError: string | null = null;
      try {
        for (const dex of [undefined, ...books]) Object.assign(mids, await fetchAllMids(dex).catch(() => ({})));
        for (const a of wallets) {
          const held = [...(await fetchClearinghouseState(a.wallet!)), ...(await Promise.all(books.map((d) => fetchClearinghouseState(a.wallet!, d).catch(() => [])))).flat()];
          for (const p of held) {
            const mark = mids[p.coin] ?? null;
            live.push({ account: a.name, coin: p.coin, side: p.szi > 0 ? "long" : "short", size: Math.abs(p.szi), entry: p.entryPx, mark, notional: mark != null ? Math.round(Math.abs(p.szi) * mark) : null, unrealizedPnl: r(p.unrealizedPnl, 2), liquidation: p.liquidationPx, leverage: p.leverage });
          }
        }
      } catch (err: any) {
        liveError = String(err?.message ?? err).slice(0, 200);
      }
      return {
        journal: open.map((t) => {
          const ref = parseTerminalRef(t.terminal);
          const mark = ref ? (mids[ref.symbol] ?? null) : null;
          const stopNow = ref?.seen?.stop ?? t.initialStop ?? null;
          return {
            ...tradeDigest(t),
            stopNow,
            targetsNow: ref?.seen?.targets ?? (t.initialTarget != null ? [t.initialTarget] : []),
            noStopResting: ref?.unprotected === true,
            mark,
            openR: r(rAt(mark, t.entryPrice, ref?.idea?.stop ?? t.initialStop, t.direction), 2),
            stopMoves: ref?.moves?.filter((m) => m.kind === "stop").length ?? 0,
          };
        }),
        onTheVenue: live,
        ...(liveError ? { venueError: liveError } : {}),
        ...(wallets.length === 0 ? { note: "No Hyperliquid wallet is watched, so only the journal's open trades are known." } : {}),
      };
    },
  }),
  tool({
    name: "trades",
    description: "The journal's trades, newest first, each with its result in R and in money, best reach and worst dip, how it was entered and exited, what management made or cost against leaving the plan alone, and the start of its notes. Use it to look at recent trading, a symbol's history, or to find trades worth a closer look with trade_detail.",
    schema: z.object({
      status: z.enum(["closed", "open", "all"]).optional(),
      symbol: z.string().max(24).optional(),
      since: isoDate.optional(),
      until: isoDate.optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    input_schema: obj({
      status: { type: "string", enum: ["closed", "open", "all"], description: "Default closed." },
      symbol: { type: "string", description: "Only this symbol, as the journal writes it (e.g. BTC, FARTCOIN, XYZ100)." },
      since: { type: "string", description: "Only trades that ended (or, when open, began) on or after this ISO date." },
      until: { type: "string", description: "Only trades up to this ISO date." },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 30." },
    }),
    run: async (userId, input) => {
      const all = await storageFor(userId).listTrades();
      const status = input.status ?? "closed";
      const kept = all
        .filter((t) => (status === "all" ? t.status !== "cancelled" : status === "open" ? t.status === "open" : t.status === "closed"))
        .filter((t) => !input.symbol || t.symbol.toLowerCase() === input.symbol.toLowerCase())
        .filter((t) => inRange(t, input.since, input.until))
        .sort((a, b) => (b.exitTime ?? b.entryTime).localeCompare(a.exitTime ?? a.entryTime));
      return { matching: kept.length, shown: Math.min(kept.length, input.limit ?? 30), trades: kept.slice(0, input.limit ?? 30).map((t) => tradeDigest(t)) };
    },
  }),
  tool({
    name: "trade_detail",
    description: "One trade in full, by its id: every field, the whole of its notes, rationale and review note, each add and take with price and time, and every stop move. Use it after trades or open_positions, when a trade needs reading closely.",
    schema: z.object({ id: z.number().int().positive() }),
    input_schema: obj({ id: { type: "integer", description: "The trade's id, from trades or open_positions." } }, ["id"]),
    run: async (userId, input) => {
      const t = await storageFor(userId).getTrade(input.id);
      if (!t) return { error: `No trade with id ${input.id}.` };
      const ref = parseTerminalRef(t.terminal);
      return {
        ...tradeDigest(t, true),
        fills: t.fills.map((f) => ({ kind: f.kind, price: f.price, size: f.size, time: f.time })),
        plan: ref?.idea ? { entry: ref.idea.entry, stop: ref.idea.stop, targets: ref.idea.targets, riskDollars: r(ref.idea.riskDollars, 2) } : null,
        moves: ref?.moves?.map((m) => ({ at: m.at, kind: m.kind, from: m.from, to: m.to, rAtTheTime: r(m.r, 2) })) ?? [],
        planOutcome: t.noManagementOutcome ?? null,
        grades: { entry: t.entryGrade ?? null, stop: t.stopGrade ?? null, exit: t.exitGrade ?? null },
      };
    },
  }),
  tool({
    name: "trading_stats",
    description: "The journal's statistics over closed trades in a period: count, win rate, expectancy and totals in R and in money, average winner and loser, profit factor, and what management made or cost. Optionally split by symbol, direction, how the trade was entered (limit or market), weekday, hour of entry, month, account or exit reason (times are Europe/Prague). Use it for any question about performance, edge, or what is and is not working.",
    schema: z.object({
      since: isoDate.optional(),
      until: isoDate.optional(),
      groupBy: z.enum(["symbol", "direction", "entryType", "weekday", "hour", "month", "account", "exitReason"]).optional(),
    }),
    input_schema: obj({
      since: { type: "string", description: "From this ISO date. Default: everything." },
      until: { type: "string", description: "To this ISO date." },
      groupBy: { type: "string", enum: ["symbol", "direction", "entryType", "weekday", "hour", "month", "account", "exitReason"], description: "Also split the period by this." },
    }),
    run: async (userId, input) => {
      const closed = closedTrades(await storageFor(userId).listTrades()).filter((t) => inRange(t, input.since, input.until));
      const out: Record<string, unknown> = { period: { since: input.since ?? "the beginning", until: input.until ?? "now" }, overall: statsOf(closed) };
      if (input.groupBy) {
        const keyOf = (t: TradeWithTags): string => {
          switch (input.groupBy) {
            case "symbol":
              return t.symbol;
            case "direction":
              return t.direction;
            case "entryType":
              return t.entryType ?? "not recorded";
            case "account":
              return t.account ?? "none";
            case "exitReason":
              return t.exitReason ?? "not recorded";
            case "weekday":
              return pragueParts(t.entryTime).weekday;
            case "hour":
              return `${pragueParts(t.entryTime).hour}:00`;
            default:
              return pragueParts(t.exitTime ?? t.entryTime).month;
          }
        };
        const groups = new Map<string, TradeWithTags[]>();
        for (const t of closed) groups.set(keyOf(t), [...(groups.get(keyOf(t)) ?? []), t]);
        out.groups = Array.from(groups, ([key, list]) => ({ [input.groupBy!]: key, ...statsOf(list) }))
          .sort((a, b) => (b.trades as number) - (a.trades as number))
          .slice(0, 40);
      }
      return out;
    },
  }),
  tool({
    name: "upcoming_events",
    description: "The US macro releases of high impact (CPI, NFP, FOMC, PPI…) and large earnings on the calendar in the next hours. Use it before suggesting a setup or when asked what is coming: a release inside a trade's horizon can run stops either way.",
    schema: z.object({ hours: z.number().int().min(1).max(168).optional() }),
    input_schema: obj({ hours: { type: "integer", minimum: 1, maximum: 168, description: "How far ahead to look. Default 48." } }),
    run: async (_userId, input) => {
      const from = new Date();
      const to = new Date(from.getTime() + (input.hours ?? 48) * 3600_000);
      const events = await calendarStore.between(from.toISOString(), to.toISOString());
      return { from: from.toISOString(), to: to.toISOString(), events: events.map((e) => ({ at: e.at, title: e.title, kind: e.kind, impact: e.impact, forecast: e.forecast, previous: e.previous })) };
    },
  }),
];

/** The tools as the API takes them. Inputs stream as they are written, so each is checked against its schema here before it runs. */
const API_TOOLS: Beta.BetaToolUnion[] = CHAT_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Beta.BetaTool.InputSchema, eager_input_streaming: true }));

/** A tool result too large to be worth the reading it costs is refused, and the model asked to narrow it. */
const RESULT_LIMIT = 150_000;

async function runTool(userId: number, name: string, input: unknown): Promise<{ content: string; ok: boolean }> {
  const t = CHAT_TOOLS.find((x) => x.name === name);
  if (!t) return { content: `No tool named ${name}.`, ok: false };
  const parsed = t.schema.safeParse(input ?? {});
  if (!parsed.success) return { content: `The input did not fit the tool: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ").slice(0, 400)}`, ok: false };
  try {
    const out = JSON.stringify(await (t.run as (u: number, i: unknown) => Promise<unknown>)(userId, parsed.data));
    if (out.length > RESULT_LIMIT) return { content: "The result is too large. Ask for less: a lower limit, a shorter period, or fewer coins.", ok: false };
    return { content: out, ok: true };
  } catch (err: any) {
    return { content: `The tool failed: ${String(err?.message ?? err).slice(0, 300)}`, ok: false };
  }
}

/* ------------------------------- the prompt ------------------------------- */

export const CHAT_SYSTEM = `You are the analyst inside Edgeline, a trading journal and relative-strength screener, talking with its owner: a discretionary trader of crypto perpetuals (and some stock and index markets) on Hyperliquid. They ask about the screener, their open positions, their past trades and statistics, and for setups.

You have read-only tools over the site's own data. Nothing you do can place, change or close a trade, and you should never suggest that you can.

How to work:
- Get the numbers before you answer. Anything about the market, a coin, positions or performance is answered from the tools, not from memory. Call several tools at once when a question needs more than one.
- Say when the data is old. The screener runs hourly while the server is awake; every screener answer carries the run's time and age. If a run is more than a couple of hours old, say so before leaning on it.
- Each message from the trader begins with the current time. Use it for "today", "this week" and for how old things are.
- Be direct and brief. Lead with the answer, then the few numbers that carry it. No disclaimers about financial advice, no restating the question, no padding. Use short lists or a small table when comparing coins or trades; plain sentences otherwise.
- Say what you do not know. If a reading is missing (no taker flow, no open-interest history, too few trades to mean anything), say that rather than reasoning around it. A statistic on a handful of trades is an anecdote; call it one.

Reading the screener:
- RS is the coin's move against BTC over the timeframe. On its own it rewards beta: a high-beta coin beats BTC on every green day. Prefer the readings that take that out: alpha (the move with beta × BTC's move removed), hold (up capture minus down capture: what the coin makes on BTC's green hours against what it gives back on the red), and the 1–99 rating with its change from a week ago (a coin climbing the ranks matters more than one already at the top).
- The score is six independent votes from −6 to +6: momentum, alpha, resilience, open interest against price, funding crowding, taker flow.
- Taker flow (CVD) is net taker buying as a share of volume. Spot buying is paid for in full and is the stronger kind; perp buying while spot sells is leverage.
- Open interest against price: up with price is new longs, down with price up is short covering, up with price down is new shorts.
- Top-decile funding with rising open interest is a crowded, leverage-driven move, and weighs against a long.
- A strong coin in a strong sector is a better read than a strong coin alone.

Suggesting a setup:
- Only from what the tools show, and only where several independent readings agree. Name the ones that agree and the ones that do not.
- Give it as: the coin and direction, why now (the readings), the trigger that would get you in, the invalidation (the structure stop on the timeframe, or the level that breaks the idea) with its distance in percent, and what would make you stand aside. Check upcoming_events for a release inside the trade's horizon.
- Look at the trader's open positions first: do not propose doubling an exposure they already carry without saying so.
- If nothing lines up, say so. No setup is a valid answer.

Reviewing the trader's own trading:
- Work from their numbers: results in R first, money second. R is the result over the risk taken; it needs a stop, so trades without one count in money only.
- "Management" is what the trader's actions during a trade (moving the stop, taking early, adding) made or cost against leaving the original plan alone. Positive is management that helped.
- Be honest about what the record shows, including where the trader is the problem. Tie every claim to trades or statistics you fetched.`;

/* ------------------------------- a turn ------------------------------- */

export type ChatEvent =
  | { t: "thread"; id: number; title: string }
  | { t: "text"; d: string }
  | { t: "thinking"; d: string }
  | { t: "tool"; name: string; input: unknown }
  | { t: "tool_done"; name: string; ok: boolean }
  | { t: "done"; model: string; usage: { input: number; output: number; cached: number }; note?: string }
  | { t: "error"; message: string };

export class ChatRefused extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const MAX_ROUNDS = 8;
/** Streaming, so the ceiling is room rather than a wait: thinking and the answer share it. */
const MAX_TOKENS = 64_000;

/** The time, said in the question: in the prompt it would change every turn and nothing before it could be cached. */
const nowLine = (d = new Date()) =>
  `Now: ${new Intl.DateTimeFormat("en-GB", { timeZone: PRAGUE, weekday: "short", year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d)} ${PRAGUE} (${d.toISOString().slice(0, 16)}Z).`;

const parseContent = (raw: string): Beta.BetaMessageParam["content"] => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

/** What an error from the API means to the person typing, most specific first. */
function saidOf(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "The server's Anthropic key was refused. Check ANTHROPIC_API_KEY.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This key may not use that model. Choose another.";
  if (err instanceof Anthropic.NotFoundError) return "That model is not available to this key. Choose another.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by Anthropic. Try again in a minute.";
  if (err instanceof Anthropic.BadRequestError) return `The request was refused: ${err.message.slice(0, 240)}`;
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach Anthropic. Try again.";
  if (err instanceof Anthropic.APIError) return `Anthropic answered with an error (${err.status ?? "no status"}). Try again.`;
  return String((err as any)?.message ?? err).slice(0, 240);
}

/**
 * One turn of a conversation. Emits events as the model thinks, calls tools
 * and writes; resolves once the turn is stored. A refusal to start (no key,
 * an unknown model or thread) throws ChatRefused before anything is sent;
 * a failure after that is an "error" event, and nothing is stored.
 */
export async function runChat(opts: {
  userId: number;
  threadId: number | null;
  model: string;
  effort: ChatEffort;
  text: string;
  emit: (e: ChatEvent) => void;
  signal: AbortSignal;
}): Promise<void> {
  const { userId, emit, signal } = opts;
  if (!chatEnabled()) throw new ChatRefused("The chat needs ANTHROPIC_API_KEY on the server.", 503);
  const text = opts.text.trim();
  if (!text) throw new ChatRefused("Nothing to send.");
  if (text.length > 20_000) throw new ChatRefused("That message is too long.");
  if (!(await availableModels()).some((m) => m.id === opts.model)) throw new ChatRefused("That model is not one of the choices.");

  let threadId = opts.threadId;
  const messages: Beta.BetaMessageParam[] = [];
  if (threadId != null) {
    const thread = await chatStore.thread(userId, threadId);
    if (!thread) throw new ChatRefused("That conversation no longer exists.", 404);
    for (const m of await chatStore.messages(threadId)) messages.push({ role: m.role as "user" | "assistant", content: parseContent(m.content) });
  }
  const title = text.replace(/\s+/g, " ").slice(0, 60);
  const question: Beta.BetaMessageParam = { role: "user", content: [{ type: "text", text: nowLine() }, { type: "text", text }] };
  messages.push(question);
  const fresh: Beta.BetaMessageParam[] = [question];
  const usage = { input: 0, output: 0, cached: 0 };
  let served = opts.model;
  let note: string | undefined;
  let wrote = false;

  try {
    for (let round = 0; ; round++) {
      const withFallback = WITH_FALLBACK.has(opts.model) && !fallbackRefused;
      const params = (fallback: boolean): Beta.MessageCreateParamsStreaming => ({
        model: opts.model,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: CHAT_SYSTEM }],
        // The reasoning is always on for these models; a summary of it is asked for so the wait has something to show.
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: opts.effort },
        tools: API_TOOLS,
        messages,
        // The prompt, the tools and the conversation so far are the same bytes next turn: cached up to the last message.
        cache_control: { type: "ephemeral" },
        ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
        stream: true,
      });
      const ask = async (fallback: boolean): Promise<Beta.BetaMessage> => {
        const stream = anthropic().beta.messages.stream(params(fallback), { signal });
        stream.on("text", (d) => {
          wrote = true;
          emit({ t: "text", d });
        });
        stream.on("thinking", (d) => emit({ t: "thinking", d }));
        return stream.finalMessage();
      };
      let message: Beta.BetaMessage;
      try {
        message = await ask(withFallback);
      } catch (err) {
        // The fallback parameter itself refused, before anything was written: asked again without it, and not sent again.
        if (withFallback && !wrote && err instanceof Anthropic.BadRequestError) {
          fallbackRefused = true;
          message = await ask(false);
        } else if (!(err instanceof Anthropic.APIError) && !signal.aborted && !wrote) {
          // Not the API's error: a tool input that arrived as unreadable JSON. The turn never completed, so it is asked once more.
          message = await ask(withFallback);
        } else throw err;
      }
      served = message.model;
      usage.input += (message.usage.input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0);
      usage.cached += message.usage.cache_read_input_tokens ?? 0;
      usage.output += message.usage.output_tokens ?? 0;

      if (message.stop_reason === "refusal") {
        emit({ t: "error", message: "The model declined to answer that. Rephrase it, or try another model." });
        return;
      }
      const calls = message.content.filter((b): b is Beta.BetaToolUseBlock => b.type === "tool_use");
      // A tool call cut off at the ceiling may parse as a valid, shorter input: never run on it.
      if (message.stop_reason === "max_tokens" && calls.length) {
        emit({ t: "error", message: "The answer ran out of room in the middle of a tool call. Ask again, or ask for less at once." });
        return;
      }
      const reply: Beta.BetaMessageParam = { role: "assistant", content: message.content };
      messages.push(reply);
      fresh.push(reply);
      if (message.stop_reason !== "tool_use" || calls.length === 0) {
        if (message.stop_reason === "max_tokens") note = "The answer ran out of room and was cut short.";
        break;
      }
      if (round + 1 >= MAX_ROUNDS) {
        emit({ t: "error", message: "The model kept asking for more data without answering. Ask again, more narrowly." });
        return;
      }
      // Every call of the round, together, and every result back in one message.
      const results = await Promise.all(
        calls.map(async (c): Promise<Beta.BetaToolResultBlockParam> => {
          emit({ t: "tool", name: c.name, input: c.input });
          const out = await runTool(userId, c.name, c.input);
          emit({ t: "tool_done", name: c.name, ok: out.ok });
          return { type: "tool_result", tool_use_id: c.id, content: out.content, ...(out.ok ? {} : { is_error: true }) };
        }),
      );
      const back: Beta.BetaMessageParam = { role: "user", content: results };
      messages.push(back);
      fresh.push(back);
      // A gap between what was written before the tools and what comes after them.
      if (wrote) emit({ t: "text", d: "\n\n" });
    }
  } catch (err) {
    // Stopped by the person: nothing to say, nothing stored.
    if (signal.aborted || err instanceof Anthropic.APIUserAbortError) return;
    emit({ t: "error", message: saidOf(err) });
    return;
  }

  if (threadId == null) {
    threadId = await chatStore.createThread(userId, title, opts.model);
    emit({ t: "thread", id: threadId, title });
  }
  await chatStore.append(
    threadId,
    opts.model,
    fresh.map((m, i) => ({ role: m.role, content: JSON.stringify(m.content), meta: i === fresh.length - 1 ? JSON.stringify({ model: served, usage, effort: opts.effort }) : null })),
  );
  emit({ t: "done", model: served, usage, ...(note ? { note } : {}) });
}

/* ------------------------------- a conversation, for the page ------------------------------- */

export interface ChatBubble {
  role: "user" | "assistant";
  text: string;
  /** The tools called on the way to this answer, in order. */
  tools: string[];
  at: string;
  model?: string;
  usage?: { input: number; output: number; cached: number };
}

/**
 * The stored messages as the page shows them: the question as typed, and
 * everything the model did until it stopped as one answer — its text, with
 * the tools it called. Tool results and thinking are the model's working
 * and stay out.
 */
export function bubblesOf(rows: { role: string; content: string; meta: string | null; at: string }[]): ChatBubble[] {
  const out: ChatBubble[] = [];
  for (const row of rows) {
    const content = parseContent(row.content);
    const blocks = typeof content === "string" ? [{ type: "text" as const, text: content }] : (content as any[]);
    if (row.role === "user") {
      // Tool results travel as user messages; they are not something the person said.
      if (blocks.some((b) => b?.type === "tool_result")) continue;
      const texts = blocks.filter((b) => b?.type === "text").map((b) => String(b.text));
      out.push({ role: "user", text: texts[texts.length - 1] ?? "", tools: [], at: row.at });
      continue;
    }
    let last = out[out.length - 1];
    if (!last || last.role !== "assistant") out.push((last = { role: "assistant", text: "", tools: [], at: row.at }));
    const text = blocks
      .filter((b) => b?.type === "text")
      .map((b) => String(b.text))
      .join("");
    if (text) last.text += (last.text ? "\n\n" : "") + text;
    for (const b of blocks) if (b?.type === "tool_use") last.tools.push(String(b.name));
    if (row.meta) {
      try {
        const meta = JSON.parse(row.meta);
        last.model = meta.model;
        last.usage = meta.usage;
      } catch {
        /* no meta */
      }
    }
  }
  return out;
}
