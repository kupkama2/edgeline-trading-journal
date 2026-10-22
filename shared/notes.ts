/**
 * One note per trade.
 *
 * The why when it opened, what happened while it ran, how it ended, what it
 * looks like a week later — one text, added to as the trade goes. Everything
 * else that used to be picked by hand is read out of it once the trade is
 * closed (shared/note-read.ts).
 *
 * `rationale` survives as a derived field: the note's first paragraph, which
 * is where the why is written when the trade is opened. Everything that asks
 * "was the why written down" — the XP, the coach, the scorecard, setup tags —
 * keeps asking it of the same column, and gets the answer from the note.
 */

/** The why: the note's first paragraph, as written when the trade opened. */
export function whyOf(notes: string | null | undefined): string | null {
  const text = notes?.trim();
  if (!text) return null;
  const first = text.split(/\n\s*\n/)[0].trim();
  return first ? first.slice(0, 500) : null;
}

/** Join pieces of a note, skipping blanks and anything already in it. */
export function joinNote(...parts: (string | null | undefined)[]): string | null {
  let out = "";
  for (const p of parts) {
    const t = p?.trim();
    if (!t || out.includes(t)) continue;
    out = out ? `${out}\n\n${t}` : t;
  }
  return out || null;
}

/**
 * The note fields a write should carry, given the fields it sent and the row
 * as it stood. A writer that still sends the old fields — the why on its own,
 * a separate review note — has them folded into the one note rather than
 * kept apart.
 */
export function noteFields(
  patch: { notes?: string | null; rationale?: string | null; reviewNote?: string | null },
  before: { notes?: string | null } | null = null,
): { notes?: string | null; rationale?: string | null; reviewNote?: null } {
  const out: { notes?: string | null; rationale?: string | null; reviewNote?: null } = {};
  let notes: string | null | undefined = "notes" in patch ? (patch.notes?.trim() || null) : undefined;

  if ("rationale" in patch && patch.rationale?.trim() && notes === undefined) {
    // The why sent alone: it opens the note when there is none yet.
    const existing = before?.notes?.trim() || null;
    if (!existing) notes = patch.rationale.trim();
  }
  if ("reviewNote" in patch) {
    if (patch.reviewNote?.trim()) notes = joinNote(notes ?? before?.notes ?? null, patch.reviewNote);
    out.reviewNote = null;
  }
  if (notes !== undefined) {
    out.notes = notes;
    out.rationale = whyOf(notes);
  }
  return out;
}
