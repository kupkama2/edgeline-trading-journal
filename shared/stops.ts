/**
 * Where the stop is NOW, as opposed to where it started.
 *
 * Until now the journal stored one stop and treated it as both things at
 * once, and shared/exposure.ts said so in as many words: "a stop moved to
 * breakeven in your platform is not known here". On a scalp that is nothing.
 * On a swing held for three weeks it is most of the management — pulling a
 * stop up to entry is the moment a trade stops being able to hurt you, and
 * the journal had no way to hear about it.
 *
 * The two stops answer different questions and both are needed:
 *
 *   initialStop  is the plan, and the denominator of every R on the trade. It
 *                never moves. A trade that made 2R made 2R of the risk it was
 *                TAKEN with, and rebasing R each time a stop is pulled up
 *                would turn the same trade into a different number every time
 *                you managed it — flattering, and meaningless.
 *
 *   the moves    are what you did since. The current stop is the last of them,
 *                and it decides what is still at risk, whether anything is
 *                locked in, and where the line goes on the chart.
 *
 * Stored as a JSON list rather than a second price column, because "I moved
 * it to breakeven on Tuesday and trailed it under the Thursday low" is the
 * record worth keeping — one column holding only the latest would answer
 * "where is it" and silently lose "when did I stop risking anything".
 */
import type { Trade, TradeFill } from "./schema";
import { positionLedger } from "./fills";

export interface StopMove {
  /** ISO, when the stop was moved. */
  at: string;
  price: number;
  /** Optional: why. "breakeven", "under the Thursday low". */
  note?: string;
}

/** Newest last. Anything malformed is dropped rather than guessed at. */
export function parseStopMoves(raw: string | null | undefined): StopMove[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: StopMove[] = [];
  for (const m of parsed) {
    const price = Number((m as any)?.price);
    const at = typeof (m as any)?.at === "string" ? (m as any).at : "";
    if (!Number.isFinite(price) || price <= 0 || !at) continue;
    const note = typeof (m as any)?.note === "string" ? (m as any).note.trim() : "";
    out.push(note ? { at, price, note } : { at, price });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export function formatStopMoves(moves: StopMove[]): string | null {
  return moves.length ? JSON.stringify(moves) : null;
}

/** Where the stop is now: the last move, or the one the trade was taken with. */
export function currentStop(t: {
  initialStop?: number | null;
  stopMoves?: string | null;
}): number | null {
  const moves = parseStopMoves(t.stopMoves);
  return moves.length ? moves[moves.length - 1].price : (t.initialStop ?? null);
}

/** Has the stop been moved at all? */
export function stopWasMoved(t: { stopMoves?: string | null }): boolean {
  return parseStopMoves(t.stopMoves).length > 0;
}

/**
 * What the current stop would cost from the average entry, in money — and
 * zero once the stop is at or beyond it.
 *
 * Deliberately not negative. A stop above entry on a long does not "risk
 * minus two hundred dollars"; it risks nothing, and the two hundred is
 * locked in, which `lockedIn` reports separately. Rolling both into one
 * signed figure reads as a loss to anyone scanning a column of them.
 */
export function riskLeft(t: Trade & { fills?: TradeFill[] }): number | null {
  const stop = currentStop(t);
  if (stop == null) return null;
  const led = positionLedger(t);
  const perPoint = led.openQty * (t.pointValue ?? 1);
  if (!(perPoint > 0)) return null;
  const sign = t.direction === "short" ? -1 : 1;
  // Signed distance from the entry to the stop, in the direction of loss.
  const points = sign * (led.avgEntry - stop);
  return points > 0 ? points * perPoint : 0;
}

/**
 * Money the position cannot now give back: the stop is through the entry and
 * would close it in profit. Null when it is not, so a caller can say nothing
 * rather than print a zero on every trade that has not got there yet.
 */
export function lockedIn(t: Trade & { fills?: TradeFill[] }): number | null {
  const stop = currentStop(t);
  if (stop == null) return null;
  const led = positionLedger(t);
  const perPoint = led.openQty * (t.pointValue ?? 1);
  if (!(perPoint > 0)) return null;
  const sign = t.direction === "short" ? -1 : 1;
  const points = sign * (stop - led.avgEntry);
  return points > 0 ? points * perPoint : null;
}

/**
 * Append a move, ignoring one that changes nothing.
 *
 * Re-saving a form should not write "moved the stop to where it already was"
 * into the record — the list is a history of decisions, and a row nobody
 * decided is noise in the one place that is supposed to be all signal.
 */
export function addStopMove(
  existing: string | null | undefined,
  price: number,
  at: string = new Date().toISOString(),
  note?: string,
): StopMove[] {
  const moves = parseStopMoves(existing);
  const last = moves.length ? moves[moves.length - 1].price : null;
  if (last === price) return moves;
  const clean = (note ?? "").trim();
  moves.push(clean ? { at, price, note: clean } : { at, price });
  return moves;
}
