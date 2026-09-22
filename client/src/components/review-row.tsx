import { Suspense, lazy, useState } from "react";
import { useLocation } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  EyeOff,
  Loader2,
  Skull,
  Sparkles,
  Star,
  Zap,
} from "lucide-react";
import { useMistakeTags, useTradeImages, useUpdateTrade, readCloseNote } from "@/lib/data";
import { computeMetrics, fmtMoney, fmtR, EXIT_REASON_LABELS } from "@shared/metrics";
import { closeReadSummary } from "@shared/close-read";
import { exclusiveVerdict } from "@shared/well-traded";
import { isMiss, isReviewed } from "@shared/review";
import { StyleChip } from "@/components/style-switcher";
import { ResolveTradeDialog } from "@/components/resolve-trade";
import { useToast } from "@/hooks/use-toast";
import type { TradeWithTags, UpdateTrade } from "@shared/schema";

const TradeChart = lazy(() =>
  import("@/components/trade-chart").then((m) => ({ default: m.TradeChart })),
);

/**
 * One trade, being judged after the fact.
 *
 * Shared by the day's review and the week's, because they are the same act at
 * two distances and having written it twice would mean fixing it twice. The
 * only thing that differs is how much is open when you arrive: a day is a
 * handful of trades and the charts may as well all be up, a week can be
 * twenty and having twenty charts fetch at once to scroll past is a page that
 * takes a second to become usable.
 *
 * What a review IS, here: a sentence about what you see now that you could not
 * see then, a verdict on how it was traded, and the chart to check the
 * sentence against. The note is the work — the rest is what makes the work
 * possible in under a minute a trade, which is the difference between a habit
 * and a thing you did twice.
 */
