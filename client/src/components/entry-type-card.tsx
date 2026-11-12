import { useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Crosshair, Loader2, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { entryEdge, MIN_PER_SIDE, type EntryEdge, type EntrySide } from "@shared/entry-edge";
import { fmtFees, fmtMoney, fmtR } from "@shared/metrics";
import type { TradeWithTags } from "@shared/schema";

/**
 * Limit entries against market entries, head to head.
 *
 * The breakdown tab gives the same rows; this says what they add up to: which
 * side is ahead, by how much per trade, and whether a gap that size is more
 * than two samples this small would show by chance. It also counts the limit
 * orders that never filled, the trades the limit column cannot contain.
 */
export function EntryTypeCard({ trades }: { trades: TradeWithTags[] }) {
  const e = useMemo(() => entryEdge(trades), [trades]);
  const any = e.limit.count + e.market.count > 0;
  const { toast } = useToast();
  // The trades written before entry types were read: asked of the venues, blanks only.
  const backfill = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/trades/entry-types")).json() as Promise<{ asked: number; filled: number; unanswered: number; noVenue: number; errors: string[] }>,
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/trades"] });
      const parts = [
        `${r.filled} filled in`,
        r.unanswered ? `${r.unanswered} the venue no longer has the fills for` : "",
        r.noVenue ? `${r.noVenue} with no venue to ask (mark those on the trade)` : "",
      ].filter(Boolean);
      toast({
        title: r.filled ? "Entry types read from the venues" : "Nothing new from the venues",
        description: [parts.join(" · "), ...r.errors].filter(Boolean).join(" ").slice(0, 300),
        ...(r.errors.length && !r.filled ? { variant: "destructive" as const } : {}),
      });
    },
    onError: (err: any) => toast({ title: "Could not ask the venues", description: String(err?.message ?? err).replace(/^\d+:\s*/, "").slice(0, 200), variant: "destructive" }),
  });
  const askButton = e.unknown > 0 && (
    <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => backfill.mutate()} disabled={backfill.isPending} data-testid="button-entry-type-backfill">
      {backfill.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
      Read past trades from the venues
    </Button>
  );

  return (
    <Card className="border-card-border bg-card p-4" data-testid="card-entry-type">
      <div className="mb-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <Crosshair className="h-4 w-4 text-muted-foreground" />
          Limit entries vs market entries
        </h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          A limit rested on the book and price came to it. A market entry took what was there: a market order, a stop,
          or a limit priced through the book. Read from the venue's fills where it has them, from the terminal's order,
          or as you set it on the trade.
        </p>
      </div>

      {!any ? (
        <p className="text-[11px] leading-snug text-muted-foreground" data-testid="entry-type-empty">
          No closed trade says how it was entered yet. Trades synced from Hyperliquid or Binance get it on the next
          sync; the terminal's get it from the order it sent; any other trade can be marked on its page.
          {e.unknown > 0 && ` ${e.unknown} closed ${e.unknown === 1 ? "trade is" : "trades are"} waiting for one.`}
          {askButton && <span className="mt-2 block">{askButton}</span>}
        </p>
      ) : (
        <>
          <p className="mb-3 text-[11px] leading-snug text-foreground/90" data-testid="entry-type-sentence">
            {sentence(e)}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <SideBox s={e.limit} lead={e.better === "limit" && e.verdict !== "too-few"} />
            <SideBox s={e.market} lead={e.better === "market" && e.verdict !== "too-few"} />
          </div>
          <ul className="mt-3 space-y-1 text-[10px] leading-snug text-muted-foreground">
            {e.unfilled > 0 && (
              <li data-testid="entry-type-unfilled">
                {e.unfilled} limit {e.unfilled === 1 ? "order" : "orders"} never filled
                {e.unfilledResolved > 0
                  ? `; of the ${e.unfilledResolved} checked against the market, ${e.unfilledWouldHaveWon} would have reached the target.`
                  : "."}{" "}
                Those are the moves that left without you, and they are in neither column: a limit record looks better
                partly because its runners never filled.
              </li>
            )}
            {e.unknown > 0 && (
              <li data-testid="entry-type-unknown">
                {e.unknown} closed {e.unknown === 1 ? "trade says" : "trades say"} nothing about the entry and{" "}
                {e.unknown === 1 ? "is" : "are"} left out. The venues can say for the ones they filled; others can be marked on the trade.
              </li>
            )}
          </ul>
          {askButton && <div className="mt-2">{askButton}</div>}
        </>
      )}
    </Card>
  );
}

/** Under half a hundredth of an R is flat: printed as "−0.00R" in red, it read as a loss. */
const flat = (r: number) => (Math.abs(r) < 0.005 ? 0 : r);

function SideBox({ s, lead }: { s: EntrySide; lead: boolean }) {
  const exp = flat(s.expectancyR);
  return (
    <div
      className={`rounded-md border px-3 py-2 ${lead ? "border-emerald-500/40 bg-emerald-500/5" : "border-border/60"}`}
      data-testid={`entry-type-side-${s.type}`}
    >
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {s.label} · {s.count} {s.count === 1 ? "trade" : "trades"}
      </p>
      <p className={`font-mono text-lg font-bold ${s.measured === 0 || exp === 0 ? "text-muted-foreground" : exp > 0 ? "text-emerald-500" : "text-red-500"}`}>
        {s.measured ? fmtR(exp) : "—"}
        <span className="ml-1 text-[10px] font-normal text-muted-foreground">per trade</span>
      </p>
      <dl className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
        <dt className="text-muted-foreground">Win rate</dt>
        <dd className="text-right font-mono">{s.measured ? `${Math.round(s.winRate * 100)}%` : "—"}</dd>
        <dt className="text-muted-foreground">Total</dt>
        <dd className="text-right font-mono">{s.measured ? fmtR(flat(s.totalR)) : "—"}</dd>
        <dt className="text-muted-foreground">Profit factor</dt>
        <dd className="text-right font-mono">{s.profitFactor != null ? s.profitFactor.toFixed(2) : "—"}</dd>
        <dt className="text-muted-foreground">Net P&L</dt>
        <dd className={`text-right font-mono ${s.totalPnL >= 0 ? "text-emerald-500" : "text-red-500"}`}>{fmtMoney(s.totalPnL)}</dd>
        {s.totalFees > 0 && (
          <>
            <dt className="text-muted-foreground">Fees</dt>
            <dd className="text-right font-mono text-muted-foreground">{fmtFees(s.totalFees)}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function sentence(e: EntryEdge): string {
  const gap = `${fmtR(Math.abs(e.diffR)).replace(/^[+−-]/, "")} per trade`;
  const ahead = e.better === "limit" ? "Limit entries are ahead" : e.better === "market" ? "Market entries are ahead" : "Dead level";
  switch (e.verdict) {
    case "too-few":
      return `Not enough yet to call it: a comparison needs ${MIN_PER_SIDE} measured trades a side, and there are ${e.limit.measured} limit and ${e.market.measured} market.${
        e.better ? ` So far, ${ahead.toLowerCase()} by ${gap}.` : ""
      }`;
    case "clear":
      return `${ahead} by ${gap}, more than twice what chance would give two samples this size. That is a real gap on this record, not a proof it lasts.`;
    case "leaning":
      return `${ahead} by ${gap}, but a gap this size could still be noise at these sample sizes. Worth watching as more trades come in.`;
    case "no-difference":
      return e.better
        ? `${ahead} by ${gap}, which is within what chance alone would give. On this record, how you enter is not what decides the result.`
        : "Both sides earn the same per trade so far.";
  }
}
