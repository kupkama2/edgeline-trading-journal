import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, HelpCircle } from "lucide-react";
import { GAP_LABELS, GAP_WHY, owedAftermath, type Gap } from "@shared/aftermath";
import { fmtR, computeMetrics, EXIT_REASON_LABELS } from "@shared/metrics";
import { typedSymbol } from "@shared/symbols";
import type { TradeWithTags } from "@shared/schema";

/**
 * Trades still owed their aftermath.
 *
 * A trade you took off by hand is the one the journal knows least about and
 * should know most about: the market never got to answer whether the plan
 * would have paid, so the answer has to be fetched from a chart afterwards.
 * That is a real errand, and an errand nobody can see is an errand nobody
 * runs — hence a list rather than a flag buried on each row.
 *
 * Deliberately not a nag. It hides itself entirely when nothing is owed,
 * opens collapsed, sorts so the trade worth walking back for is first, and
 * every line is one click into the fields that answer it. The headline counts
 * only the trades whose OUTCOME is unknown — a hand-close leaves a question
 * nothing else can answer, whereas a stop-out missing its post-exit prices is
 * tidying. Counting every blank field would put a three-digit number on a
 * card nobody would then read.
 */
export function OwedCard({
  trades,
  onOpen,
}: {
  trades: TradeWithTags[];
  onOpen: (t: TradeWithTags) => void;
}) {
  const [open, setOpen] = useState(false);
  const owed = owedAftermath(trades);
  if (owed.length === 0) return null;

  // The headline count is the trades whose OUTCOME is unknown — the ones a
  // hand-close left genuinely unanswerable. Counting every blank field would
  // put a three-digit number on a card nobody would then read.
  const unresolved = owed.filter((o) => o.gaps.includes("outcome"));

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
          {unresolved.length > 0
            ? `${unresolved.length} trade${unresolved.length === 1 ? "" : "s"} you closed by hand never said what would have happened`
            : `${owed.length} closed trade${owed.length === 1 ? "" : "s"} missing their aftermath`}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
          {owed.length} owed
        </span>
      </button>

      {/* Said once, not on every row. It is the same sentence for every line
          in the list, and repeated forty times it stops being read. */}
      <p className="mt-1.5 pl-6 text-[11px] leading-snug text-muted-foreground">
        {unresolved.length > 0
          ? "Taken off before the plan resolved, so the answer is on the chart rather than in the row. Set an alert at the target and the stop; when one hits, come back and fill it in."
          : "The path and the aftermath are what make an exit judgeable. Fill them in and these rows start answering for themselves."}
      </p>

      {open && (
        <ul className="mt-2 space-y-1.5" data-testid="list-owed">
          {owed.slice(0, 12).map(({ trade, gaps }) => (
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
                <span className="ml-auto flex flex-wrap justify-end gap-1">
                  {gaps.map((g: Gap) => (
                    <span
                      key={g}
                      title={GAP_WHY[g]}
                      className={`rounded-full border px-1.5 py-0.5 text-[10px] ${
                        g === "outcome"
                          ? "border-amber-500/50 text-amber-500"
                          : "border-border text-muted-foreground"
                      }`}
                    >
                      {GAP_LABELS[g]}
                    </span>
                  ))}
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
