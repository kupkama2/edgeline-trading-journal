import { useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowDownRight,
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
} from "lucide-react";
import { useDailyNotes, useSaveDailyNote, useTrades } from "@/lib/data";
import { useStyleScopedTrades } from "@/lib/style-filter";
import { StyleSwitcher } from "@/components/style-switcher";
import { dayKey, monthGrid, summarizeDays, tradesOnDay } from "@shared/daily";
import { computeMetrics, fmtMoney, fmtR } from "@shared/metrics";

/**
 * The day as the unit of review.
 *
 * One free-form file per day — dump anything, any time, edit it later — beside
 * the numbers that day actually produced. The calendar is the index: each cell
 * carries the day's realised P&L and trade count, so a month of trading reads
 * at a glance and any day is one click from its full report.
 *
 * Only the written note is stored. Everything quantitative is derived from the
 * trade log at render time, so this page can never disagree with the journal.
 */

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function monthLabel(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

export default function Daily() {
  const { data: trades = [], isLoading } = useTrades();
  const scoped = useStyleScopedTrades(trades);
  const { data: notes = [] } = useDailyNotes();
  const save = useSaveDailyNote();

  const today = dayKey(new Date());
  const [selected, setSelected] = useState(today);
  const [view, setView] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const days = useMemo(() => summarizeDays(scoped), [scoped]);
  const noteByDay = useMemo(
    () => new Map(notes.map((n) => [n.day, n])),
    [notes],
  );

  /* ------------------------------ editor ------------------------------ */

  // The draft belongs to one day; switching days must never carry text across.
  const stored = noteByDay.get(selected)?.body ?? "";
  const [draft, setDraft] = useState(stored);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setDraft(stored);
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  // Adopt a background refetch only while the editor has no unsaved typing.
  useEffect(() => {
    if (!dirty) setDraft(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored]);

  // Debounced autosave: the note should survive a tab close without a save
  // button, but not cost a write per keystroke.
  const timer = useRef<ReturnType<typeof setTimeout>>();
  function onType(next: string) {
    setDraft(next);
    setDirty(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      save.mutate({ day: selected, body: next }, { onSuccess: () => setDirty(false) });
    }, 800);
  }
  useEffect(() => () => clearTimeout(timer.current), []);

  function stampTime() {
    const now = new Date().toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
    const sep = draft.trim().length ? "\n\n" : "";
    onType(`${draft}${sep}[${now}] `);
  }

  /* ----------------------------- day report ---------------------------- */

  const { entered, closed } = useMemo(
    () => tradesOnDay(scoped, selected),
    [scoped, selected],
  );
  const summary = days.get(selected);
  // Union, closed first: what the day settled reads before what it opened.
  const dayTrades = useMemo(() => {
    const ids = new Set(closed.map((t) => t.id));
    return [...closed, ...entered.filter((t) => !ids.has(t.id))];
  }, [entered, closed]);

  const cells = useMemo(() => monthGrid(view.year, view.month), [view]);

  function shiftMonth(by: number) {
    setView(({ year, month }) => {
      const d = new Date(year, month + by, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Daily</h1>
          <p className="text-xs text-muted-foreground">
            One file per day. Dump anything, any time — the numbers fill themselves in.
          </p>
        </div>
        <StyleSwitcher />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        {/* ------------------------------ calendar ------------------------------ */}
        <Card className="border-card-border bg-card p-4" data-testid="card-calendar">
          <div className="mb-3 flex items-center justify-between">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => shiftMonth(-1)}
              data-testid="button-prev-month"
              aria-label="Previous month"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-semibold" data-testid="text-month-label">
              {monthLabel(view.year, view.month)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => shiftMonth(1)}
              data-testid="button-next-month"
              aria-label="Next month"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          <div className="grid grid-cols-7 gap-1">
            {WEEKDAYS.map((d) => (
              <div
                key={d}
                className="pb-1 text-center text-[10px] uppercase tracking-wider text-muted-foreground"
              >
                {d}
              </div>
            ))}
            {cells.map((date) => {
              const k = dayKey(date);
              const inMonth = date.getMonth() === view.month;
              const s = days.get(k);
              const hasNote = (noteByDay.get(k)?.body ?? "").trim().length > 0;
              const active = k === selected;
              const pnl = s?.totalPnL ?? 0;
              return (
                <button
                  key={k}
                  onClick={() => setSelected(k)}
                  data-testid={`cell-day-${k}`}
                  className={`flex min-h-[52px] flex-col items-center justify-start rounded-md border p-1 text-center transition-colors ${
                    active
                      ? "border-primary bg-primary/10"
                      : "border-transparent hover:border-border hover:bg-secondary/40"
                  } ${inMonth ? "" : "opacity-35"}`}
                >
                  <span
                    className={`text-[11px] leading-tight ${
                      k === today ? "font-bold text-primary" : ""
                    }`}
                  >
                    {date.getDate()}
                  </span>
                  {s && s.closed > 0 ? (
                    <>
                      <span
                        className={`font-mono text-[10px] leading-tight ${
                          pnl > 0
                            ? "text-emerald-500"
                            : pnl < 0
                              ? "text-red-500"
                              : "text-muted-foreground"
                        }`}
                      >
                        {fmtMoney(pnl)}
                      </span>
                      <span className="font-mono text-[9px] leading-tight text-muted-foreground">
                        {s.wins}W {s.losses}L
                      </span>
                    </>
                  ) : (
                    // The dot marks a day that has words but no closed trades —
                    // a skipped day you wrote about is still a day reviewed.
                    hasNote && <span className="mt-1 h-1 w-1 rounded-full bg-primary/70" />
                  )}
                </button>
              );
            })}
          </div>
        </Card>

        {/* ----------------------------- day detail ----------------------------- */}
        <div className="min-w-0 space-y-4">
          <Card className="border-card-border bg-card p-4" data-testid="card-day-note">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold" data-testid="text-selected-day">
                {new Date(`${selected}T00:00:00`).toLocaleDateString(undefined, {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
              </h2>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground" data-testid="text-save-state">
                  {save.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : dirty ? (
                    "typing…"
                  ) : (noteByDay.get(selected) ?? null) ? (
                    <Check className="h-3 w-3 text-emerald-500" />
                  ) : null}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={stampTime}
                  data-testid="button-stamp-time"
                >
                  <Clock className="mr-1 h-3 w-3" />
                  Stamp time
                </Button>
              </div>
            </div>
            <Textarea
              value={draft}
              onChange={(e) => onType(e.target.value)}
              placeholder={
                selected === today
                  ? "What's happening today? Market context, state of mind, trades you skipped and why — dump it here as the day goes."
                  : "Nothing written for this day. You can still add it."
              }
              className="min-h-[180px] font-mono text-[12px] leading-relaxed"
              data-testid="input-day-note"
            />
          </Card>

          <Card className="border-card-border bg-card p-4" data-testid="card-day-report">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
              <Badge variant="secondary" className="font-mono" data-testid="badge-day-entered">
                {summary?.entered ?? 0} opened
              </Badge>
              <Badge variant="secondary" className="font-mono" data-testid="badge-day-closed">
                {summary?.closed ?? 0} closed
              </Badge>
              {summary && summary.closed > 0 && (
                <>
                  <Badge variant="secondary" className="font-mono">
                    {summary.wins}W / {summary.losses}L
                  </Badge>
                  <Badge
                    variant="secondary"
                    className={`font-mono ${
                      summary.totalPnL > 0
                        ? "text-emerald-500"
                        : summary.totalPnL < 0
                          ? "text-red-500"
                          : ""
                    }`}
                    data-testid="badge-day-pnl"
                  >
                    {fmtMoney(summary.totalPnL)}
                  </Badge>
                  <Badge variant="secondary" className="font-mono">
                    {fmtR(summary.totalR)}
                  </Badge>
                </>
              )}
            </div>

            {dayTrades.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                No trades on this day.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {dayTrades.map((t) => {
                  const m = computeMetrics(t);
                  const closedToday = closed.some((c) => c.id === t.id);
                  return (
                    <li
                      key={t.id}
                      className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5"
                      data-testid={`row-day-trade-${t.id}`}
                    >
                      {t.direction === "long" ? (
                        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                      ) : (
                        <ArrowDownRight className="h-3.5 w-3.5 shrink-0 text-red-500" />
                      )}
                      <span className="font-mono text-[11px] font-semibold">{t.symbol}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        @ {t.entryPrice}
                      </span>
                      <span className="ml-auto flex items-center gap-2 font-mono text-[11px]">
                        {closedToday && m.actualR != null ? (
                          <>
                            <span
                              className={
                                m.actualR > 0
                                  ? "text-emerald-500"
                                  : m.actualR < 0
                                    ? "text-red-500"
                                    : ""
                              }
                            >
                              {fmtR(m.actualR)}
                            </span>
                            <span className="text-muted-foreground">
                              {fmtMoney(m.actualPnL)}
                            </span>
                          </>
                        ) : (
                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            {t.status}
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
