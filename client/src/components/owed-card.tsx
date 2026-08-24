import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, HelpCircle } from "lucide-react";
import { owedOutcome } from "@shared/aftermath";
import { fmtR, computeMetrics, EXIT_REASON_LABELS } from "@shared/metrics";
import { typedSymbol } from "@shared/symbols";
import { num } from "@/components/trade-shared";
import type { TradeWithTags } from "@shared/schema";

/**
 * Trades that never said whether the plan would have paid.
 *
 * One question, not a checklist: left completely alone, would price have hit
 * the target or the stop first? A trade taken off by hand cannot answer it,
 * and no other field in the journal can either — so it is the one thing worth
 * going back to a chart for, and the only thing this card asks about.
 *
 * Deliberately not a nag. It hides itself entirely when nothing is owed,
 * opens collapsed, and every line is one click into the field that answers
 * it. "Undetermined" clears a trade off this list as surely as an answer
 * does: a flag you cannot clear by looking teaches you to stop looking.
 */
export function OwedCard({
  trades,
  onOpen,
}: {
  trades: TradeWithTags[];
  onOpen: (t: TradeWithTags) => void;
}) {
  const [open, setOpen] = useState(false);
  const owed = owedOutcome(trades);
  if (owed.length === 0) return null;

  return (
    <Card className="border-card-border bg-card p-3" data-testid="card-owed-aftermath">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
        data-testid="button-toggle-owed"
      >
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
            open ? "" : "-rotate-90"
          }`}
        />
        <HelpCircle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        <span className="text-sm font-semibold tracking-tight">
          {owed.length} trade{owed.length === 1 ? "" : "s"}: left alone, would it have hit the
          target or the stop?
        </span>
      </button>

      <p className="mt-1.5 pl-6 text-[11px] leading-snug text-muted-foreground">
        Taken off before either level was reached, so nothing in the row knows which one price
        got to first. Set an alert at both; when one fires, come back and mark it. Until then
        these trades cannot be compared against leaving them alone.
      </p>

      {open && (
        <ul className="mt-2 space-y-1.5" data-testid="list-owed">
          {owed.slice(0, 12).map((trade) => (
            <li key={trade.id}>
              <button
                type="button"
                onClick={() => onOpen(trade)}
                className="flex w-full flex-wrap items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5 text-left text-xs transition-colors hover:border-primary/40"
                data-testid={`owed-trade-${trade.id}`}
              >
                <span className="font-mono font-semibold">{typedSymbol(trade)}</span>
                <Badge variant="outline" className="shrink-0 text-[10px] capitalize">
                  {trade.exitReason ? EXIT_REASON_LABELS[trade.exitReason] : "—"}
                </Badge>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {fmtR(computeMetrics(trade).actualR)}
                </span>
                {/* The two levels to set the alerts at — the errand itself,
                    rather than a description of the errand. */}
                <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
                  {trade.direction === "short" ? "▾" : "▴"} target {num(trade.initialTarget)} ·
                  stop {num(trade.initialStop)}
                </span>
              </button>
            </li>
          ))}
          {owed.length > 12 && (
            <li className="pl-1 text-[11px] text-muted-foreground" data-testid="text-owed-more">
              …and {owed.length - 12} more, marked on their rows below.
            </li>
          )}
        </ul>
      )}
    </Card>
  );
}
