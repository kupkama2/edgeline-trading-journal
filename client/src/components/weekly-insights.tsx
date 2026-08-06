import { useMemo, useState } from "react";
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
import { useWeeklyInsights, useWeeklyReviews } from "@/lib/data";

/**
 * The written half of the weekly review.
 *
 * The card beside this one already answers "what happened" from the numbers.
 * This one reads what you *wrote* — the "should have waited for the retest",
 * the "perfect version was half the size" — and checks that story against the
 * record. Contradictions lead, because a belief the data doesn't support is the
 * most expensive thing in a journal and the only part neither source shows alone.
 *
 * Generation is on demand rather than scheduled: the host sleeps when idle, so a
 * weekly timer would fire unreliably, and a result nobody reads still costs a
 * model call. The result is cached per week, so pressing the button twice on a
 * Thursday does not pay twice.
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
  const { data: reviews = [] } = useWeeklyReviews();
  const { toast } = useToast();

  // Built locally so the card can say exactly how much material exists before
  // anything is sent — and stay honest when the answer is "none yet".
  const bundle = useMemo(() => buildInsightsBundle(trades, tags), [trades, tags]);

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
            {bundle.reflectionCount > 0
              ? `${bundle.reflectionCount} of ${bundle.closedCount} trades this week carry a note.`
              : "Write what you'd have done differently on a trade and this has something to read."}
          </p>
        </div>
        <Button
          size="sm"
          variant={shown ? "ghost" : "default"}
          className="h-7 shrink-0 text-[11px]"
          onClick={() => run(Boolean(shown))}
          disabled={generate.isPending || bundle.reflectionCount === 0}
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
