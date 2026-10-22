/**
 * A trade's review note, read into its fields, and read again when it changes.
 *
 * The note is where a trade gets judged in your own words, and the fields —
 * the grades, the exit reason, the demons — are what every breakdown runs on.
 * The read fills them from the words. Two things make that safe to repeat:
 *
 *   - It never touches what you set yourself. A field counts as the read's
 *     only while it still holds what the last read put there; change it by
 *     hand and it is yours from then on.
 *   - A changed note replaces what the last read said. "Actually it went
 *     lower, so the stop was good" has to take back the "tight" the first
 *     version earned, or editing a note would change nothing.
 *
 * What the read set is kept on the trade (noteRead) with a fingerprint of the
 * text it read, so an unchanged note is never read twice and a changed one is
 * always read again.
 */
import type { CloseRead } from "./close-read";

export const NOTE_FIELDS = ["entryGrade", "stopGrade", "exitGrade", "exitReason"] as const;
type Field = (typeof NOTE_FIELDS)[number];

export interface NoteReadRecord {
  /** Fingerprint of the note as read. */
  hash: string;
  at: string;
  /** What this read wrote: a field it left alone is absent. */
  set: Partial<Record<Field, string>> & { demonIds: number[] };
}

/** FNV-1a over the trimmed text: enough to tell an edited note from the same one. */
export function noteHash(text: string): string {
  let h = 0x811c9dc5;
  const s = text.trim();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function parseNoteRead(raw: string | null | undefined): NoteReadRecord | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j.hash !== "string" || !j.set || !Array.isArray(j.set.demonIds)) return null;
    return j as NoteReadRecord;
  } catch {
    return null;
  }
}

type Graded = { [K in Field]?: string | null } & {
  reviewNote?: string | null;
  noteRead?: string | null;
  mistakeTagIds: number[];
};

/** A note that has words and has not been read as it now stands. */
export function noteNeedsRead(t: Graded): boolean {
  const note = t.reviewNote?.trim();
  if (!note) return false;
  return parseNoteRead(t.noteRead)?.hash !== noteHash(note);
}

/**
 * What to write for one read: the field patch, the demon list when it
 * changes, and the record of what this read set.
 */
export function applyNoteRead(
  t: Graded,
  read: Pick<CloseRead, Field | "demonIds">,
  at: string,
): {
  patch: Partial<Record<Field, string | null>> & { noteRead: string };
  mistakeTagIds: number[] | undefined;
  record: NoteReadRecord;
} {
  const prev = parseNoteRead(t.noteRead);
  const patch: Partial<Record<Field, string | null>> = {};
  const set: NoteReadRecord["set"] = { demonIds: [] };

  for (const f of NOTE_FIELDS) {
    const now = t[f] ?? null;
    const before = prev?.set[f] ?? null;
    // The read's to change while it is empty or still holds the last read's value.
    const ours = now == null || (before != null && now === before);
    if (!ours) continue;
    const next = read[f] ?? null;
    if (next != null) {
      if (next !== now) patch[f] = next;
      set[f] = next;
    } else if (now != null) {
      // The last read set it and the note no longer says so.
      patch[f] = null;
    }
  }

  // Demons: drop what the last read added, then add what this one finds.
  const earlier = new Set(prev?.set.demonIds ?? []);
  const kept = t.mistakeTagIds.filter((id) => !earlier.has(id));
  const added = read.demonIds.filter((id) => !kept.includes(id));
  const next = [...kept, ...added];
  set.demonIds = added;
  const same = next.length === t.mistakeTagIds.length && next.every((id) => t.mistakeTagIds.includes(id));

  const record: NoteReadRecord = { hash: noteHash(t.reviewNote ?? ""), at, set };
  return {
    patch: { ...patch, noteRead: JSON.stringify(record) },
    mistakeTagIds: same ? undefined : next,
    record,
  };
}
