/**
 * One number for how well the trading was done, and the habit that is
 * holding it down.
 *
 * The scorecard grades the RESULT: edge, its steadiness, what was kept.
 * This grades the BEHAVIOUR, which is the part a trader can change by
 * Monday: was every trade the same size, were there too many of them, what
 * happened in the minutes after a loss, was there a plan, did a loss stay
 * the size it was meant to be, did managing the trade beat leaving it
 * alone, how often was a mistake tagged, was the trade looked at again.
 *
 * Each habit is scored 0–100 from the log alone, over a window of days, and
 * the score is their weighted average. The one taking the most off it is
 * named as the thing to fix, with the figure it was scored from, the trades behind it,
 * and one thing to do about it. The same window before this one is scored
 * too, so the number can be seen to move.
 *
 * Nothing here knows whether money was made. A month of losing trades taken
 * properly scores high; a lucky month of oversized revenge trades does not.
 * A habit with too few trades to judge is left out rather than guessed.
 */
import type { TradeWithTags } from "./schema";
import { computeMetrics, isSettled } from "./metrics";
import { isMissed } from "./missed";
import { dayKeyOfIso } from "./daily";
import { DEFAULT_GUARDRAILS, type GuardRails } from "./guardrails";

export const EDGE_SCORE_DAYS = [30, 90] as const;
/** Under this many trades in the window there is no score. */
export const EDGE_SCORE_MIN_TRADES = 10;
/** Under this many trades a habit can be judged on, it is left out. */
const MIN_PART = 5;

export type EdgePartId = "sizing" | "overtrading" | "after-loss" | "plan" | "losses" | "exits" | "mistakes" | "review";

export interface EdgePart {
  id: EdgePartId;
  label: string;
  /** What the habit is, in a line. */
  asks: string;
  /** Its share of the score. */
  weight: number;
  /** 0–100; null when there are too few trades to judge it on. */
  score: number | null;
  /** The figure the score came from, as a sentence. */
  detail: string;
  /** One thing to do about it. */
  tip: string;
  /** What the trades behind it made, in R, when that can be said. Negative is a cost. */
  r: number | null;
  /** The trades that pulled it down, newest first. */
  tradeIds: number[];
}

export interface EdgeScore {
  days: number;
  /** Trades entered in the window. */
  trades: number;
  /** 0–100; null when the window holds too few trades. */
  score: number | null;
  /** The score of the same number of days before these; null when it has none. */
  previous: number | null;
  parts: EdgePart[];
  /** The habit taking the most off the score: the one to work on. */
  weakest: EdgePart | null;
  /** A word for the score. */
  grade: string;
  /** One sentence: what to do next. */
  headline: string;
}

const DAY = 24 * 3600_000;
const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const median = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
/** `v` placed between `zero` (scores 0) and `full` (scores 100). */
const scale = (v: number, zero: number, full: number) => Math.round(Math.max(0, Math.min(1, (v - zero) / (full - zero))) * 100);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const signedR = (r: number) => `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(1)}R`;
const newestFirst = (ts: TradeWithTags[]) => ts.slice().sort((a, b) => b.entryTime.localeCompare(a.entryTime)).map((t) => t.id);

export function edgeGrade(score: number | null): string {
  if (score == null) return "Not yet";
  if (score >= 90) return "Excellent";
  if (score >= 75) return "Solid";
  if (score >= 60) return "Uneven";
  if (score >= 40) return "Leaking";
  return "Out of control";
}

interface Row {
  t: TradeWithTags;
  at: number;
  /** One R in money; null when the trade has no stop to measure it by. */
  risk: number | null;
  /** The result in R; null while open or when it cannot be measured. */
  r: number | null;
  /** What the plan would have made left alone, less what was made; null when unknown. */
  delta: number | null;
  closedAt: number | null;
}

