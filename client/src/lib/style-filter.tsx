import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { TradeWithTags, TradingStyle } from "@shared/schema";

/**
 * What the whole app is currently looking at.
 *
 * Two independent axes, because they answer different questions and a trader
 * asks both. The STYLE is the strategy — scalps and swings have different hold
 * times and R profiles, and pooling them produces an average that describes
 * neither. The ACCOUNT is where it ran — the same strategy on a funded eval
 * and on live money is the same edge under different rules, and a prop
 * account's drawdown limit only cares about its own trades.
 *
 * Either, both, or neither. Crossing them ("swings, but only on Apex") is the
 * combination that makes a per-account risk limit checkable, and it falls out
 * for free once the two are separate rather than one merged picker.
 *
 * null on an axis means "all" — a read-only overview rather than a selection.
 */
const STYLE_KEY = "edgeline.activeStyleIds";
const ACCOUNT_KEY = "edgeline.activeAccounts";
/** The single-value keys this replaced; read once, then retired. */
const LEGACY_STYLE_KEY = "edgeline.activeStyleId";
const LEGACY_ACCOUNT_KEY = "edgeline.activeAccount";

export interface Scope {
  /** Empty means every style — a selection of none is not a filter of none. */
  styleIds: number[];
  accounts: string[];
}

export const EMPTY_SCOPE: Scope = { styleIds: [], accounts: [] };

const StyleCtx = createContext<{
  scope: Scope;
  toggleStyle: (id: number) => void;
  toggleAccount: (a: string) => void;
  clearStyles: () => void;
  clearAccounts: () => void;
  /**
   * The one style in scope, or null when that question has no single answer.
   *
   * Filtering is a set; WRITING is not. A new trade belongs to exactly one
   * book, and "which one" is only answerable when exactly one is selected —
   * with three selected, or none, the entry card falls back to its own
   * default rather than picking arbitrarily on your behalf.
   */
  activeStyleId: number | null;
  activeAccount: string | null;
}>({
  scope: EMPTY_SCOPE,
  toggleStyle: () => {},
  toggleAccount: () => {},
  clearStyles: () => {},
  clearAccounts: () => {},
  activeStyleId: null,
  activeAccount: null,
});

function readList<T>(key: string, parse: (raw: string) => T | null): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => parse(String(x))).filter((x): x is T => x != null);
  } catch {
    return [];
  }
}

function readStyles(): number[] {
  const stored = readList(STYLE_KEY, (r) => {
    const n = Number(r);
    return Number.isInteger(n) ? n : null;
  });
  if (stored.length) return stored;
  // One-time carry-over from the single-select era.
  const legacy = Number(localStorage.getItem(LEGACY_STYLE_KEY));
  localStorage.removeItem(LEGACY_STYLE_KEY);
  return Number.isInteger(legacy) && legacy ? [legacy] : [];
}

function readAccounts(): string[] {
  const stored = readList(ACCOUNT_KEY, (r) => r.trim() || null);
  if (stored.length) return stored;
  const legacy = localStorage.getItem(LEGACY_ACCOUNT_KEY);
  localStorage.removeItem(LEGACY_ACCOUNT_KEY);
  return legacy ? [legacy] : [];
}

/** In or out, preserving the order the chips were picked in. */
export function toggleStyleIn(cur: number[], id: number): number[] {
  return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
}

/**
 * Same, for the free-text account column. Membership is compared the way the
 * filter compares it, so clicking a chip that reads "Apex eval" turns off a
 * stored "apex eval " rather than selecting it a second time.
 */
export function toggleAccountIn(cur: string[], account: string): string[] {
  return cur.some((x) => sameAccount(x, account))
    ? cur.filter((x) => !sameAccount(x, account))
    : [...cur, account];
}

