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
const STYLE_KEY = "edgeline.activeStyleId";
const ACCOUNT_KEY = "edgeline.activeAccount";

export interface Scope {
  styleId: number | null;
  account: string | null;
}

const StyleCtx = createContext<{
  activeStyleId: number | null;
  setActiveStyleId: (id: number | null) => void;
  activeAccount: string | null;
  setActiveAccount: (a: string | null) => void;
  scope: Scope;
}>({
  activeStyleId: null,
  setActiveStyleId: () => {},
  activeAccount: null,
  setActiveAccount: () => {},
  scope: { styleId: null, account: null },
});

function readStored(): number | null {
  const raw = localStorage.getItem(STYLE_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

export function StyleFilterProvider({ children }: { children: React.ReactNode }) {
  const [activeStyleId, setActiveStyleId] = useState<number | null>(readStored);
  const [activeAccount, setActiveAccount] = useState<string | null>(
    () => localStorage.getItem(ACCOUNT_KEY) || null,
  );

  useEffect(() => {
    if (activeStyleId == null) localStorage.removeItem(STYLE_KEY);
    else localStorage.setItem(STYLE_KEY, String(activeStyleId));
  }, [activeStyleId]);

  useEffect(() => {
    if (!activeAccount) localStorage.removeItem(ACCOUNT_KEY);
    else localStorage.setItem(ACCOUNT_KEY, activeAccount);
  }, [activeAccount]);

  const value = useMemo(
    () => ({
      activeStyleId,
      setActiveStyleId,
      activeAccount,
      setActiveAccount,
      scope: { styleId: activeStyleId, account: activeAccount },
    }),
    [activeStyleId, activeAccount],
  );
  return <StyleCtx.Provider value={value}>{children}</StyleCtx.Provider>;
}

export const useStyleFilter = () => useContext(StyleCtx);

/** Trades belonging to `styleId`, or every trade when it is null ("All"). */
export function filterByStyle<T extends { styleId: number | null }>(
  trades: T[],
  styleId: number | null,
): T[] {
  if (styleId == null) return trades;
  return trades.filter((t) => t.styleId === styleId);
}

/**
 * Both axes at once. Account matching is trimmed and case-insensitive because
 * the column is free text — "Apex Eval" and "apex eval " are one account that
 * happens to have been typed twice.
 */
export function filterByScope<T extends { styleId: number | null; account?: string | null }>(
  trades: T[],
  scope: Scope,
): T[] {
  let out = filterByStyle(trades, scope.styleId);
  if (scope.account) {
    const want = scope.account.trim().toLowerCase();
    out = out.filter((t) => (t.account ?? "").trim().toLowerCase() === want);
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
