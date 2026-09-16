/**
 * Reading "what happened" off the trader's own words.
 *
 * The close used to be eight buttons, three rows of grades, a row of
 * demons and a row of green flags — a form to be worked through after
 * every trade, which is exactly when nobody wants to work through a form.
 * Now it is a sentence or two in a box: "stopped on the wick then it ran
 * to target without me, moved the stop up too early". A model reads the
 * sentence into the same fields the buttons wrote, the fields stay (they
 * are what every breakdown is built on), and the buttons stay too, one
 * click away, as the way to correct a reading.
 *
 * This file is the part that must not trust the model: whatever comes
 * back is filtered to the values the journal actually has. A grade that
 * is not one of the three is no grade; a demon not on the trader's own
 * list is dropped rather than invented; an exit grade on a trade stopped
 * at its original stop is discarded, because the picker would not have
 * offered it either. Nothing said is nothing recorded.
 */
import { GRADES, gradeLabel } from "./grades";
import { HIGHLIGHT_TAXONOMY } from "./highlights";
import { EXIT_REASON_LABELS } from "./metrics";
import { exitReasonEnum, noManagementOutcomeEnum } from "./schema";

export interface CloseRead {
  exitReason: string | null;
  entryGrade: string | null;
  stopGrade: string | null;
  exitGrade: string | null;
  /** Ids on the trader's own demon list. */
  demonIds: number[];
  /** Canonical spellings, from the taxonomy or the journal's own extras. */
  highlights: string[];
  noManagementOutcome: string | null;
}

export const EMPTY_CLOSE_READ: CloseRead = {
  exitReason: null,
  entryGrade: null,
  stopGrade: null,
  exitGrade: null,
  demonIds: [],
  highlights: [],
  noManagementOutcome: null,
};

/** Ways a model says "closed by hand" that are not the enum's word for it. */
const REASON_ALIASES: Record<string, string> = {
  manual: "discretion",
  manual_early: "discretion",
  manual_late: "discretion",
  by_hand: "discretion",
  closed_by_hand: "discretion",
  discretionary: "discretion",
  be: "breakeven",
  break_even: "breakeven",
  trail: "trailed",
  trailing: "trailed",
  trailing_stop: "trailed",
  stopped: "stop",
  stopped_out: "stop",
  stop_loss: "stop",
  tp: "target",
  take_profit: "target",
  hit_target: "target",
  timed: "time",
  time_stop: "time",
  invalidation: "invalidated",
};

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(str).filter((s): s is string => s != null) : [];
const oneOf = (v: unknown, options: readonly string[]): string | null => {
  const s = str(v)?.toLowerCase();
  return s && options.includes(s) ? s : null;
};
const dedupe = <T,>(xs: T[]) => Array.from(new Set(xs));

export function normalizeCloseRead(
  json: unknown,
  demons: { id: number; name: string }[],
  knownHighlights: string[] = [],
): CloseRead {
  const j = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;

  const rawReason = str(j.exitReason)?.toLowerCase().replace(/[\s-]+/g, "_") ?? null;
  const reason = rawReason ? (REASON_ALIASES[rawReason] ?? rawReason) : null;
  const exitReason =
    reason && (exitReasonEnum.options as readonly string[]).includes(reason) ? reason : null;

  const entryGrade = oneOf(j.entryGrade, GRADES.entry);
  const stopGrade = oneOf(j.stopGrade, GRADES.stop);
  // The picker does not ask how a stop-out was timed; neither does this.
  const exitGrade = exitReason === "stop" ? null : oneOf(j.exitGrade, GRADES.exit);

  const demonIds = dedupe(
    list(j.demons ?? j.mistakes)
      .map((n) => demons.find((d) => same(d.name, n))?.id)
      .filter((id): id is number => id != null),
  );

  const pool = dedupe([...HIGHLIGHT_TAXONOMY, ...knownHighlights]);
  const highlights = dedupe(
    list(j.highlights)
      .map((h) => pool.find((p) => same(p, h)))
      .filter((h): h is string => h != null),
  );

  const noManagementOutcome = oneOf(j.noManagementOutcome, noManagementOutcomeEnum.options);

  return { exitReason, entryGrade, stopGrade, exitGrade, demonIds, highlights, noManagementOutcome };
}

export function closeReadEmpty(r: CloseRead): boolean {
  return (
    r.exitReason == null &&
    r.entryGrade == null &&
    r.stopGrade == null &&
    r.exitGrade == null &&
    r.demonIds.length === 0 &&
    r.highlights.length === 0 &&
    r.noManagementOutcome == null
  );
}

const NMO_LABELS: Record<string, string> = {
  target_first: "target first, left alone",
  stop_first: "stop first, left alone",
  undetermined: "undetermined, left alone",
};

/** One line saying what was read, in the words the pickers use. */
export function closeReadSummary(r: CloseRead, demons: { id: number; name: string }[]): string {
  const parts: string[] = [];
  if (r.exitReason) parts.push(EXIT_REASON_LABELS[r.exitReason] ?? r.exitReason);
  for (const [axis, g] of [
    ["entry", r.entryGrade],
    ["stop", r.stopGrade],
    ["exit", r.exitGrade],
  ] as const) {
    if (g) parts.push(`${axis} ${gradeLabel(axis, g)?.toLowerCase() ?? g}`);
  }
  for (const id of r.demonIds) {
    const d = demons.find((x) => x.id === id);
    if (d) parts.push(d.name);
  }
  parts.push(...r.highlights);
  if (r.noManagementOutcome) parts.push(NMO_LABELS[r.noManagementOutcome] ?? r.noManagementOutcome);
  return parts.join(" · ");
}
