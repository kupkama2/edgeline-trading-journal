/**
 * Saying which book a trade happened in, when the ticker could not.
 *
 * This is the visible half of the silent failure described in
 * shared/price-pair.ts: a trade whose symbol matches nothing on either venue
 * is skipped by the settler, never stamped as checked, and skipped again
 * tomorrow — forever, without a word. Nothing in the journal said so, because
 * nothing in the journal knew how to say it.
 *
 * So it says so here, on the trade, and offers the fix in the same breath.
 * The list is ranked rather than filtered, because the usual cause is a
 * spelling difference — PEPE against the venue's 1000PEPE — and seeing the
 * near misses is what makes the right row obvious.
 */
import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link2, Loader2, X } from "lucide-react";
import { useBinanceSymbols, useHyperliquidSymbols, useUpdateTrade } from "@/lib/data";
import { useToast } from "@/hooks/use-toast";
import type { TradeWithTags } from "@shared/schema";
import { describePair, formatPricePair, pairCandidates, parsePricePair } from "@shared/price-pair";
import { pairForTradeWithFallback } from "@shared/binance";
import { hlCoinFor, venueOfAccount } from "@shared/hyperliquid";

/**
 * Whether the journal can work out a book for this trade on its own — the
 * same question the server asks, asked with the same functions so the two
 * cannot drift into disagreeing about which trades are stranded.
 */
export function needsPair(
  trade: TradeWithTags,
  binance: { symbol: string; baseAsset: string; market: "futures" | "spot" }[],
  hyperliquid: { name: string }[],
): boolean {
  if (parsePricePair(trade.pricePair)) return false;
  // A contract code is a futures trade, which has no crypto pair and is not
  // missing one. Offering to point NQ at a Binance book would be noise on
  // every row of a futures log.
  if (trade.contract?.trim()) return false;
  // Until a catalogue has loaded, nothing is stranded — it is unknown, and an
  // unknown that renders as a warning is a warning nobody can act on.
  if (binance.length === 0 && hyperliquid.length === 0) return false;
  if (venueOfAccount(trade.account) === "hyperliquid") {
    if (hlCoinFor(trade.symbol, hyperliquid.map((h) => h.name))) return false;
  }
  return pairForTradeWithFallback(trade, binance as any) == null;
}

export function PairPicker({ trade }: { trade: TradeWithTags }) {
  const { data: binance = [] } = useBinanceSymbols();
  const { data: hyperliquid = [] } = useHyperliquidSymbols();
  const update = useUpdateTrade();
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState<string | null>(null);

  const chosen = parsePricePair(trade.pricePair);
  const stranded = needsPair(trade, binance, hyperliquid);

  const options = useMemo(
    () => pairCandidates(query.trim() || trade.symbol, binance, hyperliquid),
    [query, trade.symbol, binance, hyperliquid],
  );

  async function choose(value: string | null) {
    setSaving(value ?? "clear");
    try {
      await update.mutateAsync({ id: trade.id, trade: { pricePair: value } as any });
      toast(
        value
          ? { title: "Pointed at a book", description: `${trade.symbol} now reads ${describePair(parsePricePair(value)!)}.` }
          : { title: "Back to the ticker", description: `${trade.symbol} is matched automatically again.` },
      );
    } catch (err: any) {
      toast({
        title: "That didn't save",
        description: String(err?.message ?? err).slice(0, 160),
        variant: "destructive",
      });
    } finally {
      setSaving(null);
    }
  }

  // Nothing to say on a trade that matched on its own and was never overridden.
  if (!stranded && !chosen) return null;

  return (
    <Card
      className={`p-3 sm:p-4 ${chosen ? "border-card-border bg-card" : "border-amber-500/40 bg-amber-500/5"}`}
      data-testid="card-pair-picker"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Link2 className={`h-3.5 w-3.5 shrink-0 ${chosen ? "text-muted-foreground" : "text-amber-500"}`} />
        {chosen ? (
          <>
            <span className="text-xs">
              Prices read from{" "}
              <span className="font-mono font-semibold" data-testid="text-pair-chosen">
                {describePair(chosen)}
              </span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-6 px-2 text-[10px] text-muted-foreground"
              onClick={() => void choose(null)}
              disabled={saving != null}
              data-testid="button-pair-clear"
            >
              <X className="mr-1 h-3 w-3" />
              Match it automatically
            </Button>
          </>
        ) : (
          <div className="min-w-0">
            <p className="text-xs font-semibold text-amber-500" data-testid="text-pair-stranded">
              No book matches “{trade.symbol}”.
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
              Nothing can be read for this trade — not whether the plan would have paid, not how
              far it ran, not the chart — until it is pointed at a pair. Pick the one it happened
              in.
            </p>
          </div>
        )}
      </div>

      {!chosen && (
        <div className="mt-3 space-y-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search Binance and Hyperliquid — try "${trade.symbol}"`}
            className="h-8 text-xs"
            data-testid="input-pair-search"
          />
          {options.length === 0 ? (
            <p className="text-[11px] text-muted-foreground" data-testid="text-pair-none">
              Nothing matching. The catalogues may not have loaded yet, or the coin is not listed
              on either venue.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5" data-testid="pair-options">
              {options.map((ref) => {
                const value = formatPricePair(ref);
                return (
                  <Button
                    key={value}
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 font-mono text-[10px]"
                    onClick={() => void choose(value)}
                    disabled={saving != null}
                    data-testid={`button-pair-${value}`}
                  >
                    {saving === value && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                    {describePair(ref)}
                  </Button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