export function StyleFilterProvider({ children }: { children: React.ReactNode }) {
  const [styleIds, setStyleIds] = useState<number[]>(readStyles);
  const [accounts, setAccounts] = useState<string[]>(readAccounts);

  useEffect(() => {
    if (styleIds.length === 0) localStorage.removeItem(STYLE_KEY);
    else localStorage.setItem(STYLE_KEY, JSON.stringify(styleIds));
  }, [styleIds]);

  useEffect(() => {
    if (accounts.length === 0) localStorage.removeItem(ACCOUNT_KEY);
    else localStorage.setItem(ACCOUNT_KEY, JSON.stringify(accounts));
  }, [accounts]);

  const value = useMemo(() => {
    const scope: Scope = { styleIds, accounts };
    return {
      scope,
      toggleStyle: (id: number) => setStyleIds((cur) => toggleStyleIn(cur, id)),
      toggleAccount: (a: string) => setAccounts((cur) => toggleAccountIn(cur, a)),
      clearStyles: () => setStyleIds([]),
      clearAccounts: () => setAccounts([]),
      activeStyleId: styleIds.length === 1 ? styleIds[0] : null,
      activeAccount: accounts.length === 1 ? accounts[0] : null,
    };
  }, [styleIds, accounts]);

  return <StyleCtx.Provider value={value}>{children}</StyleCtx.Provider>;
}

export const useStyleFilter = () => useContext(StyleCtx);

/** Free-text account names, compared the way a human would read them. */
export const sameAccount = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/** Trades belonging to `styleId`, or every trade when it is null ("All"). */
export function filterByStyle<T extends { styleId: number | null }>(
  trades: T[],
  styleId: number | null,
): T[] {
  if (styleId == null) return trades;
  return trades.filter((t) => t.styleId === styleId);
}

/**
 * Both axes, each a set. A trade has to satisfy every axis that has a
 * selection, and an axis with nothing selected constrains nothing — so
 * "neither" is the whole log rather than an empty page.
 */
export function filterByScope<T extends { styleId: number | null; account?: string | null }>(
  trades: T[],
  scope: Scope,
): T[] {
  let out = trades;
  if (scope.styleIds.length) {
    out = out.filter((t) => t.styleId != null && scope.styleIds.includes(t.styleId));
  }
  if (scope.accounts.length) {
    out = out.filter((t) => scope.accounts.some((a) => sameAccount(a, t.account)));
  }
  return out;
}

/**
 * Every account name in use, for the picker. Trimmed, deduped, sorted.
 *
 * When one account has been typed two ways the FIRST spelling wins rather than
 * the last, so the chip does not rename itself as more trades load — matching
 * is case-insensitive either way, so the choice is cosmetic and stability is
 * the only thing to optimise for.
 */
export function knownAccounts(trades: { account?: string | null }[]): string[] {
  const seen = new Map<string, string>();
  for (const t of trades) {
    const raw = t.account?.trim();
    if (raw && !seen.has(raw.toLowerCase())) seen.set(raw.toLowerCase(), raw);
  }
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
}

/** Scope the page to whatever the filter bar currently says. */
export function useScopedTrades(trades: TradeWithTags[]): TradeWithTags[] {
  const { scope } = useStyleFilter();
  return useMemo(() => filterByScope(trades, scope), [trades, scope]);
}

/** Older name, kept so nothing has to change to keep working. */
export const useStyleScopedTrades = useScopedTrades;

export function styleName(styles: TradingStyle[], id: number | null): string {
  if (id == null) return "Unassigned";
  return styles.find((s) => s.id === id)?.name ?? "Unassigned";
}

/** Tailwind classes per style colour, kept small and explicit for JIT safety. */
export const STYLE_COLORS: Record<string, { dot: string; chip: string }> = {
  amber: { dot: "bg-amber-500", chip: "border-amber-500/40 bg-amber-500/10 text-amber-400" },
  violet: { dot: "bg-violet-500", chip: "border-violet-500/40 bg-violet-500/10 text-violet-400" },
  emerald: { dot: "bg-emerald-500", chip: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400" },
  sky: { dot: "bg-sky-500", chip: "border-sky-500/40 bg-sky-500/10 text-sky-400" },
  rose: { dot: "bg-rose-500", chip: "border-rose-500/40 bg-rose-500/10 text-rose-400" },
  slate: { dot: "bg-slate-500", chip: "border-slate-500/40 bg-slate-500/10 text-slate-400" },
};

export const STYLE_COLOR_NAMES = Object.keys(STYLE_COLORS);

export const styleColor = (color: string | undefined) =>
  STYLE_COLORS[color ?? "slate"] ?? STYLE_COLORS.slate;
