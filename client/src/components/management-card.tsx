/**
 * The idea against what was done to it.
 *
 * A trade sent from the terminal carries its whole life: the plan as drawn,
 * every stop and target moved with the R it was moved at, every take and
 * add, the minute the tape reached the original stop or target, the exit.
 * This card lays that out and answers the one question all of it exists
 * for — would leaving the plan alone have paid more? — with the model's
 * read on the decisions under it once the trade is over.
 */
import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { GitCompareArrows, Loader2, Sparkles } from "lucide-react";
import type { TradeWithTags } from "@shared/schema";
import { computeMetrics } from "@shared/metrics";
import { ideaOf, managementTimeline, parseTerminalRef, planVerdictOf, rAt } from "@shared/terminal";
import { useReviewTrade } from "@/lib/terminal";
import { useToast } from "@/hooks/use-toast";
import { num } from "@/components/trade-shared";

const fmtR = (v: number | null | undefined, blank = "—") => (v == null ? blank : `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function ManagementCard({ trade }: { trade: TradeWithTags }) {
  const ref = useMemo(() => parseTerminalRef(trade.terminal), [trade.terminal]);
  const review = useReviewTrade();
  const { toast } = useToast();
  if (!ref || trade.status === "pending" || trade.status === "cancelled") return null;

  const idea = ideaOf(trade, ref);
  const plan = planVerdictOf(trade, ref);
  const m = computeMetrics(trade);
  const rows = managementTimeline(trade, ref);
  const closed = trade.status === "closed";
  // Net of costs where the metrics have it; gross from the idea otherwise.
  const planR = m.potentialR ?? plan.planR;
  const actualR = closed ? m.actualR : null;
  const delta = actualR != null && planR != null ? actualR - planR : null;
  const w = ref.planWatch;
  const touched = (ref.moves?.length ?? 0) > 0 || (trade.fills ?? []).some((f) => (f.note ?? "").startsWith("terminal"));
  const exitR = closed && trade.exitPrice != null ? rAt(trade.exitPrice, trade.entryPrice, idea.stop, trade.direction) : null;

  const planLine = plan.verdict
    ? `Left alone, the original ${plan.verdict === "stop_first" ? "stop" : "target"} would have been hit first${plan.at ? ` (${when(plan.at)})` : ""}.`
    : w?.first === "ambiguous"
      ? "The tape reached both original levels inside one minute — which came first is not knowable from candles."
      : w
        ? `Neither original level reached yet (watched to ${when(new Date(w.coveredTo).toISOString())}).`
        : "The original levels have not been watched yet.";

  return (
    <Card className="border-card-border bg-card p-3 sm:p-4" data-testid="card-management">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <GitCompareArrows className="h-4 w-4 text-sky-400" />
        <h3 className="text-sm font-semibold">Idea vs management</h3>
        {ref.review && (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
              ref.review.verdict === "helped" ? "bg-emerald-500/15 text-emerald-400" : ref.review.verdict === "hurt" ? "bg-red-500/15 text-red-400" : "bg-secondary text-muted-foreground"
            }`}
            data-testid="badge-management-verdict"
          >
            management {ref.review.verdict}
          </span>
        )}
        {!touched && <span className="text-[10px] text-muted-foreground">set and forget so far</span>}
      </div>

      {/* The three numbers. */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label="Set and forget" value={fmtR(planR, plan.verdict ? "—" : "?")} tone={planR == null ? "" : planR >= 0 ? "text-emerald-400" : "text-red-400"} testId="stat-plan-r" />
        <Stat label={closed ? "As managed" : "Open now"} value={closed ? fmtR(actualR) : "running"} tone={actualR == null ? "" : actualR >= 0 ? "text-emerald-400" : "text-red-400"} testId="stat-actual-r" />
        <Stat label="Management" value={fmtR(delta)} tone={delta == null ? "" : Math.abs(delta) < 0.1 ? "text-muted-foreground" : delta > 0 ? "text-emerald-400" : "text-red-400"} testId="stat-delta-r" />
      </div>
      <p className="mt-2 text-[11px] leading-snug text-muted-foreground" data-testid="text-plan-line">
        {planLine}
        {exitR != null && closed && ` You left at ${fmtR(exitR)} on the original risk.`}
      </p>

      {/* The timeline. */}
      <ol className="mt-3 space-y-1 border-l border-border/60 pl-3 text-[11px]" data-testid="list-management-timeline">
        {rows.map((r, i) => (
          <li key={i} className="relative">
            <span className={`absolute -left-[15px] top-1.5 h-1.5 w-1.5 rounded-full ${dot(r.kind)}`} />
            <span className="mr-2 font-mono text-[10px] text-muted-foreground">{when(r.at)}</span>
            <span className={r.kind === "plan-hit" ? "text-amber-400" : r.kind === "exit" ? "font-medium" : ""}>{r.text}</span>
          </li>
        ))}
      </ol>

      {/* The read. */}
      {ref.review ? (
        <div className="mt-3 rounded-md border border-border/60 bg-background/40 p-2.5" data-testid="text-management-review">
          <p className="text-[11px] leading-snug">{ref.review.summary}</p>
          {ref.review.lesson && <p className="mt-1 text-[11px] leading-snug text-sky-300">Next time: {ref.review.lesson}</p>}
          <p className="mt-1 text-[10px] text-muted-foreground">
            read {when(ref.review.at)} · plan {ref.review.basis.planVerdict ?? "unknown"} · {num(idea.qty)} at {num(idea.entry)}
          </p>
        </div>
      ) : closed ? (
        <p className="mt-3 text-[10px] text-muted-foreground" data-testid="text-management-unreviewed">
          {plan.verdict ? "The read on this management is on its way." : "Waiting for the tape to reach one of the original levels before the management is read."}
        </p>
      ) : null}
      {closed && (
        <Button
          size="sm"
          variant="ghost"
          className="mt-2 h-7 px-2 text-[11px] text-muted-foreground"
          disabled={review.isPending}
          onClick={() =>
            review
              .mutateAsync(trade.id)
              .then(() => toast({ title: "Reviewed", description: "The management read is on the trade." }))
              .catch((err: any) => toast({ title: "Not reviewed", description: String(err?.message ?? err).replace(/^\d+:\s*/, "").slice(0, 200), variant: "destructive" }))
          }
          data-testid="button-management-review"
        >
          {review.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Sparkles className="mr-1 h-3 w-3" />}
          {ref.review ? "Read it again" : "Read it now"}
        </Button>
      )}
    </Card>
  );
}

function Stat({ label, value, tone, testId }: { label: string; value: string; tone: string; testId: string }) {
  return (
    <div className="rounded-md bg-background/40 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`font-mono text-sm font-semibold ${tone}`} data-testid={testId}>
        {value}
      </div>
    </div>
  );
}

function dot(kind: string): string {
  switch (kind) {
    case "stop":
      return "bg-red-400";
    case "target":
      return "bg-emerald-400";
    case "reduce":
    case "add":
      return "bg-sky-400";
    case "plan-hit":
      return "bg-amber-400";
    case "exit":
      return "bg-foreground";
    default:
      return "bg-muted-foreground";
  }
}
