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
 * Nothing here is a judgement about the trade — taking a trade off by hand is
 * often the right call. It is a judgement about the RECORD, which is a
 * different thing and the only one a journal is entitled to make.
 */
import type { TradeWithTags } from "./schema";

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
 * "Undetermined" counts as ANSWERED. It is a real answer — you went back, the
 * path wasn't legible, and you said so — and a flag that cannot be cleared by
 * looking is a flag that teaches you to stop looking. The distinction the
 * field carries is between null (never asked) and undetermined (asked, and
 * the chart didn't say).
 */
export function outcomeUnknown(t: TradeWithTags): boolean {
  if (t.status !== "closed" || t.exitPrice == null) return false;
  if (t.noManagementOutcome != null) return false;
  return impliedOutcome(t) == null;
}

/**
 * The worklist: closed trades that never said whether the plan would have
 * paid, most recent first.
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
