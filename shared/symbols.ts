/**
 * Futures contracts: what they roll up to, and what one is actually worth.
 *
 * Brokers quote the *specific contract* ("MNQU6" = Micro E-mini Nasdaq-100,
 * September 2026). Journaling wants two different things from that string and
 * they pull in opposite directions:
 *
 *   the INSTRUMENT, so a micro, its full-size sibling and every expiry month
 *   pool into one set of stats rather than fragmenting across MNQU6/MNQZ6/NQZ6
 *
 *   the SIZE, so 10 points on 2 micros and 10 points on 2 e-minis do not
 *   record identical P&L — $2 a point against $20
 *
 * Hence one table with both, rather than two tables that can drift apart.
 *
 * WHY THE UNIT MATTERS. For anything quoted in dollars per unit of a physical
 * or digital thing — 0.1 BTC, 100 troy ounces, 1,000 barrels — the dollars per
 * point and the units per contract are the SAME NUMBER, because a $1 move on
 * 0.1 BTC is $0.10. That coincidence is what lets three nano contracts be
 * displayed as "0.03 BTC" without storing anything extra. Index futures have
 * no such unit: an NQ point is an index point, and $20 is a multiplier rather
 * than a quantity of something.
 */

export interface ContractSpec {
  /** The root as written — "MBT", not "BTC". */
  root: string;
  /** What it rolls up to for stats and charts. */
  underlying: string;
  /** Dollars per 1.00 of price movement, per contract. */
  pointValue: number;
  /**
   * What one contract holds, when the quote is dollars-per-something. Equal to
   * pointValue by construction; named separately because "0.1 BTC" and "$0.10
   * a point" are the same fact told to two different readers.
   */
  unit?: string;
  /** Human name, for the entry card's confirmation line. */
  label: string;
  /**
   * True when the bare root means something else far more often than it means
   * this contract. "BTC" typed into a crypto journal is spot Bitcoin roughly
   * always and CME's 5-BTC future roughly never, so the future is recognised
   * only when written with a month code (BTCZ6). Getting this wrong scales a
   * position by 5x in silence, which is the worst kind of wrong.
   */
  monthCodeOnly?: boolean;
}

export const CONTRACTS: ContractSpec[] = [
  /* --------------------------- equity index --------------------------- */
  { root: "ES", underlying: "ES", pointValue: 50, label: "E-mini S&P 500" },
  { root: "MES", underlying: "ES", pointValue: 5, label: "Micro S&P 500" },
  { root: "NQ", underlying: "NQ", pointValue: 20, label: "E-mini Nasdaq-100" },
  { root: "MNQ", underlying: "NQ", pointValue: 2, label: "Micro Nasdaq-100" },
  { root: "YM", underlying: "YM", pointValue: 5, label: "E-mini Dow" },
  { root: "MYM", underlying: "YM", pointValue: 0.5, label: "Micro Dow" },
  { root: "RTY", underlying: "RTY", pointValue: 50, label: "E-mini Russell 2000" },
  { root: "M2K", underlying: "RTY", pointValue: 5, label: "Micro Russell 2000" },

  /* ------------------------------ metals ------------------------------ */
  { root: "GC", underlying: "GC", pointValue: 100, unit: "oz", label: "Gold" },
  { root: "MGC", underlying: "GC", pointValue: 10, unit: "oz", label: "Micro Gold" },
  { root: "SI", underlying: "SI", pointValue: 5000, unit: "oz", label: "Silver" },
  { root: "SIL", underlying: "SI", pointValue: 1000, unit: "oz", label: "Micro Silver" },
  { root: "HG", underlying: "HG", pointValue: 25000, unit: "lb", label: "Copper" },
  { root: "MHG", underlying: "HG", pointValue: 2500, unit: "lb", label: "Micro Copper" },
  { root: "PL", underlying: "PL", pointValue: 50, unit: "oz", label: "Platinum" },
  { root: "PA", underlying: "PA", pointValue: 100, unit: "oz", label: "Palladium" },

  /* ------------------------------ energy ------------------------------ */
  { root: "CL", underlying: "CL", pointValue: 1000, unit: "bbl", label: "Crude Oil (WTI)" },
  { root: "MCL", underlying: "CL", pointValue: 100, unit: "bbl", label: "Micro Crude Oil" },
  { root: "BZ", underlying: "BZ", pointValue: 1000, unit: "bbl", label: "Brent Crude" },
  { root: "NG", underlying: "NG", pointValue: 10000, unit: "MMBtu", label: "Natural Gas" },
  { root: "QG", underlying: "NG", pointValue: 2500, unit: "MMBtu", label: "E-mini Natural Gas" },
  { root: "RB", underlying: "RB", pointValue: 42000, unit: "gal", label: "RBOB Gasoline" },
  { root: "HO", underlying: "HO", pointValue: 42000, unit: "gal", label: "Heating Oil" },

  /* ------------------------------ crypto ------------------------------ */
  // Micros and below are unambiguous roots — nothing else is called "MBT".
  { root: "MBT", underlying: "BTC", pointValue: 0.1, unit: "BTC", label: "Micro Bitcoin" },
  { root: "MET", underlying: "ETH", pointValue: 0.1, unit: "ETH", label: "Micro Ether" },
  { root: "MSL", underlying: "SOL", pointValue: 25, unit: "SOL", label: "Micro Solana" },
  { root: "MXP", underlying: "XRP", pointValue: 2500, unit: "XRP", label: "Micro XRP" },
  // The full-size crypto contracts share their ticker with the spot pair, so
  // they only count when a month code says a contract was meant.
  { root: "BTC", underlying: "BTC", pointValue: 5, unit: "BTC", label: "Bitcoin futures", monthCodeOnly: true },
  { root: "ETH", underlying: "ETH", pointValue: 50, unit: "ETH", label: "Ether futures", monthCodeOnly: true },
  { root: "SOL", underlying: "SOL", pointValue: 500, unit: "SOL", label: "Solana futures", monthCodeOnly: true },
  { root: "XRP", underlying: "XRP", pointValue: 50000, unit: "XRP", label: "XRP futures", monthCodeOnly: true },

  /* ----------------------------- rates & FX ---------------------------- */
  { root: "ZB", underlying: "ZB", pointValue: 1000, label: "30-Year T-Bond" },
  { root: "ZN", underlying: "ZN", pointValue: 1000, label: "10-Year T-Note" },
  { root: "ZF", underlying: "ZF", pointValue: 1000, label: "5-Year T-Note" },
  { root: "ZT", underlying: "ZT", pointValue: 2000, label: "2-Year T-Note" },
  { root: "6E", underlying: "6E", pointValue: 125000, unit: "EUR", label: "Euro FX" },
  { root: "6B", underlying: "6B", pointValue: 62500, unit: "GBP", label: "British Pound" },
  { root: "6A", underlying: "6A", pointValue: 100000, unit: "AUD", label: "Australian Dollar" },
  { root: "6C", underlying: "6C", pointValue: 100000, unit: "CAD", label: "Canadian Dollar" },
];

