/**
 * Tilt: the trades that should not have been taken, and the meter that says
 * when the next one is coming.
 *
 * A tilt trade is a verdict on the entry, never on the outcome. It stays in
 * the journal — the day happened — and stays out of the plan book, so every
 * headline number runs on the trades that were the plan. The point is not
 * to hide the damage; the tilt book is one toggle away, and the cost of it
 * is reported on its own. The point is that ten in-and-out trades taken on
 * somebody else's rhythm must not become the sample the plan is judged by.
 *
 * The meter is the other half. Marking a trade tilt afterwards is honest and
 * late. The meter reads the day as it is being logged and fills a segment
 * for each sign of it: a trade marked tilt, a third loss in a row, the daily
 * stop. At three it turns the entry form strict — the next trade is tilt
 * unless you argue it back in. At five it locks: go take a walk, and for the
 * length of the walk nothing logs as a plan trade. The journal still takes
 * the trade, as tilt, because a trade that was made is a fact; what it will
 * not take is the trade into the numbers.
 *
 * Everything here is a pure function of the log and the clock, so the form,
 * the card and the tests all read the same rules.
 */
import type { TradeWithTags, TradingStyle } from "./schema";
import { computeMetrics, DAILY_LOSS_STOP, LOSS_STREAK_LIMIT } from "./metrics";
import { inSessionWindow, windowLabel } from "./session";

/** The bar has five segments. */
export const TILT_SEGMENTS = 5;
/** Three filled: the form is strict, the next entry is tilt unless argued back. */
export const TILT_STRICT = 3;
/** Five filled: locked. Go take a walk. */
export const TILT_LOCK = 5;
/** How long the walk is. The lock holds at least this long past the last sign. */
export const WALK_MINUTES = 30;
/** Back into the same symbol this soon after losing on it is a re-entry. */
export const REENTRY_MINUTES = 15;

const MINUTE = 60_000;

export const isTilt = (t: { tilt?: boolean | null }) => t.tilt === true;
/** The trades that were the plan. Every headline number runs on these. */
export const planBook = <T extends { tilt?: boolean | null }>(trades: T[]) =>
  trades.filter((t) => !isTilt(t));
export const tiltBook = <T extends { tilt?: boolean | null }>(trades: T[]) =>
  trades.filter(isTilt);

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);
const sameLocalDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const endOfLocalDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();

/** Entries made on `day`, in the order they were made. Cancelled orders are not trades taken. */
export function entriesOn(trades: TradeWithTags[], day: Date): TradeWithTags[] {
  return trades
    .filter((t) => t.status !== "cancelled" && sameLocalDay(new Date(t.entryTime), day))
    .slice()
    .sort((a, b) => a.entryTime.localeCompare(b.entryTime));
}

/** Trades closed on `day`, in the order they closed. */
export function closesOn(trades: TradeWithTags[], day: Date): TradeWithTags[] {
  return trades
    .filter((t) => t.status === "closed" && t.exitTime && sameLocalDay(new Date(t.exitTime), day))
    .slice()
    .sort((a, b) => a.exitTime!.localeCompare(b.exitTime!));
}

const pnlOf = (t: TradeWithTags) => computeMetrics(t).actualPnL ?? 0;

/** Trailing losses, newest first, on a list already in close order. */
export function trailingLosses(closes: TradeWithTags[]): number {
  let n = 0;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (pnlOf(closes[i]) < 0) n++;
    else break;
  }
  return n;
}

/* ------------------------------ signals ------------------------------ */

export type TiltSignal =
  | { kind: "over-cap"; count: number; cap: number }
  | { kind: "reentry"; symbol: string; minutesAgo: number }
  | { kind: "outside-window"; window: string }
  | { kind: "loss-streak"; streak: number }
  | { kind: "daily-stop"; pnl: number };

export const SIGNAL_LABELS: Record<TiltSignal["kind"], string> = {
  "over-cap": "over this book's daily cap",
  reentry: "back into a symbol minutes after losing on it",
  "outside-window": "outside the session window",
  "loss-streak": "after a losing streak",
  "daily-stop": "after the daily stop",
};

export function signalSentence(s: TiltSignal): string {
  switch (s.kind) {
    case "over-cap":
      return `Trade ${s.count} of a book that allows ${s.cap} a day.`;
    case "reentry":
      return `Back into ${s.symbol} ${s.minutesAgo} min after losing on it.`;
    case "outside-window":
      return `Outside the session window (${s.window}).`;
    case "loss-streak":
      return `${s.streak} losses in a row today.`;
    case "daily-stop":
      return `The daily stop is hit.`;
  }
}

