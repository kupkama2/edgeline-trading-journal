/**
 * The weekly read: what to fix next, book by book.
 *
 * Scalps and swings are different jobs, so the advice never averages them —
 * each style is reviewed against itself and the books are ordered by what
 * they are currently losing. Findings carry a price in R, because "you trade
 * badly at 2pm" is an opinion and "2pm has cost you 5.4R" is a decision.
 *
 * It appears once a week and can be put away; the numbers underneath it live
 * on Stats and never move. Dismissal is remembered per ISO week, so putting it
 * away on Tuesday does not silence next Monday.
 */
import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, Target, X } from "lucide-react";
import { useMistakeTags, useStyles, useTrades } from "@/lib/data";
import { reviewAll } from "@shared/coach";
import { styleColor } from "@/lib/style-filter";

/** Monday-anchored week key, so "this week" means the same all week. */
function weekKey(d = new Date()): string {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}

const DISMISS_KEY = "edgeline.coachDismissed";

export function CoachCard() {
  const { data: trades = [] } = useTrades();
  const { data: tags = [] } = useMistakeTags();
  const { data: styles = [] } = useStyles();
  const week = weekKey();
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISS_KEY) === week,
  );
  const [open, setOpen] = useState(true);

  const reviews = useMemo(
    () => reviewAll(trades, tags, styles),
    [trades, tags, styles],
  );

  if (dismissed || reviews.length === 0) return null;

  const totalCost = reviews.reduce(
    (a, r) => a + r.findings.reduce((x, f) => x + f.costR, 0),
    0,
  );

  return (
    <Card className="border-primary/30 bg-card p-4" data-testid="card-coach">
      <div className="flex flex-wrap items-center gap-2">
        <Target className="h-4 w-4 shrink-0 text-primary" />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-1.5 text-sm font-semibold tracking-tight"
          data-testid="button-toggle-coach"
        >
          This week's read
          <ChevronDown
            className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${
              open ? "" : "-rotate-90"
            }`}
          />
        </button>
        <span className="font-mono text-[11px] text-muted-foreground">
          {reviews.length} {reviews.length === 1 ? "book" : "books"} · about{" "}
          <span className="text-primary">{totalCost.toFixed(1)}R</span> in reach
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto h-6 w-6 text-muted-foreground"
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, week);
            setDismissed(true);
          }}
          aria-label="Put this away until next week"
          data-testid="button-dismiss-coach"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {open && (
        <div className="mt-3 space-y-3">
          {reviews.map((r) => {
            const style = styles.find((s) => s.id === r.styleId);
            const c = styleColor(style?.color ?? "slate");
            return (
              <div key={String(r.styleId)} data-testid={`coach-style-${r.styleId}`}>
                <div className="mb-1.5 flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
                  <span className="text-xs font-semibold">{r.styleName}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {r.trades} closed
                  </span>
                </div>
                <ul className="space-y-1.5">
                  {r.findings.map((f) => (
                    <li
                      key={f.id}
                      className="rounded-md border border-border/60 bg-secondary/20 p-2.5"
                      data-testid={`coach-finding-${f.id}`}
                    >
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-xs font-medium">{f.title}</span>
                        {f.costR > 0 && (
                          <Badge
                            variant="outline"
                            className="border-primary/40 font-mono text-[10px] font-normal text-primary"
                          >
                            {f.costR.toFixed(1)}R
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                        {f.detail}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <p className="text-[10px] leading-snug text-muted-foreground">
            Costs are what those trades actually lost, not a promise of what fixing them pays.
            Every figure here is arithmetic over your own log — check any of it on Stats.
          </p>
        </div>
      )}
    </Card>
  );
}
