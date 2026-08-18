/**
 * The setups you actually trade, as one-tap chips.
 *
 * Rationale tags were free text extracted from a sentence, which is fine for
 * the long tail and bad for the handful of setups that are most of the book:
 * "61.8", "0.618", "cc" and "CC retest" are one setup spelled four ways, and
 * the Setup breakdown splits it into four rows that each look too small to
 * mean anything. The whole value of that table is sample size.
 *
 * So: a canonical name per setup, plus the spellings that mean it. Typing any
 * alias — by hand, or pulled out of a rationale by the parser — lands on the
 * same tag as tapping the chip. Anything not listed stays exactly as typed;
 * this is a normaliser for the common few, not a whitelist.
 */
export interface SetupTag {
  name: string;
  /** Lowercased spellings that mean this setup. The canonical name is implied. */
  aliases: string[];
  /** Shown under the chip when the alias is what you'd actually say. */
  hint?: string;
}

export const SETUP_TAGS: SetupTag[] = [
  { name: "61.8 Fib", aliases: ["cc", "61.8", "618", "0.618", ".618", "61.8%", "cc retest"], hint: "CC" },
  { name: "Golden Pocket", aliases: ["gp", "goldenpocket", "0.65", "65-70"], hint: "GP" },
  /**
   * 78.6 is deliberately NOT an alias here. It is a different level — the
   * square root of 0.618 — and traders who use both mean both. Folding them
   * would be the same mistake as leaving "cc" and "61.8" apart, run backwards:
   * one row that quietly averages two setups instead of two rows that split
   * one.
   */
  { name: "76.2 Fib", aliases: ["76.2", "762", "0.762", ".762", "76.2%"] },
  { name: "Reclaim", aliases: ["reclaimed", "reclaims", "level reclaim"] },
];

/** alias (lowercased) -> canonical name. Built once, includes the names. */
const CANONICAL = new Map<string, string>();
for (const s of SETUP_TAGS) {
  CANONICAL.set(s.name.toLowerCase(), s.name);
  for (const a of s.aliases) CANONICAL.set(a.toLowerCase(), s.name);
}

/**
 * The canonical spelling of a setup tag, or the input trimmed if we've never
 * heard of it. Never returns empty for non-empty input — an unknown tag is
 * still the user's tag.
 */
export function normalizeSetupTag(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  return CANONICAL.get(t.toLowerCase()) ?? t;
}

/**
 * Normalise a whole list, dropping blanks and duplicates that only differed by
 * spelling. Order is preserved so the first mention stays first — a tag list
 * that reshuffles itself on save reads as data loss even when nothing is lost.
 */
export function normalizeSetupTags(raw: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const n = normalizeSetupTag(r);
    if (!n) continue;
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

/** True when this tag is one of the canonical setups (for chip highlighting). */
export function isKnownSetup(tag: string): boolean {
  return SETUP_TAGS.some((s) => s.name.toLowerCase() === tag.trim().toLowerCase());
}