export function ReviewRow({
  trade: t,
  chartOpen = false,
}: {
  trade: TradeWithTags;
  /** Whether the chart starts up. A day says yes; a week says no. */
  chartOpen?: boolean;
}) {
  const m = computeMetrics(t);
  const update = useUpdateTrade();
  const { data: demons = [] } = useMistakeTags();
  const { toast } = useToast();
  const [note, setNote] = useState(t.reviewNote ?? "");
  const [reading, setReading] = useState(false);
  const [read, setRead] = useState<string | null>(null);
  const [showChart, setShowChart] = useState(chartOpen);
  const [resolving, setResolving] = useState(false);
  const [, navigate] = useLocation();
  const done = isReviewed(t);
  const win = (m.actualPnL ?? 0) >= 0;
  const miss = isMiss(t);
  const { data: shots = [] } = useTradeImages(miss ? t.id : null);
  const shot = shots[0]?.data ?? null;
  const plannedR =
    miss && t.initialStop != null && t.initialTarget != null && t.entryPrice > 0
      ? Math.abs(t.initialTarget - t.entryPrice) / Math.abs(t.entryPrice - t.initialStop)
      : null;

  const write = (patch: Record<string, unknown>) =>
    update.mutateAsync({ id: t.id, trade: patch as any }).catch((err: any) =>
      toast({
        title: "That didn't save",
        description: String(err?.message ?? err).slice(0, 160),
        variant: "destructive",
      }),
    );

  /**
   * Traded well and tilt are one answer, not two checkboxes.
   *
   * exclusiveVerdict is what keeps them from both being true — a trade cannot
   * be your best execution of the month and a tilt trade at once, and the one
   * place that rule lives is shared so every writer obeys it. Pressing the one
   * already set clears it: the second press of a toggle is how somebody takes
   * back a judgement they made too fast.
   */
  const verdict = (field: "wellTraded" | "tilt") => {
    const on = field === "tilt" ? t.tilt : t.wellTraded;
    void write(exclusiveVerdict({ [field]: !on } as any));
  };

  /**
   * The note, read into the fields it is about.
   *
   * The same reader the close form uses, pointed at the second pass instead of
   * the first — "should have let it run, chased the entry again" names a demon
   * and grades an entry, and typing those into pickers afterwards is the part
   * that stops getting done in week three. It only ever ADDS: demons and
   * highlights are merged, and a grade already set by hand is left alone,
   * because the read is a suggestion made from one sentence and what you put
   * there deliberately outranks it.
   */
  async function readIt() {
    const text = note.trim();
    if (!text) return;
    setReading(true);
    try {
      const r = await readCloseNote(text, {
        direction: t.direction === "short" ? "short" : "long",
        entryPrice: t.entryPrice,
        initialStop: t.initialStop,
        initialTarget: t.initialTarget,
        exitPrice: t.exitPrice,
      });
      if (!r) {
        toast({ title: "Couldn't read that", description: "The note is saved either way." });
        return;
      }
      const patch: Record<string, unknown> = {};
      if (r.entryGrade && !t.entryGrade) patch.entryGrade = r.entryGrade;
      if (r.stopGrade && !t.stopGrade) patch.stopGrade = r.stopGrade;
      if (r.exitGrade && !t.exitGrade) patch.exitGrade = r.exitGrade;
      if (r.exitReason && !t.exitReason) patch.exitReason = r.exitReason;
      const tags = Array.from(new Set([...t.mistakeTagIds, ...r.demonIds]));
      const newTags = tags.length !== t.mistakeTagIds.length;
      const said = closeReadSummary(r, demons);
      setRead(said || "nothing it could place");
      if (Object.keys(patch).length > 0 || newTags) {
        await update
          .mutateAsync({
            id: t.id,
            trade: patch as UpdateTrade,
            // Undefined rather than the unchanged list: the route takes the
            // absence as "leave the demons alone", and sending them back
            // unchanged is a write that can only lose a race.
            mistakeTagIds: newTags ? tags : undefined,
          })
          .catch(() => setRead("read it, but couldn't save what it found"));
      }
    } finally {
      setReading(false);
    }
  }

  /** The note is the work; the stamp only records that the work happened. */
  async function mark() {
    await write({
      reviewNote: note.trim() || null,
      reviewedAt: done ? null : new Date().toISOString(),
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
        {miss && (
          <Badge variant="outline" className="border-sky-500/40 text-[10px] text-sky-400">
            <EyeOff className="mr-1 h-3 w-3" />
            didn't take
          </Badge>
        )}
        {!t.scalp && !miss && t.exitReason && (
          <Badge variant="outline" className="text-[10px] capitalize">
            {EXIT_REASON_LABELS[t.exitReason]}
          </Badge>
        )}
        <span className="text-[10px] text-muted-foreground">{when}</span>

        <span className="ml-auto flex items-center gap-2 font-mono text-sm">
          {miss ? (
            <span className="text-[11px] text-muted-foreground" data-testid={`review-miss-r-${t.id}`}>
              {plannedR != null ? (
                <>
                  planned <span className="font-semibold text-sky-400">{plannedR.toFixed(2)}R</span>
                </>
              ) : (
                "no levels logged"
              )}
            </span>
          ) : (
            <>
              <span className={`font-bold ${win ? "text-emerald-400" : "text-primary"}`}>
                {fmtR(m.actualR)}
              </span>
              <span className={win ? "text-emerald-400/80" : "text-primary/80"}>
                {fmtMoney(m.actualPnL)}
              </span>
            </>
          )}
        </span>
      </div>

      {/* A miss carries its screenshot; that IS the record for one. */}
      {shot && (
        <button
          type="button"
          onClick={() => navigate(`/trade/${t.id}`)}
          className="mt-2 block w-full overflow-hidden rounded-md border border-card-border"
          data-testid={`review-miss-shot-${t.id}`}
        >
          <img src={shot} alt="" className="max-h-52 w-full bg-secondary/20 object-contain" />
        </button>
      )}

      {(t.rationale?.trim() || t.notes?.trim()) && (
        <p
          className={`mt-1.5 text-[11px] leading-snug ${
            miss ? "text-foreground/90" : "text-muted-foreground"
          }`}
        >
          {t.rationale?.trim() && <span className="text-foreground">{t.rationale.trim()}</span>}
          {t.rationale?.trim() && t.notes?.trim() && " · "}
          {t.notes?.trim()}
        </p>
      )}

      {/*
        The chart, with the plan still drawn on it.
        Judging an exit off a row of numbers is judging it off your memory of
        the chart; this is the chart. Entry, stop and target are on it, so
        "did it reach the target after I got out" is a thing you can see
        rather than a thing you have to remember.
      */}
      {!t.scalp && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowChart((v) => !v)}
            className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
            aria-expanded={showChart}
            data-testid={`button-review-chart-${t.id}`}
          >
            {showChart ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            {showChart ? "Hide the chart" : "Show the chart"}
          </button>
          {showChart && (
            <div className="mt-2">
              <Suspense
                fallback={<div className="h-40 animate-pulse rounded-md bg-secondary/30" />}
              >
                <TradeChart trade={t} />
              </Suspense>
            </div>
          )}
        </div>
      )}

      {/* One verdict, in one press. These are the two things worth saying
          about execution that are not a sentence, and they are the two the
          rest of the journal counts. */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          variant={t.wellTraded ? "default" : "outline"}
          className={`h-7 text-[11px] ${t.wellTraded ? "" : "text-muted-foreground"}`}
          disabled={update.isPending}
          onClick={() => verdict("wellTraded")}
          aria-pressed={Boolean(t.wellTraded)}
          data-testid={`button-review-well-${t.id}`}
        >
          <Star className={`mr-1 h-3 w-3 ${t.wellTraded ? "fill-current" : ""}`} />
          Traded well
        </Button>
        <Button
          type="button"
          size="sm"
          variant={t.tilt ? "destructive" : "outline"}
          className={`h-7 text-[11px] ${t.tilt ? "" : "text-muted-foreground"}`}
          disabled={update.isPending}
          onClick={() => verdict("tilt")}
          aria-pressed={Boolean(t.tilt)}
          data-testid={`button-review-tilt-${t.id}`}
        >
          <Skull className="mr-1 h-3 w-3" />
          Tilt
        </Button>
        {/* For the order that was logged as a trade and never became one.
            Kept out of P&L rather than deleted: an entry that never filled
            and would have paid is a real cost, and the only way that pattern
            is ever visible is keeping the record. */}
        {t.status !== "cancelled" && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 text-[11px] text-muted-foreground"
            onClick={() => setResolving(true)}
            data-testid={`button-review-unfilled-${t.id}`}
          >
            <Ban className="mr-1 h-3 w-3" />
            Never filled
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 text-[11px] text-muted-foreground"
          disabled={reading || note.trim() === ""}
          onClick={() => void readIt()}
          title="Read the note into the demons, the grades and the exit reason"
          data-testid={`button-review-read-${t.id}`}
        >
          {reading ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Sparkles className="mr-1 h-3 w-3" />
          )}
          Read the note
        </Button>
        {read && (
          <span className="text-[10px] text-muted-foreground" data-testid={`review-read-${t.id}`}>
            {read}
          </span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={
            miss
              ? "Was passing it right? What would have had to be different?"
              : "What do you see now that you could not see then?"
          }
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

      {resolving && <ResolveTradeDialog trade={t} onClose={() => setResolving(false)} />}
    </Card>
  );
}
