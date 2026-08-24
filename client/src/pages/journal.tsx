import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronDown, ClipboardPaste, Eye, EyeOff } from "lucide-react";
import { useTrades, useMistakeTags } from "@/lib/data";
import { filterByScope, useStyleFilter } from "@/lib/style-filter";
import { type TradeWithTags } from "@shared/schema";
import { computeMetrics } from "@shared/metrics";
import { DailyGuardCard } from "@/components/daily-guard";
import { ScorecardCard } from "@/components/scorecard-card";
import { CoachCard } from "@/components/coach-card";
import { StyleSwitcher } from "@/components/style-switcher";
import { ImportTradesDialog } from "@/components/import-trades";
import { MissedTradeDialog } from "@/components/missed-trade";
import { FillDialog } from "@/components/fill-dialog";
import { ResolveTradeDialog } from "@/components/resolve-trade";
import { type ImportCandidate } from "@shared/import-parse";
import { NewTradeCard } from "@/components/new-trade-card";
import { useLocation } from "wouter";
import { ClosedTradeRow, OpenTradeRow, PendingTradeRow } from "@/components/trade-rows";
import { OwedCard } from "@/components/owed-card";
import { useOutcomeWatch } from "@/lib/outcome-watch";
import { num } from "@/components/trade-shared";

/* ================================ page ================================ */

type SortKey = "newest" | "oldest" | "symbol" | "risk";

/** How many closes the journal shows before you ask for the rest. */
const CLOSED_PREVIEW = 3;

const SORT_LABELS: Record<SortKey, string> = {
  newest: "Newest",
  oldest: "Oldest",
  symbol: "Symbol",
  risk: "Risk",
};

/**
 * Sort a trade list. "Risk" is 1R in dollars rather than stop distance in
 * points, since points are not comparable across instruments — 40 points of NQ
 * and 40 points of BTC are wildly different amounts of money.
 */
function sortTrades(list: TradeWithTags[], key: SortKey): TradeWithTags[] {
  const out = [...list];
  switch (key) {
    case "oldest":
      return out.sort((a, b) => a.entryTime.localeCompare(b.entryTime));
    case "symbol":
      return out.sort(
        (a, b) => a.symbol.localeCompare(b.symbol) || b.entryTime.localeCompare(a.entryTime),
      );
    case "risk":
      return out.sort(
        (a, b) => computeMetrics(b).riskDollars - computeMetrics(a).riskDollars,
      );
    default:
      return out.sort((a, b) => b.entryTime.localeCompare(a.entryTime));
  }
}

function SortControl({
  value,
  onChange,
}: {
  value: SortKey;
  onChange: (k: SortKey) => void;
}) {
  return (
    <div className="flex gap-0.5">
      {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => onChange(k)}
          data-testid={`button-sort-${k}`}
          className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
            value === k
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {SORT_LABELS[k]}
        </button>
      ))}
    </div>
  );
}

