import { Suspense, lazy, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ArrowRight, Check, Loader2, Pencil, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useUpdateTrade } from "@/lib/data";
import { store } from "@/lib/scoped-storage";
import { num } from "@/components/trade-shared";
import { computeMetrics, fmtR } from "@shared/metrics";
import type { TradeWithTags } from "@shared/schema";

const TradeChart = lazy(() =>
  import("@/components/trade-chart").then((m) => ({ default: m.TradeChart })),
);

export interface FieldChange {
  field: "mae" | "mfe" | "postExitPeak" | "postExitAdverse";
  from: number;
  to: number;
}

const LABEL: Record<FieldChange["field"], string> = {
  mae: "Worst price against you",
  mfe: "Best price in your favour",
  postExitPeak: "Ran on to, after you left",
  postExitAdverse: "Fell to, after you left",
};

/**
 * The trade went further than your record of it says.
 *
 * The settler fills blanks and never overwrites, which is right — MAE and MFE
 * are read off a chart by hand, and a hand-read value is a judgement about
 * which wick counted. But refusing silently threw away the interesting half:
 * you wrote 1.20, the archive says the wick reached 1.35, and nothing on
 * screen ever said so.
 *
 * Shown rather than applied, and shown with the chart, because the question
 * "did it really go there?" is not answerable from two numbers side by side.
 * The R each version implies is spelled out too — that is what the change
 * actually costs or buys, and it is the reason to care about a price moving
 * a decimal place.
 */
export function MarketSuggestion({
  trade,
  changes,
  onClose,
}: {
  trade: TradeWithTags;
  changes: FieldChange[];
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [dropped, setDropped] = useState<Record<string, boolean>>({});
  const { toast } = useToast();
  const update = useUpdateTrade();

  const taking = changes.filter((c) => !dropped[c.field]);

  /*
   * What each version says the trade did, in R.
   *
   * A price moving from 1.20 to 1.35 means nothing on its own. "You were
   * 2.4R onside, not 1.6R" is the same fact in the unit the journal is
   * actually kept in, and it is what makes the difference worth a decision.
   */
  const before = computeMetrics(trade);
  const after = computeMetrics({
    ...trade,
    ...Object.fromEntries(taking.map((c) => [c.field, c.to])),
  } as TradeWithTags);

  async function accept() {
    if (taking.length === 0) return onClose();
    setSaving(true);
    try {
      await update.mutateAsync({
        id: trade.id,
        trade: Object.fromEntries(taking.map((c) => [c.field, c.to])) as any,
      });
      toast({
        title: "Taken from the market",
        description: `${taking.length} ${taking.length === 1 ? "number" : "numbers"} updated on this trade.`,
      });
      onClose();
    } catch (err: any) {
      toast({
        title: "Couldn't save that",
        description: String(err?.message ?? err).slice(0, 160),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  function dismiss() {
    /*
     * A dismissal has to stick, or the same window returns on the next check
     * and the answer "no" means nothing. Keyed by WHAT was proposed, not just
     * by the trade: if the archive later finds the price went further still,
     * that is a new claim and deserves to be asked again.
     */
    store.set(dismissKey(trade.id, changes), "1");
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto" data-testid="dialog-suggestion">
        <DialogTitle className="flex items-center gap-2 text-sm">
          The market says this trade went further
        </DialogTitle>
        <p className="text-[11px] text-muted-foreground">
          Read back from {trade.symbol}'s own candles. Nothing has been changed — these are
          offered because they are further than what you recorded, and only ever further:
          a reading that fell short of yours would more likely be a coarser chart than a
          correction.
        </p>

        {/* The chart, because "did it really go there?" is not a question two
            numbers side by side can answer. */}
        <Suspense fallback={<div className="h-40 animate-pulse rounded-md bg-secondary/30" />}>
          <TradeChart trade={trade} />
        </Suspense>

        <ul className="space-y-1.5" data-testid="suggestion-changes">
          {changes.map((c) => {
            const off = dropped[c.field];
            return (
              <li
                key={c.field}
                className={`flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs ${
                  off ? "border-border/40 opacity-45" : "border-card-border bg-secondary/20"
                }`}
                data-testid={`suggestion-${c.field}`}
              >
                <span className="min-w-[11rem] text-[11px]">{LABEL[c.field]}</span>
                <span className="font-mono text-muted-foreground line-through">{num(c.from)}</span>
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <span className="font-mono font-semibold text-foreground">{num(c.to)}</span>
                <button
                  type="button"
                  className="ml-auto text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => setDropped((p) => ({ ...p, [c.field]: !p[c.field] }))}
                  data-testid={`button-drop-${c.field}`}
                >
                  {off ? "take it after all" : "leave mine"}
                </button>
              </li>
            );
          })}
        </ul>

        {/* What it comes to. R is the unit the journal is kept in, so this is
            the line that says whether the change matters. */}
        {before.mfeR != null && after.mfeR != null && before.mfeR !== after.mfeR && (
          <p className="text-[11px]" data-testid="suggestion-r">
            Best reach goes from{" "}
            <span className="font-mono text-muted-foreground">{fmtR(before.mfeR)}</span> to{" "}
            <span className="font-mono text-emerald-400">{fmtR(after.mfeR)}</span>.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            className="flex-1"
            disabled={saving || taking.length === 0}
            onClick={accept}
            data-testid="button-accept-suggestion"
          >
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
            Take {taking.length === changes.length ? "them" : `the ${taking.length}`}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              /*
               * The editor, with the claim left standing.
               *
               * Dismissing here would be wrong twice over: nothing has been
               * decided yet, and if the editor is closed without touching
               * these fields the disagreement is still true — silencing it
               * would lose the finding to a button that only meant "not like
               * this".
               */
              onClose();
              window.location.hash = `#/trade/${trade.id}/edit`;
            }}
            data-testid="button-edit-suggestion"
          >
            <Pencil className="mr-2 h-4 w-4" />
            Edit by hand
          </Button>
          <Button type="button" variant="ghost" onClick={dismiss} data-testid="button-dismiss-suggestion">
            <X className="mr-2 h-4 w-4" />
            Keep mine
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Keyed by the claim, not just the trade.
 *
 * "No" to the archive saying 1.35 is not "no" to it later saying 1.52 — the
 * second is new information and deserves to be asked again. Rounded, so that
 * the same reading arriving with a different final decimal does not read as a
 * fresh claim.
 */
export function dismissKey(tradeId: number, changes: FieldChange[]): string {
  const shape = changes
    .map((c) => `${c.field}:${c.to.toPrecision(8)}`)
    .sort()
    .join(",");
  return `edgeline.suggestion.${tradeId}.${shape}`;
}

/** Has this exact claim already been turned down? */
export function alreadyDismissed(tradeId: number, changes: FieldChange[]): boolean {
  return store.get(dismissKey(tradeId, changes)) != null;
}
