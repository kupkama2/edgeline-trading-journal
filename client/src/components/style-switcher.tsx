import { Layers } from "lucide-react";
import { useStyles } from "@/lib/data";
import { styleColor, useStyleFilter } from "@/lib/style-filter";

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

/**
 * Scopes the whole page to one trading style. "All" is an overview only —
 * per-style stats never pool, so the guardrail still evaluates each book
 * independently behind the scenes.
 */
export function StyleSwitcher() {
  const { data: styles = [] } = useStyles();
  const { activeStyleId, setActiveStyleId } = useStyleFilter();

  if (styles.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="style-switcher">
      <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <button
        type="button"
        onClick={() => setActiveStyleId(null)}
        aria-pressed={activeStyleId == null}
        data-testid="button-style-all"
        className={`rounded-full border px-2.5 py-1 text-[11px] leading-tight transition-colors ${
          activeStyleId == null
            ? "border-foreground/30 bg-secondary text-foreground"
            : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
        }`}
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
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] leading-tight transition-colors ${
              on
                ? c.chip
                : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
            {s.name}
          </button>
        );
      })}
    </div>
  );
}
