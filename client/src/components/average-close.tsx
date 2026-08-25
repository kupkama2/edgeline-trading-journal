import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Calculator } from "lucide-react";
import { exitCoverage, residualFromAverage } from "@shared/fills";
import { num } from "@/components/trade-shared";
import type { TradeWithTags } from "@shared/schema";

/**
 * "I only logged the exits that were easy to copy."
 *
 * Which is the sensible thing to do. A limit clip is one tidy row on the
 * exchange; a market close is a dozen prints of the same order. So a trader
 * writes down the tidy ones and stops — and the trade is left half
 * decomposed, with a gap the exit price is not the answer to.
 *
 * The exit price here means the price the LAST slice came off at, because
 * that is what the ledger settles the remainder at. The number the exchange
 * shows is the average across the whole position. They are different figures
 * and nothing in the data says which one got typed in, so this does not
 * guess: it asks for the average and solves the remainder from it.
 *
 * Given an average that is right there is exactly one price the rest can have
 * come off at. Put that in the exit field and the total is the one on the
 * statement — the partials having added detail without touching the
 * arithmetic, which is the whole point of logging them.
 */
export function AverageCloseSolver({
  trade,
  onUse,
}: {
  trade: TradeWithTags;
  onUse: (price: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const cov = exitCoverage(trade);

  // Nothing logged, or nothing left over: there is no gap to close.
  if (!cov || cov.residualQty <= cov.totalQty * 0.005) return null;

  const average = Number(typed);
  const solved = typed.trim() && isFinite(average) ? residualFromAverage(trade, average) : null;

  return (
    <div
      className="space-y-1.5 rounded-md border border-border/60 bg-secondary/20 px-3 py-2 text-[11px]"
      data-testid="panel-average-close"
    >
      <p className="flex items-center gap-1.5 text-muted-foreground">
        <Calculator className="h-3 w-3" />
        These exits cover{" "}
        <span className="font-mono text-foreground">{Math.round(cov.covered * 100)}%</span> of the
        position. The last <span className="font-mono text-foreground">{num(cov.residualQty)}</span>{" "}
        is carried by the exit price above.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Average close on the exchange</span>
        <Input
          type="number"
          step="any"
          inputMode="decimal"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="e.g. 110"
          className="h-7 w-28 font-mono text-xs"
          data-testid="input-average-close"
        />
        {solved?.price != null && (
          <>
            <span className="text-muted-foreground">
              → the rest came off at{" "}
              <span className="font-mono text-foreground">{num(solved.price)}</span>
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              onClick={() => onUse(String(solved.price))}
              data-testid="button-use-solved-exit"
            >
              Use it
            </Button>
          </>
        )}
      </div>

      {/* A mistyped size solves perfectly cleanly to a nonsense price. Saying
          the numbers disagree is the only honest output there — a plausible
          figure written into the exit field is worse than the gap it filled. */}
      {solved?.problem && (
        <p className="text-amber-500" data-testid="text-average-close-problem">
          {solved.problem}
        </p>
      )}
    </div>
  );
}
