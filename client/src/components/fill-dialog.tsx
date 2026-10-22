import { useEffect, useMemo, useState } from "react";
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
import {
  addFromTotals,
  convertFillSize,
  partialFromTotals,
  fillOutsideTrade,
  positionLedger,
  suggestPartialSize,
  validateFill,
} from "@shared/fills";
import { fmtMoney } from "@shared/metrics";
import { typedSymbol } from "@shared/symbols";
import { useAddFill } from "@/lib/data";
import { TimeField, localNow, num, toIso, toLocalInput } from "@/components/trade-shared";
import { maskIfQuote } from "@shared/redact";

/**
 * Log a scaling event: profit off, or size on.
 *
 * The dialog leads with the ledger — average entry, what's still on, what's
 * already banked — because a partial only means something against those
 * numbers. Validation is the shared module's, so what this refuses is exactly
 * what the server refuses; the message about the last piece comes from the
 * same sentence in both places.
 *
 * It works on a CLOSED trade too, which is the common case for anyone who
 * logs trades after the fact rather than managing them here. That is why the
 * time is a field: on a live trade a fill is happening now, but on a trade
 * already written up it happened somewhere inside a window that has since
 * shut, and where it falls relative to the other fills is what decides the
 * average entry an add moves.
 */
export function FillForm({
  trade,
  kind,
  onClose,
  inline = false,
}: {
  trade: TradeWithTags | null;
  kind: "add" | "partial";
  onClose: () => void;
  /** Rendered inside the editor rather than in a window of its own. */
  inline?: boolean;
}) {
  const [price, setPrice] = useState("");
  const [size, setSize] = useState("");
  const [note, setNote] = useState("");
  const [time, setTime] = useState("");
  // The unit the size is TYPED in. Storage stays in the trade's own unit;
  // crossing over just converts at the fill price on the way out.
  const [fillUnit, setFillUnit] = useState<"base" | "quote">("base");
  /*
   * How the fill is described. "totals" is what the venue shows after it —
   * the new size and average, or the size left and the profit booked — and
   * the fill is worked out from that (shared/fills.ts, addFromTotals). "fill"
   * is the fill itself, price and size, for when that is what you have.
   */
  const [mode, setMode] = useState<"totals" | "fill">("totals");
  const [totalSize, setTotalSize] = useState("");
  const [second, setSecond] = useState("");
  const { toast } = useToast();
  const addFill = useAddFill();

  const tradeUnit: "base" | "quote" = trade?.sizeUnit === "quote" ? "quote" : "base";
  useEffect(() => {
    if (!trade) return;
    setFillUnit(trade.sizeUnit === "quote" ? "quote" : "base");
    // On a live trade this is happening now. On a closed one "now" is after
    // the trade ended, so the entry is the honest starting point — inside the
    // window, ordered ahead of the exit, and obviously in need of correcting.
    setTime(trade.status === "closed" ? toLocalInput(trade.entryTime) : localNow());
  }, [trade?.id, trade?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const led = useMemo(() => (trade ? positionLedger(trade) : null), [trade]);

  // The size in the trade's own unit — what actually gets stored.
  const effSize =
    trade && size.trim()
      ? convertFillSize(Number(size), fillUnit, tradeUnit, Number(price))
      : null;
  const fromTotals =
    trade && mode === "totals" && totalSize.trim() && second.trim() && isFinite(Number(totalSize)) && isFinite(Number(second))
      ? kind === "add"
        ? addFromTotals(trade, { size: Number(totalSize), avgEntry: Number(second) }, fillUnit)
        : partialFromTotals(trade, { size: Number(totalSize), booked: Number(second) }, fillUnit)
      : null;
  // Both numbers have to BE numbers before this counts as a fill. Checking
  // finiteness here rather than only inside `problem` is what keeps the save
  // button disabled on "abc" — a non-numeric price used to sail through to
  // the server and come back as a validation error.
  const priceNum = Number(price);
  const parsed =
    mode === "totals"
      ? fromTotals?.ok
        ? { kind, price: fromTotals.price, size: fromTotals.size }
        : null
      : trade && price.trim() && isFinite(priceNum) && priceNum > 0 && effSize != null && effSize > 0
        ? { kind, price: priceNum, size: effSize }
        : null;
  const problem = trade && parsed ? validateFill(trade, parsed) : null;
  // A separate, softer channel: nothing downstream breaks on a mistimed fill,
  // so this points rather than blocks.
  const timeWarning = trade ? fillOutsideTrade(trade, time ? toIso(time) : null) : null;

  // What THIS partial would bank, previewed before commit — the number the
  // decision is actually about.
  const preview = useMemo(() => {
    if (!trade || !led || !parsed || kind !== "partial" || problem) return null;
    const sign = trade.direction === "long" ? 1 : -1;
    const qty =
      trade.sizeUnit === "quote" ? (parsed.price > 0 ? parsed.size / parsed.price : 0) : parsed.size;
    return sign * (parsed.price - led.avgEntry) * qty * (trade.pointValue ?? 1);
  }, [trade, led, parsed, kind, problem]);

  function reset() {
    setPrice("");
    setSize("");
    setNote("");
    setTotalSize("");
    setSecond("");
  }

  async function save() {
    if (!trade || !parsed || problem) return;
    try {
      await addFill.mutateAsync({
        tradeId: trade.id,
        kind,
        price: parsed.price,
        size: parsed.size,
        time: time ? toIso(time) : undefined,
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
  // Futures have no meaningful USD-notional sizing, so no unit choice there.
  const canSwitchUnit = (trade.pointValue ?? 1) === 1;

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
  // The hint follows whichever unit is being typed.
  const hintPx = Number(price) > 0 ? Number(price) : priceHint;
  const sizeHintShown =
    sizeHint == null
      ? null
      : fillUnit === tradeUnit
        ? sizeHint
        : fillUnit === "quote"
          ? Math.round(sizeHint * hintPx)
          : hintPx > 0
            ? Math.round((sizeHint / hintPx) * 1e4) / 1e4
            : null;

  const heading = (
    <span className="flex items-center gap-2 text-sm font-semibold">
      {kind === "partial" ? (
        <Minus className="h-4 w-4 text-emerald-500" />
      ) : (
        <Plus className="h-4 w-4 text-sky-400" />
      )}
      {trade.status === "closed"
        ? kind === "partial"
          ? "Log a partial you took"
          : "Log size you added"
        : kind === "partial"
          ? "Take partial profit"
          : "Add to position"}{" "}
      — {typedSymbol(trade)}
    </span>
  );

  const body = (
        <div className="space-y-3">
          {/* The ledger this fill plays against. */}
          <div className="grid grid-cols-3 gap-2 rounded-md border border-border/60 bg-secondary/30 p-2.5 text-center font-mono text-xs">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Avg entry</p>
              <p data-testid="fill-avg-entry">{num(led.avgEntry)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Still on</p>
              {/* The ledger counts coins; a USD trade reads it back in USD, at
                  the average entry — the same terms the size was given in. */}
              <p data-testid="fill-open-qty">
                {maskIfQuote(trade.sizeUnit, num(trade.sizeUnit === "quote" ? led.openQty * led.avgEntry : led.openQty))}
                <span className="ml-0.5 text-muted-foreground">{trade.sizeUnit === "quote" ? "USD" : "ct"}</span>
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Banked</p>
              <p className={led.realizedPnL >= 0 ? "text-emerald-400" : "text-primary"}>
                {fmtMoney(led.realizedPnL)}
              </p>
            </div>
          </div>

          <div className="flex gap-1 text-[10px]" role="tablist">
            {(
              [
                ["totals", kind === "add" ? "New size & average" : "Size left & profit"],
                ["fill", "One fill: price & size"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                className={`rounded px-2 py-1 transition-colors ${
                  mode === m ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
                }`}
                data-testid={`button-fill-mode-${m}`}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === "totals" ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <Label className="text-[11px]">{kind === "add" ? "New total size" : "Size left"}</Label>
                    {canSwitchUnit && (
                      <div className="flex gap-0.5">
                        {(["base", "quote"] as const).map((u) => (
                          <button
                            key={u}
                            type="button"
                            onClick={() => setFillUnit(u)}
                            aria-pressed={fillUnit === u}
                            className={`rounded px-1 py-0.5 text-[9px] uppercase tracking-wider transition-colors ${
                              fillUnit === u ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
                            }`}
                            data-testid={`button-totals-unit-${u}`}
                          >
                            {u === "base" ? "units" : "usd"}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <Input
                    value={totalSize}
                    onChange={(e) => setTotalSize(e.target.value)}
                    inputMode="decimal"
                    placeholder={num(fillUnit === "quote" ? led.openQty * led.avgEntry : led.openQty)}
                    className="h-9 font-mono text-sm"
                    data-testid="input-fill-total-size"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">{kind === "add" ? "New average entry" : "Profit booked ($)"}</Label>
                  <Input
                    value={second}
                    onChange={(e) => setSecond(e.target.value)}
                    inputMode="decimal"
                    placeholder={kind === "add" ? num(led.avgEntry) : "e.g. 250"}
                    className="h-9 font-mono text-sm"
                    data-testid="input-fill-second"
                  />
                </div>
              </div>
              <p className="text-[10px] leading-snug text-muted-foreground">
                {kind === "add"
                  ? "As the position panel shows it now. One add or several, it is logged as one at the price that gives that average."
                  : "The profit on the piece you took, before fees. A loss is a minus."}
                {fillUnit === "quote" &&
                  " A USD size here is valued at your average entry. If the venue's USD figure is at the current price instead, switch to units."}
              </p>
              {fromTotals?.ok && (
                <p className="font-mono text-[11px]" data-testid="fill-from-totals">
                  = {kind === "add" ? "added" : "took"}{" "}
                  {maskIfQuote(trade.sizeUnit, num(fromTotals.qty))} {(trade.pointValue ?? 1) === 1 ? "units" : "ct"} at{" "}
                  {num(fromTotals.price)}
                </p>
              )}
              {fromTotals && !fromTotals.ok && (
                <p className="text-[11px] leading-snug text-amber-500" data-testid="fill-from-totals-problem">
                  {fromTotals.problem}
                </p>
              )}
            </div>
          ) : (
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
                <div className="flex items-center gap-1.5">
                  <Label className="text-[11px]">Size</Label>
                  {canSwitchUnit ? (
                    <div className="flex gap-0.5">
                      {(["base", "quote"] as const).map((u) => (
                        <button
                          key={u}
                          type="button"
                          onClick={() => setFillUnit(u)}
                          data-testid={`button-fill-unit-${u}`}
                          aria-pressed={fillUnit === u}
                          className={`rounded px-1 py-0.5 text-[9px] uppercase tracking-wider transition-colors ${
                            fillUnit === u
                              ? "bg-primary/15 text-primary"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {u === "base" ? "units" : "usd"}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">(ct)</span>
                  )}
                </div>
                {sizeHintShown != null && (
                  <button
                    type="button"
                    onClick={() => setSize(String(sizeHintShown))}
                    title="Equal split of what's still on across the remaining TPs"
                    data-testid="button-apply-split"
                    className="rounded px-1 font-mono text-[10px] leading-tight text-primary transition-colors hover:bg-primary/10"
                  >
                    even → {maskIfQuote(trade.sizeUnit, String(sizeHintShown))}
                  </button>
                )}
              </div>
              <Input
                value={size}
                onChange={(e) => setSize(e.target.value)}
                inputMode="decimal"
                placeholder={sizeHintShown != null ? String(sizeHintShown) : "—"}
                className="h-9 font-mono text-sm"
                data-testid="input-fill-size"
              />
            </div>
          </div>

          )}

          {mode === "fill" && fillUnit !== tradeUnit && effSize != null && (
            <p className="font-mono text-[10px] text-muted-foreground" data-testid="fill-converted">
              = {maskIfQuote(tradeUnit, num(effSize))} {tradeUnit === "quote" ? "USD" : "units"} at this price
            </p>
          )}
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
              against avg {num(led.avgEntry)}.
            </p>
          )}

          <TimeField
            label={trade.status === "closed" ? "When did it fill?" : "Fill time"}
            value={time}
            onChange={setTime}
            testId="input-fill-time"
          />
          {timeWarning && (
            <p className="text-[11px] leading-snug text-amber-500" data-testid="fill-time-warning">
              {timeWarning} Saved anyway if that is right — only the order against the other
              fills changes the numbers.
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
  );

  /*
   * Inline, this is a panel that opens where the button is — a partial is part
   * of writing the trade up, and sending it to a window stacked over the
   * editor made a small correction feel like a separate errand and buried the
   * numbers it should be read against.
   */
  if (inline) {
    return (
      <div
        className="space-y-3 rounded-md border border-border bg-secondary/20 p-3"
        data-testid="panel-fill-inline"
      >
        {heading}
        {body}
      </div>
    );
  }

  return (
    <Dialog open={trade != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}

/** The same form in a window, for the surfaces that are not the editor. */
export function FillDialog(props: {
  trade: TradeWithTags | null;
  kind: "add" | "partial";
  onClose: () => void;
}) {
  return <FillForm {...props} />;
}
