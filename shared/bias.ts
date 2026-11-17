/**
 * The day's bias for a market: which way to lean before the session, and
 * what the lean rests on.
 *
 * It is read from the daily candles, by five plain questions about the
 * days that have closed, each worth a point for the bulls or the bears:
 *
 *   trend       is the close above a rising 20-day average, itself above
 *               the 50-day (or the mirror of that)
 *   yesterday   did the day close beyond the day before's high or low,
 *               or stay inside it
 *   the close   did it finish in the top or the bottom third of its range
 *   structure   three days of higher highs and higher lows, or lower ones
 *   the week    is price above or below where the week opened
 *
 * Two points either way is a bias; less is no bias, and saying so is the
 * point: most days have none worth trading. On top of it sits where price
 * is now against yesterday's range, which is what confirms or denies the
 * lean as the day goes on.
 *
 * It is arithmetic over candles and can be checked by hand. It knows no
 * news, no session and no order flow, and a strong bias is not a signal:
 * it is the side on which a setup deserves the benefit of the doubt.
 */
import { ema, type ScreenerCandle } from "./screener";

export type BiasSide = "bullish" | "bearish" | "neutral";

export interface BiasVote {
  id: "trend" | "yesterday" | "close" | "structure" | "week";
  /** +1 for the bulls, −1 for the bears, 0 for neither. */
  vote: -1 | 0 | 1;
  /** What was seen, in words. */
  text: string;
}

export interface DailyBias {
  side: BiasSide;
  /** The votes added up: −5 to +5. */
  score: number;
  votes: BiasVote[];
  /** Where price is now against yesterday's range: what the day has done with the bias so far. */
  today: { text: string; agrees: boolean | null };
  levels: {
    price: number;
    /** Today's change from yesterday's close, as a fraction. */
    change: number | null;
    prevHigh: number;
    prevLow: number;
    prevClose: number;
    /** The middle of yesterday's range. */
    prevMid: number;
    dayOpen: number;
    weekOpen: number | null;
    ema20: number | null;
    ema50: number | null;
  };
  /** The last completed day the bias was read from, as a UTC date. */
  asOf: string;
}

const DAY = 86400_000;
/** Monday 00:00 UTC of the week a time falls in. */
const weekStart = (t: number) => {
  const d = new Date(t);
  const dow = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * DAY;
};

/** Two points either way is a bias. */
export const BIAS_MIN = 2;

/**
 * The bias from a market's daily candles, oldest first, the last being the
 * day still forming. Null with fewer than five completed days: there is no
 * yesterday to read, or no day before it.
 */
