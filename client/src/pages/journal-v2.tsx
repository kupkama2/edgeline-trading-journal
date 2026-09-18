import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CalendarRange,
  ChevronDown,
  ClipboardList,
  ClipboardPaste,
  EyeOff,
  HelpCircle,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  useTrades,
  useMistakeTags,
  useAccountSettings,
  useMarks,
} from "@/lib/data";
import { filterByScope, scopeActive, useStyleFilter } from "@/lib/style-filter";
import type { TradeWithTags } from "@shared/schema";
import { computeMetrics, fmtMoney, fmtR } from "@shared/metrics";
import { scorecard } from "@shared/scorecard";
import { groupByDay, dayLabel } from "@shared/verdict";
import { owedOutcome } from "@shared/aftermath";
import { journalHealth } from "@shared/health";
import { reviewDue, weekKey } from "@shared/review";
import { openRisk } from "@shared/exposure";
import { DailyGuardCard, useDailyStats, useTiltGuard } from "@/components/daily-guard";
import { Spark } from "@/components/scorecard-card";
import { StyleSwitcher } from "@/components/style-switcher";
import { ImportTradesDialog } from "@/components/import-trades";
import { MissedTradeDialog } from "@/components/missed-trade";
import { FillDialog } from "@/components/fill-dialog";
import { ResolveTradeDialog } from "@/components/resolve-trade";
import type { ImportCandidate } from "@shared/import-parse";
import { NewTradeCard } from "@/components/new-trade-card";
import { ClosedTradeRowV2, OpenTradeRowV2 } from "@/components/trade-rows-v2";
import { TradeBody } from "@/pages/trade-view";
import { TradeEditor } from "@/components/trade-dialogs";
import { PendingTradeRow } from "@/components/trade-rows";
import { OwedCard } from "@/components/owed-card";
import { HealthCard } from "@/components/health-card";
import { useSideBySide } from "@/hooks/use-mobile";
import { ScalpLog } from "@/components/scalp-log";
import { useOutcomeWatch } from "@/lib/outcome-watch";

/**
 * The journal, quiet.
 *
 * Same data, same numbers, far less of it on screen. The organising idea is
 * that a journal page has exactly two jobs — let you log what just happened,
 * and let you find the trade you are thinking about — and that everything
 * which is neither of those is a card you scroll past every day until you stop
 * seeing any of them. So the advisory cards are folded into one line of chips
 * that open on demand, the figures are one strip rather than a scorecard, and
 * a closed trade is four things on a row.
 *
 * Two things deliberately keep their full voice. The tilt meter, because a
 * fail-safe you made smaller is a fail-safe you removed: the moment the meter
 * leaves calm, the whole guard card comes back at full size. And the entry
 * form, because logging is the one thing this page is FOR.
 */

/** How many days of closes are shown before you ask for the rest. */
const DAY_PREVIEW = 3;

/* ============================== figures =============================== */

