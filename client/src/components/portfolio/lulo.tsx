import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fmtAmount } from "@shared/metrics";
import { useLulo, useRefreshLulo } from "@/lib/sigil";
import { ValueLine } from "./charts";

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const rate = (n: number | null) => (n == null ? "—" : `${n.toFixed(2)}%`);

/**
 * The Lulo deposit of every Solana wallet followed above: what is in it,
 * what it has earned, and the rate it is earning at now. Lulo is asked
 * directly; nothing is typed in.
 */
export function LuloSection() {
  const page = useLulo();
  const refresh = useRefreshLulo();
  const d = page.data;
  if (page.isLoading) return <p className="py-6 text-center text-xs text-muted-foreground">Reading…</p>;
  if (!d) return <p className="text-xs text-amber-500">Lulo could not be read just now.</p>;
  const errors = d.wallets.filter((w) => w.error);
  const held = d.wallets.filter((w) => w.account);
  const t = d.total;
  return (
    <div className="space-y-3" data-testid="lulo-root">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-[11px] text-muted-foreground">
          Read {new Date(d.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} from Lulo, for the Solana addresses followed on this page.
        </p>
        <Button size="sm" variant="outline" className="h-8" onClick={() => refresh.mutate()} disabled={refresh.isPending} data-testid="lulo-refresh">
          {refresh.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
          Read now
        </Button>
      </div>
      {errors.map((w) => (
        <p key={w.address} className="flex items-start gap-1.5 text-xs text-amber-500" data-testid="lulo-error">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {w.label ?? short(w.address)}: {w.error}
        </p>
      ))}
      {d.followed === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="lulo-empty">
          Follow the Solana wallet that holds the deposit under "Addresses followed", and it shows here.
        </p>
      ) : held.length === 0 && errors.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="lulo-empty">
          None of the {d.followed} Solana {d.followed === 1 ? "address" : "addresses"} followed has a Lulo deposit. If yours sits in another wallet, follow that one.
        </p>
      ) : (
        held.length > 0 && (
          <Card className="border-card-border bg-card p-3 sm:p-4" data-testid="lulo-stats">
            <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">In Lulo</p>
                <p className="font-mono text-2xl font-bold" data-testid="lulo-value">
                  {fmtAmount(t.valueUsd, 2)}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Interest earned</p>
                <p className="font-mono text-lg font-bold leading-tight text-emerald-400" data-testid="lulo-interest">
                  +{fmtAmount(t.interestUsd, 2)}
                </p>
                <p className="font-mono text-[10px] text-muted-foreground">on {fmtAmount(t.depositedUsd, 2)} put in</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Earning now</p>
                <p className="font-mono text-sm font-semibold" data-testid="lulo-rate">
                  {rate(d.rate)} a year
                </p>
              </div>
              <div className="text-[11px] text-muted-foreground">
                {t.protectedUsd > 0 && (
                  <p>
                    Protected <span className="font-mono text-foreground">{fmtAmount(t.protectedUsd, 2)}</span> at {rate(d.rates.protected)}
                  </p>
                )}
                {t.boostedUsd > 0 && (
                  <p>
                    Boosted <span className="font-mono text-foreground">{fmtAmount(t.boostedUsd, 2)}</span> at {rate(d.rates.boosted)}
                  </p>
                )}
              </div>
            </div>
            {held.length > 1 && (
              <ul className="mt-2 divide-y divide-border/40 text-xs">
                {held.map((w) => (
                  <li key={w.address} className="flex justify-between py-1">
                    <span>{w.label ?? short(w.address)}</span>
                    <span className="font-mono">
                      {fmtAmount(w.account!.valueUsd, 2)} <span className="text-emerald-400">+{fmtAmount(w.account!.interestUsd, 2)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3">
              <ValueLine points={d.history.map((h) => ({ label: h.date, value: h.valueUsd }))} format={(v) => fmtAmount(v, 2)} testId="lulo-history" />
            </div>
          </Card>
        )
      )}
    </div>
  );
}
