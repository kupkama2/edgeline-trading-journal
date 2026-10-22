/**
 * A trade's note, read into its fields once the trade is closed, and read
 * again whenever the note changes after that.
 *
 * The note is the one place a trade is described in your own words — the why
 * when it opened, the management, the exit, the second look (shared/notes.ts)
 * — and the fields are what every breakdown runs on: the grades, the exit
 * reason, the demons and highlights, traded well or tilt, what the untouched
 * plan would have done. While the trade is open the note is still being
 * written, so nothing is read from it until it closes.
 *
 * Two things make the read safe to repeat:
 *
 *   - It never touches what you set yourself. A field counts as the read's
 *     only while it is empty or still holds what the last read put there;
 *     correct it by hand and it is yours from then on.
 *   - A changed note replaces what the last read said. "Actually it went
 *     lower, so the stop was good" takes back the "tight" the first version
 *     earned, or editing a note would change nothing.
 *
 * What the read set is kept on the trade (noteRead) with a fingerprint of the
 * text it read, so an unchanged note is never read twice.
 */
import type { CloseRead } from "./close-read";
import { parseHighlights, serializeHighlights } from "./highlights";

export const NOTE_FIELDS = ["entryGrade", "stopGrade", "exitGrade", "exitReason", "noManagementOutcome"] as const;
type Field = (typeof NOTE_FIELDS)[number];
type Verdict = "well" | "poorly" | "tilt";

export interface NoteReadRecord {
  /** Fingerprint of the note as read. */
  hash: string;
  at: string;
  /** What this read wrote: a field it left alone is absent. */
  set: Partial<Record<Field, string>> & { demonIds: number[]; highlights?: string[]; verdict?: Verdict };
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
  status?: string | null;
  notes?: string | null;
  noteRead?: string | null;
  highlights?: string | null;
  wellTraded?: boolean | null;
  tradedPoorly?: boolean | null;
  tilt?: boolean | null;
  mistakeTagIds: number[];
};

/** A closed trade whose note has words and has not been read as it now stands. */
export function noteNeedsRead(t: Graded): boolean {
  if (t.status !== "closed") return false;
  const note = t.notes?.trim();
  if (!note) return false;
  return parseNoteRead(t.noteRead)?.hash !== noteHash(note);
}

const verdictOf = (t: Graded): Verdict | null =>
  t.tilt ? "tilt" : t.wellTraded ? "well" : t.tradedPoorly ? "poorly" : null;

/** Drop what the last read added to a list, keep what you added, add what this read finds. */
function mergeList<T>(now: T[], earlier: T[], found: T[]): { next: T[]; added: T[] } {
  const kept = now.filter((x) => !earlier.includes(x));
  const added = found.filter((x) => !kept.includes(x));
  return { next: [...kept, ...added], added };
}
const sameSet = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * What to write for one read: the field patch, the demon list when it
 * changes, and the record of what this read set.
 */
export function applyNoteRead(
  t: Graded,
  read: Pick<CloseRead, Field | "demonIds" | "highlights"> & { verdict?: Verdict | null },
  at: string,
): {
  patch: Partial<Record<Field, string | null>> & {
    noteRead: string;
    highlights?: string | null;
    wellTraded?: boolean;
    tradedPoorly?: boolean;
    tilt?: boolean;
  };
  mistakeTagIds: number[] | undefined;
  record: NoteReadRecord;
} {
  const prev = parseNoteRead(t.noteRead);
  const patch: Record<string, unknown> = {};
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

  // Traded well and tilt are one answer (shared/well-traded.ts), read as one.
  const nowV = verdictOf(t);
  if (nowV == null || nowV === (prev?.set.verdict ?? null)) {
    const nextV = read.verdict ?? null;
    if (nextV !== nowV) {
      patch.wellTraded = nextV === "well";
      patch.tradedPoorly = nextV === "poorly";
      patch.tilt = nextV === "tilt";
    }
    if (nextV) set.verdict = nextV;
  }

  const demons = mergeList(t.mistakeTagIds, prev?.set.demonIds ?? [], read.demonIds);
  set.demonIds = demons.added;

  const hlNow = parseHighlights(t.highlights ?? null);
  const hl = mergeList(hlNow, prev?.set.highlights ?? [], read.highlights ?? []);
  if (hl.added.length) set.highlights = hl.added;
  if (!sameSet(hl.next, hlNow)) patch.highlights = serializeHighlights(hl.next);

  const record: NoteReadRecord = { hash: noteHash(t.notes ?? ""), at, set };
  return {
    patch: { ...(patch as any), noteRead: JSON.stringify(record) },
    mistakeTagIds: sameSet(demons.next, t.mistakeTagIds) ? undefined : demons.next,
    record,
  };
}
