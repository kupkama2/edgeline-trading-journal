import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { FLAG_HORIZONS, type FlagCell } from "@shared/flag-track";
import { fmtPct, useScreenerTrack } from "@/lib/screener";

const HORIZON_LABEL = { "24h": "1 day", "3d": "3 days", "1w": "1 week" } as const;
const OPEN_KEY = "edgeline.screener.track.open";

function Cell({ c, control }: { c: FlagCell; control: boolean }) {
  if (!c.n) return <span className="text-muted-foreground">—</span>;
  // For the control (weakest), losing to BTC is the flags working.
  const good = c.avgRs == null ? null : control ? c.avgRs < 0 : c.avgRs > 0;
  return (
    <span className="font-mono" title={`${c.beat} of ${c.n} beat BTC; mean move against BTC ${fmtPct(c.avgRs)}, mean price move ${fmtPct(c.avg)}`}>
      <span className={good == null ? "" : good ? "text-emerald-400" : "text-red-400"}>{fmtPct(c.avgRs)}</span>
      <span className="ml-1 text-[10px] text-muted-foreground">
        {c.beat}/{c.n}
      </span>
    </span>
  );
}

/**
 * Did the flags work: what each kind of flagged coin did against BTC a
 * day, three days and a week after it was first flagged. Folded away
 * until asked for; it fills in as the runs go by.
 */
export function ScreenerTrackCard() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(OPEN_KEY, o ? "0" : "1");
      } catch {
        /* fine */
      }
      return !o;
    });
  };
  const q = useScreenerTrack(open);
  const t = q.data;
  return (
    <Card className="border-card-border bg-card p-3 sm:p-4" data-testid="screener-track">
      <button type="button" onClick={toggle} className="flex items-center gap-1.5 text-left text-sm font-semibold hover:text-sky-400" aria-expanded={open} data-testid="screener-track-toggle">
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Do the screener's badges work?
        <span className="text-[11px] font-normal text-muted-foreground">· what badged coins did next, compared with BTC</span>
      </button>
      {open && (
        <div className="mt-2">
          {q.isLoading && <p className="text-xs text-muted-foreground">Pricing the flags…</p>}
          <p className="mb-2 text-[11px] text-muted-foreground">
            When the table gives a coin a badge (Candidate, a score of 4 or more, a rating of 90 or more), it is noted here. A day, three days and a week later it is checked: did the coin do better than BTC? If the badges mean something, badged coins should beat BTC more often than not, and the weakest coins should lose to it.
          </p>
          {t && t.entries === 0 && <p className="text-xs text-muted-foreground">Nothing noted yet. Each scan records what it badges; the first results appear a day later.</p>}
          {t && t.entries > 0 && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full max-w-2xl text-xs">
                  <thead>
                    <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="py-1 pr-2 text-left font-medium">Badge</th>
                      <th className="px-1.5 py-1 text-right font-medium">Times given</th>
                      {FLAG_HORIZONS.map((h) => (
                        <th key={h} className="px-1.5 py-1 text-right font-medium">
                          {HORIZON_LABEL[h]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {t.kinds.map((k) => (
                      <tr key={k.id} className="border-b border-border/40 last:border-0" data-testid={`screener-track-${k.id}`}>
                        <td className="whitespace-nowrap py-1 pr-2 text-muted-foreground">{k.label}</td>
                        <td className="px-1.5 py-1 text-right font-mono">{k.logged}</td>
                        {FLAG_HORIZONS.map((h) => (
                          <td key={h} className="whitespace-nowrap px-1.5 py-1 text-right">
                            <Cell c={k.cells[h]} control={k.id === "weakest-1D"} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-1.5 text-[10px] text-muted-foreground">
                Each cell: the average result against BTC, then how many beat BTC out of how many were checked. "+2.1% 7/10" means badged coins beat BTC by 2.1% on average and 7 of 10 did better than BTC. A coin counts once a day at most, over the last 30 days. With only a handful of entries the numbers mean little.
              </p>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
