import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useMistakeTags, useTrades } from "@/lib/data";
import { useGuardRails } from "@/lib/prefs";
import { EDGE_SCORE_DAYS, edgeScore, type EdgePart } from "@shared/edge-score";

/** Red under 60, amber under 75, green from there: the same bands as the word beside the number. */
const tone = (score: number | null) => (score == null ? "text-muted-foreground" : score >= 75 ? "text-emerald-400" : score >= 60 ? "text-amber-400" : "text-red-400");
const fill = (score: number | null) => (score == null ? "bg-muted-foreground/30" : score >= 75 ? "bg-emerald-500" : score >= 60 ? "bg-amber-500" : "bg-red-500");
const ring = (score: number | null) => (score == null ? "hsl(var(--muted-foreground) / 0.4)" : score >= 75 ? "#10b981" : score >= 60 ? "#f59e0b" : "#ef4444");

function PartRow({ part, weakest, open, onToggle, symbols }: { part: EdgePart; weakest: boolean; open: boolean; onToggle: () => void; symbols: Map<number, string> }) {
  return (
    <div className={`rounded-md border ${weakest ? "border-red-500/40 bg-red-500/5" : "border-transparent"}`} data-testid={`edge-part-${part.id}`}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-2 py-1.5 text-left" aria-expanded={open}>
        <span className="w-24 shrink-0 text-[11px] font-medium">{part.label}</span>
        <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary/70">
          <span className={`block h-full rounded-full ${fill(part.score)}`} style={{ width: `${part.score ?? 0}%` }} />
        </span>
        <span className={`w-7 shrink-0 text-right font-mono text-[11px] font-semibold ${tone(part.score)}`}>{part.score ?? "–"}</span>
      </button>
      {open && (
        <div className="space-y-1.5 px-2 pb-2 text-[11px] leading-snug">
          <p className="text-muted-foreground">{part.asks}</p>
          <p>{part.detail}</p>
          {part.score != null && part.score < 90 && (
            <p className="rounded border border-border/60 bg-secondary/40 px-2 py-1.5">
              <span className="font-semibold">To raise it: </span>
              {part.tip}
            </p>
          )}
          {part.tradeIds.length > 0 && (
            <p className="flex flex-wrap items-center gap-1 text-muted-foreground">
              The trades:
              {part.tradeIds.slice(0, 6).map((id) => (
                <Link key={id} href={`/trade/${id}`} className="rounded border border-border/60 px-1 py-px font-mono text-[10px] text-foreground hover:bg-secondary">
                  {symbols.get(id) ?? `#${id}`}
                </Link>
              ))}
              {part.tradeIds.length > 6 && <span>and {part.tradeIds.length - 6} more</span>}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The header's score: how well the trading was done, and under it what is
 * holding the number down. Always on screen, so the one habit to fix is in
 * view on every page.
 */
export function EdgeScoreChip() {
  const { data: trades } = useTrades();
  const { data: tags } = useMistakeTags();
  const rails = useGuardRails();
  const [days, setDays] = useState<number>(EDGE_SCORE_DAYS[0]);
  const [openPart, setOpenPart] = useState<string | null>(null);
  const s = useMemo(() => edgeScore(trades ?? [], { days, rails, tags: tags ?? [] }), [trades, days, rails, tags]);
  const symbols = useMemo(() => new Map((trades ?? []).map((t) => [t.id, t.symbol] as const)), [trades]);
  if (!trades) return null;

  const shown = openPart ?? s.weakest?.id ?? null;
  const delta = s.score != null && s.previous != null ? s.score - s.previous : null;
  const deg = Math.round(((s.score ?? 0) / 100) * 360);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-8 items-center gap-1.5 rounded-full border border-border/70 bg-secondary/40 pl-0.5 pr-0.5 transition-colors hover:bg-secondary sm:pr-2.5"
          title={s.score == null ? s.headline : `Edge score ${s.score}/100${s.weakest ? `, biggest leak: ${s.weakest.label}` : ""}`}
          data-testid="chip-edge-score"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full" style={{ background: `conic-gradient(${ring(s.score)} ${deg}deg, hsl(var(--secondary)) ${deg}deg)` }}>
            <span className={`flex h-[22px] w-[22px] items-center justify-center rounded-full bg-background font-mono text-[10px] font-bold ${tone(s.score)}`}>{s.score ?? "–"}</span>
          </span>
          {s.weakest && s.weakest.score! < 90 && (
            <span className="hidden max-w-28 truncate text-[10px] font-medium text-muted-foreground sm:inline" data-testid="chip-edge-leak">
              Fix: <span className="text-foreground">{s.weakest.label}</span>
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[80vh] w-[min(92vw,24rem)] overflow-y-auto p-3" data-testid="panel-edge-score">
        <div className="flex items-start gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Edge score</p>
            <p className="flex items-baseline gap-1.5">
              <span className={`font-mono text-3xl font-bold leading-none ${tone(s.score)}`} data-testid="text-edge-score">
                {s.score ?? "–"}
              </span>
              <span className="text-[11px] text-muted-foreground">/ 100 · {s.grade}</span>
            </p>
            {delta != null && (
              <p className={`mt-1 flex items-center gap-0.5 text-[10px] ${delta > 0 ? "text-emerald-400" : delta < 0 ? "text-red-400" : "text-muted-foreground"}`} data-testid="text-edge-delta">
                {delta > 0 ? <ArrowUp className="h-3 w-3" /> : delta < 0 ? <ArrowDown className="h-3 w-3" /> : null}
                {delta === 0 ? "Unchanged" : `${Math.abs(delta)} ${delta > 0 ? "up" : "down"}`} on the {days} days before
              </p>
            )}
          </div>
          <div className="ml-auto flex rounded-md border border-border/70 p-0.5">
            {EDGE_SCORE_DAYS.map((d) => (
              <button key={d} type="button" onClick={() => setDays(d)} aria-pressed={days === d} className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${days === d ? "bg-secondary text-foreground" : "text-muted-foreground"}`} data-testid={`edge-days-${d}`}>
                {d}d
              </button>
            ))}
          </div>
        </div>

        <p className="mt-2 text-[11px] leading-snug" data-testid="text-edge-headline">
          {s.headline}
        </p>

        <div className="mt-2 space-y-0.5">
          {s.parts.map((p) => (
            <PartRow key={p.id} part={p} weakest={s.weakest?.id === p.id && p.score! < 90} open={shown === p.id} onToggle={() => setOpenPart(shown === p.id ? "" : p.id)} symbols={symbols} />
          ))}
        </div>

        <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
          Scored on how you traded over the last {days} days ({s.trades} trades), not on what it made. Each habit is 0 to 100; sizing counts most. A dash means too few trades to judge it.
        </p>
      </PopoverContent>
    </Popover>
  );
}
