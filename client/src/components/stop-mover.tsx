/**
 * Moving the stop, and saying what that took off the table.
 *
 * This is most of what managing a swing IS. You take it, it goes your way,
 * you pull the stop to entry and the trade can no longer hurt you — and until
 * now the journal went on reporting the risk it was opened with for however
 * many weeks you held it, because one stop column was doing the work of two.
 *
 * The original stays put. It is the denominator of every R on the trade, and
 * a figure that quietly rebases each time you manage a position would make
 * the same trade a different number every time you did the right thing. What
 * changes is what is still at risk — which is the number you act on.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ArrowDownToLine, Check, ShieldCheck } from "lucide-react";
import { useUpdateTrade } from "@/lib/data";
import { useToast } from "@/hooks/use-toast";
import type { TradeWithTags } from "@shared/schema";
import { positionLedger } from "@shared/fills";
import { fmtAmount, fmtMoney } from "@shared/metrics";
import {
  addStopMove,
  currentStop,
  formatStopMoves,
  lockedIn,
  parseStopMoves,
  riskLeft,
} from "@shared/stops";
import { num } from "@/components/trade-shared";

export function StopMover({ trade }: { trade: TradeWithTags }) {
  const update = useUpdateTrade();
  const { toast } = useToast();
  const [typing, setTyping] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const moves = parseStopMoves(trade.stopMoves);
  const stop = currentStop(trade);
  const left = riskLeft(trade);
  const locked = lockedIn(trade);
  const entry = positionLedger(trade).avgEntry;

  if (trade.initialStop == null) return null;

  async function moveTo(price: number, why?: string) {
    const next = addStopMove(trade.stopMoves, price, new Date().toISOString(), why);
    try {
      await update.mutateAsync({
        id: trade.id,
        trade: { stopMoves: formatStopMoves(next) } as any,
      });
      setTyping(null);
      setNote("");
    } catch (err: any) {
      toast({
        title: "That didn't save",
        description: String(err?.message ?? err).slice(0, 160),
        variant: "destructive",
      });
    }
  }

  const risky = left != null && left > 0;
  return (
    <Card
      className={`p-3 sm:p-4 ${locked != null ? "border-emerald-500/40 bg-emerald-500/5" : "border-card-border bg-card"}`}
      data-testid="card-stop-mover"
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Stop now</p>
          <p className="font-mono text-sm font-semibold text-primary" data-testid="text-stop-now">
            {num(stop)}
            {moves.length > 0 && (
              <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                from {num(trade.initialStop)}
              </span>
            )}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Still at risk</p>
          <p
            className={`font-mono text-sm font-semibold ${risky ? "text-primary" : "text-emerald-400"}`}
            data-testid="text-risk-left"
          >
            {left == null ? "—" : risky ? fmtAmount(left) : "nothing"}
          </p>
        </div>
        {/* The whole point of pulling a stop through the entry, in one figure. */}
        {locked != null && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Locked in</p>
            <p className="font-mono text-sm font-semibold text-emerald-400" data-testid="text-locked-in">
              {fmtMoney(locked)}
            </p>
          </div>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {/* Breakeven is THE move, so it is a button rather than a number to
              type — but only while there is still risk to take off. Past the
              entry it would be a move backwards wearing the label of an
              improvement, and "Moved it" already covers going anywhere. */}
          {entry > 0 && risky && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              onClick={() => void moveTo(entry, "breakeven")}
              disabled={update.isPending}
              data-testid="button-stop-breakeven"
            >
              <ShieldCheck className="mr-1 h-3 w-3" />
              To breakeven
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => setTyping(typing == null ? String(stop ?? "") : null)}
            data-testid="button-stop-move"
          >
            <ArrowDownToLine className="mr-1 h-3 w-3" />
            Moved it
          </Button>
        </div>
      </div>

      {typing != null && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            autoFocus
            type="number"
            step="any"
            inputMode="decimal"
            value={typing}
            onChange={(e) => setTyping(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = Number(typing);
                if (isFinite(v) && v > 0) void moveTo(v, note);
              }
              if (e.key === "Escape") setTyping(null);
              e.stopPropagation();
            }}
            className="h-8 w-28 font-mono text-xs"
            placeholder="new stop"
            data-testid="input-stop-new"
          />
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = Number(typing);
                if (isFinite(v) && v > 0) void moveTo(v, note);
              }
              e.stopPropagation();
            }}
            className="h-8 max-w-[16rem] flex-1 text-xs"
            placeholder="why — under the Thursday low"
            data-testid="input-stop-note"
          />
          <Button
            size="sm"
            className="h-8 px-2 text-[11px]"
            onClick={() => {
              const v = Number(typing);
              if (isFinite(v) && v > 0) void moveTo(v, note);
            }}
            disabled={update.isPending}
            data-testid="button-stop-save"
          >
            <Check className="mr-1 h-3 w-3" />
            Save
          </Button>
        </div>
      )}

      {/* The history, because "when did this stop being able to hurt me" is a
          question the latest price alone cannot answer. */}
      {moves.length > 0 && (
        <div className="mt-3 space-y-0.5 border-t border-border/50 pt-2" data-testid="list-stop-moves">
          {moves.map((mv, i) => (
            <div key={`${mv.at}-${i}`} className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
              <span className="font-mono text-foreground/80">{num(mv.price)}</span>
              <span className="text-muted-foreground">
                {new Date(mv.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </span>
              {mv.note && <span className="text-muted-foreground">· {mv.note}</span>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
