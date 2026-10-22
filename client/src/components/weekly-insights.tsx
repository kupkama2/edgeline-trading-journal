import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Sparkles, TriangleAlert } from "lucide-react";
import type { MistakeTag, TradeWithTags } from "@shared/schema";
import {
  buildInsightsBundle,
  type WeeklyInsights,
} from "@shared/weekly-insights";
import { localWeek, readStaleNotes, useDailyNotes, useWeeklyInsights, useWeeklyReviews } from "@/lib/data";
import { noteNeedsRead } from "@shared/note-read";

/**
 * The written half of the weekly review.
 *
 * The card beside this one already answers "what happened" from the numbers.
 * This one reads what you *wrote* — the "should have waited for the retest",
 * the "perfect version was half the size" — and checks that story against the
 * record. Contradictions lead, because a belief the data doesn't support is the
 * most expensive thing in a journal and the only part neither source shows alone.
 *
 * Generation is automatic once per week, from the first visit that has
 * material to read — not from a timer, because the host sleeps when idle and a
 * result nobody is looking at still costs a model call. Opening the page IS
 * the evidence somebody is looking. The server caches per week, so the auto
 * run costs one call weekly at most, and the button remains for regenerating
 * after logging more of the week.
 */
export function WeeklyInsightsCard({
  trades,
  tags,
}: {
  trades: TradeWithTags[];
  tags: MistakeTag[];
}) {
  const [insights, setInsights] = useState<WeeklyInsights | null>(null);
  const generate = useWeeklyInsights();
  const { data: reviews = [], isFetched: reviewsReady } = useWeeklyReviews();
  const { data: dailyNotes = [] } = useDailyNotes();
  const { toast } = useToast();

  // Built locally so the card can say exactly how much material exists before
  // anything is sent — and stay honest when the answer is "none yet".
  const bundle = useMemo(
    () => buildInsightsBundle(trades, tags, undefined, dailyNotes),
    [trades, tags, dailyNotes],
  );
  const hasMaterial = bundle.reflectionCount > 0 || bundle.dayNotes.length > 0;

  /*
   * Notes this week written or changed since the AI last read them. Generating
   * the insights reads them first; this is for the week already generated,
   * when a note was edited afterwards.
   */
  const week = useMemo(() => localWeek(bundle.weekStart), [bundle.weekStart]);
  const unread = useMemo(
    () =>
      trades.filter((t) => {
        const at = t.exitTime ?? t.entryTime;
        return t.status === "closed" && noteNeedsRead(t) && week.from && week.to && at >= week.from && at < week.to;
      }).length,
    [trades, week],
  );
  const [readingNotes, setReadingNotes] = useState(false);
  async function readNotes() {
    if (!week.from || !week.to) return;
    setReadingNotes(true);
    try {
      const r = await readStaleNotes({ from: week.from, to: week.to });
      toast({
        title: `Read ${r.read} ${r.read === 1 ? "note" : "notes"}`,
        description: r.failed
          ? `${r.failed} could not be read — they are saved as written.`
          : "Grades, exit reasons and demons updated where the notes say so. Anything you set by hand is left alone.",
      });
    } catch (err: any) {
      toast({ title: "Couldn't read the notes", description: String(err?.message ?? err).slice(0, 160), variant: "destructive" });
    } finally {
      setReadingNotes(false);
    }
  }

  // A previously generated week survives a reload without re-spending a call.
  const stored = useMemo(() => {
    const row = reviews.find((r) => r.weekStart === bundle.weekStart);
    if (!row?.insights) return null;
    try {
      return JSON.parse(row.insights) as WeeklyInsights;
    } catch {
      return null;
    }
  }, [reviews, bundle.weekStart]);

  const shown = insights ?? stored;

  /*
   * Fire the week's one generation on arrival, when there is something to
   * read and no cached result. Guarded three ways: a ref so one mount asks
   * once; sessionStorage per week so a failing model is not re-paid on every
   * navigation; and the reviews query having SETTLED — before it resolves,
   * `stored` is empty whether or not the week is cached, and firing then
   * would race the cache it exists to respect.
   */
  const autoTried = useRef(false);
  useEffect(() => {
    if (autoTried.current || !reviewsReady) return;
    if (!hasMaterial || stored || insights || generate.isPending) return;
    const guard = `edgeline.autoInsights.${bundle.weekStart}`;
    // Blocked storage reads as "not tried yet"; the ref still stops a repeat.
    let tried = false;
    try {
      tried = sessionStorage.getItem(guard) != null;
    } catch {
      tried = false;
    }
    if (tried) return;
    autoTried.current = true;
    try {
      sessionStorage.setItem(guard, "1");
    } catch {
      /* the ref above is the guard for this visit */
    }
    // Quietly: an auto run that fails should not toast over the journal.
    generate
      .mutateAsync({ weekStart: bundle.weekStart, force: false })
      .then((res) => {
        if (res.ok && res.insights) setInsights(res.insights);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewsReady, hasMaterial, stored, insights, bundle.weekStart]);

  async function run(force = false) {
    const res = await generate.mutateAsync({ weekStart: bundle.weekStart, force });
    if (res.ok && res.insights) {
      setInsights(res.insights);
    } else {
      toast({ title: res.message ?? "Nothing to analyse yet" });
    }
  }

  return (
    <Card className="border-card-border bg-card p-4 sm:p-5" data-testid="card-weekly-insights">
      <div className="mb-3 flex items-start gap-2">
        <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold tracking-tight">What your notes say</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {hasMaterial
              ? [
                  bundle.reflectionCount > 0
                    ? `${bundle.reflectionCount} of ${bundle.closedCount} trades carry a note`
                    : null,
                  bundle.dayNotes.length > 0
                    ? `${bundle.dayNotes.length} daily ${bundle.dayNotes.length === 1 ? "review" : "reviews"}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ") + " this week."
              : "Write on a trade or in the daily page and this has something to read."}
          </p>
          {unread > 0 && (
            <button
              type="button"
              onClick={() => void readNotes()}
              disabled={readingNotes}
              className="mt-1 inline-flex items-center gap-1 text-left text-[11px] text-primary hover:underline disabled:opacity-60"
              data-testid="button-read-changed-notes"
            >
              {readingNotes && <Loader2 className="h-3 w-3 animate-spin" />}
              {unread} {unread === 1 ? "note" : "notes"} written or changed since the last read — read{" "}
              {unread === 1 ? "it" : "them"} now
            </button>
          )}
        </div>
        <Button
          size="sm"
          variant={shown ? "ghost" : "default"}
          className="h-7 shrink-0 text-[11px]"
          onClick={() => run(Boolean(shown))}
          disabled={generate.isPending || !hasMaterial}
          data-testid="button-generate-insights"
        >
          {generate.isPending && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
          {shown ? "Regenerate" : "Read my notes"}
        </Button>
      </div>

      {!shown ? null : (
        <div className="space-y-3">
          {/* Deliberately first: where belief and record disagree. */}
          {shown.contradictions && shown.contradictions.length > 0 && (
            <div className="rounded-md border border-primary/40 bg-primary/5 p-2.5">
              <div className="mb-1.5 flex items-center gap-1.5">
                <TriangleAlert className="h-3 w-3 text-primary" />
                <span className="text-[11px] font-semibold">
                  Your notes and your numbers disagree
                </span>
              </div>
              <ul className="space-y-1 pl-4">
                {shown.contradictions.map((c, i) => (
                  <li
                    key={i}
                    className="list-disc text-[11px] leading-snug"
                    data-testid={`insight-contradiction-${i}`}
                  >
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {shown.themes && shown.themes.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                Recurring themes
              </p>
              <div className="space-y-1.5">
                {shown.themes.map((t, i) => (
                  <div key={i} className="flex items-start gap-2" data-testid={`insight-theme-${i}`}>
                    <Badge variant="secondary" className="mt-0.5 shrink-0 font-mono text-[10px]">
                      {t.occurrences ?? "—"}×
                    </Badge>
                    <div className="min-w-0">
                      <p className="text-[11px] leading-snug">{t.theme}</p>
                      {t.evidence && t.evidence.length > 0 && (
                        <p className="mt-0.5 text-[10px] italic leading-snug text-muted-foreground">
                          “{t.evidence.join("” · “")}”
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {shown.focus && (
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                Work on this
              </p>
              <p className="text-[11px] leading-snug" data-testid="insight-focus">
                <span className="font-semibold">{shown.focus.name}</span> — {shown.focus.why}
              </p>
            </div>
          )}

          {shown.oneChange && (
            <div className="rounded-md border border-border p-2.5">
              <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                One change for next week
              </p>
              <p className="text-[11px] leading-snug" data-testid="insight-one-change">
                {shown.oneChange}
              </p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
