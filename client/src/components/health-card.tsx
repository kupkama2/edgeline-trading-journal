import { useState } from "react";
import { Card } from "@/components/ui/card";
import { ChevronDown, ClipboardList } from "lucide-react";
import { HEALTH_LABELS, journalHealth } from "@shared/health";
import type { TradeWithTags } from "@shared/schema";

/**
 * What the journal is missing, above the journal.
 *
 * A blank field fails silently — the trade drops out of whichever number
 * needed it and nothing on screen says so. This card says so: one line
 * with the counts, and under it the trades themselves, each a click from
 * the form that fixes it. It disappears entirely when there is nothing to
 * say, which is the state it is trying to get you to.
 */
export function HealthCard({
  trades,
  onOpen,
  feeAccounts,
}: {
  trades: TradeWithTags[];
  onOpen: (t: TradeWithTags) => void;
  /** Accounts with a fee schedule, lower-cased — where a missing fee is a gap. */
  feeAccounts?: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  const issues = journalHealth(trades, Date.now(), feeAccounts);
  if (issues.length === 0) return null;
  const total = issues.reduce((n, i) => n + i.trades.length, 0);

  return (
    <Card className="border-card-border bg-card p-3" data-testid="card-health">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center gap-2 text-left"
        data-testid="button-toggle-health"
      >
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
            open ? "" : "-rotate-90"
          }`}
        />
        <ClipboardList className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        <span className="text-sm font-semibold tracking-tight">
          {total} thing{total === 1 ? "" : "s"} the journal is missing
        </span>
        <span className="ml-auto flex flex-wrap gap-1">
          {issues.map((i) => (
            <span
              key={i.kind}
              className="rounded-full border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              data-testid={`health-count-${i.kind}`}
            >
              {i.trades.length} {HEALTH_LABELS[i.kind].title}
            </span>
          ))}
        </span>
      </button>

      {open && (
        <div className="mt-2 space-y-2.5 pl-6" data-testid="list-health">
          {issues.map((i) => (
            <div key={i.kind} data-testid={`health-${i.kind}`}>
              <p className="text-[11px] font-medium">
                {i.trades.length} {HEALTH_LABELS[i.kind].title}
              </p>
              <p className="text-[10px] leading-snug text-muted-foreground">
                {HEALTH_LABELS[i.kind].why}
              </p>
              <ul className="mt-1 flex flex-wrap gap-1">
                {i.trades.slice(0, 12).map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(t)}
                      className="rounded border border-border/60 px-1.5 py-0.5 font-mono text-[10px] transition-colors hover:border-primary/50"
                      data-testid={`health-trade-${i.kind}-${t.id}`}
                    >
                      {t.symbol} ·{" "}
                      {new Date(t.entryTime).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </button>
                  </li>
                ))}
                {i.trades.length > 12 && (
                  <li className="self-center text-[10px] text-muted-foreground">
                    +{i.trades.length - 12} more
                  </li>
                )}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