export function dailyBias(daily: ScreenerCandle[]): DailyBias | null {
  if (daily.length < 6) return null;
  const today = daily[daily.length - 1];
  const done = daily.slice(0, -1);
  const y = done[done.length - 1];
  const p = done[done.length - 2];
  const closes = done.map((c) => c.c);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e20Was = ema(closes.slice(0, -5), 20);
  const votes: BiasVote[] = [];

  /* ---- trend ---- */
  if (e20 == null) votes.push({ id: "trend", vote: 0, text: "Too few days for the 20-day average" });
  else {
    const rising = e20Was != null ? e20 > e20Was : null;
    const stacked = e50 == null ? true : e20 > e50;
    const stackedDown = e50 == null ? true : e20 < e50;
    if (y.c > e20 && stacked && rising !== false) votes.push({ id: "trend", vote: 1, text: e50 == null ? "Closed above a rising 20-day average" : "Closed above the 20-day average, which is above the 50-day" });
    else if (y.c < e20 && stackedDown && rising !== true) votes.push({ id: "trend", vote: -1, text: e50 == null ? "Closed below a falling 20-day average" : "Closed below the 20-day average, which is below the 50-day" });
    else votes.push({ id: "trend", vote: 0, text: y.c > e20 ? "Above the 20-day average, but the averages do not agree" : "Below the 20-day average, but the averages do not agree" });
  }

  /* ---- yesterday against the day before ---- */
  if (y.c > p.h) votes.push({ id: "yesterday", vote: 1, text: "Yesterday closed above the previous day's high" });
  else if (y.c < p.l) votes.push({ id: "yesterday", vote: -1, text: "Yesterday closed below the previous day's low" });
  else if (y.h <= p.h && y.l >= p.l) votes.push({ id: "yesterday", vote: 0, text: "Yesterday was an inside day: no expansion either way" });
  else if (y.h > p.h && y.c < p.h && y.c < y.o) votes.push({ id: "yesterday", vote: -1, text: "Yesterday took the previous high and closed back under it, down on the day" });
  else if (y.l < p.l && y.c > p.l && y.c > y.o) votes.push({ id: "yesterday", vote: 1, text: "Yesterday took the previous low and closed back above it, up on the day" });
  else votes.push({ id: "yesterday", vote: 0, text: "Yesterday closed inside the previous day's range" });

  /* ---- where yesterday closed in its own range ---- */
  const range = y.h - y.l;
  const where = range > 0 ? (y.c - y.l) / range : 0.5;
  if (where >= 2 / 3) votes.push({ id: "close", vote: 1, text: `Yesterday closed in the top third of its range (${Math.round(where * 100)}%)` });
  else if (where <= 1 / 3) votes.push({ id: "close", vote: -1, text: `Yesterday closed in the bottom third of its range (${Math.round(where * 100)}%)` });
  else votes.push({ id: "close", vote: 0, text: `Yesterday closed mid-range (${Math.round(where * 100)}%)` });

  /* ---- three days of structure ---- */
  const [a, b, c] = done.slice(-3);
  if (b.h > a.h && c.h > b.h && b.l > a.l && c.l > b.l) votes.push({ id: "structure", vote: 1, text: "Three days of higher highs and higher lows" });
  else if (b.h < a.h && c.h < b.h && b.l < a.l && c.l < b.l) votes.push({ id: "structure", vote: -1, text: "Three days of lower highs and lower lows" });
  else votes.push({ id: "structure", vote: 0, text: "No clean run of highs and lows over three days" });

  /* ---- against the week's open ---- */
  const ws = weekStart(today.t);
  const first = daily.find((d) => d.t >= ws);
  const weekOpen = first ? first.o : null;
  // On a Monday the week has only just opened: last week's close stands in, so the vote is not a coin toss on the first hour.
  const weekRef = first && first.t === today.t ? y.c : weekOpen;
  const price = today.c;
  if (weekRef == null) votes.push({ id: "week", vote: 0, text: "No week open to compare with" });
  else if (first && first.t === today.t) votes.push({ id: "week", vote: 0, text: "The week has just opened" });
  else if (price > weekRef) votes.push({ id: "week", vote: 1, text: "Trading above the week's open" });
  else if (price < weekRef) votes.push({ id: "week", vote: -1, text: "Trading below the week's open" });
  else votes.push({ id: "week", vote: 0, text: "At the week's open" });

  const score = votes.reduce((s, v) => s + v.vote, 0);
  const side: BiasSide = score >= BIAS_MIN ? "bullish" : score <= -BIAS_MIN ? "bearish" : "neutral";

  /* ---- what today has done with it so far ---- */
  const mid = (y.h + y.l) / 2;
  let todayRead: DailyBias["today"];
  if (price > y.h) todayRead = { text: "Now above yesterday's high", agrees: side === "neutral" ? null : side === "bullish" };
  else if (price < y.l) todayRead = { text: "Now below yesterday's low", agrees: side === "neutral" ? null : side === "bearish" };
  else if (price >= mid) todayRead = { text: "Now in the upper half of yesterday's range", agrees: side === "neutral" ? null : side === "bullish" };
  else todayRead = { text: "Now in the lower half of yesterday's range", agrees: side === "neutral" ? null : side === "bearish" };

  return {
    side,
    score,
    votes,
    today: todayRead,
    levels: { price, change: y.c > 0 ? price / y.c - 1 : null, prevHigh: y.h, prevLow: y.l, prevClose: y.c, prevMid: mid, dayOpen: today.o, weekOpen, ema20: e20, ema50: e50 },
    asOf: new Date(y.t).toISOString().slice(0, 10),
  };
}