/**
 * What is wrong with taking `candidate` now, given the day so far.
 *
 * Read at logging time, before the trade exists: the log is everything
 * else, and the candidate is the symbol, the book and the moment. Each
 * signal is one plain sentence the form can show; none of them is a rule
 * on its own — the meter decides how loud they are.
 */
export function tiltSignals(
  candidate: { symbol: string; styleId: number | null; entryTime: Date },
  trades: TradeWithTags[],
  style: TradingStyle | null | undefined,
): TiltSignal[] {
  const out: TiltSignal[] = [];
  const at = candidate.entryTime.getTime();
  const before = (t: TradeWithTags) => ms(t.entryTime) <= at;

  if (style?.maxTradesPerDay != null) {
    const taken = entriesOn(trades, candidate.entryTime).filter(
      (t) => t.styleId === candidate.styleId && before(t),
    ).length;
    if (taken + 1 > style.maxTradesPerDay) {
      out.push({ kind: "over-cap", count: taken + 1, cap: style.maxTradesPerDay });
    }
  }

  const symbol = candidate.symbol.trim().toUpperCase();
  const lastOnSymbol = trades
    .filter(
      (t) =>
        t.status === "closed" &&
        t.exitTime &&
        t.symbol.toUpperCase() === symbol &&
        ms(t.exitTime) <= at &&
        at - ms(t.exitTime) <= REENTRY_MINUTES * MINUTE,
    )
    .sort((a, b) => b.exitTime!.localeCompare(a.exitTime!))[0];
  if (lastOnSymbol && pnlOf(lastOnSymbol) < 0) {
    out.push({
      kind: "reentry",
      symbol: lastOnSymbol.symbol,
      minutesAgo: Math.max(0, Math.round((at - ms(lastOnSymbol.exitTime)) / MINUTE)),
    });
  }

  if (style && inSessionWindow(candidate.entryTime, style.sessionStart, style.sessionEnd) === false) {
    out.push({ kind: "outside-window", window: windowLabel(style.sessionStart, style.sessionEnd) ?? "" });
  }

  const closes = closesOn(trades, candidate.entryTime).filter((t) => ms(t.exitTime) <= at);
  const streak = trailingLosses(closes);
  if (streak >= LOSS_STREAK_LIMIT) out.push({ kind: "loss-streak", streak });

  const pnl = closes.reduce((s, t) => s + pnlOf(t), 0);
  if (pnl <= -DAILY_LOSS_STOP) out.push({ kind: "daily-stop", pnl });

  return out;
}

/* ------------------------------- meter ------------------------------- */

export type TiltState = "calm" | "warm" | "strict" | "locked";

export interface TiltReason {
  kind: "tilt-trade" | "loss-streak" | "daily-stop";
  /** Segments this reason fills. */
  segments: number;
  label: string;
}

export interface TiltMeter {
  /** Entries made today. */
  tradesToday: number;
  /** Of those, marked tilt. */
  tiltToday: number;
  /** Trailing losses among today's closes. */
  lossStreak: number;
  pnlToday: number;
  /** Segments lit, 0..TILT_SEGMENTS. */
  filled: number;
  reasons: TiltReason[];
  state: TiltState;
  /**
   * When the walk ends: WALK_MINUTES past the last sign, or the end of the
   * day when the daily stop is what locked it. Null unless locked.
   */
  walkEndsAt: number | null;
  /**
   * Changes whenever a new sign lands after a lock, so an acknowledgement
   * given for one walk does not cover the next. Null unless locked.
   */
  lockKey: string | null;
}

/**
 * The day, read as a gauge.
 *
 * One segment per tilt trade entered today, one more for a losing streak
 * at the guard's limit, and all of them for the daily stop — a day that has
 * hit its stop is over, whatever else it says. Capped at the bar.
 */
