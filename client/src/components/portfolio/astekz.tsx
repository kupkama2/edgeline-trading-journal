import { AlertTriangle, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { fmtAmount } from "@shared/metrics";
import { useAstekz, useRefreshAstekz } from "@/lib/sigil";
import { ValueLine } from "./charts";

const pct = (n: number | null | undefined, d = 2) => (n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(d)}%`);
const tone = (n: number | null | undefined) => (n == null || Math.abs(n) < 0.005 ? "text-muted-foreground" : n > 0 ? "text-emerald-400" : "text-red-400");
const qty = (n: number) => (Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n.toLocaleString(undefined, { maximumSignificantDigits: 6 }));
const price = (n: number) => (n >= 1 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n.toLocaleString(undefined, { maximumSignificantDigits: 4 }));
const when = (iso: string) => new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const said = (err: any) => String(err?.message ?? err).replace(/^\d{3}:\s*/, "").replace(/^\{"message":"(.*)"\}$/, "$1");

/**
 * The Astekz portfolio as its public page publishes it, read once a day by
 * the server: what is held and at what weight, the share in cash, progress
 * toward the page's goal, and what was bought, sold or resized since the
 * day before.
 */
export function AstekzSection() {
  const page = useAstekz();
  const refresh = useRefreshAstekz();
  const { toast } = useToast();
  const d = page.data;
  const s = d?.latest ?? null;
  const onRefresh = async () => {
    try {
      await refresh.mutateAsync();
    } catch (err) {
      toast({ title: "Not read", description: said(err), variant: "destructive" });
      void page.refetch();
    }
  };

  if (page.isLoading) return <p className="py-6 text-center text-xs text-muted-foreground">Reading…</p>;
  const head = (
    <div className="flex flex-wrap items-center gap-2">
      <p className="min-w-0 flex-1 text-[11px] text-muted-foreground">
        {s ? `Read ${when(s.at)}` : "Not read yet"} · once a day from{" "}
        <a href={d?.page} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground">
          the public page <ExternalLink className="h-3 w-3" />
        </a>
        , priced from CoinGecko the way the page prices itself.
      </p>
      <Button size="sm" variant="outline" className="h-8" onClick={onRefresh} disabled={refresh.isPending || d?.reading} data-testid="astekz-refresh">
        {refresh.isPending || d?.reading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
        Read now
      </Button>
    </div>
  );
  const failed = d?.failed && (
    <p className="flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-500" data-testid="astekz-failed">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        The read at {when(d.failed.at)} failed: {d.failed.error}. {s ? `Showing the last good one, from ${when(s.at)}.` : "There is no earlier read to show."}
      </span>
    </p>
  );

  if (!s)
    return (
      <div className="space-y-3" data-testid="astekz-root">
        {head}
        {failed}
        {!d?.enabled && <p className="text-xs text-muted-foreground">The daily read is switched off on the server.</p>}
      </div>
    );

  const progress = Math.max(0, Math.min(100, s.progressPct));
  return (
    <div className="space-y-3" data-testid="astekz-root">
      {head}
      {failed}
      {!d!.failed && d!.stale && (
        <p className="text-xs text-amber-500" data-testid="astekz-stale">
          This read is more than a day old.
        </p>
      )}

      <Card className="border-card-border bg-card p-3 sm:p-4" data-testid="astekz-stats">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Value</p>
            <p className="font-mono text-2xl font-bold" data-testid="astekz-value">
              {fmtAmount(s.totalUsd, 0)}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">P&amp;L on {fmtAmount(s.costUsd, 0)}</p>
            <p className={`font-mono text-sm font-semibold ${tone(s.pnlPct)}`} data-testid="astekz-pnl">
              {pct(s.pnlPct)}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">In cash</p>
            <p className="font-mono text-sm font-semibold" data-testid="astekz-cash">
              {s.cashPct.toFixed(1)}%
            </p>
          </div>
          <div className="min-w-40 flex-1">
            <p className="flex justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
              <span>Progress to {fmtAmount(s.goalUsd, 0)}</span>
              <span className="font-mono text-foreground" data-testid="astekz-progress">
                {s.progressPct.toFixed(2)}%
              </span>
            </p>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-secondary/70">
              <div className="h-full rounded-full bg-emerald-500" style={{ width: `${progress}%` }} />
            </div>
          </div>
        </div>
        <div className="mt-3">
          <ValueLine points={d!.history.map((h) => ({ label: h.date, value: h.valueUsd }))} format={(v) => fmtAmount(v, 0)} testId="astekz-history" />
        </div>
      </Card>

      <Card className="border-card-border bg-card p-3 sm:p-4" data-testid="astekz-holdings">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Holdings</p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="px-1.5 py-1.5 font-medium">Asset</th>
                <th className="px-1.5 py-1.5 text-right font-medium">Weight</th>
                <th className="px-1.5 py-1.5 text-right font-medium">Value</th>
                <th className="px-1.5 py-1.5 text-right font-medium">P&amp;L</th>
                <th className="hidden px-1.5 py-1.5 text-right font-medium sm:table-cell">Quantity</th>
                <th className="hidden px-1.5 py-1.5 text-right font-medium sm:table-cell">Price</th>
              </tr>
            </thead>
            <tbody>
              {s.holdings.map((h) => (
                <tr key={h.ticker} className="border-b border-border/40" data-testid={`astekz-row-${h.ticker}`}>
                  <td className="px-1.5 py-1.5">
                    <span className="font-semibold">{h.ticker}</span> <span className="text-muted-foreground">{h.name}</span>
                  </td>
                  <td className="px-1.5 py-1.5 text-right font-mono">{h.weight.toFixed(1)}%</td>
                  <td className="px-1.5 py-1.5 text-right font-mono">{fmtAmount(h.valueUsd, 0)}</td>
                  <td className={`px-1.5 py-1.5 text-right font-mono ${h.cash ? "text-muted-foreground" : tone(h.pnlPct)}`}>{h.cash ? "—" : pct(h.pnlPct, 1)}</td>
                  <td className="hidden px-1.5 py-1.5 text-right font-mono sm:table-cell">{h.cash ? "—" : qty(h.qty)}</td>
                  <td className="hidden px-1.5 py-1.5 text-right font-mono sm:table-cell" title={h.priceFrom}>
                    {h.cash ? "—" : price(h.priceUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="border-card-border bg-card p-3 sm:p-4" data-testid="astekz-changes">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Change log</p>
        {d!.changes.length === 0 ? (
          <p className="text-xs text-muted-foreground">{d!.history.length < 2 ? "Changes appear from the second day's read on." : "Nothing bought, sold or resized since the first read."}</p>
        ) : (
          <ul className="divide-y divide-border/40 text-xs">
            {d!.changes.map((c) => (
              <li key={c.date} className="py-1.5" data-testid={`astekz-change-${c.date}`}>
                <span className="font-mono font-semibold">{c.date}</span> <span className="text-muted-foreground">since {c.since.slice(5)}</span>
                <span className="mt-0.5 block space-y-0.5">
                  {c.bought.map((b) => (
                    <span key={b.ticker} className="block text-emerald-400">
                      BOUGHT {b.ticker} {qty(b.qty)} · {fmtAmount(b.valueUsd, 0)}
                    </span>
                  ))}
                  {c.sold.map((b) => (
                    <span key={b.ticker} className="block text-red-400">
                      SOLD {b.ticker} {qty(b.qty)} · was {fmtAmount(b.valueUsd, 0)}
                    </span>
                  ))}
                  {c.resized.map((r) => (
                    <span key={r.ticker} className="block text-amber-400">
                      RESIZED {r.ticker} {qty(r.from)} → {qty(r.to)} ({pct(r.pct, 1)})
                    </span>
                  ))}
                  {c.cashDelta !== 0 && (
                    <span className="block text-muted-foreground">
                      Cash {c.cashDelta > 0 ? "up" : "down"} {fmtAmount(Math.abs(c.cashDelta), 0)}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
