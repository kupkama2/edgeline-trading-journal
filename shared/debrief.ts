/**
 * Talking a day through, and the journal filing what was said.
 *
 * Reviewing trade by trade is the chore that gets skipped. Saying what
 * happened — "longed BTC and PUMP, lost both, stops too tight" — is how a
 * trader actually thinks about a day, and it contains everything a review
 * asks for: which trades, what went wrong, what to do differently. So the
 * day can be talked through in one piece of text, and the text is filed:
 *
 *   - each trade it talks about gets the trader's own words as its review
 *     note, plus the grades, the mistakes and the verdict those words say;
 *   - the whole text is kept as the day's note, where the weekly read
 *     finds the lessons;
 *   - and every trade that finished on the day and was NOT talked about is
 *     named, because a debrief that skips the trade you would rather not
 *     think about is the one that most needed writing.
 *
 * The model splits the text and reads it; this file decides what may be
 * believed. A trade reference the model invents is dropped, a mistake not
 * on the trader's list is dropped, and whether a trade was mentioned at all
 * is checked here as well, by name, so a model that skips one cannot make
 * it vanish from the "not talked about" list.
 */
import type { TradeWithTags } from "./schema";
import { normalizeCloseRead, type CloseRead } from "./close-read";
import { computeMetrics } from "./metrics";

/** One of the day's trades, as the model is shown it. */
export interface DebriefTrade {
  ref: string;
  symbol: string;
  direction: string;
  status: string;
  entryPrice: number;
  exitPrice: number | null;
  pnl: number | null;
  r: number | null;
  /** Local wall-clock time of the entry, "14:05". */
  at: string;
}

export interface DebriefEntry {
  tradeId: number;
  /** The trader's own words about this trade, as the review note. */
  note: string;
  read: CloseRead;
  /** "well" for traded well, "tilt" for should not have been taken. */
  verdict: "well" | "tilt" | null;
}

export interface Debrief {
  entries: DebriefEntry[];
  /** The day's lessons, in the trader's words, for the day's note. */
  lessons: string[];
  /** Things the text talks about that are not one of the day's trades. */
  unmatched: string[];
  /** The day's trades nobody said anything about. */
  unmentioned: number[];
}

/** "T1", "T2"… — references the model can only copy, never mistake for prices. */
export const refOf = (i: number) => `T${i + 1}`;

export function debriefTrades(trades: TradeWithTags[]): DebriefTrade[] {
  return trades.map((t, i) => {
    const m = computeMetrics(t);
    const d = new Date(t.entryTime);
    const p = (n: number) => String(n).padStart(2, "0");
    return {
      ref: refOf(i),
      symbol: t.symbol,
      direction: t.direction,
      status: t.status === "cancelled" ? "passed on (not taken)" : t.status,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      pnl: m.actualPnL != null ? Math.round(m.actualPnL * 100) / 100 : null,
      r: m.actualR != null ? Math.round(m.actualR * 100) / 100 : null,
      at: Number.isNaN(d.getTime()) ? "" : `${p(d.getHours())}:${p(d.getMinutes())}`,
    };
  });
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The trades the text names outright: the symbol as a whole word, any case.
 * "Pump" names PUMP; "BTC" names BTC and not WBTC.
 */
export function mentionedByName(text: string, trades: Pick<TradeWithTags, "id" | "symbol">[]): Set<number> {
  const out = new Set<number>();
  for (const t of trades) {
    const sym = t.symbol.trim();
    if (!sym) continue;
    if (new RegExp(`(^|[^A-Za-z0-9])${escape(sym)}($|[^A-Za-z0-9])`, "i").test(text)) out.add(t.id);
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const strs = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

/** What the model said, kept only where it can be believed. */
export function normalizeDebrief(
  json: unknown,
  text: string,
  trades: TradeWithTags[],
  demons: { id: number; name: string }[],
  highlights: string[] = [],
): Debrief {
  const j = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const byRef = new Map(trades.map((t, i) => [refOf(i), t]));
  const seen = new Set<number>();
  const entries: DebriefEntry[] = [];
  for (const raw of Array.isArray(j.trades) ? (j.trades as Record<string, unknown>[]) : []) {
    const t = byRef.get(str(raw?.ref).toUpperCase());
    if (!t || seen.has(t.id)) continue;
    const note = str(raw.note).slice(0, 2000);
    if (!note) continue;
    seen.add(t.id);
    const verdict = raw.verdict === "well" || raw.verdict === "tilt" ? raw.verdict : null;
    entries.push({ tradeId: t.id, note, read: normalizeCloseRead(raw, demons, highlights), verdict });
  }
  // Named in the text but not given words by the model is still mentioned —
  // the check below is about what was SAID, and the name was said.
  const named = mentionedByName(text, trades);
  const unmentioned = trades.filter((t) => !seen.has(t.id) && !named.has(t.id)).map((t) => t.id);
  return {
    entries,
    lessons: strs(j.lessons).slice(0, 10),
    unmatched: strs(j.unmatched).slice(0, 10),
    unmentioned,
  };
}

/**
 * The day's note after a debrief: the text, added to whatever was there,
 * and never twice.
 */
export function mergeDayNote(existing: string | null | undefined, text: string): string {
  const was = (existing ?? "").trim();
  const add = text.trim();
  if (!add || was.includes(add)) return was;
  return was ? `${was}\n\n${add}` : add;
}
