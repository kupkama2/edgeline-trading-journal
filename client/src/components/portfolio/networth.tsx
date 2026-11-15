import { AlertTriangle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { fmtAmount } from "@shared/metrics";
import { ValueLine } from "./charts";
import { PALETTE } from "./charts";

export interface NetWorth {
  at: string;
  totalUsd: number;
  parts: { id: string; label: string; valueUsd: number; pnlUsd: number | null; asOf: string | null }[];
  missing: string[];
  history: { date: string; valueUsd: number }[];
}

const tone = (n: number) => (Math.abs(n) < 0.005 ? "text-muted-foreground" : n > 0 ? "text-emerald-400" : "text-red-400");

/**
 * Everything followed on this page as one figure, and what each part of it
 * is worth: the addresses, Sigil Core, Lulo, and the positions valued by
 * hand. Astekz is somebody else's and is not in it.
 */
export function NetWorthSection() {
  // Read again whenever any part of the page is: the sum is only as fresh as its parts.
  const { data: d, isLoading } = useQuery<NetWorth>({ queryKey: ["/api/networth"], refetchInterval: 60_000 });
  if (isLoading) return <p className="py-6 text-center text-xs text-muted-foreground">Adding it up…</p>;
  if (!d) return <p className="text-xs text-amber-500">The total could not be worked out just now.</p>;
  const known = d.parts.filter((p) => p.pnlUsd != null);
  const pnl = known.reduce((s, p) => s + p.pnlUsd!, 0);
  return (
    <Card className="border-card-border bg-card p-3 sm:p-4" data-testid="networth">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Everything</p>
          <p className="font-mono text-3xl font-bold" data-testid="networth-total">
            {fmtAmount(d.totalUsd, 0)}
          </p>
        </div>
        {known.length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Gain where the cost is known</p>
            <p className={`font-mono text-lg font-bold leading-tight ${tone(pnl)}`} data-testid="networth-pnl">
              {pnl >= 0 ? "+" : "−"}
              {fmtAmount(Math.abs(pnl), 0)}
            </p>
          </div>
        )}
      </div>

      {d.totalUsd > 0 && (
        <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-secondary/70" aria-hidden>
          {d.parts.map((p, i) => (
            <div key={p.id} style={{ width: `${(p.valueUsd / d.totalUsd) * 100}%`, background: PALETTE[i % PALETTE.length] }} title={p.label} />
          ))}
        </div>
      )}
      <ul className="mt-2 divide-y divide-border/40 text-xs" data-testid="networth-parts">
        {d.parts.map((p, i) => (
          <li key={p.id} className="flex items-baseline gap-2 py-1.5" data-testid={`networth-part-${p.id}`}>
            <span className="h-2 w-2 shrink-0 self-center rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="min-w-0 flex-1 truncate">
              {p.label}
              {p.asOf && <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">as of {p.asOf}</span>}
            </span>
            {p.pnlUsd != null && (
              <span className={`font-mono text-[11px] ${tone(p.pnlUsd)}`}>
                {p.pnlUsd >= 0 ? "+" : "−"}
                {fmtAmount(Math.abs(p.pnlUsd), 0)}
              </span>
            )}
            <span className="w-24 text-right font-mono font-semibold">{fmtAmount(p.valueUsd, 0)}</span>
            <span className="w-12 text-right font-mono text-[11px] text-muted-foreground">{d.totalUsd > 0 ? `${((p.valueUsd / d.totalUsd) * 100).toFixed(1)}%` : ""}</span>
          </li>
        ))}
        {d.parts.length === 0 && <li className="py-1.5 text-muted-foreground">Nothing to add up yet: follow an address, load Sigil Core, or add a position below.</li>}
      </ul>
      {d.missing.map((m) => (
        <p key={m} className="mt-1 flex items-start gap-1.5 text-[11px] text-amber-500" data-testid="networth-missing">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          {m}. The total is short of it.
        </p>
      ))}
      <div className="mt-3">
        <ValueLine points={d.history.map((h) => ({ label: h.date, value: h.valueUsd }))} format={(v) => fmtAmount(v, 0)} testId="networth-history" />
      </div>
    </Card>
  );
}
