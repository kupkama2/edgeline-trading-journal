/**
 * One question, asked of the trades that can still answer it.
 *
 * "If I had left it completely alone — no moving the stop, no taking it off
 * early — would price have hit my target or my stop first?"
 *
 * That is the only thing worth chasing after the fact, because it is the only
 * one the trade cannot answer for itself. Let a plan run to its own stop or
 * target and the market writes the answer on the row. Take it off at 1.2R
 * because it felt heavy and the experiment stops there: nothing in the record
 * knows whether the plan was right, so noManagementOutcome — and with it
 * potentialR, managementDeltaR, and any claim that managing the trade helped
 * or hurt — is simply absent.
 *
 * This used to flag the post-exit prices and the MAE/MFE path too. It no
 * longer does. Those are worth recording when you have them, but they are not
 * worth an alert: a flag that fires on four things at once is a flag nobody
 * reads, and it buried the one question that actually needs walking back to a
 * chart for.
 *
 * "Undetermined" stays on the list rather than clearing it. When you close a
 * trade by hand, neither level has been reached yet and undetermined is the
 * only truthful thing to write — it is a parking space, not a verdict.
 *
 * Nothing here is a judgement about the trade — taking a trade off by hand is
 * often the right call. It is a judgement about the RECORD, which is a
 * different thing and the only one a journal is entitled to make.
 */
import type { TradeWithTags } from "./schema";
import { AFTERMATH_HORIZON_MS } from "./binance";

/**
 * Did price demonstrably reach one of the trade's ORIGINAL levels?
 *
 * When the exit is at the original stop or the original target, the untouched
 * plan provably got there — there is nothing to look up, and asking would be
 * busywork. Directional and tolerant, because a stop fills through its level
 * rather than exactly on it and a target may fill a tick past.
 *
 * Read off the exit PRICE, never the exit reason. A stop moved to breakeven
 * still closes as "stopped out", and treating that as "the untouched plan hit
 * its stop" would put a false answer in the one field this exists to protect.
 * The label is what you called it; the price is what happened.
 */
export function impliedOutcome(t: TradeWithTags): "target_first" | "stop_first" | null {
  if (t.exitPrice == null || t.initialStop == null) return null;
  const sign = t.direction === "short" ? -1 : 1;
  const risk = Math.abs(t.entryPrice - t.initialStop);
  if (!(risk > 0)) return null;
  const slack = risk * 0.1;
  if (sign * (t.exitPrice - t.initialStop) <= slack) return "stop_first";
  if (t.initialTarget != null && sign * (t.exitPrice - t.initialTarget) >= -slack) {
    return "target_first";
  }
  return null;
}

/**
 * Is the untouched-plan outcome still unanswered on this trade?
 *
 * "Undetermined" counts as UNANSWERED, which is the whole point. At the
 * moment you close a trade by hand, neither level has been reached yet —
 * there is nothing else you could truthfully put in the field. So
 * "undetermined" is where a trade is parked while the market finishes the
 * question, not a verdict that it never will. Treating it as a verdict is how
 * a journal fills up with trades that quietly opted out of being comparable
 * against leaving them alone.
 *
 * The field therefore carries two shades of the same state — never asked, and
 * asked-but-not-yet — and both stay on the list. See `outcomeParked` for
 * telling them apart in the UI.
 *
 * A trade whose price PROVES which level came first is still exempt, however
 * it was labelled: the row already answers it and asking again is busywork.
 */
export function outcomeUnknown(t: TradeWithTags): boolean {
  if (t.status !== "closed" || t.exitPrice == null) return false;
  const said = t.noManagementOutcome;
  if (said != null && said !== "undetermined") return false;
  return impliedOutcome(t) == null;
}

/**
 * Closed, but the price path was never filled in — and could still be.
 *
 * The archive publishes a day at a time, so a trade closed this morning has
 * no file covering its own exit yet. The reader withholds MAE and MFE rather
 * than measuring them over a window it only half saw, which is right, and
 * leaves a trade that is settled but unmeasured.
 *
 * Nothing used to bring those back. The sweep's worklist was `outcomeUnknown`
 * alone, and a trade whose PLAN outcome had already been decided was never
 * looked at again — so the numbers withheld on Monday stayed missing for good,
 * however much data the archive published on Tuesday.
 *
 * Bounded by the aftermath horizon: past it there is nothing further to learn,
 * and retrying forever would fill the per-run budget with trades that can
 * never be completed while newer ones queued behind them.
 */
export function pathIncomplete(t: TradeWithTags, now = Date.now()): boolean {
  if (t.status !== "closed" || t.exitPrice == null) return false;
  if (t.mae != null && t.mfe != null) return false;
  const exit = t.exitTime ? new Date(t.exitTime).getTime() : null;
  if (exit == null || !Number.isFinite(exit)) return false;
  return now - exit < AFTERMATH_HORIZON_MS + 7 * 24 * 60 * 60 * 1000;
}

/**
 * Parked deliberately, rather than never asked.
 *
 * Same errand either way, but they read differently: one is a trade you have
 * looked at and are waiting on, the other you have not touched since closing.
 */
export const outcomeParked = (t: TradeWithTags) =>
  t.noManagementOutcome === "undetermined";

/**
 * The worklist: closed trades that have not yet said whether the plan would
 * have paid, most recent first.
 *
 * Recency rather than any notion of importance, because the errand is going
 * back to a chart and the trade from yesterday is the one you can still
 * reconstruct.
 */
export function owedOutcome(trades: TradeWithTags[]): TradeWithTags[] {
  return trades
    .filter(outcomeUnknown)
    .slice()
    .sort((a, b) => (b.exitTime ?? b.entryTime).localeCompare(a.exitTime ?? a.entryTime));
}
