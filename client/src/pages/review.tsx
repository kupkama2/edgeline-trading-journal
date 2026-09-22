import { useMemo, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  CalendarRange,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  EyeOff,
  Skull,
  Star,
  Zap,
} from "lucide-react";
import { useTradeImages, useTrades, useUpdateTrade } from "@/lib/data";
import { computeMetrics, fmtMoney, fmtR, EXIT_REASON_LABELS } from "@shared/metrics";
import { dayKey, isReviewed, reviewProgress, weekBefore, weekKey, weekStart } from "@shared/review";
import { ReviewRow } from "@/components/review-row";
import type { TradeWithTags } from "@shared/schema";

/**
 * The week, one trade at a time.
 *
 * Every trade here was written up in the minute after it closed, with the
 * screen still in front of you. That is the only moment you will ever record
 * what you were thinking and the worst moment to judge it — and judging is
 * what this screen is for. Six trades read in a row say things no single one
 * of them says.
 *
 * It is a list rather than a wizard: a wizard would make skipping one feel
 * like failing, and the point is to get through the week, not to be marched
 * through it. Each trade carries its own numbers so the judgement can be
 * made here, a box for what the second pass has to say, and one button. The
 * bar at the top is the only pressure applied.
 */
function parseWeek(param: string | undefined): Date {
  if (param && /^\d{4}-\d{2}-\d{2}$/.test(param)) {
    const [y, m, d] = param.split("-").map(Number);
    const at = new Date(y, m - 1, d, 12);
    if (!Number.isNaN(at.getTime())) return weekStart(at);
  }
  return weekStart(new Date());
}

export default function Review() {
  const [, params] = useRoute("/review/:week");
  const [, navigate] = useLocation();
  const { data: trades, isLoading } = useTrades();
  const week = parseWeek(params?.week);
  const p = useMemo(() => reviewProgress(trades ?? [], week), [trades, week]);

  const go = (d: Date) => navigate(`/review/${weekKey(d)}`);
  const thisWeek = weekKey(new Date());

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
          <h1 className="text-xl font-bold tracking-tight">The week in review</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Read them in a row. Six trades together say things no one of them says.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => go(weekBefore(week))}
            aria-label="The week before"
            data-testid="button-week-back"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-36 text-center font-mono text-[11px]" data-testid="text-week-label">
            {p.label}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={weekKey(week) >= thisWeek}
            onClick={() => go(new Date(week.getTime() + 7 * 24 * 60 * 60 * 1000))}
            aria-label="The week after"
            data-testid="button-week-forward"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Card className="border-card-border bg-card p-4" data-testid="card-review-progress">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <CalendarRange className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-semibold tracking-tight" data-testid="text-review-count">
            {p.trades.length === 0
              ? "Nothing closed this week"
              : p.done
                ? `All ${p.trades.length} gone over`
                : `${p.reviewed} of ${p.trades.length} gone over`}
          </span>
          <div className="flex min-w-32 flex-1 items-center gap-1" data-testid="review-bar">
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
          {/* The other distance. A day gone over the evening it happened is
              already gone over here — one flag — so this is a shortcut into
              the same work, not a second copy of it. */}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 text-[11px] text-muted-foreground"
            onClick={() => navigate(`/review/day/${dayKey(new Date())}`)}
            data-testid="button-to-today"
          >
            Today →
          </Button>
        </div>
        {!p.done && (
          <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
            Say what you see now that you could not see then. A trade with nothing to add is
            still worth marking — going over it is the point, not the writing.
          </p>
        )}
      </Card>

      {p.trades.length === 0 ? (
        <Card className="border-card-border bg-card p-6 text-center">
          <p className="text-sm">No closed trades in this week.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Step back a week, or go and make some.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {p.trades.map((t) => (
            <ReviewRow key={t.id} trade={t} />
          ))}
        </div>
      )}
    </div>
  );
}
