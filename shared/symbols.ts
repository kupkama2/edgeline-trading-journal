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

/**
 * Dollars per one point of price movement, per contract.
 *
 * This is deliberately keyed on the *specific* contract rather than the rolled-
 * up root: MNQ and NQ are the same instrument for grouping purposes (which is
 * why both normalize to "NQ"), but they are emphatically not the same size —
 * $2 a point versus $20. Without this, a 10-point win on 2 micros and on 2
 * e-minis record identical P&L, and the daily-loss guardrail fires at the wrong
 * threshold.
 *
 * Anything absent here — crypto, equities, FX — is 1, i.e. price moves are
 * already denominated in the quote currency and need no scaling.
 */
export const CONTRACT_POINT_VALUES: Record<string, number> = {
  NQ: 20,
  MNQ: 2,
  ES: 50,
  MES: 5,
  YM: 5,
  MYM: 0.5,
  RTY: 50,
  M2K: 5,
  GC: 100,
  MGC: 10,
  CL: 1000,
  MCL: 100,
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

/**
 * Resolve the contract root as *written* — "MNQU6" → "MNQ", not "NQ". This is
 * the half of the symbol that normalizeSymbol deliberately throws away, and the
 * half that determines what a point is worth.
 */
function contractRoot(raw: string): string | null {
  const s = raw.trim().toUpperCase();
  if (!s) return null;
  if (CONTRACT_POINT_VALUES[s] != null) return s;

  // Longest root first so "MNQ" wins over "NQ" on "MNQU6".
  const roots = Object.keys(CONTRACT_POINT_VALUES).sort((a, b) => b.length - a.length);
  for (const root of roots) {
    if (s.startsWith(root) && CONTRACT_SUFFIX.test(s.slice(root.length))) {
      return root;
    }
  }
  return null;
}

/**
 * Dollars per point for a raw symbol as the user typed it. Defaults to 1 for
 * anything that isn't a known futures contract, which is correct: a crypto or
 * equity price move is already in quote currency.
 */
export function pointValueFor(raw: string | null | undefined): number {
  if (!raw) return 1;
  const root = contractRoot(raw);
  return root ? CONTRACT_POINT_VALUES[root] : 1;
}
