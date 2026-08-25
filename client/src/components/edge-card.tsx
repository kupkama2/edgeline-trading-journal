import { useMemo } from "react";
import { useLocation } from "wouter";
import { Card } from "@/components/ui/card";
import { Scale } from "lucide-react";
import { edgeSentence, managementEdge, type EdgeBucket } from "@shared/management";
import type { TradeWithTags } from "@shared/schema";

/**
 * Where the management edge comes from, and where it leaks.
 *
 * Every other card here scores the RESULT. This one scores the decisions
 * taken after the entry, which is the only part of a trade you can still
 * change once it is running — and it answers the question a trader actually
 * asks about them: am I good at this, and if so, at which part?
 *
 * Deliberately two lists rather than one net figure. "+6R from management"
 * fits a trader who cuts losers brilliantly and dumps winners just as well as
 * one who does neither and got lucky, and those want opposite fixes. Netting
 * them lets the larger habit hide the one worth working on.
 */
export function EdgeCard({ trades }: { trades: TradeWithTags[] }) {
  const [, navigate] = useLocation();
  const e = useMemo(() => managementEdge(trades), [trades]);
  const sentence = edgeSentence(e);

  if (e.measured === 0) {
    return (
      <Card className="border-card-border bg-card p-4" data-testid="card-management-edge">
        <Heading />
        <p className="text-[11px] leading-snug text-muted-foreground" data-testid="edge-empty">
          Nothing measurable yet. This compares what you made against what the untouched plan
          would have made, so it needs trades where you have answered — or the feed has settled
          — whether the target or the stop came first.
          {e.unmeasured > 0 && ` ${e.unmeasured} closed ${e.unmeasured === 1 ? "trade is" : "trades are"} still waiting on that.`}
        </p>
      </Card>
    );
  }

  return (
    <Card className="border-card-border bg-card p-4" data-testid="card-management-edge">
      <Heading />

      {sentence && (
        <p className="mb-3 text-[11px] leading-snug text-foreground/90" data-testid="edge-sentence">
          {sentence}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Column
          title="Where it comes from"
          empty="Nothing yet — no managed trade has beaten its own plan."
          buckets={e.edges}
          onOpen={(id) => navigate(`/trade/${id}`)}
        />
        <Column
          title="Where it leaks"
          empty="Nothing — no managed trade has come in under its own plan."
          buckets={e.leaks}
          onOpen={(id) => navigate(`/trade/${id}`)}
        />
      </div>

      {e.neutral.length > 0 && (
        <p className="mt-3 border-t border-border/60 pt-2 text-[10px] text-muted-foreground">
          {e.neutral.map((b) => `${b.trades} ${b.label.toLowerCase()}`).join(" · ")} — the plan and
          the outcome agreed, so managing changed nothing either way.
        </p>
      )}

      {/* The sample, stated. A decomposition over eleven trades and one over
          two hundred read identically on a card and mean completely different
          things. */}
      <p className="mt-2 text-[10px] leading-snug text-muted-foreground" data-testid="edge-sample">
        Over {e.measured} measured {e.measured === 1 ? "trade" : "trades"}, management is{" "}
        <span className={e.totalR >= 0 ? "text-emerald-400" : "text-primary"}>
          {e.totalR > 0 ? "+" : ""}
          {e.totalR.toFixed(1)}R
        </span>{" "}
        net.
        {e.unmeasured > 0 &&
          ` ${e.unmeasured} more closed ${e.unmeasured === 1 ? "trade has" : "trades have"} no plan outcome yet and are left out.`}
      </p>
    </Card>
  );
}

function Heading() {
  return (
    <div className="mb-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
        <Scale className="h-4 w-4 text-muted-foreground" />
        Where your management edge comes from
      </h2>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        Every trade you managed against what the untouched plan would have done, filed by what
        you actually did. Gains and leaks kept apart on purpose: a net figure lets the bigger
        habit hide the one worth fixing.
      </p>
    </div>
  );
}

function Column({
  title,
  empty,
  buckets,
  onOpen,
}: {
  title: string;
  empty: string;
  buckets: EdgeBucket[];
  onOpen: (tradeId: number) => void;
}) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">{title}</p>
      {buckets.length === 0 ? (
        <p className="text-[11px] leading-snug text-muted-foreground">{empty}</p>
      ) : (
        // Capped rather than full-bleed: on a wide screen an uncapped row
        // strands the R figure half a card away from the label it belongs to,
        // and the pair stops reading as one line.
        <ul className="max-w-sm space-y-1.5">
          {buckets.map((b) => (
            <li key={b.id} data-testid={`edge-bucket-${b.id}`}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-medium">{b.label}</span>
                <span
                  className={`shrink-0 font-mono text-xs font-semibold ${
                    b.kind === "edge" ? "text-emerald-400" : "text-primary"
                  }`}
                >
                  {b.r > 0 ? "+" : ""}
                  {b.r.toFixed(1)}R
                </span>
              </div>
              <p className="text-[10px] leading-snug text-muted-foreground">
                {b.hint} ·{" "}
                {/* Every count opens the trades behind it: a number you cannot
                    check is a number you end up arguing with. */}
                <button
                  type="button"
                  onClick={() => onOpen(b.tradeIds[0])}
                  className="underline-offset-2 hover:text-foreground hover:underline"
                  data-testid={`button-edge-open-${b.id}`}
                >
                  {b.trades} {b.trades === 1 ? "trade" : "trades"}
                </button>
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
