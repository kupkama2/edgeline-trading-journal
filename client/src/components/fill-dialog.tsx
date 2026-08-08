import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Minus, Plus } from "lucide-react";
import { parseExtraTargets, type TradeWithTags } from "@shared/schema";
import { positionLedger, suggestPartialSize, validateFill } from "@shared/fills";
import { fmtMoney } from "@shared/metrics";
import { useAddFill } from "@/lib/data";
import { num } from "@/components/trade-shared";

/**
 * Log a scaling event on a running trade: profit off, or size on.
 *
 * The dialog leads with the ledger — average entry, what's still on, what's
 * already banked — because a partial only means something against those
 * numbers. Validation is the shared module's, so what this refuses is exactly
 * what the server refuses; the message about "use Close for the last piece"
 * comes from the same sentence in both places.
 */
export function FillDialog({
  trade,
  kind,
  onClose,
}: {
  trade: TradeWithTags | null;
  kind: "add" | "partial";
  onClose: () => void;
}) {
  const [price, setPrice] = useState("");
  const [size, setSize] = useState("");
  const [note, setNote] = useState("");
  const { toast } = useToast();
  const addFill = useAddFill();

  const led = useMemo(() => (trade ? positionLedger(trade) : null), [trade]);

  const parsed =
    trade && price.trim() && size.trim()
      ? { kind, price: Number(price), size: Number(size) }
      : null;
  const problem =
    trade && parsed && isFinite(parsed.price) && isFinite(parsed.size)
      ? validateFill(trade, parsed)
      : null;

  // What THIS partial would bank, previewed before commit — the number the
  // decision is actually about.
  const preview = useMemo(() => {
    if (!trade || !led || !parsed || kind !== "partial" || problem) return null;
    if (!isFinite(parsed.price) || !isFinite(parsed.size)) return null;
    const sign = trade.direction === "long" ? 1 : -1;
    const qty =
      trade.sizeUnit === "quote" ? (parsed.price > 0 ? parsed.size / parsed.price : 0) : parsed.size;
    return sign * (parsed.price - led.avgEntry) * qty * (trade.pointValue ?? 1);
  }, [trade, led, parsed, kind, problem]);

  function reset() {
    setPrice("");
    setSize("");
    setNote("");
  }

  async function save() {
    if (!trade || !parsed || problem) return;
    try {
      await addFill.mutateAsync({
        tradeId: trade.id,
        kind,
        price: parsed.price,
        size: parsed.size,
        note: note.trim() || null,
      });
      toast({
        title: kind === "partial" ? "Partial logged" : "Add logged",
        description:
          kind === "partial" && preview != null
            ? `Banked ${fmtMoney(preview)} — the rest keeps running.`
            : "Average entry updated.",
      });
      reset();
      onClose();
    } catch (err: any) {
      toast({
        title: "Couldn't log that",
        description: String(err?.message ?? err).slice(0, 180),
        variant: "destructive",
      });
    }
  }

  if (!trade || !led) return null;
  const unit = trade.sizeUnit === "quote" ? "USD" : "ct";

  // The nth partial usually happens at the nth planned TP, so suggest exactly
  // that: first partial hints TP1, the next hints TP2, and so on. A hint only
  // — the typed price always wins, because fills happen where they happen.
  const plannedTps = [trade.initialTarget, ...parseExtraTargets(trade.extraTargets)].filter(
    (x): x is number => x != null,
  );
  const priceHint =
    kind === "partial" && plannedTps[led.partials] != null
      ? plannedTps[led.partials]
      : trade.entryPrice;
  // Default plan: peel off an equal share per remaining TP.
  const sizeHint =
    kind === "partial" ? suggestPartialSize(trade, Number(price) || null) : null;

  return (
    <Dialog open={trade != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            {kind === "partial" ? (
              <Minus className="h-4 w-4 text-emerald-500" />
            ) : (
              <Plus className="h-4 w-4 text-sky-400" />
            )}
            {kind === "partial" ? "Take partial profit" : "Add to position"} — {trade.symbol}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {/* The ledger this fill plays against. */}
          <div className="grid grid-cols-3 gap-2 rounded-md border border-border/60 bg-secondary/30 p-2.5 text-center font-mono text-xs">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Avg entry</p>
              <p data-testid="fill-avg-entry">{num(led.avgEntry, 4)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Still on</p>
              <p data-testid="fill-open-qty">
                {num(led.openQty, 4)}
                <span className="ml-0.5 text-muted-foreground">ct</span>
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Banked</p>
              <p className={led.realizedPnL >= 0 ? "text-emerald-400" : "text-primary"}>
                {fmtMoney(led.realizedPnL)}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-[11px]">Price</Label>
              <Input
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                inputMode="decimal"
                placeholder={String(priceHint)}
                className="h-9 font-mono text-sm"
                data-testid="input-fill-price"
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label className="text-[11px]">
                  Size <span className="text-muted-foreground">({unit})</span>
                </Label>
                {sizeHint != null && (
                  <button
                    type="button"
                    onClick={() => setSize(String(sizeHint))}
                    title="Equal split of what's still on across the remaining TPs"
                    data-testid="button-apply-split"
                    className="rounded px-1 font-mono text-[10px] leading-tight text-primary transition-colors hover:bg-primary/10"
                  >
                    even → {sizeHint}
                  </button>
                )}
              </div>
              <Input
                value={size}
                onChange={(e) => setSize(e.target.value)}
                inputMode="decimal"
                placeholder={sizeHint != null ? String(sizeHint) : "—"}
                className="h-9 font-mono text-sm"
                data-testid="input-fill-size"
              />
            </div>
          </div>

          {problem && (
            <p className="text-[11px] leading-snug text-amber-500" data-testid="fill-problem">
              {problem}
            </p>
          )}
          {preview != null && (
            <p className="font-mono text-[11px]" data-testid="fill-preview">
              This banks{" "}
              <span className={preview >= 0 ? "text-emerald-400" : "text-primary"}>
                {fmtMoney(preview)}
              </span>{" "}
              against avg {num(led.avgEntry, 4)}.
            </p>
          )}

          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={kind === "partial" ? "why here? (optional)" : "why add? (optional)"}
            className="h-8 text-xs"
            data-testid="input-fill-note"
          />

          <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={save}
              disabled={!parsed || !!problem || addFill.isPending}
              data-testid="button-fill-save"
            >
              {addFill.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {kind === "partial" ? "Take it" : "Add it"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
