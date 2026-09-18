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
  Skull,
  Star,
  Zap,
} from "lucide-react";
import { useTrades, useUpdateTrade } from "@/lib/data";
import { computeMetrics, fmtMoney, fmtR, EXIT_REASON_LABELS } from "@shared/metrics";
import { isReviewed, reviewProgress, weekBefore, weekKey, weekStart } from "@shared/review";
import { StyleChip } from "@/components/style-switcher";
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

function ReviewRow({ trade: t }: { trade: TradeWithTags }) {
  const m = computeMetrics(t);
  const update = useUpdateTrade();
  const [note, setNote] = useState(t.reviewNote ?? "");
  const [, navigate] = useLocation();
  const done = isReviewed(t);
  const win = (m.actualPnL ?? 0) >= 0;

  async function mark() {
    await update.mutateAsync({
      id: t.id,
      trade: {
        reviewNote: note.trim() || null,
        // Un-marking keeps whatever was written: the note is the work, the
        // stamp is only the record that the work happened.
        reviewedAt: done ? null : new Date().toISOString(),
      } as any,
    });
  }

  const when = new Date(t.exitTime ?? t.entryTime).toLocaleDateString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <Card
      className={`border-card-border bg-card p-3.5 transition-colors ${
        done ? "border-emerald-500/30" : ""
      }`}
      data-testid={`card-review-${t.id}`}
      data-reviewed={done ? "true" : "false"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => navigate(`/trade/${t.id}`)}
          className="font-mono text-sm font-semibold hover:underline"
          data-testid={`button-open-${t.id}`}
        >
          {t.symbol}
        </button>
        <StyleChip styleId={t.styleId} />
        {t.scalp && (
          <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-400">
            <Zap className="mr-1 h-3 w-3" />
            scalp
          </Badge>
        )}
        {t.tilt && (
          <Badge variant="outline" className="border-primary/50 text-[10px] text-primary">
            <Skull className="mr-1 h-3 w-3" />
            tilt
          </Badge>
        )}
        {t.wellTraded && !t.tilt && (
          <Badge variant="outline" className="border-amber-500/50 text-[10px] text-amber-400">
            <Star className="mr-1 h-3 w-3 fill-current" />
            well traded
          </Badge>
        )}
        {!t.scalp && t.exitReason && (
          <Badge variant="outline" className="text-[10px] capitalize">
            {EXIT_REASON_LABELS[t.exitReason]}
          </Badge>
        )}
        <span className="text-[10px] text-muted-foreground">{when}</span>

        <span className="ml-auto flex items-center gap-2 font-mono text-sm">
          <span className={`font-bold ${win ? "text-emerald-400" : "text-primary"}`}>
            {fmtR(m.actualR)}
          </span>
          <span className={win ? "text-emerald-400/80" : "text-primary/80"}>
            {fmtMoney(m.actualPnL)}
          </span>
        </span>
      </div>

      {/* What it was for, in the words written at the time — the thing the
          second pass is judging. */}
      {(t.rationale?.trim() || t.notes?.trim()) && (
        <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
          {t.rationale?.trim() && <span className="text-foreground">{t.rationale.trim()}</span>}
          {t.rationale?.trim() && t.notes?.trim() && " · "}
          {t.notes?.trim()}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What do you see now that you could not see then?"
          className="min-h-[52px] flex-1 basis-64 text-xs"
          data-testid={`input-review-note-${t.id}`}
        />
        <Button
          type="button"
          size="sm"
          variant={done ? "outline" : "default"}
          className="h-9 shrink-0 text-[11px]"
          disabled={update.isPending}
          onClick={() => void mark()}
          data-testid={`button-review-${t.id}`}
        >
          {update.isPending ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="mr-1.5 h-3.5 w-3.5" />
          )}
          {done ? "Gone over" : "Mark gone over"}
        </Button>
      </div>
    </Card>
  );
}
