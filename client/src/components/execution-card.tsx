/**
 * Am I early or late — and what has it actually cost?
 *
 * One late exit that round-trips a winner is the loudest event of a trading
 * week, and it is almost never the expensive one. The point of this card is to
 * put both sins on the same scale at the same time: the R the move went on to
 * offer after you took profit early, next to the R you reached and handed back
 * by holding on. Whichever total is bigger is the habit worth working on,
 * regardless of which one is fresh.
 *
 * Everything here is counted from grades you gave yourself, so it says how
 * many trades are graded and never fills the gap with an assumption. An
 * ungraded trade is absent, not average.
 */
import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Scale } from "lucide-react";
import type { TradeWithTags } from "@shared/schema";
import {
  MIN_GRADED,
  exitCost,
  executionReport,
  overrideReport,
  type AxisReport,
} from "@shared/grades";

function Axis({ r }: { r: AxisReport }) {
  const shown = r.buckets.filter((b) => b.count > 0);
  return (
    <div className="min-w-0" data-testid={`execution-axis-${r.axis}`}>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {r.label}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {r.graded} graded
        </span>
      </div>

      {r.graded === 0 ? (
        <p className="text-[11px] leading-snug text-muted-foreground">
          Not graded yet.
        </p>
      ) : (
        <>
          {/* Proportion, not a chart: three widths say "mostly late" faster
              than three numbers do, and the numbers are underneath anyway. */}
          <div className="flex h-1.5 overflow-hidden rounded-full bg-secondary">
            {r.buckets.map((b) => (
              <span
                key={b.grade}
                style={{ width: `${b.share * 100}%` }}
                className={b.tone === "good" ? "bg-emerald-400" : "bg-amber-400/70"}
                title={`${b.label}: ${b.count}`}
              />
            ))}
          </div>
          <ul className="mt-1.5 space-y-0.5">
            {shown.map((b) => (
              <li
                key={b.grade}
                className="flex items-baseline justify-between gap-2 text-[11px]"
                data-testid={`execution-${r.axis}-${b.grade}`}
              >
                <span className={b.tone === "good" ? "text-emerald-400" : "text-amber-400"}>
                  {b.label}
                </span>
                <span className="font-mono text-muted-foreground">
                  {Math.round(b.share * 100)}% ·{" "}
                  <span className={b.expectancyR >= 0 ? "text-emerald-400" : "text-primary"}>
                    {b.expectancyR >= 0 ? "+" : ""}
                    {b.expectancyR.toFixed(2)}R
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function ExecutionCard({ trades }: { trades: TradeWithTags[] }) {
  const report = useMemo(() => executionReport(trades), [trades]);
  const cost = useMemo(() => exitCost(trades), [trades]);
  const override = useMemo(() => overrideReport(trades), [trades]);

  if (report.closed === 0) return null;

  const axes = [report.entry, report.stop, report.exit];
  // Named per axis: "you are late more often than not" is unreadable when the
  // entry and the exit can both be late and mean opposite things.
  const leans = axes
    .filter((a) => a.lean)
    .map((a) => `${a.lean!.label.toLowerCase()} on the ${a.label.toLowerCase()}`);

  return (
    <Card className="border-card-border bg-card p-4 sm:p-5" data-testid="card-execution">
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <Scale className="h-4 w-4 shrink-0 self-center text-primary" />
        <h2 className="text-sm font-semibold tracking-tight">Early or late?</h2>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {report.graded} of {report.closed} graded
        </span>
      </div>

      {report.graded === 0 ? (
        <p className="text-[11px] leading-snug text-muted-foreground">
          Nothing graded yet. Every trade you close now asks three one-tap questions —
          was the entry early, late or right; was the stop too tight, right or too wide;
          was the take-profit early, late or perfect. After a handful of trades this card
          starts telling you which way you lean and what that lean has cost.
        </p>
      ) : (
        <>
          <div className="grid gap-5 sm:grid-cols-3">
            {axes.map((a) => (
              <Axis key={a.axis} r={a} />
            ))}
          </div>

          {/* The headline the whole card exists for. */}
          {(cost.earlyCount > 0 || cost.lateCount > 0) && (
            <div
              className="mt-4 grid gap-3 border-t border-border/60 pt-3 sm:grid-cols-2"
              data-testid="execution-exit-cost"
            >
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Out too early
                </p>
                <p className="font-mono text-lg font-bold leading-tight text-amber-400">
                  {cost.earlyR.toFixed(1)}R
                </p>
                <p className="text-[10px] leading-snug text-muted-foreground">
                  the move went on to offer, across {cost.earlyCount}{" "}
                  {cost.earlyCount === 1 ? "trade" : "trades"}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Out too late
                </p>
                <p className="font-mono text-lg font-bold leading-tight text-amber-400">
                  {cost.lateR.toFixed(1)}R
                </p>
                <p className="text-[10px] leading-snug text-muted-foreground">
                  reached and handed back, across {cost.lateCount}{" "}
                  {cost.lateCount === 1 ? "trade" : "trades"}
                </p>
              </div>
            </div>
          )}

          <p
            className="mt-3 text-[11px] leading-snug text-muted-foreground"
            data-testid="execution-verdict"
          >
            {cost.worse && report.exit.graded >= MIN_GRADED && (
              <>
                <span className="text-foreground">
                  {cost.worse === "late"
                    ? "Holding on is costing you more than taking profit early."
                    : "Taking profit early is costing you more than holding on."}
                </span>{" "}
              </>
            )}
            {leans.length > 0 && <>You lean {leans.join(", and ")}. </>}
            {override.verdict}
          </p>
        </>
      )}
    </Card>
  );
}
