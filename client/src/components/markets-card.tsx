/**
 * What the journal can actually read prices from, in numbers.
 *
 * Every automatic answer here — did the stop get hit, how far did it run, is
 * there a chart — depends on a catalogue fetched from a venue, and until now
 * the only sign that a catalogue was empty was a feature quietly doing
 * nothing. "I cannot find WTIOIL" and "the builder books never loaded" look
 * identical from the outside, and they need completely different fixes.
 *
 * So the counts are on the page. Not a health score and not advice: the four
 * numbers that decide whether a symbol can be found, and the venue's own words
 * when one of them refused.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface MarketStatus {
  pairs: number;
  futures: number;
  spot: number;
  source: string;
  lastError?: string | null;
  hyperliquid: {
    listed: number;
    delisted: number;
    dexes: number;
    builderPerps: number;
    lastOkAt: string | null;
    lastError: string | null;
    dexError: string | null;
    catalogueAt: string | null;
  };
}

function Row({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={`font-mono text-xs tabular-nums ${tone}`}>{value}</span>
    </div>
  );
}

export function MarketsCard() {
  const { data } = useQuery<MarketStatus>({
    queryKey: ["/api/binance/status"],
    staleTime: 60_000,
  });
  const hl = data?.hyperliquid;
  const qc = useQueryClient();
  const { toast } = useToast();

  /*
   * Re-reading by hand, because the lists refresh once a day.
   *
   * That cadence is right for a venue that lists a coin every few weeks and
   * wrong for the moment somebody is looking at an empty picker. It is also
   * what makes a deploy that teaches the journal to fetch MORE look broken:
   * the new code is handed yesterday's rows and reports, honestly, that it
   * found nothing new.
   */
  const refresh = useMutation({
    mutationFn: () => apiRequest("POST", "/api/markets/refresh"),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["/api/binance/status"] }),
        qc.invalidateQueries({ queryKey: ["/api/binance/symbols"] }),
        qc.invalidateQueries({ queryKey: ["/api/hyperliquid/symbols"] }),
      ]);
      toast({ title: "Read both venues again" });
    },
    onError: (err: any) =>
      toast({
        title: "Could not re-read the venues",
        description: String(err?.message ?? err).slice(0, 160),
        variant: "destructive",
      }),
  });

  return (
    <Card className="border-card-border bg-card p-4 sm:p-5" data-testid="card-markets">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-tight">Markets the journal can read</h2>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-[11px]"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          data-testid="button-markets-refresh"
        >
          {refresh.isPending ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="mr-1 h-3 w-3" />
          )}
          Read them again
        </Button>
      </div>
      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
        Fetched from each venue once a day and cached. A symbol missing from these lists cannot be
        found in the picker, charted, or settled — so if something is not turning up, this is the
        first place to look.
      </p>

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Binance</p>
          <Row label="pairs" value={data ? String(data.pairs) : "—"} />
          <Row label="perps · spot" value={data ? `${data.futures} · ${data.spot}` : "—"} />
          <Row
            label="list in use"
            value={data?.source ?? "—"}
            tone={data && data.source !== "binance" ? "text-amber-500" : ""}
          />
          {data?.lastError && (
            <p className="font-mono text-[10px] leading-snug text-amber-500">{data.lastError}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Hyperliquid</p>
          <Row label="perps listed" value={hl ? String(hl.listed) : "—"} />
          {/*
            The two that answer the equities-and-commodities question. The coin
            perps are the venue's own book; everything else is deployed by a
            builder into a book of its own, and zero books means none of those
            markets exist as far as this journal is concerned — whatever the
            ticker is called.
          */}
          <Row
            label="builder books"
            value={hl ? String(hl.dexes) : "—"}
            tone={hl && hl.dexes === 0 ? "text-amber-500" : ""}
          />
          <Row
            label="perps from them"
            value={hl ? String(hl.builderPerps) : "—"}
            tone={hl && hl.builderPerps === 0 ? "text-amber-500" : ""}
          />
          {hl?.lastError && (
            <p className="font-mono text-[10px] leading-snug text-amber-500" data-testid="markets-hl-error">
              {hl.lastError}
            </p>
          )}
          {/* The venue's own words about the books specifically, which is a
              different failure from the universe not loading at all. */}
          {hl?.dexError && (
            <p className="font-mono text-[10px] leading-snug text-amber-500" data-testid="markets-dex-error">
              {hl.dexError}
            </p>
          )}
          {/*
            Said only when the stored list is the evidence.
            This line used to claim the venue had no builder books whenever a
            counter read zero — and that counter lived in the server's memory,
            so it read zero after every restart whether or not anybody had
            asked. A sentence about the venue has to come from the catalogue,
            which is the thing that survives a deploy.
          */}
          {hl && hl.catalogueAt && hl.dexes === 0 && !hl.lastError && !hl.dexError && (
            <p className="text-[10px] leading-snug text-amber-500" data-testid="markets-no-books">
              The list this journal holds has no builder-deployed books in it, so there are no
              equity or commodity perps to offer. Read them again to check.
            </p>
          )}
          {hl?.catalogueAt && (
            <p className="text-[10px] leading-snug text-muted-foreground" data-testid="markets-hl-fetched">
              list written {new Date(hl.catalogueAt).toLocaleString()}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