function rowsOf(trades: TradeWithTags[]): Row[] {
  return trades
    .filter((t) => (t.status === "open" || t.status === "closed") && !isMissed(t) && Number.isFinite(ms(t.entryTime)))
    .map((t) => {
      const m = computeMetrics(t);
      const risk = t.scalp ? (t.riskAmount != null && t.riskAmount > 0 ? t.riskAmount : null) : m.riskDollars > 0 && t.initialStop != null ? m.riskDollars : null;
      const closedAt = isSettled(t) ? ms(t.exitTime ?? t.entryTime) : null;
      return { t, at: ms(t.entryTime), risk, r: closedAt != null ? m.actualR : null, delta: closedAt != null ? m.managementDeltaR : null, closedAt };
    })
    .sort((a, b) => a.at - b.at);
}

function parts(rows: Row[], rails: GuardRails, now: number, tagNames: Map<number, string>): EdgePart[] {
  const out: EdgePart[] = [];
  const rOf = (rs: Row[]) => {
    const got = rs.map((x) => x.r).filter((r): r is number => r != null);
    return got.length ? sum(got) : null;
  };
  const made = (rs: Row[]) => {
    const r = rOf(rs);
    return r == null ? "" : ` Together they made ${signedR(r)}.`;
  };

  /* ---- every trade the same size ---- */
  {
    const sized = rows.filter((x) => x.risk != null);
    const base: Omit<EdgePart, "score" | "detail" | "r" | "tradeIds"> = {
      id: "sizing",
      label: "Sizing",
      asks: "Is the risk the same on every trade?",
      weight: 20,
      tip: "Decide the risk before the entry and let the size follow from the stop. Treat any trade more than half again your usual risk as a rule break.",
    };
    if (sized.length < MIN_PART) out.push({ ...base, score: null, detail: "Too few trades with a stop to compare their risk.", r: null, tradeIds: [] });
    else {
      const usual = median(sized.map((x) => x.risk!));
      const off = sized.filter((x) => x.risk! > usual * 1.5 || x.risk! < usual * 0.5);
      const big = sized.filter((x) => x.risk! > usual * 1.5);
      const largest = Math.max(...sized.map((x) => x.risk!)) / usual;
      const share = 1 - off.length / sized.length;
      out.push({
        ...base,
        score: scale(share, 0.5, 0.95),
        detail:
          off.length === 0
            ? `All ${sized.length} trades risked within half of your usual amount.`
            : `${off.length} of ${sized.length} trades risked more than half above or below your usual amount; the largest was ${largest.toFixed(1)}× it.${big.length ? made(big).replace("Together they", "The oversized ones") : ""}`,
        r: rOf(big),
        tradeIds: newestFirst(off.map((x) => x.t)),
      });
    }
  }

  /* ---- too many trades in a day ---- */
  const byDay = new Map<string, Row[]>();
  for (const x of rows) {
    const k = dayKeyOfIso(x.t.entryTime);
    if (k) byDay.set(k, [...(byDay.get(k) ?? []), x]);
  }
  {
    const base: Omit<EdgePart, "score" | "detail" | "r" | "tradeIds"> = { id: "overtrading", label: "Overtrading", asks: "Do you stop when the day's trades are done?", weight: 15, tip: "" };
    const counts = Array.from(byDay.values()).map((d) => d.length);
    if (rows.length < MIN_PART || counts.length < 3) out.push({ ...base, tip: "Set a number of trades for the day and stop at it.", score: null, detail: "Too few trading days to know what a normal day is.", r: null, tradeIds: [] });
    else {
      // Twice a normal day, and never fewer than three: one extra trade on a quiet style is not overtrading.
      const limit = Math.max(3, Math.ceil(median(counts) * 2));
      const days = Array.from(byDay.values()).filter((d) => d.length > limit);
      const extra = days.flatMap((d) => d.slice(limit));
      out.push({
        ...base,
        tip: `Stop for the day after ${limit} trades. The ones after that are the ones this counts.`,
        score: scale(1 - extra.length / rows.length, 0.8, 1),
        detail: days.length === 0 ? `No day went past ${limit} trades, twice your normal day.` : `On ${plural(days.length, "day")} of ${byDay.size} you took more than ${limit} trades, twice your normal day: ${plural(extra.length, "extra trade")}.${made(extra)}`,
        r: rOf(extra),
        tradeIds: newestFirst(extra.map((x) => x.t)),
      });
    }
  }

  /* ---- the minutes after a loss ---- */
  {
    const base: Omit<EdgePart, "score" | "detail" | "r" | "tradeIds"> = {
      id: "after-loss",
      label: "After a loss",
      asks: "Do you wait after losing, or go straight back in?",
      weight: 15,
      tip: `After a loss, wait ${rails.walkMinutes} minutes before the next entry, and stop for the day after ${rails.lossStreakLimit} losses in a row.`,
    };
    const losses = rows.filter((x) => x.closedAt != null && x.r != null && x.r < 0);
    const hot = new Set<Row>();
    for (const x of rows) {
      // Opened within the re-entry window of a losing close.
      if (losses.some((l) => l.t.id !== x.t.id && x.at >= l.closedAt! && x.at - l.closedAt! <= rails.reentryMinutes * 60_000)) hot.add(x);
    }
    for (const day of Array.from(byDay.values())) {
      // Opened after the day's losing streak had reached the limit.
      for (const x of day) {
        const before = rows.filter((y) => y.closedAt != null && y.closedAt <= x.at && dayKeyOfIso(y.t.exitTime ?? y.t.entryTime) === dayKeyOfIso(x.t.entryTime) && y.r != null).sort((a, b) => a.closedAt! - b.closedAt!);
        let streak = 0;
        for (let i = before.length - 1; i >= 0 && before[i].r! < 0; i--) streak++;
        if (streak >= rails.lossStreakLimit) hot.add(x);
      }
    }
    if (rows.length < MIN_PART || losses.length < 3) out.push({ ...base, score: null, detail: "Too few losses in the window to see what follows them.", r: null, tradeIds: [] });
    else {
      const list = Array.from(hot);
      out.push({
        ...base,
        score: scale(1 - list.length / rows.length, 0.85, 1),
        detail: list.length === 0 ? `No trade was opened within ${rails.reentryMinutes} minutes of a loss or after ${rails.lossStreakLimit} losses in a row.` : `${plural(list.length, "trade")} of ${rows.length} ${list.length === 1 ? "was" : "were"} opened within ${rails.reentryMinutes} minutes of a loss, or after ${rails.lossStreakLimit} losses in a row.${made(list)}`,
        r: rOf(list),
        tradeIds: newestFirst(list.map((x) => x.t)),
      });
    }
  }

  /* ---- a plan before the entry ---- */
  {
    const base: Omit<EdgePart, "score" | "detail" | "r" | "tradeIds"> = {
      id: "plan",
      label: "Plan",
      asks: "Was each trade planned, with a stop and a target?",
      weight: 15,
      tip: "No entry without a stop and a target written down first. A trade you would mark as tilt is one not to take.",
    };
    const planned = rows.filter((x) => !x.t.scalp);
    const tilt = planned.filter((x) => x.t.tilt);
    const noStop = planned.filter((x) => !x.t.tilt && x.t.initialStop == null);
    const noTarget = planned.filter((x) => !x.t.tilt && x.t.initialStop != null && x.t.initialTarget == null);
    const bad = [...tilt, ...noStop, ...noTarget];
    if (planned.length < MIN_PART) out.push({ ...base, score: null, detail: "Too few trades to judge.", r: null, tradeIds: [] });
    else {
      const bits = [tilt.length ? `${plural(tilt.length, "tilt trade")}` : "", noStop.length ? `${noStop.length} with no stop` : "", noTarget.length ? `${noTarget.length} with no target` : ""].filter(Boolean);
      out.push({
        ...base,
        // A trade with no target is half a miss: it was still planned and stopped.
        score: scale(1 - (tilt.length + noStop.length + noTarget.length * 0.5) / planned.length, 0.6, 0.97),
        detail: bits.length === 0 ? `All ${planned.length} trades had a stop and a target, and none was marked tilt.` : `Of ${planned.length} trades: ${bits.join(", ")}.${tilt.length ? made(tilt).replace("Together they", "The tilt trades") : ""}`,
        r: rOf(tilt),
        tradeIds: newestFirst(bad.map((x) => x.t)),
      });
    }
  }

  /* ---- a loss the size it was meant to be ---- */
  {
    const base: Omit<EdgePart, "score" | "detail" | "r" | "tradeIds"> = {
      id: "losses",
      label: "Loss control",
      asks: "Does a loss stay at the 1R you planned?",
      weight: 15,
      tip: "Leave the stop where it was set, or move it only towards the price. A loss past 1R means it was moved away, or there was none.",
    };
    const losers = rows.filter((x) => x.r != null && x.r < 0);
    const over = losers.filter((x) => x.r! < -1.15);
    // Days that closed past the daily stop, by the money they lost.
    const dayPnl = new Map<string, number>();
    for (const x of rows) {
      if (x.closedAt == null) continue;
      const k = dayKeyOfIso(x.t.exitTime ?? x.t.entryTime);
      const pnl = computeMetrics(x.t).actualPnL;
      if (k && pnl != null) dayPnl.set(k, (dayPnl.get(k) ?? 0) + pnl);
    }
    const blown = Array.from(dayPnl.values()).filter((p) => p <= -rails.dailyLossStop).length;
    if (losers.length < MIN_PART) out.push({ ...base, score: null, detail: "Too few measured losses to judge.", r: null, tradeIds: [] });
    else {
      const worst = Math.min(...losers.map((x) => x.r!));
      const excess = sum(over.map((x) => x.r! + 1));
      out.push({
        ...base,
        score: Math.max(0, scale(1 - over.length / losers.length, 0.6, 0.97) - blown * 10),
        detail:
          (over.length === 0 ? `All ${losers.length} losses stayed near the 1R planned.` : `${over.length} of ${losers.length} losses went past the 1R planned (the worst ${signedR(worst)}), ${Math.abs(excess).toFixed(1)}R more than they should have cost.`) +
          (blown ? ` ${plural(blown, "day")} closed past your daily loss stop.` : ""),
        r: over.length ? excess : null,
        tradeIds: newestFirst(over.map((x) => x.t)),
      });
    }
  }

  /* ---- managing against leaving alone ---- */
  {
    const base: Omit<EdgePart, "score" | "detail" | "r" | "tradeIds"> = {
      id: "exits",
      label: "Exits",
      asks: "Does managing the trade beat leaving it to the stop or target?",
      weight: 10,
      tip: "Once in, let the stop or the target take it. Before closing by hand, write down what changed since the entry.",
    };
    const known = rows.filter((x) => x.delta != null);
    if (known.length < MIN_PART) out.push({ ...base, score: null, detail: "Too few closed trades where it is known what the plan would have done.", r: null, tradeIds: [] });
    else {
      const total = sum(known.map((x) => x.delta!));
      const per = total / known.length;
      const cost = known.filter((x) => x.delta! < -0.25);
      out.push({
        ...base,
        score: scale(per, -0.5, 0),
        detail: per >= 0 ? `Across ${known.length} trades your management made ${signedR(total)} more than leaving them alone.` : `Across ${known.length} trades your management made ${signedR(total)} against leaving them alone: ${Math.abs(per).toFixed(2)}R given up per trade.`,
        r: total,
        tradeIds: newestFirst(cost.map((x) => x.t)),
      });
    }
  }

  /* ---- mistakes tagged ---- */
  const closed = rows.filter((x) => x.closedAt != null);
  {
    const base: Omit<EdgePart, "score" | "detail" | "r" | "tradeIds"> = { id: "mistakes", label: "Mistakes", asks: "How many trades carry a mistake you tagged yourself?", weight: 5, tip: "Pick the most common tag and make it the one rule for next week." };
    const bad = closed.filter((x) => x.t.mistakeTagIds.length > 0 || x.t.tradedPoorly);
    if (closed.length < MIN_PART) out.push({ ...base, score: null, detail: "Too few closed trades to judge.", r: null, tradeIds: [] });
    else {
      const tally = new Map<number, number>();
      for (const x of bad) for (const id of x.t.mistakeTagIds) tally.set(id, (tally.get(id) ?? 0) + 1);
      const top = Array.from(tally.entries()).sort((a, b) => b[1] - a[1])[0];
      const name = top ? tagNames.get(top[0]) : undefined;
      out.push({
        ...base,
        tip: name ? `"${name}" is the most common, on ${plural(top![1], "trade")}. Make avoiding it the one rule for next week.` : base.tip,
        score: scale(1 - bad.length / closed.length, 0.5, 0.95),
        detail: bad.length === 0 ? `None of ${closed.length} closed trades carries a mistake.` : `${bad.length} of ${closed.length} closed trades carry a mistake tag or were marked as traded poorly.${made(bad)}`,
        r: rOf(bad),
        tradeIds: newestFirst(bad.map((x) => x.t)),
      });
    }
  }

  /* ---- looked at again ---- */
  {
    const base: Omit<EdgePart, "score" | "detail" | "r" | "tradeIds"> = { id: "review", label: "Review", asks: "Do you go back over a trade once it is closed?", weight: 5, tip: "Review each closed trade the same day or the next morning; the Review tab lists the ones waiting." };
    // A trade closed in the last day has not had its chance yet.
    const due = closed.filter((x) => now - x.closedAt! > DAY);
    const owed = due.filter((x) => !x.t.reviewedAt);
    if (due.length < MIN_PART) out.push({ ...base, score: null, detail: "Too few closed trades to judge.", r: null, tradeIds: [] });
    else
      out.push({
        ...base,
        score: scale(1 - owed.length / due.length, 0.3, 0.95),
        detail: owed.length === 0 ? `All ${due.length} closed trades were reviewed.` : `${owed.length} of ${due.length} closed trades were never reviewed.`,
        r: null,
        tradeIds: newestFirst(owed.map((x) => x.t)),
      });
  }
  return out;
}

