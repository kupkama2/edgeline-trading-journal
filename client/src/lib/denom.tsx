import { createContext, useContext, useMemo, useState } from "react";
import { DollarSign, Ruler } from "lucide-react";
import { store } from "@/lib/scoped-storage";
import { fmtMoney, fmtR } from "@shared/metrics";

/**
 * R or dollars — which unit the statistics are read in.
 *
 * These are not two renderings of one number. R divides the position size
 * out; dollars multiply it back in. So they agree only when the size never
 * varies, and everywhere they disagree the disagreement is itself the finding:
 * "+0.4R a trade but −$900 overall" says the losing trades were the big ones,
 * and neither figure says that on its own.
 *
 * R stays the default because it is the unit the journal is kept in and the
 * only one in which two trades on different instruments are comparable. But
 * the broker's statement is in dollars, and "am I actually making money" is a
 * question about dollars, so the switch has to be one click and it has to
 * apply everywhere at once rather than card by card.
 *
 * A device preference, not a record: it is remembered per account like the
 * filters are, and changing it changes nothing about any trade.
 */
export type Denom = "R" | "USD";

const KEY = "edgeline.denom";

const DenomCtx = createContext<{ denom: Denom; setDenom: (d: Denom) => void }>({
  denom: "R",
  setDenom: () => {},
});

export function DenomProvider({ children }: { children: React.ReactNode }) {
  const [denom, set] = useState<Denom>(() => (store.get(KEY) === "USD" ? "USD" : "R"));
  const value = useMemo(
    () => ({
      denom,
      setDenom: (d: Denom) => {
        set(d);
        store.set(KEY, d);
      },
    }),
    [denom],
  );
  return <DenomCtx.Provider value={value}>{children}</DenomCtx.Provider>;
}

export function useDenom() {
  return useContext(DenomCtx);
}

/**
 * One figure, in whichever unit is switched on.
 *
 * Both values are supplied by the caller rather than derived here, because
 * there is no general conversion: the dollars behind an R depend on what that
 * particular trade risked, and only the caller knows whether it is holding one
 * trade's R, an average across trades of different sizes, or a total. A helper
 * that multiplied by "a typical 1R" would produce a number that looks right
 * and is not.
 *
 * A null on the side being asked for renders as an em-dash rather than
 * falling back to the other unit — silently answering in R a question asked
 * in dollars is worse than not answering.
 */
export function useFig() {
  const { denom } = useDenom();
  return (r: number | null | undefined, usd: number | null | undefined) =>
    denom === "USD" ? fmtMoney(usd) : fmtR(r);
}

/** The switch itself. */
export function DenomToggle() {
  const { denom, setDenom } = useDenom();
  return (
    <div
      className="inline-flex shrink-0 rounded-lg border border-border bg-secondary/30 p-0.5"
      role="group"
      aria-label="Show figures in R or dollars"
      data-testid="toggle-denom"
    >
      {(
        [
          { id: "R" as const, label: "R", icon: Ruler, title: "Risk multiples — comparable across instruments and sizes" },
          { id: "USD" as const, label: "USD", icon: DollarSign, title: "Dollars — what the broker's statement says" },
        ]
      ).map(({ id, label, icon: Icon, title }) => (
        <button
          key={id}
          type="button"
          title={title}
          onClick={() => setDenom(id)}
          aria-pressed={denom === id}
          data-testid={`button-denom-${id}`}
          className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            denom === id
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}