export function tiltMeter(trades: TradeWithTags[], now: Date = new Date()): TiltMeter {
  const entries = entriesOn(trades, now);
  const closes = closesOn(trades, now);
  const tilts = entries.filter(isTilt);
  const lossStreak = trailingLosses(closes);
  const pnlToday = closes.reduce((s, t) => s + pnlOf(t), 0);
  const stopHit = pnlToday <= -DAILY_LOSS_STOP;

  const reasons: TiltReason[] = [];
  if (tilts.length) {
    reasons.push({
      kind: "tilt-trade",
      segments: tilts.length,
      label: `${tilts.length} tilt ${tilts.length === 1 ? "trade" : "trades"}`,
    });
  }
  if (lossStreak >= LOSS_STREAK_LIMIT) {
    reasons.push({ kind: "loss-streak", segments: 1, label: `${lossStreak} losses in a row` });
  }
  if (stopHit) {
    reasons.push({ kind: "daily-stop", segments: TILT_SEGMENTS, label: "daily stop hit" });
  }
  const filled = Math.min(TILT_SEGMENTS, reasons.reduce((n, r) => n + r.segments, 0));

  const state: TiltState =
    filled >= TILT_LOCK ? "locked" : filled >= TILT_STRICT ? "strict" : filled > 0 ? "warm" : "calm";

  let walkEndsAt: number | null = null;
  let lockKey: string | null = null;
  if (state === "locked") {
    // The last sign: the newest tilt entry or the newest loss, whichever is later.
    const lastTilt = tilts.length ? ms(tilts[tilts.length - 1].entryTime) : -Infinity;
    const lastLoss = lossStreak > 0 ? ms(closes[closes.length - 1].exitTime) : -Infinity;
    const lastSign = Math.max(lastTilt, lastLoss);
    walkEndsAt = stopHit
      ? endOfLocalDay(now)
      : (Number.isFinite(lastSign) ? lastSign : now.getTime()) + WALK_MINUTES * MINUTE;
    lockKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}:${filled}:${Number.isFinite(lastSign) ? lastSign : 0}`;
  }

  return {
    tradesToday: entries.length,
    tiltToday: tilts.length,
    lossStreak,
    pnlToday,
    filled,
    reasons,
    state,
    walkEndsAt,
    lockKey,
  };
}

/**
 * Whether the form refuses a plan trade right now. Locked until the walk is
 * over AND it has been acknowledged — a walk is not something the clock
 * takes for you.
 */
export function tiltLocked(m: TiltMeter, acked: ReadonlySet<string>, now: Date = new Date()): boolean {
  if (m.state !== "locked" || m.walkEndsAt == null || m.lockKey == null) return false;
  return now.getTime() < m.walkEndsAt || !acked.has(m.lockKey);
}

/* -------------------------------- cost -------------------------------- */

export interface BookTotals {
  count: number;
  /** Net of fees and funding, every closed trade. */
  pnl: number;
  /** Sum of R over the trades that have one. */
  r: number;
  measured: number;
  wins: number;
}

export function bookTotals(closed: TradeWithTags[]): BookTotals {
  const out: BookTotals = { count: 0, pnl: 0, r: 0, measured: 0, wins: 0 };
  for (const t of closed) {
    if (t.status !== "closed") continue;
    const m = computeMetrics(t);
    out.count++;
    out.pnl += m.actualPnL ?? 0;
    if ((m.actualPnL ?? 0) > 0) out.wins++;
    if (m.actualR != null) {
      out.r += m.actualR;
      out.measured++;
    }
  }
  return out;
}

export interface TiltCost {
  plan: BookTotals;
  tilt: BookTotals;
}

/** What the plan made and what tilt cost, over the same trades. */
export function tiltCost(trades: TradeWithTags[]): TiltCost {
  const closed = trades.filter((t) => t.status === "closed");
  return { plan: bookTotals(planBook(closed)), tilt: bookTotals(tiltBook(closed)) };
}

/** Tilt trades grouped by the hour of day they were entered (local). */
export function tiltByHour(trades: TradeWithTags[]): { hour: number; count: number; pnl: number }[] {
  const by = new Map<number, { hour: number; count: number; pnl: number }>();
  for (const t of tiltBook(trades)) {
    if (t.status === "cancelled") continue;
    const h = new Date(t.entryTime).getHours();
    const row = by.get(h) ?? { hour: h, count: 0, pnl: 0 };
    row.count++;
    if (t.status === "closed") row.pnl += pnlOf(t);
    by.set(h, row);
  }
  return Array.from(by.values()).sort((a, b) => a.hour - b.hour);
}

/** Tilt trades grouped by whose idea it was. An empty source is your own. */
export function tiltBySource(trades: TradeWithTags[]): { source: string; count: number; pnl: number }[] {
  const by = new Map<string, { source: string; count: number; pnl: number }>();
  for (const t of tiltBook(trades)) {
    if (t.status === "cancelled") continue;
    const key = t.source?.trim() || "";
    const row = by.get(key.toLowerCase()) ?? { source: key, count: 0, pnl: 0 };
    row.count++;
    if (t.status === "closed") row.pnl += pnlOf(t);
    by.set(key.toLowerCase(), row);
  }
  return Array.from(by.values()).sort((a, b) => b.count - a.count);
}

/* ----------------------------- from here ----------------------------- */

/**
 * "Everything after this one was tilt": the trade and every later entry on
 * the same day that is not already marked. The ids to flip.
 */
export function tiltFromHere(trades: TradeWithTags[], id: number): number[] {
  const from = trades.find((t) => t.id === id);
  if (!from) return [];
  const day = new Date(from.entryTime);
  return entriesOn(trades, day)
    .filter((t) => t.entryTime >= from.entryTime && !isTilt(t))
    .map((t) => t.id);
}
