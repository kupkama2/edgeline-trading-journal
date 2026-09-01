/**
 * Which way the trade goes, read off the levels.
 *
 * Long or short is not really a separate decision — it is already implied by
 * where you put the stop and the target. A stop under the entry and a target
 * over it IS a long; there is no other trade those three prices describe. So
 * typing the levels and then also picking the direction is asking for the same
 * fact twice, and the second answer is the one that gets forgotten.
 *
 * Which matters more than convenience, because getting it wrong is silent and
 * expensive. Direction flips the sign of every R in the trade: a short logged
 * as a long turns a winner into a loser, a −1R into a +1R, and it does not
 * look wrong on the row — it looks like a different trade that happened to you.
 *
 * Two rules make this safe to act on:
 *
 *   1. It only reads what the levels ACTUALLY say. A stop and a target on the
 *      same side of the entry describe no trade at all, and this reports the
 *      contradiction rather than picking whichever it saw first.
 *
 *   2. It never overrules a person. Inferring into an untouched field is help;
 *      changing an answer someone gave is an argument, and one the form always
 *      wins. Where a stated direction disagrees with the levels, the caller
 *      gets a warning to show, not a value to write.
 */
export type Direction = "long" | "short";

export interface DirectionRead {
  /** What the levels imply. Null when they say nothing, or disagree. */
  implied: Direction | null;
  /**
   * The stop and the target sit on the SAME side of the entry.
   *
   * Not "no information" — worse. It is two levels describing two different
   * trades, and one of the three prices is a typo. Worth saying so.
   */
  conflict: boolean;
  /** Which levels the reading rests on, for saying so out loud. */
  from: ("stop" | "target")[];
}

const NOTHING: DirectionRead = { implied: null, conflict: false, from: [] };

/** A level exactly on the entry is not on either side of it. */
const side = (level: number, entry: number): Direction | null => {
  if (!isFinite(level) || !isFinite(entry) || level === entry) return null;
  return level > entry ? "long" : "short";
};

/**
 * Read the direction from entry, stop and target.
 *
 * The stop's implication is inverted — a stop BELOW the entry protects a long
 * — while the target's is direct. Either alone is enough; both agreeing is
 * better; both disagreeing is a contradiction and gets reported as one.
 */
export function readDirection(
  entry: number | null | undefined,
  stop: number | null | undefined,
  target: number | null | undefined,
): DirectionRead {
  if (entry == null || !isFinite(entry)) return NOTHING;

  // A stop under the entry means a long; the side function answers "above or
  // below", so the stop's reading is the opposite of the side it sits on.
  const fromStop =
    stop == null ? null : invert(side(stop, entry));
  const fromTarget = target == null ? null : side(target, entry);

  if (fromStop && fromTarget) {
    if (fromStop === fromTarget) {
      return { implied: fromStop, conflict: false, from: ["stop", "target"] };
    }
    /*
     * Stop and target on the same side of the entry. Both readings are
     * confident and they point opposite ways, so there is no honest answer —
     * and quietly preferring the stop would write a direction that is wrong
     * half the time it comes up.
     */
    return { implied: null, conflict: true, from: ["stop", "target"] };
  }
  if (fromStop) return { implied: fromStop, conflict: false, from: ["stop"] };
  if (fromTarget) return { implied: fromTarget, conflict: false, from: ["target"] };
  return NOTHING;
}

function invert(d: Direction | null): Direction | null {
  return d == null ? null : d === "long" ? "short" : "long";
}

/**
 * Why a stated direction and the levels do not match, in one sentence.
 *
 * Null when they agree, when the levels say nothing, or when the levels
 * contradict each other — that last case is its own message and the caller
 * says it separately, because "your stop is on the wrong side" would be
 * misleading advice when the target is the price that is actually wrong.
 */
export function directionWarning(
  picked: Direction,
  read: DirectionRead,
): string | null {
  if (read.conflict || read.implied == null || read.implied === picked) return null;
  const stopSide = picked === "long" ? "below" : "above";
  const targetSide = picked === "long" ? "above" : "below";
  if (read.from.length === 2) {
    return `Marked ${picked}, but the stop and target are the other way round — a ${picked} wants its stop ${stopSide} the entry and its target ${targetSide}.`;
  }
  if (read.from[0] === "stop") {
    return `Marked ${picked}, but the stop is on the wrong side of the entry — a ${picked} stops out ${stopSide} it.`;
  }
  return `Marked ${picked}, but the target is on the wrong side of the entry — a ${picked} takes profit ${targetSide} it.`;
}

/** The two levels describe two different trades. One of the prices is a typo. */
export function conflictWarning(read: DirectionRead): string | null {
  return read.conflict
    ? "The stop and the target are on the same side of the entry, so these three prices do not describe a trade. One of them is a typo."
    : null;
}
