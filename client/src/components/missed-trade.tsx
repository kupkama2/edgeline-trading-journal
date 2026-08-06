import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { EyeOff, Loader2 } from "lucide-react";
import { useCreateTrade } from "@/lib/data";
import { useStyleFilter } from "@/lib/style-filter";

/**
 * Log a setup you saw and did not take.
 *
 * A journal that records only what you did measures half the decisions. This
 * one stores the plan — entry, stop, target — so the miss can later be priced
 * in R against the trades you did take, which is the only way "I hesitate too
 * much" or "my filter is working" stops being a feeling and becomes a number.
 *
 * It lands as a cancelled trade with reason 'never_placed', so it stays out of
 * P&L, the daily calendar and every guardrail — it was never a position — while
 * still living in the same table as everything else.
 */
export function MissedTradeDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [symbol, setSymbol] = useState("");
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [entryPrice, setEntry] = useState("");
  const [initialStop, setStop] = useState("");
  const [initialTarget, setTarget] = useState("");
  const [notes, setNotes] = useState("");
  const [outcome, setOutcome] = useState<"unknown" | "hit" | "missed">("unknown");
  const { toast } = useToast();
  const create = useCreateTrade();
  const { activeStyleId } = useStyleFilter();

  const nums = {
    entryPrice: Number(entryPrice),
    initialStop: Number(initialStop),
    initialTarget: Number(initialTarget),
  };
  // Stop and target are required here even though a cancelled trade doesn't
  // normally need them: without both there is no R to price the miss in, and an
  // unpriceable missed trade is just a note.
  const ready =
    symbol.trim() !== "" &&
    Object.values(nums).every((n) => isFinite(n) && n > 0) &&
    nums.entryPrice !== nums.initialStop;

  function reset() {
    setSymbol("");
    setDirection("long");
    setEntry("");
    setStop("");
    setTarget("");
    setNotes("");
    setOutcome("unknown");
  }

  async function save() {
    if (!ready) return;
    try {
      await create.mutateAsync({
        trade: {
          styleId: activeStyleId,
          symbol: symbol.trim().toUpperCase(),
          direction,
          // Size is meaningless for a trade that never existed, but the column
          // is NOT NULL. One unit keeps R arithmetic well-defined and dollar
          // figures obviously nominal.
          size: 1,
          sizeUnit: "base",
          entryPrice: nums.entryPrice,
          initialStop: nums.initialStop,
          initialTarget: nums.initialTarget,
          entryTime: new Date().toISOString(),
          status: "cancelled",
          cancelReason: "never_placed",
          wouldHaveHitTarget: outcome === "unknown" ? null : outcome === "hit",
          notes: notes.trim() || null,
        },
        mistakeTagIds: [],
      });
      toast({
        title: "Missed trade logged",
        description:
          outcome === "unknown"
            ? "Mark what it did later and it starts counting."
            : "Priced against the trades you did take.",
      });
      reset();
      onClose();
    } catch (err: any) {
      toast({
        title: "Couldn't save that",
        description: String(err?.message ?? err).slice(0, 180),
        variant: "destructive",
      });
    }
  }

  const rr =
    ready && Math.abs(nums.entryPrice - nums.initialStop) > 0
      ? Math.abs(nums.initialTarget - nums.entryPrice) /
        Math.abs(nums.entryPrice - nums.initialStop)
      : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <EyeOff className="h-4 w-4" />
            Log a trade you didn't take
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-[11px]">Symbol</Label>
              <Input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                placeholder="MNQU6"
                className="h-8 font-mono text-xs"
                data-testid="input-missed-symbol"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">Direction</Label>
              <div className="flex gap-1">
                {(["long", "short"] as const).map((d) => (
                  <Button
                    key={d}
                    size="sm"
                    variant={direction === d ? "default" : "outline"}
                    className="h-8 flex-1 text-[11px] capitalize"
                    onClick={() => setDirection(d)}
                    data-testid={`button-missed-${d}`}
                  >
                    {d}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            {(
              [
                ["Entry", entryPrice, setEntry, "entry"],
                ["Stop", initialStop, setStop, "stop"],
                ["Target", initialTarget, setTarget, "target"],
              ] as const
            ).map(([label, value, set, id]) => (
              <div key={id} className="space-y-1">
                <Label className="text-[11px]">{label}</Label>
                <Input
                  value={value}
                  onChange={(e) => set(e.target.value)}
                  inputMode="decimal"
                  placeholder="—"
                  className="h-8 font-mono text-xs"
                  data-testid={`input-missed-${id}`}
                />
              </div>
            ))}
          </div>

          {rr != null && (
            <p className="text-[11px] text-muted-foreground" data-testid="text-missed-rr">
              Planned <span className="font-mono font-semibold">{rr.toFixed(2)}R</span> — what this
              would have paid if it worked.
            </p>
          )}

          <div className="space-y-1">
            <Label className="text-[11px]">What did it do?</Label>
            <div className="flex flex-wrap gap-1">
              {(
                [
                  ["unknown", "Don't know yet"],
                  ["hit", "Hit target"],
                  ["missed", "Hit stop"],
                ] as const
              ).map(([id, label]) => (
                <Button
                  key={id}
                  size="sm"
                  variant={outcome === id ? "default" : "outline"}
                  className="h-7 text-[11px]"
                  onClick={() => setOutcome(id)}
                  data-testid={`button-missed-outcome-${id}`}
                >
                  {label}
                </Button>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground">
              Unknown is fine — it stays uncounted until you say, rather than being guessed either
              way.
            </p>
          </div>

          <div className="space-y-1">
            <Label className="text-[11px]">Why didn't you take it?</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="waited for a retest that never came · already down on the day · wasn't at the desk"
              className="h-16 text-xs"
              data-testid="input-missed-notes"
            />
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={save}
              disabled={!ready || create.isPending}
              data-testid="button-missed-save"
            >
              {create.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Log it
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
