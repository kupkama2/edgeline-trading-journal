/**
 * What a closed trade never told you.
 *
 * A trade closed by hand is the one the journal knows least about, and it is
 * the one it should know most about. Let a plan run to its stop or its target
 * and the market answers the question for you: the trade IS the experiment,
 * and the result is written on it. Cut it at 1.2R because it felt heavy and
 * the experiment stops there — would it have paid the target? would it have
 * come back and stopped you? — and nothing in the row can say. Those are
 * exactly the trades the edge is decided on, and they are the ones that go
 * into the log with three fields empty.
 *
 * The gaps are knowable, just not from inside the app: they are on the chart,
 * later. So the honest thing is not to guess them but to say which trades are
 * still owed, and make walking that list quick. Hence a gap list per trade
 * and a worklist across them.
 *
 * Nothing here is a judgement about the trade — a hand-close is often the
 * right call. It is a judgement about the RECORD, which is a different thing
 * and the only one a journal is entitled to make.
 */
import type { TradeWithTags } from "./schema";

export type Gap = "outcome" | "runOn" | "worse" | "path";

export const GAP_LABELS: Record<Gap, string> = {
  outcome: "target or stop first?",
  runOn: "how far it ran after",
  worse: "how much worse it got",
  path: "the path while you held",
};

/** The one sentence explaining why each gap is worth walking back for. */
export const GAP_WHY: Record<Gap, string> = {
  outcome: "Without it the trade cannot be compared against leaving it alone.",
  runOn: "The early-exit half of the exit-timing read.",
  worse: "What the exit avoided — the only figure that can come out in its favour.",
  path: "MAE and MFE: how much heat it took, and how far it actually ran.",
};

/**
 * Exits where the market answered the question, versus where you did.
 *
 * "Hit target" and "stopped out" are resolutions; everything else is a
 * decision taken before the plan resolved, and it is the decision that leaves
 * the record incomplete.
 */
const RESOLVED_BY_MARKET = new Set(["target", "stop"]);

/**
 * Did the trade demonstrably hit one of its original levels?
 *
 * When the exit price is AT the original stop or target, the untouched plan
 * provably reached that level first — there is nothing to look up, and asking
 * would be busywork. Directional and tolerant, because a stop fills through
 * the level rather than exactly on it, and a target may fill a tick past.
 *
 * Deliberately not inferred from the exit reason alone: a stop MOVED to
 * breakeven still closes as "stopped out", and calling that "the plan hit its
 * stop" would put a false answer in the field this exists to protect.
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

export interface AftermathGaps {
  gaps: Gap[];
  /**
   * Closed before the plan resolved — you took it off, the market did not.
   * The gaps matter more here, and "outcome" is only ever missing here.
   */
  cutShort: boolean;
}

/**
 * What this trade still owes. Null for anything not closed — an open trade is
 * not missing its aftermath, it is still having it.
 */
export function aftermathGaps(t: TradeWithTags): AftermathGaps | null {
  if (t.status !== "closed" || t.exitPrice == null) return null;
  const cutShort = !RESOLVED_BY_MARKET.has(t.exitReason ?? "") && impliedOutcome(t) == null;
  const gaps: Gap[] = [];
  // Only ever asked of a hand-close. On a trade that ran to its own stop or
  // target the answer is on the row already, and a permanent amber flag over
  // a question with a known answer is how a signal gets ignored.
  if (cutShort && t.noManagementOutcome == null) gaps.push("outcome");
  if (t.postExitPeak == null) gaps.push("runOn");
  if (t.postExitAdverse == null) gaps.push("worse");
  if (t.mae == null && t.mfe == null) gaps.push("path");
  return { gaps, cutShort };
}

export interface Owed {
  trade: TradeWithTags;
  gaps: Gap[];
  cutShort: boolean;
}

/**
 * The worklist: closed trades still missing something, worst first.
 *
 * Ordered by how much is missing rather than by date, because the point is to
 * fix the record and a hand-closed trade with three blanks is worth more than
 * a stop-out missing one. Ties break to the most recent, which is the one
 * still fresh enough to reconstruct from memory and a chart.
 */
export function owedAftermath(trades: TradeWithTags[]): Owed[] {
  const out: Owed[] = [];
  for (const trade of trades) {
    const g = aftermathGaps(trade);
    if (!g || g.gaps.length === 0) continue;
    out.push({ trade, gaps: g.gaps, cutShort: g.cutShort });
  }
  return out.sort((a, b) => {
    // A missing outcome outranks any number of aftermath blanks: it is the
    // only gap that makes a trade uncomparable against leaving it alone.
    const weight = (o: Owed) => (o.gaps.includes("outcome") ? 10 : 0) + o.gaps.length;
    const d = weight(b) - weight(a);
    if (d !== 0) return d;
    return (b.trade.exitTime ?? b.trade.entryTime).localeCompare(
      a.trade.exitTime ?? a.trade.entryTime,
    );
  });
}
