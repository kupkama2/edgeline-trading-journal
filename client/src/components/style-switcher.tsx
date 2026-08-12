import { useMemo } from "react";
import { Layers, Wallet } from "lucide-react";
import { useStyles, useTrades } from "@/lib/data";
import { knownAccounts, styleColor, useStyleFilter } from "@/lib/style-filter";

/**
 * Marks which book a trade belongs to. Only rendered while viewing "All
 * styles" — once the page is scoped the label is just noise.
 */
export function StyleChip({ styleId }: { styleId: number | null }) {
  const { data: styles = [] } = useStyles();
  const { activeStyleId } = useStyleFilter();

  if (activeStyleId != null || styleId == null) return null;
  const style = styles.find((s) => s.id === styleId);
  if (!style) return null;
  const c = styleColor(style.color);

  return (
    <span
      className={`flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] leading-tight ${c.chip}`}
      data-testid={`chip-trade-style-${styleId}`}
    >
      <span className={`h-1 w-1 rounded-full ${c.dot}`} />
      {style.name}
    </span>
  );
}

const pill = (on: boolean, chip?: string) =>
  `rounded-full border px-2.5 py-1 text-[11px] leading-tight transition-colors ${
    on
      ? chip ?? "border-foreground/30 bg-secondary text-foreground"
      : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
  }`;

/**
 * Scopes the whole page: which strategy, which account, either, both, or
 * neither.
 *
 * Two rows rather than one merged list, because the axes are independent and
 * crossing them is the point — "swings, on the Apex eval" is a different
 * question from either half, and a single picker would force a choice between
 * them. The account row only appears once there is more than one account to
 * choose between; a row with one option is a row that teaches nothing.
 *
 * "All" is an overview only. Per-style stats never pool behind the scenes —
 * the guardrail still evaluates each book independently whatever this says.
 */
export function StyleSwitcher() {
  const { data: styles = [] } = useStyles();
  const { data: trades = [] } = useTrades();
  const { activeStyleId, setActiveStyleId, activeAccount, setActiveAccount } =
    useStyleFilter();

  const accounts = useMemo(() => knownAccounts(trades), [trades]);
  if (styles.length === 0 && accounts.length < 2) return null;

  return (
    <div className="space-y-1.5" data-testid="style-switcher">
      {styles.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <button
            type="button"
            onClick={() => setActiveStyleId(null)}
            aria-pressed={activeStyleId == null}
            data-testid="button-style-all"
            className={pill(activeStyleId == null)}
          >
            All styles
          </button>

          {styles.map((s) => {
            const on = s.id === activeStyleId;
            const c = styleColor(s.color);
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setActiveStyleId(s.id)}
                aria-pressed={on}
                data-testid={`button-style-${s.id}`}
                className={`flex items-center gap-1.5 ${pill(on, c.chip)}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
                {s.name}
              </button>
            );
          })}
        </div>
      )}

      {accounts.length > 1 && (
        <div className="flex flex-wrap items-center gap-2" data-testid="account-switcher">
          <Wallet className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <button
            type="button"
            onClick={() => setActiveAccount(null)}
            aria-pressed={activeAccount == null}
            data-testid="button-account-all"
            className={pill(activeAccount == null)}
          >
            All accounts
          </button>
          {accounts.map((a) => {
            const on = activeAccount?.toLowerCase() === a.toLowerCase();
            return (
              <button
                key={a}
                type="button"
                onClick={() => setActiveAccount(on ? null : a)}
                aria-pressed={on}
                data-testid={`button-account-${a}`}
                className={pill(on, "border-sky-500/40 bg-sky-500/10 text-sky-400")}
              >
                {a}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