/** One figure: the number, and the word for what it is. Nothing else. */
function Fig({
  label,
  value,
  tone = "",
  testId,
}: {
  label: string;
  value: string;
  tone?: string;
  testId?: string;
}) {
  return (
    <div className="min-w-0">
      <div className={`font-mono text-base font-bold leading-none tabular-nums ${tone}`} data-testid={testId}>
        {value}
      </div>
      <div className="mt-1 truncate text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

/**
 * The day and the record, side by side.
 *
 * V1 opens with a scorecard: four figures, each with its arithmetic under it,
 * a sparkline and a verdict. All of that is genuinely good and it is also a
 * thing you read once a week, not every time you open the page — so here it is
 * six numbers and a link to the page where the working lives.
 */
function FiguresStrip({ trades }: { trades: TradeWithTags[] }) {
  /*
   * Today reads the SCOPED list, the same one the day groups below are built
   * from, so the figure at the top of the page and the "Today" header further
   * down can never disagree about what today came to.
   *
   * It used to read the day list the guard uses, which forces the book to
   * "both" — so today's money always counted tilt while the day header never
   * did, and the same page showed two different answers. The guard still gets
   * the forced list, because a tilt meter that cannot see tilt trades is not a
   * meter; but that is the guard's business, not this strip's.
   */
  const s = useDailyStats(trades);
  const card = useMemo(() => scorecard(trades), [trades]);

  return (
    <Card className="p-3 sm:p-4" data-testid="card-figures">
      <div className="grid grid-cols-3 gap-4 sm:grid-cols-6">
        <Fig
          label="today"
          value={s.total ? fmtMoney(s.pnl) : "—"}
          tone={!s.total ? "text-muted-foreground" : s.pnl >= 0 ? "text-emerald-400" : "text-primary"}
          testId="fig-today"
        />
        <Fig
          label={s.total === 1 ? "trade today" : "trades today"}
          value={s.total ? `${s.wins}W ${s.losses}L` : "0"}
          testId="fig-today-count"
        />
        <Fig
          label="net R"
          value={card.count ? fmtR(card.totalR) : "—"}
          tone={card.totalR >= 0 ? "text-emerald-400" : "text-primary"}
          testId="fig-total-r"
        />
        <Fig
          label="net"
          value={card.count ? fmtMoney(card.totalPnL) : "—"}
          tone={card.totalPnL >= 0 ? "text-emerald-400" : "text-primary"}
          testId="fig-total-pnl"
        />
        <Fig
          label="win rate"
          value={card.measured ? `${Math.round(card.winRate * 100)}%` : "—"}
          testId="fig-win-rate"
        />
        <Fig
          label="per trade"
          value={card.measured ? fmtR(card.expectancyR) : "—"}
          tone={card.expectancyR >= 0 ? "text-emerald-400" : "text-primary"}
          testId="fig-expectancy"
        />
      </div>
      {/* The curve stays, because it is the one thing here that is a SHAPE
          rather than a number: six figures tell you where the record stands
          and only the line tells you how it got there — a flat month and a
          round trip through a drawdown come to the same totals. Shorter than
          V1's and without its labels; the working is a click away. */}
      {card.curve.length > 1 && (
        <div className="mt-3" data-testid="v2-curve">
          <Spark curve={card.curve} up={card.totalR >= 0} className="h-10 w-full" />
        </div>
      )}
      <div className="mt-3 flex items-center justify-between border-t border-border/50 pt-2">
        <span className="text-[10px] text-muted-foreground">
          {card.count} closed{card.unmeasured > 0 ? ` · ${card.unmeasured} without a stop, so no R` : ""}
        </span>
        <Link
          href="/stats"
          className="text-[10px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          data-testid="link-full-scorecard"
        >
          the working →
        </Link>
      </div>
    </Card>
  );
}

/* ============================= attention ============================== */

/**
 * Everything the journal wants from you, on one line.
 *
 * V1 stacks three cards here — the week you owe, the trades whose outcome is
 * unanswered, the fields left blank — each of which is right to exist and none
 * of which needs to be open. A chip says how many; clicking it opens the card
 * that was always there. When there is nothing owed the line disappears
 * entirely, which is the state worth designing for.
 */
function Chip({
  tone,
  icon: Icon,
  children,
  ...rest
}: {
  tone: "amber" | "red";
  icon: typeof HelpCircle;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const tones = {
    amber: "border-amber-500/40 bg-amber-500/5 text-amber-500 hover:bg-amber-500/10",
    red: "border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/15",
  };
  return (
    <button
      type="button"
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${tones[tone]}`}
      {...rest}
    >
      <Icon className="h-3 w-3 shrink-0" />
      {children}
    </button>
  );
}

function AttentionRow({
  closed,
  scoped,
  allTrades,
  feeAccounts,
  onOpen,
}: {
  closed: TradeWithTags[];
  scoped: TradeWithTags[];
  allTrades: TradeWithTags[];
  feeAccounts: ReadonlySet<string>;
  onOpen: (t: TradeWithTags) => void;
}) {
  const [open, setOpen] = useState<"owed" | "health" | null>(null);
  const owed = owedOutcome(closed);
  const issues = journalHealth(scoped, Date.now(), feeAccounts);
  const missing = issues.reduce((n, i) => n + i.trades.length, 0);
  // The week you owe is never scoped: the style filter asks questions of the
  // record, and the week you owe is the week you owe.
  const due = reviewDue(allTrades);

  if (!due && owed.length === 0 && missing === 0) return null;

  return (
    <div className="space-y-2" data-testid="attention-row">
      <div className="flex flex-wrap items-center gap-2">
        {due && (
          <Link href={`/review/${weekKey(due.week)}`} data-testid="chip-review">
            <Chip tone={due.weeksAgo >= 2 ? "red" : "amber"} icon={CalendarRange}>
              {due.progress.left.length} to go over{due.weeksAgo >= 2 ? ` · ${due.weeksAgo} weeks back` : ""}
            </Chip>
          </Link>
        )}
        {owed.length > 0 && (
          <Chip
            tone="amber"
            icon={HelpCircle}
            onClick={() => setOpen((v) => (v === "owed" ? null : "owed"))}
            aria-expanded={open === "owed"}
            data-testid="chip-owed"
          >
            {owed.length} target or stop?
          </Chip>
        )}
        {missing > 0 && (
          <Chip
            tone="amber"
            icon={ClipboardList}
            onClick={() => setOpen((v) => (v === "health" ? null : "health"))}
            aria-expanded={open === "health"}
            data-testid="chip-health"
          >
            {missing} missing
          </Chip>
        )}
      </div>
      {open === "owed" && <OwedCard trades={closed} onOpen={onOpen} />}
      {open === "health" && (
        <HealthCard trades={scoped} onOpen={onOpen} feeAccounts={feeAccounts} />
      )}
    </div>
  );
}

/* ================================ page ================================ */

export default function JournalV2() {
  const { data: trades, isLoading } = useTrades();
  const { data: accountSettings = [] } = useAccountSettings();
  const feeAccounts = new Set(
    accountSettings
      .filter((a) => a.makerFee > 0 || a.takerFee > 0)
      .map((a) => a.name.trim().toLowerCase()),
  );
  const { data: marks } = useMarks(
    (trades ?? []).some((t) => t.status === "open" && !t.contract?.trim()),
  );
  const { data: tags = [] } = useMistakeTags();
  const { activeStyleId, scope } = useStyleFilter();
  const sideBySide = useSideBySide();
  const [, navigate] = useLocation();
  const openTrade = (t: TradeWithTags) => navigate(`/trade/${t.id}/edit`);
  const viewTrade = (t: TradeWithTags) => navigate(`/trade/${t.id}`);

  const [importing, setImporting] = useState(false);
  const [loggingMissed, setLoggingMissed] = useState(false);
  const [resolving, setResolving] = useState<TradeWithTags | null>(null);
  const [filling, setFilling] = useState<{ trade: TradeWithTags; kind: "add" | "partial" } | null>(null);
  const [importSeed, setImportSeed] = useState<ImportCandidate[] | null>(null);
  const [entryOpen, setEntryOpen] = useState(false);
  const [scalpOpen, setScalpOpen] = useState(false);
  // Shut by default. The filters are how you ask the record a question, and
  // most of the time you are not asking one — but a filter left on and out of
  // sight would silently change every number on the page, so the control says
  // when one is.
  const [filtersOpen, setFiltersOpen] = useState(false);
  /*
   * A trade opens IN the list rather than over it.
   *
   * The overlay is still there for a link arriving from somewhere else, but
   * clicking a row in the journal expands it in place the way the log card
   * expands: the page keeps its scroll, the rows around it stay where they
   * are, and closing it does not re-run the page you were already on. One at
   * a time — two expanded trades is a page you scroll rather than read.
   */
  const [openId, setOpenId] = useState<number | null>(null);
  /*
   * And the full editor is a state of the expanded trade, not a second place.
   * Most corrections never reach it: the figures inside answer to a
   * double-click. It is here for the fields a number box cannot hold — the
   * exit reason, the tags, a second target, the written note.
   */
  const [editingId, setEditingId] = useState<number | null>(null);
  const toggleTrade = (t: TradeWithTags) => {
    setEditingId(null);
    setOpenId((cur) => (cur === t.id ? null : t.id));
  };
  const [showClosed, setShowClosed] = useState(true);
  const [allDays, setAllDays] = useState(false);

  const scoped = useMemo(() => filterByScope(trades ?? [], scope), [trades, scope]);
  // The day is the day: the guard reads every trade taken today, tilt
  // included, whichever book the rest of the page is showing.
  const dayTrades = useMemo(
    () => filterByScope(trades ?? [], { ...scope, book: "both" }),
    [trades, scope],
  );
  const open = useMemo(
    () =>
      scoped
        .filter((t) => t.status === "open")
        .sort((a, b) => b.entryTime.localeCompare(a.entryTime)),
    [scoped],
  );
  const pending = useMemo(() => scoped.filter((t) => t.status === "pending"), [scoped]);
  const closed = useMemo(() => scoped.filter((t) => t.status === "closed"), [scoped]);
  const days = useMemo(() => groupByDay(closed), [closed]);
  const exposure = useMemo(() => openRisk(scoped), [scoped]);
  const filtered = scopeActive(scope);

  // The fail-safe. Everything else on this page got quieter; this one gets
  // exactly as loud as it was, the moment there is anything to be loud about.
  const tilt = useTiltGuard(dayTrades);
  const guardLoud = tilt.meter.state !== "calm" || tilt.locked;

  useOutcomeWatch(closed.length > 0);

  const shown = allDays ? days : days.slice(0, DAY_PREVIEW);

  /**
   * The expanded trade, under the row it belongs to.
   *
   * Indented and railed so it reads as belonging to the row above rather than
   * as the next item in the list — the same gesture the log card makes when it
   * opens.
   */
  const panel = (t: TradeWithTags) =>
    openId !== t.id ? null : (
      <div
        className="ml-2 mt-1 rounded-md border border-primary/30 bg-card/60 p-3 sm:p-4"
        data-testid={`panel-trade-${t.id}`}
        /* A click inside the trade is not a click on the row, and the rows
           above and below both open on click. Without this, correcting a
           figure would collapse the thing being corrected. */
        onClick={(e) => e.stopPropagation()}
      >
        {/*
          The way back out, always in reach.
          A trade is a long panel and the row that opened it scrolls away
          within a screen, so closing one meant scrolling back up to find the
          thing you were done with. This rides the top of the panel instead,
          just under the app's own header — the same idea as the save bar at
          the other end.

          It sits ABOVE the editor as well as the body, so there is one way
          out whichever state the trade is in, and it never covers the last
          line of the panel because it is the first child rather than an
          overlay.
        */}
        <button
          type="button"
          onClick={() => {
            setEditingId(null);
            setOpenId(null);
          }}
          className="sticky top-14 z-20 -mx-3 mb-2 flex w-[calc(100%+1.5rem)] items-center gap-2 border-b border-border/70 bg-card/95 px-3 py-2 text-left backdrop-blur transition-colors hover:text-primary sm:-mx-4 sm:w-[calc(100%+2rem)] sm:px-4"
          title="Close this trade"
          data-testid={`button-collapse-${t.id}`}
        >
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="font-mono text-sm font-semibold">{t.symbol}</span>
          <span className="text-[11px] text-muted-foreground">
            {editingId === t.id ? "editing" : "click to close"}
          </span>
          <X className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
        {editingId === t.id ? (
          <TradeEditor trade={t} card={null} onClose={() => setEditingId(null)} />
        ) : (
          <TradeBody
            trade={t}
            onEdit={() => setEditingId(t.id)}
            onCloseTrade={() => setEditingId(t.id)}
            onResolve={() => setResolving(t)}
            onFill={(kind) => setFilling({ trade: t, kind })}
            onDeleted={() => setOpenId(null)}
          />
        )}
      </div>
    );

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <h1 className="text-xl font-bold tracking-tight">Journal</h1>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className={`h-7 px-2 text-[11px] ${
              filtered ? "text-primary" : "text-muted-foreground"
            }`}
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
            aria-label="Filters"
            title={filtered ? "A filter is on — this page is a subset" : "Styles, accounts, sources, book"}
            data-testid="button-toggle-filters"
          >
            <SlidersHorizontal className="mr-1 h-3 w-3" />
            {filtered ? "Filtered" : "Filter"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px] text-muted-foreground"
            onClick={() => setLoggingMissed(true)}
            data-testid="button-open-missed"
          >
            <EyeOff className="mr-1 h-3 w-3" />
            Didn't take
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px] text-muted-foreground"
            onClick={() => setImporting(true)}
            data-testid="button-open-import"
          >
            <ClipboardPaste className="mr-1 h-3 w-3" />
            Import
          </Button>
        </div>
      </div>

      {filtersOpen && <StyleSwitcher />}

      <FiguresStrip trades={scoped} />

      {guardLoud && <DailyGuardCard trades={dayTrades} tags={tags} styleId={activeStyleId} />}

      <AttentionRow
        closed={closed}
        scoped={scoped}
        allTrades={trades ?? []}
        feeAccounts={feeAccounts}
        onOpen={openTrade}
      />

      <div
        className={`grid items-start gap-5 ${
          entryOpen && sideBySide
            ? "grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]"
            : "grid-cols-1"
        }`}
      >
        {/* Two ways in, two buttons. Shut, they are a pair of short labels on
            one line — the page should not spend a third of its height on two
            things you are not currently doing. Whichever you open takes the
            row to itself, because a half-width form is a worse form. */}
        <div
          className={
            entryOpen || scalpOpen ? "space-y-3" : "grid grid-cols-2 items-start gap-3"
          }
          data-testid="log-row"
        >
          <NewTradeCard
            onOrdersDetected={(rows) => {
              setImportSeed(rows);
              setImporting(true);
            }}
            onExpandedChange={setEntryOpen}
            narrow={sideBySide}
            compact
          />
          {/* Hidden while the setup form is open: it would sit under a tall
              form as an orphan, and the two are alternatives anyway. */}
          {!entryOpen && <ScalpLog compact onOpenChange={setScalpOpen} />}
        </div>

        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold tracking-tight">Open</h2>
            <span className="font-mono text-[11px] text-muted-foreground" data-testid="text-open-count">
              {open.length}
              {exposure.trades > 0 && (
                <>
                  {" · "}
                  <span className="text-primary" data-testid="open-risk-r">
                    −{exposure.r.toFixed(2)}R
                  </span>{" "}
                  <span className="text-primary" data-testid="open-risk-dollars">
                    {fmtMoney(-exposure.dollars)}
                  </span>{" "}
                  at risk
                  {exposure.oneWay.side && exposure.trades > 1 &&
                    (exposure.long.trades === 0 || exposure.short.trades === 0) && (
                      <span className="text-amber-500" data-testid="open-risk-one-way">
                        {" "}· all one way
                      </span>
                    )}
                </>
              )}
            </span>
          </div>
          {isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : open.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">Nothing open.</p>
          ) : (
            <div className="space-y-1.5">
              {open.map((t) => (
                <div key={t.id}>
                  <OpenTradeRowV2
                    t={t}
                    mark={marks?.[t.id] ?? null}
                    expanded={openId === t.id}
                    onSelect={() => toggleTrade(t)}
                    onEdit={() => {
                      setOpenId(t.id);
                      setEditingId(t.id);
                    }}
                    onResolve={() => setResolving(t)}
                    onAdd={() => setFilling({ trade: t, kind: "add" })}
                    onTake={() => setFilling({ trade: t, kind: "partial" })}
                  />
                  {panel(t)}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {pending.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold tracking-tight">Waiting to be filled</h2>
            <span className="font-mono text-[11px] text-muted-foreground" data-testid="text-pending-count">
              {pending.length} could open
            </span>
          </div>
          <div className="grid gap-2 [&>*]:min-w-0 md:grid-cols-2">
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

      {/* The record. A day at a time, because that is the unit it happened in —
          which is also what lets every row underneath drop its timestamp. */}
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
            Closed
          </button>
          <span className="font-mono text-[11px] text-muted-foreground">{closed.length} logged</span>
        </div>

        {showClosed &&
          (closed.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">Nothing closed yet.</p>
          ) : (
            <>
              <div className="space-y-4">
                {shown.map((g) => (
                  <div key={g.key} data-testid={`day-${g.key}`}>
                    <div className="flex items-baseline gap-2 border-b border-border/50 px-3 pb-1">
                      <span className="text-xs font-semibold tracking-tight" data-testid={`day-label-${g.key}`}>
                        {dayLabel(g.date)}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {g.trades.length}
                        {g.tilt > 0 ? ` · ${g.tilt} tilt` : ""}
                      </span>
                      <span className="ml-auto flex items-baseline gap-2 font-mono text-[11px] tabular-nums">
                        {g.r != null && (
                          <span className={g.r >= 0 ? "text-emerald-400/80" : "text-primary/80"}>
                            {fmtR(g.r)}
                          </span>
                        )}
                        <span
                          className={`font-semibold ${g.pnl >= 0 ? "text-emerald-400" : "text-primary"}`}
                          data-testid={`day-pnl-${g.key}`}
                        >
                          {fmtMoney(g.pnl)}
                        </span>
                      </span>
                    </div>
                    <div className="mt-1 space-y-0.5">
                      {g.trades.map((t) => (
                        <div key={t.id}>
                          <ClosedTradeRowV2
                            t={t}
                            expanded={openId === t.id}
                            onSelect={() => toggleTrade(t)}
                            onEdit={() => {
                              setOpenId(t.id);
                              setEditingId(t.id);
                            }}
                          />
                          {panel(t)}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {days.length > DAY_PREVIEW && (
                <button
                  type="button"
                  onClick={() => setAllDays((v) => !v)}
                  className="text-[11px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                  data-testid="button-show-all-closed"
                >
                  {allDays
                    ? `Show only the last ${DAY_PREVIEW} days`
                    : `Show all ${days.length} days`}
                </button>
              )}
            </>
          ))}
      </div>

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
