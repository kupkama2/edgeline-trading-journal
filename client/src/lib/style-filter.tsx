import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { TradeWithTags, TradingStyle } from "@shared/schema";

/**
 * The active trading style scopes almost everything the app shows: trade lists,
 * daily stats, demon streaks and the guardrail lock. `null` means "All styles"
 * — a read-only overview, since pooled numbers across a scalping book and a
 * swing book aren't comparable.
 */
const STORAGE_KEY = "edgeline.activeStyleId";

const StyleCtx = createContext<{
  activeStyleId: number | null;
  setActiveStyleId: (id: number | null) => void;
}>({ activeStyleId: null, setActiveStyleId: () => {} });

function readStored(): number | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

export function StyleFilterProvider({ children }: { children: React.ReactNode }) {
  const [activeStyleId, setActiveStyleId] = useState<number | null>(readStored);

  useEffect(() => {
    if (activeStyleId == null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(activeStyleId));
  }, [activeStyleId]);

  const value = useMemo(
    () => ({ activeStyleId, setActiveStyleId }),
    [activeStyleId],
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

/** Convenience for the common "scope the journal to the active style" case. */
export function useStyleScopedTrades(trades: TradeWithTags[]): TradeWithTags[] {
  const { activeStyleId } = useStyleFilter();
  return useMemo(() => filterByStyle(trades, activeStyleId), [trades, activeStyleId]);
}

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
