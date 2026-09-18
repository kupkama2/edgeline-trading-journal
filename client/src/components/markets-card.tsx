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
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";

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

  return (
    <Card className="border-card-border bg-card p-4 sm:p-5" data-testid="card-markets">
      <h2 className="text-sm font-semibold tracking-tight">Markets the journal can read</h2>
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
          {hl && hl.dexes === 0 && !hl.lastError && (
            <p className="text-[10px] leading-snug text-amber-500">
              No builder books came back, so equity and commodity perps are not in the picker.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
