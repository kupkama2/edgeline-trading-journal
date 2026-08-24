import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Trash2 } from "lucide-react";
import type { TradeWithTags } from "@shared/schema";
import { useDeleteTrade, useUpdateTrade } from "@/lib/data";

/**
 * Ending a trade that never became a position.
 *
 * Deliberately separate from closing one. A close describes how a real position
 * ended and feeds every P&L and demon metric; this describes an order that never
 * existed as a position at all, and must not.
 *
 * The distinction that earns its keep is "not filled" versus deleting: a missed
 * entry that would have hit its target is a real, measurable cost, and the only
 * way to see that pattern is to keep the record. Deleting is for mis-logs.
 */
const REASONS = [
  {
    id: "not_filled" as const,
    label: "Never filled",
    hint: "Price never reached the entry",
  },
  {
    id: "pulled" as const,
    label: "Pulled the order",
    hint: "Cancelled it before it could fill",
  },
  {
    id: "changed_mind" as const,
    label: "Changed my mind",
    hint: "Setup invalidated, or thought better of it",
  },
];

export function ResolveTradeDialog({
  trade,
  onClose,
}: {
  trade: TradeWithTags | null;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<string | null>(null);
  const [wouldHaveHit, setWouldHaveHit] = useState<boolean | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const updateTrade = useUpdateTrade();
  const deleteTrade = useDeleteTrade();
  const { toast } = useToast();

  useEffect(() => {
    setReason(null);
    setWouldHaveHit(null);
    setConfirmDelete(false);
  }, [trade?.id]);

  if (!trade) return null;

  async function save() {
    if (!trade || !reason) return;
    try {
      await updateTrade.mutateAsync({
        id: trade.id,
        trade: {
          status: "cancelled",
          cancelReason: reason as any,
          // Only meaningful for an order that never filled — a pulled order was
          // a decision, and "would it have won" is a different question there.
          wouldHaveHitTarget: reason === "not_filled" ? wouldHaveHit : null,
        },
      });
      toast({ title: `${trade.symbol} logged as ${reason.replace("_", " ")}` });
      onClose();
    } catch (err: any) {
      /*
       * Say it out loud. Without this the rejected request went nowhere: no
       * toast, no close, the dialog sitting there with the reason still
       * highlighted — indistinguishable from a button that does nothing. That
       * is exactly how a server rule rejecting every cancellation of a
       * stopless resting order went unnoticed.
       */
      toast({
        title: "Couldn't log that",
        description: String(err?.message ?? err).slice(0, 180),
        variant: "destructive",
      });
    }
  }

  async function hardDelete() {
    if (!trade) return;
    try {
      await deleteTrade.mutateAsync(trade.id);
      toast({ title: `${trade.symbol} deleted` });
      onClose();
    } catch (err: any) {
      toast({
        title: "Couldn't delete it",
        description: String(err?.message ?? err).slice(0, 180),
        variant: "destructive",
      });
      setConfirmDelete(false);
    }
  }

  const busy = updateTrade.isPending || deleteTrade.isPending;

  return (
    <Dialog open={Boolean(trade)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {trade.symbol} — didn&apos;t become a position
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            {REASONS.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setReason(r.id)}
                data-testid={`button-reason-${r.id}`}
                className={`w-full rounded-md border p-2.5 text-left transition-colors ${
                  reason === r.id
                    ? "border-primary/60 bg-primary/10"
                    : "border-border hover:border-primary/40"
                }`}
              >
                <div className="text-xs font-medium">{r.label}</div>
                <div className="text-[10px] text-muted-foreground">{r.hint}</div>
              </button>
            ))}
          </div>

          {reason === "not_filled" && (
            <div className="rounded-md border border-border p-2.5">
              <p className="mb-2 text-[11px] text-muted-foreground">
                Would it have hit your target?
              </p>
              <div className="flex gap-1.5">
                {[
                  { v: true, label: "Yes — missed a winner" },
                  { v: false, label: "No" },
                  { v: null, label: "Don't know" },
                ].map((o) => (
                  <Button
                    key={String(o.v)}
                    type="button"
                    size="sm"
                    variant={wouldHaveHit === o.v ? "default" : "outline"}
                    className="h-7 text-[10px]"
                    onClick={() => setWouldHaveHit(o.v)}
                    data-testid={`button-would-hit-${String(o.v)}`}
                  >
                    {o.label}
                  </Button>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 border-t border-border pt-3">
            {confirmDelete ? (
              <Button
                variant="destructive"
                size="sm"
                onClick={hardDelete}
                disabled={busy}
                data-testid="button-confirm-delete"
              >
                {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Delete permanently
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setConfirmDelete(true)}
                data-testid="button-delete-trade"
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                Delete instead
              </Button>
            )}
            <Button variant="ghost" size="sm" className="ml-auto" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={save}
              disabled={!reason || busy}
              data-testid="button-save-resolution"
            >
              {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Log it
            </Button>
          </div>

          <p className="text-[10px] leading-snug text-muted-foreground">
            Kept out of P&amp;L, win rate and demon streaks — it was never a
            position. Deleting removes it entirely; logging it keeps the record
            so a pattern of missed entries stays visible.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
