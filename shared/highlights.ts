/**
 * Green flags — the mirror of the demon list.
 *
 * A journal that only ever names what went wrong teaches you what to avoid
 * and nothing about what to repeat. Demons answer "what keeps costing me";
 * highlights answer "what did I do exactly right, and does it actually pay".
 * That second question is answerable the moment they are stored: the Analysis
 * breakdown slices by highlight the same way it slices by demon, so "perfect
 * entry" stops being a pat on the back and becomes an expectancy number.
 *
 * Deliberately NOT worth XP. XP rewards actions the journal can verify — a
 * written rationale, a named exit — and a self-awarded gold star is not one
 * of those. Paying for it would quietly teach you to award it.
 *
 * Stored as a JSON string[] on the trade (same convention as rationaleTags),
 * so custom flags need no schema change.
 */
import type { TradeWithTags } from "./schema";

/** The canonical set, ordered by the trade's own timeline. */
export const HIGHLIGHT_TAXONOMY: string[] = [
  "Perfect Entry",
  "Perfect Stop",
  "Perfect Target",
  "Followed The Plan",
  "Waited For The Setup",
  "Sized It Right",
  "Managed It Well",
  "Cut It Fast",
  "Let It Run",
];

/** Read the column back, dropping anything that isn't a non-empty string. */
export function parseHighlights(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s): s is string => typeof s === "string" && s.trim() !== "")
      .map((s) => s.trim());
  } catch {
    return [];
  }
}

/** Serialize for storage; empty means NULL, not "[]". */
export function serializeHighlights(list: string[]): string | null {
  const clean = Array.from(new Set(list.map((s) => s.trim()).filter(Boolean)));
  return clean.length ? JSON.stringify(clean) : null;
}

/**
 * Every flag name in use, canonical ones first, then any custom flags the
 * trades actually carry — so a name typed once keeps being offered.
 */
export function knownHighlights(trades: TradeWithTags[]): string[] {
  const custom = new Set<string>();
  for (const t of trades) {
    for (const h of parseHighlights(t.highlights)) {
      if (!HIGHLIGHT_TAXONOMY.includes(h)) custom.add(h);
    }
  }
  return [...HIGHLIGHT_TAXONOMY, ...Array.from(custom).sort()];
}