const BY_ROOT = new Map(CONTRACTS.map((c) => [c.root, c]));

/** Roots longest-first, so "MNQ" is tested before "NQ" on "MNQU6". */
const ROOTS_BY_LENGTH = CONTRACTS.map((c) => c.root).sort((a, b) => b.length - a.length);

/** Kept for the settings screen and tests; derived so it cannot drift. */
export const SYMBOL_ALIASES: Record<string, string> = Object.fromEntries(
  CONTRACTS.map((c) => [c.root, c.underlying]),
);
export const CONTRACT_POINT_VALUES: Record<string, number> = Object.fromEntries(
  CONTRACTS.map((c) => [c.root, c.pointValue]),
);

// Standard CME futures month codes.
const MONTH_CODES = "FGHJKMNQUVXZ";
const CONTRACT_SUFFIX = new RegExp(`^[${MONTH_CODES}]\\d{1,2}$`);

/**
 * The contract a raw symbol names, or null when it names none.
 *
 * `withMonthCode` reports whether the string carried an expiry, which is what
 * settles the ambiguous roots: "BTCZ6" is a futures contract, "BTC" is spot.
 */
export function contractFor(raw: string | null | undefined): ContractSpec | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase();
  if (!s) return null;

  const exact = BY_ROOT.get(s);
  if (exact) return exact.monthCodeOnly ? null : exact;

  for (const root of ROOTS_BY_LENGTH) {
    if (!s.startsWith(root)) continue;
    if (CONTRACT_SUFFIX.test(s.slice(root.length))) return BY_ROOT.get(root) ?? null;
  }
  return null;
}

/**
 * Normalize a raw symbol/contract string to its canonical root.
 * "MNQU6" -> "NQ", "MBTZ6" -> "BTC", "MBT" -> "BTC", "AAPL" -> "AAPL".
 */
/**
 * The symbol as the trader actually wrote it.
 *
 * `symbol` is the rollup ("BTC") and `contract` is what was typed ("MBTZ6");
 * the rollup is what keeps the stats merged, and the contract is what the
 * trade actually was. Anywhere a human is shown the symbol for EDITING, this
 * is the honest answer — showing the rollup and saving it back is how "MBTZ6"
 * silently becomes "BTC" and a micro becomes a full-size contract.
 */
/**
 * Split what the trader typed into the instrument and the contract.
 *
 * "MBTZ6" is a contract whose instrument is BTC; "BTCUSDT" is a spot pair with
 * no contract to tell apart. Creating and editing must agree on this, or an
 * edit leaves the old contract attached to a new instrument — so the rule
 * lives here rather than twice in the routes.
 */
export function splitTypedSymbol(raw: string): {
  symbol: string;
  contract: string | null;
} {
  const typed = raw.trim().toUpperCase();
  const isContract = Boolean(contractFor(typed)) || looksLikeFuturesContract(typed);
  return { symbol: normalizeSymbol(typed), contract: isContract ? typed : null };
}

