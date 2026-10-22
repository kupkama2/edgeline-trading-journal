import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { applyCheck } from "@/lib/data";
import { reportFailure } from "@/lib/report";
import { computeMetrics, fmtFees, fmtMoney } from "@shared/metrics";
import type { TradeWithTags } from "@shared/schema";
import { num } from "@/components/trade-shared";

/**
 * What asking the market would write, before it is written.
 *
 * The check reads candles and funding and has opinions about four prices,
 * the untouched plan and the net P&L. Each of those is a number somebody may
 * have put there on purpose, so nothing is replaced on the strength of a
 * click: the market's answer is laid out field by field, from → to, with
 * what it does to the P&L, and only Apply writes it — exactly as shown.
 */

export interface CheckPreviewData {
  proposed: { tradeId: number; patch: Record<string, unknown>; changes: { field: string; from: unknown; to: unknown }[] };
  plan?: { verdict: string; hitAt: string; recorded: string | null; applied: boolean } | null;
}

const PLAN: Record<string, string> = {
  target_first: "target first",
  stop_first: "stop first",
  undetermined: "undetermined",
};

export function CheckPreview({
  trade,
  data,
  onClose,
}: {
  trade: TradeWithTags;
  data: CheckPreviewData | null;
  onClose: (applied: boolean) => void;
}) {
  const [saving, setSaving] = useState(false);
  if (!data) return null;
  const short = trade.direction === "short";
  const LABEL: Record<string, string> = {
    noManagementOutcome: "Untouched plan would have hit",
    mfe: short ? "Lowest while in" : "Highest while in",
    mae: short ? "Highest while in" : "Lowest while in",
    postExitPeak: "Kept going your way, after",
    postExitAdverse: "Turned against you, after",
    funding: "Funding over the hold (est.)",
  };
  const show = (field: string, v: unknown) => {
    if (v == null) return "—";
    if (field === "noManagementOutcome") return PLAN[String(v)] ?? String(v);
    if (field === "funding") return `${Number(v) >= 0 ? "+" : "−"}${fmtFees(Number(v))}`;
    return typeof v === "number" ? num(v) : String(v);
  };

  // What it does to the money: only funding moves the P&L.
  const before = computeMetrics(trade).actualPnL;
  const after = computeMetrics({ ...trade, ...(data.proposed.patch as any) }).actualPnL;
  const pnlMoves = before != null && after != null && Math.abs(after - before) >= 0.005;

  const plan = data.plan;
  const kept = plan && !plan.applied && plan.recorded && plan.recorded !== plan.verdict;

  async function apply() {
    setSaving(true);
    try {
      await applyCheck(trade.id, data!.proposed.patch);
      onClose(true);
    } catch (err) {
      reportFailure("Applying the market's answer", err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose(false)}>
      <DialogContent className="max-w-md" data-testid="dialog-check-preview">
        <DialogHeader>
          <DialogTitle className="text-sm">What the market would change</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-[12px]">
          {plan && (
            <p className="leading-snug" data-testid="check-preview-plan">
              Left alone, the plan would have hit the <b>{PLAN[plan.verdict] ?? plan.verdict}</b> (
              {new Date(plan.hitAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}).
              {kept && (
                <span className="text-muted-foreground">
                  {" "}
                  Your record says {PLAN[plan.recorded!] ?? plan.recorded} — you set it, so it is kept.
                </span>
              )}
            </p>
          )}
          <ul className="divide-y divide-border rounded-md border border-border" data-testid="check-preview-changes">
            {data.proposed.changes.map((c) => (
              <li key={c.field} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2.5 py-1.5">
                <span className="min-w-0 flex-1 text-muted-foreground">{LABEL[c.field] ?? c.field}</span>
                <span className="font-mono">{show(c.field, c.from)}</span>
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <span className="font-mono text-foreground">{show(c.field, c.to)}</span>
              </li>
            ))}
          </ul>
          {pnlMoves ? (
            <p className="font-mono text-[11px]" data-testid="check-preview-pnl">
              Net P&amp;L {fmtMoney(before)} <ArrowRight className="inline h-3 w-3" /> {fmtMoney(after)}
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground">The P&amp;L does not change.</p>
          )}
          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button variant="ghost" size="sm" onClick={() => onClose(false)} data-testid="button-check-preview-keep">
              Keep what's there
            </Button>
            <Button size="sm" onClick={() => void apply()} disabled={saving} data-testid="button-check-preview-apply">
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Apply
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
