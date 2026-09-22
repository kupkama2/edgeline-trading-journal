import { useMemo } from "react";
import { useLocation, useRoute } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarCheck, Check, ChevronLeft, ChevronRight } from "lucide-react";
import { useTrades } from "@/lib/data";
import { dailyProgress, dayKey, isReviewed, weekKey } from "@shared/review";
import { ReviewRow } from "@/components/review-row";

/**
 * The day, before you have forgotten it.
 *
 * The weekly pass is the one that finds patterns — six trades in a row say
 * things no one of them says — and it is also five days late. By Sunday you
 * are reconstructing Tuesday from a chart and two numbers. Doing the same pass
 * the same evening costs a minute a trade and the memory is still in the room.
 *
 * It is not a second chore. There is one reviewed flag on a trade, so anything
 * gone over here is already gone over when Sunday comes: the week shows it
 * done, the nag stops counting it, and a week whose days were all handled is
 * simply finished. Nothing synchronises them because there is nothing to
 * synchronise — the day and the week ask the same column.
 *
 * The rows are the week's rows. Charts start OPEN here, which is the one
 * difference and the reason to bother: a day is a handful of trades, and
 * "did it reach the target after I got out" is a question about a chart.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

function parseDay(param: string | undefined): Date {
  if (param && /^\d{4}-\d{2}-\d{2}$/.test(param)) {
    const [y, m, d] = param.split("-").map(Number);
    const at = new Date(y, m - 1, d, 12);
    if (!Number.isNaN(at.getTime())) return at;
  }
  return new Date();
}

export default function DailyReview() {
  const [, params] = useRoute("/review/day/:day");
  const [, navigate] = useLocation();
  const { data: trades, isLoading } = useTrades();
  const day = parseDay(params?.day);
  const p = useMemo(() => dailyProgress(trades ?? [], day), [trades, day]);

  const go = (d: Date) => navigate(`/review/day/${dayKey(d)}`);
  const today = dayKey(new Date());

  if (isLoading) {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight">The day in review</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            While you still remember it. Anything gone over here is done for the week too.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => go(new Date(day.getTime() - DAY_MS))}
            aria-label="The day before"
            data-testid="button-day-back"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-40 text-center font-mono text-[11px]" data-testid="text-day-label">
            {p.label}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={dayKey(day) >= today}
            onClick={() => go(new Date(day.getTime() + DAY_MS))}
            aria-label="The day after"
            data-testid="button-day-forward"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Card className="border-card-border bg-card p-4" data-testid="card-daily-progress">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <CalendarCheck className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-semibold tracking-tight" data-testid="text-daily-count">
            {p.trades.length === 0
              ? "Nothing finished on this day"
              : p.done
                ? `All ${p.trades.length} gone over`
                : `${p.reviewed} of ${p.trades.length} gone over`}
          </span>
          <div className="flex min-w-32 flex-1 items-center gap-1" data-testid="daily-bar">
            {p.trades.map((t) => (
              <span
                key={t.id}
                className={`h-1.5 flex-1 rounded-sm ${
                  isReviewed(t) ? "bg-emerald-500" : "bg-border"
                }`}
              />
            ))}
          </div>
          {p.done && p.trades.length > 0 && (
            <span className="flex items-center gap-1 text-[11px] font-semibold text-emerald-400">
              <Check className="h-3.5 w-3.5" /> done
            </span>
          )}
          {/* The week this day sits in, one click away: the day is the habit,
              the week is where the pattern turns up. */}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 text-[11px] text-muted-foreground"
            onClick={() => navigate(`/review/${weekKey(day)}`)}
            data-testid="button-to-week"
          >
            Its week →
          </Button>
        </div>
        {!p.done && (
          <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
            Say what you see now that you could not see then, and how it was traded. A trade
            with nothing to add is still worth marking — going over it is the point.
          </p>
        )}
      </Card>

      {p.trades.length === 0 ? (
        <Card className="border-card-border bg-card p-6 text-center">
          <p className="text-sm">Nothing finished on this day.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            A trade belongs to the day it ENDED — a swing you are still holding will turn up
            here when it closes.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {p.trades.map((t) => (
            <ReviewRow key={t.id} trade={t} chartOpen />
          ))}
        </div>
      )}
    </div>
  );
}
