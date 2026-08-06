/**
 * Session windows — when a book is supposed to be trading.
 *
 * The hour-of-day breakdown can prove that a style's afternoon trades lose
 * money; this is where that finding becomes enforcement. A style may declare
 * the hours it trades, and an entry logged outside them draws a warning at the
 * moment of the decision rather than in next week's statistics.
 */

/** "HH:MM" → minutes since local midnight, or null if malformed. */
export function parseHHMM(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Is this moment inside the window?
 *
 * Returns null when no usable window is configured — "no opinion" is a
 * different answer from "inside", and callers must not warn on it.
 *
 * A window whose end precedes its start wraps midnight (22:00–02:00), which is
 * how a crypto book that trades the US evening into the Asia open writes it.
 */
export function inSessionWindow(
  when: Date,
  sessionStart: string | null | undefined,
  sessionEnd: string | null | undefined,
): boolean | null {
  const start = parseHHMM(sessionStart);
  const end = parseHHMM(sessionEnd);
  if (start == null || end == null || start === end) return null;

  const t = when.getHours() * 60 + when.getMinutes();
  return start < end ? t >= start && t < end : t >= start || t < end;
}

export function windowLabel(
  sessionStart: string | null | undefined,
  sessionEnd: string | null | undefined,
): string | null {
  return parseHHMM(sessionStart) != null && parseHHMM(sessionEnd) != null
    ? `${sessionStart}–${sessionEnd}`
    : null;
}
