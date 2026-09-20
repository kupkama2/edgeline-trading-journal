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
import { useAddTradeImage, useCreateTrade, fileToDownscaledDataUrl } from "@/lib/data";
import { Dropzone } from "@/components/trade-shared";
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
 *
 * The prices are OPTIONAL, and that is the point of the form rather than a
 * concession. A miss priced in R is the better record, but the moment worth
 * capturing is the one where you are watching the thing go without you, and a
 * form that demands three levels before it will take anything is a form you
 * close. A screenshot and a sentence take four seconds, they are what you
 * actually have at that moment, and an unreviewed note is still infinitely
 * more than a miss nobody wrote down. Fill the levels in if you have them and
 * the R comes with them.
 *
 * What is NOT optional is reading it back. Every miss joins its week's review
 * beside the trades that were taken, and the week is not done until it has
 * been gone over — one pass you talked yourself out of says nothing, six in a
 * row say what your filter is actually doing.
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
  const [image, setImage] = useState<string | null>(null);
  const [shrinking, setShrinking] = useState(false);
  const { toast } = useToast();
  const create = useCreateTrade();
  const addImage = useAddTradeImage();
  const { activeStyleId } = useStyleFilter();

  /** A level that was typed and makes sense, or null. */
  const level = (v: string) => {
    const n = Number(v.trim());
    return v.trim() !== "" && isFinite(n) && n > 0 ? n : null;
  };
  const nums = {
    entryPrice: level(entryPrice),
    initialStop: level(initialStop),
    initialTarget: level(initialTarget),
  };
  /*
   * All three, or none of them, as far as R is concerned. One level on its own
   * prices nothing, and two of three is the shape that looks like a record and
   * is not — so the R only appears once the set is complete and the entry and
   * the stop are actually apart.
   */
  const priced =
    nums.entryPrice != null &&
    nums.initialStop != null &&
    nums.initialTarget != null &&
    nums.entryPrice !== nums.initialStop;

  /*
   * A ticker, and something to look at. The something can be either — a chart
   * with no words is still the setup, and a sentence with no chart is still
   * the reason — but both missing leaves a row that says a name and a date,
   * which is not a thing anybody can review.
   */
  const said = notes.trim() !== "" || image != null;
  const ready = symbol.trim() !== "" && said;

  function reset() {
    setSymbol("");
    setDirection("long");
    setEntry("");
    setStop("");
    setTarget("");
    setNotes("");
    setOutcome("unknown");
    setImage(null);
  }

  async function save() {
    if (!ready) return;
    try {
      const saved: any = await create.mutateAsync({
        trade: {
          styleId: activeStyleId,
          symbol: symbol.trim().toUpperCase(),
          direction,
          // Size is meaningless for a trade that never existed, but the column
          // is NOT NULL. One unit keeps R arithmetic well-defined and dollar
          // figures obviously nominal.
          size: 1,
          sizeUnit: "base",
          // Zero where no entry was typed, the way a scalp carries zero: not a
          // price of nothing, the absence of one. Nothing measures a cancelled
          // trade, and the chart already reads a zero entry as "no level".
          entryPrice: nums.entryPrice ?? 0,
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
      /*
       * The screenshot follows the trade rather than riding with it: images go
       * to their own table through their own route. A failure here loses the
       * picture and keeps the miss, which is the right way round — the record
       * that you passed is the part that cannot be reconstructed later.
       */
      if (image && saved?.id != null) {
        try {
          await addImage.mutateAsync({ tradeId: saved.id, kind: "setup", data: image });
        } catch {
          toast({
            title: "Logged, but the screenshot didn't attach",
            description: "The miss is saved. Add the picture from the trade if you want it.",
          });
        }
      }
      toast({
        title: "Missed trade logged",
        description: priced
          ? outcome === "unknown"
            ? "Mark what it did later and it starts counting."
            : "Priced against the trades you did take."
          : "It joins this week's review.",
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

  const rr = priced
    ? Math.abs(nums.initialTarget! - nums.entryPrice!) /
      Math.abs(nums.entryPrice! - nums.initialStop!)
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
          {/* First, because it is what you have. The moment worth catching is
              the one where the thing is going without you, and at that moment
              the chart is already on screen and the levels are not in your
              head. */}
          <Dropzone
            testId="dropzone-missed"
            label="Drop the chart"
            hint="Paste, drop or click. This is the record — the numbers below are optional."
            image={image}
            busy={shrinking}
            onFile={async (f) => {
              setShrinking(true);
              try {
                setImage(await fileToDownscaledDataUrl(f));
              } catch (err: any) {
                toast({
                  title: "Couldn't read that image",
                  description: String(err?.message ?? err).slice(0, 160),
                  variant: "destructive",
                });
              } finally {
                setShrinking(false);
              }
            }}
            onClear={() => setImage(null)}
          />

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

          {/* Below the fold of attention on purpose: they make the miss
              measurable, and nothing here waits on them. */}
          <div className="grid grid-cols-3 gap-3">
            {(
              [
                ["Entry", entryPrice, setEntry, "entry"],
                ["Stop", initialStop, setStop, "stop"],
                ["Target", initialTarget, setTarget, "target"],
              ] as const
            ).map(([label, value, set, id]) => (
              <div key={id} className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">{label}</Label>
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

          <p className="text-[10px] leading-snug text-muted-foreground" data-testid="text-missed-rr">
            {rr != null ? (
              <>
                Planned <span className="font-mono font-semibold">{rr.toFixed(2)}R</span> — what
                this would have paid if it worked.
              </>
            ) : (
              "All three levels prices the miss in R against the trades you did take. Leave them and it is a note, which still gets reviewed."
            )}
          </p>

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

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
            {/* Says what is missing rather than leaving a dead button to be
                stared at. */}
            {!ready && (
              <p className="mr-auto text-[10px] text-muted-foreground" data-testid="text-missed-need">
                {symbol.trim() === ""
                  ? "Needs a ticker."
                  : "Needs a chart or a sentence — something to read back on Sunday."}
              </p>
            )}
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
