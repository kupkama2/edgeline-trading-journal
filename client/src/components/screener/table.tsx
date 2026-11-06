import { useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp } from "lucide-react";
import { TIMEFRAMES, type ScreenerRow, type Timeframe } from "@shared/screener";
import { ACCEL_ARROW, fmtPct, fmtUsd, fmtX, heat } from "@/lib/screener";

export type Filter = "all" | "candidates" | "fast" | "weakest";

/** What a column header sorts by. */
type SortKey = `rs:${Timeframe}` | "coin" | "rvol" | "funding" | "oi" | "volume";

/**
 * The ranked table: one row per coin, RS change per timeframe as heat
 * cells, the acceleration arrow beside the chosen timeframe's number,
 * RVOL, funding, OI change and the flags. A click on a header sorts by
 * it; a click on a row opens the coin; the chart's set is toggled from
 * the dot at the left.
 */
export function ScreenerTable({
  rows,
  tf,
  filter,
  search = "",
  rvolMin,
  charted,
  onToggleChart,
  onOpen,
}: {
  rows: ScreenerRow[];
  tf: Timeframe;
  filter: Filter;
  /** Part of a coin's name; empty is everything. */
  search?: string;
  rvolMin: number;
  charted: Set<string>;
  onToggleChart: (coin: string) => void;
  onOpen: (coin: string) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: `rs:${tf}`, desc: true });
  const [lastTf, setLastTf] = useState(tf);
  // The timeframe picker moves the default sort with it, unless a column was chosen by hand.
  if (lastTf !== tf) {
    setLastTf(tf);
    if (sort.key.startsWith("rs:")) setSort({ key: `rs:${tf}`, desc: true });
  }

  const q = search.trim().toLowerCase();
  const shown = useMemo(() => {
    const kept = rows.filter((r) => {
      if (q && !r.coin.toLowerCase().includes(q)) return false;
      const f = r.flags[tf];
      if (filter === "candidates") return f.candidate;
      if (filter === "fast") return f.movingFast;
      if (filter === "weakest") return f.weakest;
      return true;
    });
    const value = (r: ScreenerRow): number | string | null => {
      if (sort.key === "coin") return r.coin;
      if (sort.key === "rvol") return r.tf[tf].rvol;
      if (sort.key === "funding") return r.fundingAnnual;
      if (sort.key === "oi") return r.oiChange;
      if (sort.key === "volume") return r.volume24h;
      return r.tf[sort.key.slice(3) as Timeframe].rs;
    };
    const sorted = kept.slice().sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      // Nulls last, whichever way the sort runs.
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const c = typeof va === "string" ? va.localeCompare(String(vb)) : (va as number) - (vb as number);
      return sort.desc ? -c : c;
    });
    // Candidates first when the whole table is shown in its default order: that is what the badge is for.
    // A column chosen by hand sorts plainly, so a click on a header does what it says.
    if (filter === "all" && sort.key === `rs:${tf}` && sort.desc) {
      const cands = sorted.filter((r) => r.flags[tf].candidate);
      const rest = sorted.filter((r) => !r.flags[tf].candidate);
      return [...cands, ...rest];
    }
    return sorted;
  }, [rows, tf, filter, sort, q]);

  const Head = ({ k, children, className = "", title }: { k: SortKey; children: React.ReactNode; className?: string; title?: string }) => {
    const on = sort.key === k;
    return (
      <th
        className={`cursor-pointer select-none whitespace-nowrap px-1.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider ${on ? "text-foreground" : "text-muted-foreground hover:text-foreground"} ${className}`}
        onClick={() => setSort({ key: k, desc: on ? !sort.desc : true })}
        title={title}
        data-testid={`screener-head-${k.replace(":", "-")}`}
        aria-sort={on ? (sort.desc ? "descending" : "ascending") : "none"}
      >
        <span className="inline-flex items-center gap-0.5">
          {children}
          {on && (sort.desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
        </span>
      </th>
    );
  };

  if (shown.length === 0) {
    return (
      <p className="px-2 py-6 text-center text-xs text-muted-foreground" data-testid="screener-empty">
        {q ? `No coin matching "${search.trim()}" in the table.` : "Nothing here on this timeframe with this filter."}
      </p>
    );
  }

  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[640px] border-separate border-spacing-0 text-xs" data-testid="screener-table">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 w-5 bg-card px-1" />
            <Head k="coin" className="sticky left-5 z-10 bg-card text-left">
              Coin
            </Head>
            {TIMEFRAMES.map((t) => (
              <Head key={t} k={`rs:${t}`} className={`text-right ${t === tf ? "text-foreground" : ""}`} title={`RS change vs BTC over the last ${t}`}>
                {t}
              </Head>
            ))}
            <Head k="rvol" className="text-right" title={`Relative volume on ${tf}: the last period over the mean of the previous 20`}>
              RVOL
            </Head>
            <Head k="funding" className="text-right" title="Current funding, annualized">
              Fund.
            </Head>
            <Head k="oi" className="text-right" title="Open interest against the previous run">
              OI Δ
            </Head>
            <Head k="volume" className="text-right hidden sm:table-cell" title="24h notional volume">
              Vol 24h
            </Head>
            <th className="px-1.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Flags</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const m = r.tf[tf];
            const f = r.flags[tf];
            const on = charted.has(r.coin);
            return (
              <tr
                key={r.coin}
                className={`cursor-pointer border-t border-border/40 transition-colors hover:bg-secondary/40 ${f.candidate ? "bg-emerald-500/5" : ""}`}
                onClick={() => onOpen(r.coin)}
                data-testid={`screener-row-${r.coin}`}
              >
                <td className={`sticky left-0 z-10 px-1 py-1 align-middle ${f.candidate ? "bg-[#0b1511]" : "bg-card"}`}>
                  <button
                    type="button"
                    className={`h-3 w-3 rounded-full border transition-colors ${on ? "border-sky-400 bg-sky-400" : "border-border hover:border-sky-400"}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleChart(r.coin);
                    }}
                    title={on ? "Take off the chart" : "Put on the chart"}
                    aria-pressed={on}
                    data-testid={`screener-chart-${r.coin}`}
                  />
                </td>
                <td className={`sticky left-5 z-10 whitespace-nowrap px-1.5 py-1 font-semibold ${f.candidate ? "bg-[#0b1511]" : "bg-card"}`}>
                  {r.coin}
                  {r.error && (
                    <span className="ml-1 inline-flex items-center gap-0.5 rounded border border-amber-500/50 px-1 text-[9px] font-medium uppercase text-amber-500" title={r.error} data-testid={`screener-error-${r.coin}`}>
                      <AlertTriangle className="h-2.5 w-2.5" /> err
                    </span>
                  )}
                </td>
                {TIMEFRAMES.map((t) => {
                  const x = r.tf[t];
                  return (
                    <td
                      key={t}
                      className={`whitespace-nowrap px-1.5 py-1 text-right font-mono ${t === tf ? "font-semibold" : ""}`}
                      style={{ background: heat(x.rs) }}
                      title={x.accel ? `Acceleration: ${ACCEL_ARROW[x.accel]} · ${x.breakout ? "new 20-period high" : "no breakout"}` : undefined}
                    >
                      {fmtPct(x.rs)}
                      {t === tf && x.accel && <span className="ml-0.5 text-[10px] text-foreground/70">{ACCEL_ARROW[x.accel]}</span>}
                      {t === tf && x.breakout && <span className="ml-0.5 text-[9px] text-sky-400" title="New 20-period RS high">▲</span>}
                    </td>
                  );
                })}
                <td className={`whitespace-nowrap px-1.5 py-1 text-right font-mono ${m.rvol != null && m.rvol >= rvolMin ? "text-emerald-400" : ""}`}>{fmtX(m.rvol)}</td>
                <td className={`whitespace-nowrap px-1.5 py-1 text-right font-mono ${r.fundingAnnual != null && r.fundingAnnual > 0.3 ? "text-amber-500" : ""}`}>{fmtPct(r.fundingAnnual, 0)}</td>
                <td className="whitespace-nowrap px-1.5 py-1 text-right font-mono">{fmtPct(r.oiChange)}</td>
                <td className="hidden whitespace-nowrap px-1.5 py-1 text-right font-mono sm:table-cell">{fmtUsd(r.volume24h)}</td>
                <td className="whitespace-nowrap px-1.5 py-1">
                  <span className="inline-flex flex-wrap gap-1">
                    {f.candidate && <Flag tone="emerald" testId={`screener-candidate-${r.coin}`}>Candidate</Flag>}
                    {f.movingFast && !f.candidate && <Flag tone="sky">Fast</Flag>}
                    {f.volumeConfirmed && <Flag tone="muted">Vol</Flag>}
                    {r.leverageDriven && <Flag tone="amber">Lev</Flag>}
                    {f.weakest && <Flag tone="red">Weak</Flag>}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Flag({ tone, children, testId }: { tone: "emerald" | "sky" | "amber" | "red" | "muted"; children: React.ReactNode; testId?: string }) {
  const cls = {
    emerald: "border-emerald-500/60 bg-emerald-500/15 text-emerald-400",
    sky: "border-sky-500/50 bg-sky-500/10 text-sky-400",
    amber: "border-amber-500/50 bg-amber-500/10 text-amber-500",
    red: "border-red-500/50 bg-red-500/10 text-red-400",
    muted: "border-border text-muted-foreground",
  }[tone];
  return (
    <span className={`rounded border px-1 py-px text-[9px] font-semibold uppercase tracking-wide ${cls}`} data-testid={testId}>
      {children}
    </span>
  );
}