function total(ps: EdgePart[]): number | null {
  const scored = ps.filter((p) => p.score != null);
  if (scored.length < 3) return null;
  return Math.round(sum(scored.map((p) => p.score! * p.weight)) / sum(scored.map((p) => p.weight)));
}

export function edgeScore(
  trades: TradeWithTags[],
  opts: { now?: number; days?: number; rails?: GuardRails; tags?: { id: number; name: string }[] } = {},
): EdgeScore {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? EDGE_SCORE_DAYS[0];
  const rails = opts.rails ?? DEFAULT_GUARDRAILS;
  const tagNames = new Map((opts.tags ?? []).map((t) => [t.id, t.name] as const));
  const all = rowsOf(trades);
  const win = all.filter((x) => x.at > now - days * DAY && x.at <= now);
  const before = all.filter((x) => x.at > now - 2 * days * DAY && x.at <= now - days * DAY);

  const ps = parts(win, rails, now, tagNames);
  const enough = win.length >= EDGE_SCORE_MIN_TRADES;
  const score = enough ? total(ps) : null;
  const previous = before.length >= EDGE_SCORE_MIN_TRADES ? total(parts(before, rails, now - days * DAY, tagNames)) : null;
  // The thing to fix is the habit taking the most off the score: how far it is from 100, by how much it counts.
  const lost = (p: EdgePart) => (100 - p.score!) * p.weight;
  const weakest = score == null ? null : (ps.filter((p) => p.score != null).sort((a, b) => lost(b) - lost(a) || a.score! - b.score!)[0] ?? null);

  let headline: string;
  if (score == null) {
    const left = EDGE_SCORE_MIN_TRADES - win.length;
    headline = left > 0 ? `${plural(left, "more trade")} in the last ${days} days before there is a score.` : "Not enough of the habits can be judged yet: log stops, targets and closes.";
  } else if (weakest && weakest.score! >= 90) headline = "Nothing is leaking. Keep doing exactly this.";
  else headline = weakest ? `Biggest leak: ${weakest.label} (${weakest.score}/100). ${weakest.tip}` : "";

  return { days, trades: win.length, score, previous, parts: ps, weakest, grade: edgeGrade(score), headline };
}
