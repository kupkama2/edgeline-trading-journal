import { useMemo } from "react";
import { useLocation } from "wouter";
import { Card } from "@/components/ui/card";
import { ArrowRight, Hand, Users } from "lucide-react";
import { cohort, cohortSentence, managementCohorts, type Cohort } from "@shared/cohorts";
import { fmtAmount, fmtMoney, fmtR } from "@shared/metrics";
import type { TradeWithTags } from "@shared/schema";

/**
 * Your winners and your losers, split by whether you took a hand in them —
 * and, for the ones you did, what the untouched plan would have paid instead.
 *
 * The management card next to this one files trades by what the PLAN was
 * going to do. Useful for naming a habit, wrong for the question that gets
 * asked after a bad week: on the trades I won, was interfering worth it? On
 * the ones I lost, did it save me? Those are the same trades sliced the other
 * way, and the two slices can point in opposite directions — a trader can be
 * net positive on management while every winner they touched came in under
 * its own plan, because the losers they cut carry the whole number.
 *
 * The untouched ones are here too, and they are not decoration: without a
 * control group "managed winners average +1.8R" is a fact with nothing to be
 * compared against.
 */
export function CohortCard({ trades }: { trades: TradeWithTags[] }) {
  const [, navigate] = useLocation();
  const report = useMemo(() => managementCohorts(trades), [trades]);
  const sentence = cohortSentence(report);

  const managed = [cohort(report, "wonManaged"), cohort(report, "lostManaged")];
  const alone = [cohort(report, "wonAlone"), cohort(report, "lostAlone")];
  const anything = report.cohorts.some((c) => c.trades > 0);

  return (
    <Card className="border-card-border bg-card p-4" data-testid="card-cohorts">
      <div className="mb-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <Users className="h-4 w-4 text-muted-foreground" />
          Won and managed, lost and managed
        </h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Every closed trade split two ways: how it finished, and whether you took a hand in it.
          For the ones you touched, what the plan would have paid if you had not.
        </p>
      </div>

      {!anything ? (
        <p className="text-[11px] leading-snug text-muted-foreground" data-testid="cohorts-empty">
          Nothing to split yet. A trade lands here once it is closed, has a stop to measure R
          against, and says how it ended — the exit reason is what separates "the plan finished"
          from "you finished it".
          {report.unclassified > 0 &&
            ` ${report.unclassified} closed ${report.unclassified === 1 ? "trade has" : "trades have"} no exit reason, so there is no saying which.`}
        </p>
      ) : (
        <>
          {sentence && (
            <p
              className="mb-3 text-[11px] leading-snug text-foreground/90"
              data-testid="cohorts-sentence"
            >
              {sentence}
            </p>
          )}

          <div className="grid gap-2.5 sm:grid-cols-2">
            {managed.map((c) => (
              <Row key={c.id} c={c} onOpen={(id) => navigate(`/trade/${id}`)} />
            ))}
          </div>

          {/* The control group. Quieter, because it is context rather than a
              finding: these are the trades where you did nothing, so there is
              no decision in them to be right or wrong about. */}
          <div className="mt-3 border-t border-border/60 pt-2.5">
            <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              For comparison — the ones you left alone
            </p>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {alone.map((c) => (
                <Row key={c.id} c={c} quiet onOpen={(id) => navigate(`/trade/${id}`)} />
              ))}
            </div>
          </div>

          <p
            className="mt-2.5 text-[10px] leading-snug text-muted-foreground"
            data-testid="cohorts-sample"
          >
            {report.closed} closed {report.closed === 1 ? "trade" : "trades"} with an R to measure.
            {report.scratched > 0 &&
              ` ${report.scratched} finished flat and ${report.scratched === 1 ? "is" : "are"} in neither column.`}
            {report.unclassified > 0 &&
              ` ${report.unclassified} never said how ${report.unclassified === 1 ? "it" : "they"} ended, so ${report.unclassified === 1 ? "it is" : "they are"} left out rather than guessed at.`}
          </p>
        </>
      )}
    </Card>
  );
}

/**
 * One cohort: what it did, and what it would have done left alone.
 *
 * The counterfactual is deliberately printed as "X → Y" with the trades it
 * covers named underneath. A cohort of twenty whose comparison rests on four
 * answered trades is a different claim from one where all twenty are
 * answered, and the two look identical if only the delta is shown.
 */
function Row({
  c,
  quiet,
  onOpen,
}: {
  c: Cohort;
  quiet?: boolean;
  onOpen: (tradeId: number) => void;
}) {
  const good = c.outcome === "won";
  if (c.trades === 0) {
    return (
      <div
        className="rounded-lg border border-border/50 px-3 py-2 opacity-60"
        data-testid={`cohort-${c.id}`}
      >
        <p className="text-[11px] font-medium">{c.label}</p>
        <p className="text-[10px] text-muted-foreground">none yet</p>
      </div>
    );
  }

  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        quiet ? "border-border/50" : "border-card-border bg-secondary/20"
      }`}
      data-testid={`cohort-${c.id}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium">{c.label}</span>
        <span
          className={`shrink-0 font-mono text-xs font-semibold ${
            good ? "text-emerald-400" : "text-primary"
          }`}
          data-testid={`cohort-${c.id}-total`}
        >
          {fmtR(c.totalR)}
        </span>
      </div>
      <p className="text-[10px] leading-snug text-muted-foreground">
        {c.trades} {c.trades === 1 ? "trade" : "trades"} · {fmtR(c.avgR)} each ·{" "}
        {fmtMoney(c.totalPnL)}
      </p>

      {/* What they would have been left alone. Only for the ones you touched:
          on a trade you did nothing to, "what if you had done nothing" is not
          a counterfactual, it is the same trade. */}
      {c.hand === "managed" && (
        <div className="mt-1.5 border-t border-border/50 pt-1.5">
          {c.measured === 0 || c.deltaR == null ? (
            <p
              className="text-[10px] leading-snug text-muted-foreground"
              data-testid={`cohort-${c.id}-unmeasured`}
            >
              None of these has answered "left alone, would the target or the stop have come
              first?" — so there is nothing to compare them against yet.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="font-mono text-foreground/80">{fmtR(c.actualOnMeasuredR!)}</span>
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <span className="font-mono text-muted-foreground">{fmtR(c.planR!)}</span>
                <span className="text-[10px] text-muted-foreground">left alone</span>
                <span
                  className={`ml-auto flex items-center gap-1 font-mono text-xs font-semibold ${
                    c.deltaR >= 0 ? "text-emerald-400" : "text-primary"
                  }`}
                  data-testid={`cohort-${c.id}-delta`}
                >
                  <Hand className="h-3 w-3" />
                  {fmtR(c.deltaR)}
                </span>
              </div>
              <p className="text-[10px] leading-snug text-muted-foreground">
                {/* Unsigned: the direction is already in the verb, and
                    "cost you +$100" reads as a gain. */}
                {c.deltaR >= 0 ? "Your hand earned" : "Your hand cost"}{" "}
                {fmtAmount(c.deltaPnL ?? 0)} across{" "}
                {c.measured === c.trades
                  ? "all of them"
                  : `${c.measured} of the ${c.trades} — the rest have no plan outcome yet`}
                .
              </p>
            </>
          )}
        </div>
      )}

      {c.tradeIds.length > 0 && (
        <button
          type="button"
          onClick={() => onOpen(c.tradeIds[0])}
          className="mt-1 text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          data-testid={`cohort-${c.id}-open`}
        >
          open one
        </button>
      )}
    </div>
  );
}
