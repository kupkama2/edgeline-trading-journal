/**
 * The pre-trade gate: the questions before every entry. Any red answer, no trade.
 *
 * The questions are the trader's own (editable in Settings), each with the
 * answer that is "green". One is inverted on purpose — "Would I want to
 * enter where my stop is?" is green on No: if you would buy there, the stop
 * is in the wrong place. The answers are stamped on the trade, so the
 * record can say which trades went in against the gate and what they cost.
 */
import { z } from "zod";

export interface GateQuestion {
  id: string;
  text: string;
  /** A line under the question, when the right answer needs saying. */
  hint?: string;
  /** Which answer is green. */
  good: "yes" | "no";
}

export const DEFAULT_GATE_QUESTIONS: GateQuestion[] = [
  { id: "calm", text: "Am I calm right now?", good: "yes" },
  { id: "planned", text: "Did I plan this trade?", good: "yes" },
  { id: "entry", text: "Is this a good entry?", good: "yes" },
  { id: "stop", text: "Would I want to enter where my stop is?", hint: "Right answer is No. If you'd buy there, the stop is in the wrong place.", good: "no" },
  { id: "bias", text: "Am I with my directional bias?", good: "yes" },
  { id: "loss", text: "If I lose this trade, would I still consider it a good trade?", good: "yes" },
  { id: "size", text: "Is my size right for this stop?", hint: "Sized from the stop and the risk per trade, not from how sure it feels.", good: "yes" },
];

/**
 * Default questions added after people had already saved their own lists.
 * Each is put at the end of a saved list once; `offered` remembers it, so a
 * question deleted afterwards stays deleted.
 */
const LATER_DEFAULTS = ["size"];

export interface GateSettings {
  questions: GateQuestion[];
  /** The gate over the entry card: hard — the form stays shut until every answer is green. */
  entryCard: boolean;
  /** Send in the terminal needs a green gate for the symbol, good for ten minutes. */
  terminal: boolean;
  /** A position the tracker found asks the questions after the fact. */
  tracked: boolean;
  /** Later default questions already offered to this list (see LATER_DEFAULTS). */
  offered?: string[];
}

export const DEFAULT_GATE: GateSettings = { questions: DEFAULT_GATE_QUESTIONS, entryCard: true, terminal: true, tracked: true, offered: LATER_DEFAULTS };

/** A saved list with the later defaults it has not been offered yet, at the end. */
function withLaterDefaults(g: GateSettings): GateSettings {
  const offered = new Set(g.offered ?? []);
  const fresh = LATER_DEFAULTS.filter((id) => !offered.has(id));
  if (!fresh.length) return g;
  const have = new Set(g.questions.map((q) => q.id));
  const add = DEFAULT_GATE_QUESTIONS.filter((q) => fresh.includes(q.id) && !have.has(q.id));
  return { ...g, questions: [...g.questions, ...add].slice(0, 20), offered: [...Array.from(offered), ...fresh] };
}

const questionSchema = z.object({
  id: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/),
  text: z.string().min(1).max(200),
  hint: z.string().max(300).optional(),
  good: z.enum(["yes", "no"]),
});
export const gateSettingsSchema = z.object({
  questions: z.array(questionSchema).min(1).max(20),
  entryCard: z.boolean(),
  terminal: z.boolean(),
  tracked: z.boolean(),
  offered: z.array(z.string().max(40)).max(50).optional(),
});
export const gateSettingsPatchSchema = gateSettingsSchema.partial().strict();

/** Stored settings, read leniently: anything malformed takes its default. */
export function readGate(raw: unknown): GateSettings {
  const r = gateSettingsSchema.safeParse(raw);
  if (r.success) return withLaterDefaults(r.data);
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const qs = z.array(questionSchema).safeParse(o.questions);
  const offered = z.array(z.string()).safeParse(o.offered);
  return withLaterDefaults({
    questions: qs.success && qs.data.length ? qs.data : DEFAULT_GATE_QUESTIONS,
    entryCard: typeof o.entryCard === "boolean" ? o.entryCard : DEFAULT_GATE.entryCard,
    terminal: typeof o.terminal === "boolean" ? o.terminal : DEFAULT_GATE.terminal,
    tracked: typeof o.tracked === "boolean" ? o.tracked : DEFAULT_GATE.tracked,
    // A list that fell back to the defaults has every default already.
    offered: qs.success && qs.data.length ? (offered.success ? offered.data : []) : LATER_DEFAULTS,
  });
}

/** What a trade carries: each answer as given, when, and whether it was skipped. */
export interface GateRecord {
  at: string;
  answers: Record<string, "yes" | "no">;
  /** Skipped counts as every answer red; the record says so rather than hides it. */
  skipped?: boolean;
  /** Where it was answered. */
  where: "entry-card" | "terminal" | "tracked";
}

export const gateRecordSchema = z.object({
  at: z.string(),
  answers: z.record(z.string(), z.enum(["yes", "no"])),
  skipped: z.boolean().optional(),
  where: z.enum(["entry-card", "terminal", "tracked"]),
});

export function parseGate(raw: string | null | undefined): GateRecord | null {
  if (!raw) return null;
  try {
    const r = gateRecordSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export const formatGate = (g: GateRecord) => JSON.stringify(g);

/** The questions answered red, by id. A skipped gate is red on all of them. */
export function redAnswers(questions: GateQuestion[], g: GateRecord | null): string[] {
  if (!g) return [];
  if (g.skipped) return questions.map((q) => q.id);
  return questions.filter((q) => g.answers[q.id] != null && g.answers[q.id] !== q.good).map((q) => q.id);
}

/** Green: every question answered, and every answer the good one. */
export function gatePassed(questions: GateQuestion[], g: GateRecord | null): boolean {
  if (!g || g.skipped) return false;
  return questions.every((q) => g.answers[q.id] === q.good);
}

/** How many have no answer yet — the count on a gate asked after the fact, where red is an answer too. */
export function gateUnanswered(questions: GateQuestion[], answers: Record<string, "yes" | "no">): number {
  return questions.filter((q) => answers[q.id] == null).length;
}

/** How many are still to answer, or answered red — the "6 left" of the card. */
export function gateLeft(questions: GateQuestion[], answers: Record<string, "yes" | "no">): number {
  return questions.filter((q) => answers[q.id] !== q.good).length;
}

/**
 * The gate's record across closed trades: how the trades that passed did
 * against the trades that did not, and which question went red most.
 */
export function gateReport(
  questions: GateQuestion[],
  trades: { gate?: string | null; status: string; r: number | null }[],
): { passed: { n: number; avgR: number | null }; failed: { n: number; avgR: number | null }; unanswered: number; red: { id: string; text: string; n: number }[] } {
  const passed: number[] = [];
  const failed: number[] = [];
  let unanswered = 0;
  const redCount = new Map<string, number>();
  for (const t of trades) {
    if (t.status !== "closed") continue;
    const g = parseGate(t.gate);
    if (!g) {
      unanswered += 1;
      continue;
    }
    const reds = redAnswers(questions, g);
    for (const id of reds) redCount.set(id, (redCount.get(id) ?? 0) + 1);
    if (t.r == null) continue;
    (reds.length === 0 ? passed : failed).push(t.r);
  }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    passed: { n: passed.length, avgR: avg(passed) },
    failed: { n: failed.length, avgR: avg(failed) },
    unanswered,
    red: questions.map((q) => ({ id: q.id, text: q.text, n: redCount.get(q.id) ?? 0 })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n),
  };
}