export function typedSymbol(t: {
  symbol: string;
  contract?: string | null;
}): string {
  return t.contract?.trim() || t.symbol;
}

export function normalizeSymbol(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = raw.trim().toUpperCase();
  if (!s) return "";
  const spec = contractFor(s);
  return spec ? spec.underlying : s;
}

/**
 * True when a symbol is written like a futures contract — a root plus a month
 * code — regardless of whether this table has heard of the root.
 *
 * "NANOBITZ6" is unmistakably a contract with an expiry; the journal simply
 * does not know how big one is. That is the moment to ask, and the only moment
 * worth asking: a bare "AAPL" or "BTCUSDT" needs no multiplier and should
 * never be interrupted for one.
 */
export function looksLikeFuturesContract(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const s = raw.trim().toUpperCase();
  // At least two characters of root before the month code, so a stock ticker
  // that happens to end in a letter+digit is not mistaken for a contract.
  return /^[A-Z]{2,}[FGHJKMNQUVXZ]\d{1,2}$/.test(s);
}

/**
 * Dollars per point for a raw symbol as the user typed it.
 *
 * `remembered` is the value this symbol carried last time it was logged, and
 * it wins over the 1.0 default but never over a known contract: a broker's own
 * naming for a nano contract cannot be guessed from a table, but it only has
 * to be told to the journal once. See lastPointValueFor.
 */
export function pointValueFor(
  raw: string | null | undefined,
  remembered?: number | null,
): number {
  const spec = contractFor(raw);
  if (spec) return spec.pointValue;
  if (remembered != null && isFinite(remembered) && remembered > 0) return remembered;
  return 1;
}

/**
 * The key a remembered size is filed under: the CONTRACT root, not the
 * instrument.
 *
 * These must not be the same key. Spot BTC and a nano BTC future both belong
 * to the instrument "BTC" but hold wildly different amounts of it, so filing
 * the remembered size under the instrument would have one overwrite the other
 * and misprice whichever was logged second. Filing it under the contract root
 * keeps "NANOBIT" and "MBT" separate while still collapsing December into
 * March, which is the one thing that SHOULD merge.
 */
export function contractRoot(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = raw.trim().toUpperCase();
  const spec = contractFor(s);
  if (spec) return spec.root;
  const m = /^([A-Z]{2,})[FGHJKMNQUVXZ]\d{1,2}$/.exec(s);
  return m ? m[1] : s;
}

/**
 * What this symbol was worth the last time it was logged.
 *
 * The journal already stores pointValue on every trade, so a contract it has
 * never heard of is still only unknown once — tell it the size on the first
 * nano Bitcoin trade and every later one inherits it. Matching is on the
 * symbol as normalised, so "BITZ6" and "BITH7" are the same contract in
 * different months rather than two strangers.
 */
export function lastPointValueFor(
  raw: string | null | undefined,
  history: {
    symbol: string;
    /** The contract as written, when the row has one. */
    contract?: string | null;
    pointValue?: number | null;
    entryTime: string;
  }[],
): number | null {
  const key = contractRoot(raw);
  if (!key) return null;
  const seen = history
    // Rows written before the instrument/contract split have no contract, so
    // their symbol is the best available answer for what was typed.
    .filter((t) => contractRoot(t.contract || t.symbol) === key)
    .filter((t) => t.pointValue != null && isFinite(t.pointValue) && t.pointValue > 0)
    .sort((a, b) => b.entryTime.localeCompare(a.entryTime));
  return seen.length ? (seen[0].pointValue as number) : null;
}

/**
 * How much of the underlying a position actually holds — "3 contracts = 0.3
 * BTC". Null when the instrument has no such unit (an index future) or when
 * the symbol is not a contract at all, because inventing a unit for a Nasdaq
 * position would be worse than saying nothing.
 */
export function exposureOf(
  raw: string | null | undefined,
  contracts: number,
  pointValue?: number | null,
): { qty: number; unit: string; label: string } | null {
  const spec = contractFor(raw);
  if (!spec?.unit) return null;
  if (!isFinite(contracts) || contracts <= 0) return null;
  // The stored pointValue wins: a trade logged before a table change keeps
  // the arithmetic it was booked with.
  const per = pointValue != null && isFinite(pointValue) && pointValue > 0
    ? pointValue
    : spec.pointValue;
  return { qty: contracts * per, unit: spec.unit, label: spec.label };
}

/** Pretty-print an exposure without trailing-zero noise: 0.3 BTC, 0.03 BTC. */
export function fmtExposure(e: { qty: number; unit: string } | null): string | null {
  if (!e) return null;
  const dp = e.qty >= 100 ? 0 : e.qty >= 1 ? 2 : e.qty >= 0.01 ? 3 : 5;
  const fixed = e.qty.toFixed(dp);
  // Strip padding only when there is a decimal point to strip it from —
  // otherwise the same regex turns 1000 barrels into 1.
  const n = fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
  return `${n} ${e.unit}`;
}