export default function Journal() {
  const { data: trades, isLoading } = useTrades();
  const { data: tags = [] } = useMistakeTags();
  const { activeStyleId, scope } = useStyleFilter();
  const [, navigate] = useLocation();
  /* Editing a trade from a row opens the trade, not a window over the row.
     One address, one editor: the journal is a list of links into it. */
  const openTrade = (t: TradeWithTags) => navigate(`/trade/${t.id}/edit`);
  const [importing, setImporting] = useState(false);
  const [loggingMissed, setLoggingMissed] = useState(false);
  const [resolving, setResolving] = useState<TradeWithTags | null>(null);
  // Which trade is being scaled, and which way.
  const [filling, setFilling] = useState<{ trade: TradeWithTags; kind: "add" | "partial" } | null>(null);
  // The server already returns newest-first; this re-sorts client-side so
  // switching is instant and costs no round trip.
  const [sortBy, setSortBy] = useState<SortKey>("newest");
  const [importSeed, setImportSeed] = useState<ImportCandidate[] | null>(null);
  const [entryOpen, setEntryOpen] = useState(false);
  const [showClosed, setShowClosed] = useState(true);
  const [allClosed, setAllClosed] = useState(false);

  const tagNames = useMemo(
    () => Object.fromEntries(tags.map((t) => [t.id, t.name])),
    [tags],
  );

  const scoped = useMemo(() => filterByScope(trades ?? [], scope), [trades, scope]);
  const pending = sortTrades(scoped.filter((t) => t.status === "pending"), sortBy);
  const open = sortTrades(scoped.filter((t) => t.status === "open"), sortBy);
  /**
   * Closed trades, newest CLOSE first — the list is a record of what just
   * settled, and a trade opened last week but closed an hour ago belongs at
   * the top. Falls back to entry time for anything missing an exit stamp.
   */
  const closed = useMemo(
    () =>
      scoped
        .filter((t) => t.status === "closed")
        .sort((a, b) =>
          (b.exitTime ?? b.entryTime).localeCompare(a.exitTime ?? a.entryTime),
        ),
    [scoped],
  );
  const cancelled = scoped.filter((t) => t.status === "cancelled");

  // Ask the market to settle anything still parked, once the log has loaded.
  useOutcomeWatch(closed.length > 0);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Journal</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Drop a chart, confirm the numbers, move on. Everything else is computed.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLoggingMissed(true)}
            data-testid="button-open-missed"
          >
            <EyeOff className="mr-1.5 h-3.5 w-3.5" />
            Didn't take
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setImporting(true)}
            data-testid="button-open-import"
          >
            <ClipboardPaste className="mr-1.5 h-3.5 w-3.5" />
            Import orders
          </Button>
        </div>
      </div>

      <StyleSwitcher />

      {/* Opening the journal should answer "is this working?" before it asks
          for anything. The guard is the day; the scorecard is the record. */}
      <ScorecardCard trades={scoped} />

      <DailyGuardCard trades={scoped} tags={tags} styleId={activeStyleId} />

      <CoachCard />

      {/* What the log is still missing, above the log itself — an errand
          nobody can see is an errand nobody runs. */}
      <OwedCard trades={closed} onOpen={openTrade} />

      {/* The entry form gets its own column only while it is open. Closed, it
          is one line, and holding a half-empty column beside it just to keep
          the grid symmetrical would waste the widest part of the page —
          so the open trades take the whole width instead. */}
      <div
        className={`grid items-start gap-6 ${
          entryOpen ? "lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]" : "grid-cols-1"
        }`}
      >
        <NewTradeCard
          onOrdersDetected={(rows) => {
            setImportSeed(rows);
            setImporting(true);
          }}
          onExpandedChange={setEntryOpen}
        />

        <div className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold tracking-tight">Open trades</h2>
            <div className="flex items-center gap-2">
              <SortControl value={sortBy} onChange={setSortBy} />
              <span
                className="font-mono text-[11px] text-muted-foreground"
                data-testid="text-open-count"
              >
                {open.length} open
              </span>
            </div>
          </div>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : open.length === 0 ? (
            <Card className="border-dashed border-border bg-card/40 p-6 text-center">
              <p className="text-xs text-muted-foreground">
                No open positions. Log a setup to start tracking one.
              </p>
            </Card>
          ) : (
            <div className={entryOpen ? "space-y-2" : "grid gap-2 md:grid-cols-2"}>
              {open.map((t) => (
                <OpenTradeRow
                  key={t.id}
                  t={t}
                  onSelect={() => openTrade(t)}
                  onView={() => navigate(`/trade/${t.id}`)}
                  onEdit={() => openTrade(t)}
                  onResolve={() => setResolving(t)}
                  onAdd={() => setFilling({ trade: t, kind: "add" })}
                  onTake={() => setFilling({ trade: t, kind: "partial" })}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {pending.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold tracking-tight">
              Waiting to be filled
            </h2>
            <span
              className="font-mono text-[11px] text-muted-foreground"
              data-testid="text-pending-count"
            >
              {pending.length} could open
            </span>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {pending.map((t) => (
              <PendingTradeRow
                key={t.id}
                t={t}
                onEdit={() => openTrade(t)}
                onResolve={() => setResolving(t)}
              />
            ))}
          </div>
        </div>
      )}

      {/* The history is long and the page is for trading, not reading: only
          the last few closes are shown, and the whole section folds away. */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <button
            type="button"
            onClick={() => setShowClosed((v) => !v)}
            aria-expanded={showClosed}
            className="flex items-center gap-1.5 text-sm font-semibold tracking-tight transition-colors hover:text-primary"
            data-testid="button-toggle-closed-section"
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${showClosed ? "" : "-rotate-90"}`}
            />
            Closed trades
          </button>
          <span className="font-mono text-[11px] text-muted-foreground">
            {closed.length} logged
          </span>
        </div>
        {showClosed &&
          (closed.length === 0 ? (
            <Card className="border-dashed border-border bg-card/40 p-6 text-center">
              <p className="text-xs text-muted-foreground">
                Closed trades and their management scorecard will appear here.
              </p>
            </Card>
          ) : (
            <>
              <div className="grid gap-2 md:grid-cols-2">
                {(allClosed ? closed : closed.slice(0, CLOSED_PREVIEW)).map((t) => (
                  <ClosedTradeRow
                    key={t.id}
                    t={t}
                    tagNames={tagNames}
                    onView={() => navigate(`/trade/${t.id}`)}
                    onEdit={() => openTrade(t)}
                  />
                ))}
              </div>
              {closed.length > CLOSED_PREVIEW && (
                <button
                  type="button"
                  onClick={() => setAllClosed((v) => !v)}
                  className="text-[11px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                  data-testid="button-show-all-closed"
                >
                  {allClosed
                    ? `Show only the last ${CLOSED_PREVIEW}`
                    : `Show all ${closed.length} closed trades`}
                </button>
              )}
            </>
          ))}
      </div>

      {cancelled.length > 0 && (
        <details className="space-y-2" data-testid="section-cancelled">
          <summary className="cursor-pointer text-sm font-semibold tracking-tight">
            Never became positions
            <span className="ml-2 font-mono text-[11px] font-normal text-muted-foreground">
              {cancelled.length}
              {cancelled.filter((t) => t.wouldHaveHitTarget).length > 0 &&
                ` · ${cancelled.filter((t) => t.wouldHaveHitTarget).length} would have won`}
            </span>
          </summary>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {cancelled.map((t) => (
              <Card key={t.id} className="flex items-center gap-2 p-2.5">
                <span className="font-mono text-xs">{t.symbol}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  @ {num(t.entryPrice)}
                </span>
                <Badge variant="outline" className="text-[10px] font-normal">
                  {(t.cancelReason ?? "cancelled").replace("_", " ")}
                </Badge>
                {t.wouldHaveHitTarget === true && (
                  <Badge variant="secondary" className="text-[10px] font-normal">
                    would have hit target
                  </Badge>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto h-6 w-6 text-muted-foreground"
                  onClick={() => navigate(`/trade/${t.id}`)}
                  aria-label="View"
                >
                  <Eye className="h-3.5 w-3.5" />
                </Button>
              </Card>
            ))}
          </div>
        </details>
      )}

      <ImportTradesDialog
        open={importing}
        seedRows={importSeed}
        onClose={() => {
          setImporting(false);
          setImportSeed(null);
        }}
      />
      <ResolveTradeDialog trade={resolving} onClose={() => setResolving(null)} />
      <MissedTradeDialog open={loggingMissed} onClose={() => setLoggingMissed(false)} />
      <FillDialog
        trade={filling?.trade ?? null}
        kind={filling?.kind ?? "partial"}
        onClose={() => setFilling(null)}
      />
    </div>
  );
}

