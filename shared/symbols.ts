/**
 * Futures symbol normalization.
 *
 * Brokers/exchanges quote the *specific contract* (e.g. "MNQU6" = Micro E-mini
 * Nasdaq-100, September 2026 expiry). For journaling purposes the underlying
 * instrument is what matters — a micro contract and its full-size sibling
 * (and every expiry month of either) should all roll up as the same symbol
 * so stats, charts, and leaderboards aren't fragmented across "MNQU6",
 * "MNQZ6", "NQZ6", etc.
 *
 * Add more aliases here as needed — this list intentionally starts small.
 */
export const SYMBOL_ALIASES: Record<string, string> = {
  NQ: "NQ",
  MNQ: "NQ",
  ES: "ES",
  MES: "ES",
  YM: "YM",
  MYM: "YM",
  RTY: "RTY",
  M2K: "RTY",
  GC: "GC",
  MGC: "GC",
  CL: "CL",
  MCL: "CL",
};

// Standard CME futures month codes.
const MONTH_CODES = "FGHJKMNQUVXZ";
const CONTRACT_SUFFIX = new RegExp(`^[${MONTH_CODES}]\\d{1,2}$`);

/**
 * Normalize a raw symbol/contract string to its canonical root.
 * "MNQU6" -> "NQ", "ESZ5" -> "ES", "MNQ" -> "NQ", "AAPL" -> "AAPL" (untouched).
 */
export function normalizeSymbol(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = raw.trim().toUpperCase();
  if (!s) return "";

  // Exact alias match (e.g. plain "MNQ" or "NQ").
  if (SYMBOL_ALIASES[s]) return SYMBOL_ALIASES[s];

  // Try stripping a trailing month+year contract code against known roots,
  // longest root first so "MNQ" is checked before "NQ".
  const roots = Object.keys(SYMBOL_ALIASES).sort((a, b) => b.length - a.length);
  for (const root of roots) {
    if (s.startsWith(root)) {
      const rest = s.slice(root.length);
      if (CONTRACT_SUFFIX.test(rest)) {
        return SYMBOL_ALIASES[root];
      }
    }
  }

  return s;
}
