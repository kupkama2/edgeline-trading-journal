/**
 * Which bars a trade's chart shows: the timeframe and the window.
 *
 * Shared by the chart route and the warmer that reads charts ahead of the
 * page, so the two ask the venue for exactly the same bars and the second
 * finds the first's answer in the cache. The window's start is snapped to a
 * bar for the same reason: an open trade's window used to begin at
 * "half the hold before the entry", a figure that moved every millisecond
 * and so never matched the window read a moment earlier.
 */
import { BAR_MS, intervalFor, type Interval } from "./binance";

/** Timeframes the chart offers. */
export const ALLOWED_INTERVALS = ["1m", "15m", "1h", "4h", "1d"] as const;

/**
 * How far past the exit the chart runs, at the least.
 *
 * The aftermath is half the point. A week is enough to see the level you
 * left for reached without you, and short enough that a daily chart of a
 * scalp is not the question.
 */
export const RECENT_AFTERMATH_MS = 7 * 24 * 60 * 60 * 1000;

export interface ChartWindow {
  interval: Interval;
  from: number;
  to: number;
  /** True when `before` asked for a page of history rather than the trade's own window. */
  paging: boolean;
}

export function chartWindow(
  trade: { entryTime: string; exitTime?: string | null },
  asked: string | undefined,
  before: number | undefined,
  now = Date.now(),
): ChartWindow {
  const entry = new Date(trade.entryTime).getTime();
  const exit = trade.exitTime ? new Date(trade.exitTime).getTime() : now;
  const held = Math.max(exit - entry, 60 * 60 * 1000);
  // Half the hold before, and the same again after — enough aftermath to
  // show a level being reached without you.
  const from = entry - held * 0.5;
  /*
   * The window's near end — one and a half holds past the exit — is what
   * chooses the bar size, so a two-hour scalp keeps its one-minute bars.
   * The far end runs to now, at least a week past the exit, within what
   * those bars can show; that is the part the trader sees change from
   * one day to the next.
   */
  const nearTo = Math.min(now, exit + held * 1.5);
  const to = Math.min(now, Math.max(nearTo, exit + RECENT_AFTERMATH_MS));
  /*
   * A requested timeframe wins over the automatic one, and the WINDOW
   * moves to suit it rather than the bar count doing the moving.
   *
   * Both ends of that matter. One-minute bars on a three-week swing is a
   * request for thirty thousand candles when what you wanted was a close
   * look at the entry — so a fine timeframe zooms in, centred on the
   * trade. Daily bars on a trade you held for six hours is the opposite
   * mistake: the window is narrower than a single candle, Binance has
   * nothing whose open time falls inside it, and the chart comes back
   * empty. So a coarse timeframe zooms OUT, and you get the daily context
   * with your entry marked on it, which is the honest reading of what
   * "show me this on the daily" meant.
   */
  const interval = (ALLOWED_INTERVALS as readonly string[]).includes(asked ?? "") ? (asked as Interval) : intervalFor(nearTo - from);
  const bar = BAR_MS[interval];
  const widest = bar * 700;
  const narrowest = bar * 40;
  const mid = (entry + exit) / 2;
  let win = { from, to };
  if (to - from > widest) {
    /*
     * Too many bars. When the trade itself fits, keep it whole and trim
     * the aftermath to what the budget allows; when even the trade does
     * not fit at this bar size, centre on it and show what can be shown.
     */
    win = nearTo - from <= widest ? { from, to: from + widest } : { from: Math.max(from, mid - widest / 2), to: Math.min(to, mid + widest / 2) };
  } else if (to - from < narrowest) {
    const end = Math.min(now, Math.max(to, mid + narrowest / 2));
    win = { from: end - narrowest, to: end };
  }
  /*
   * `before` asks for history instead: the page of bars ending at that
   * instant, which is what scrolling left off the edge of the chart needs.
   *
   * A trade journal opens on the trade, and that is right — but a chart you
   * cannot scroll back on is a screenshot. Loading every bar Binance has up
   * front to avoid the question would be megabytes for a view nobody may
   * look at, so history arrives a page at a time as it is asked for.
   */
  const paging = before != null && Number.isFinite(before) && before > 0;
  if (paging) win = { from: before! - bar * 600, to: before! };
  // The start on a bar boundary, so the same window asked twice is the same key.
  return { interval, from: Math.floor(win.from / bar) * bar, to: win.to, paging };
}
