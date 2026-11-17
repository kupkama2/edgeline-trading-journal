import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Card } from "@/components/ui/card";
import type { DailyBias } from "@shared/bias";

interface BiasMarket {
  coin: string;
  label: string;
  group: "Crypto" | "TradFi" | "Metals";
  bias: DailyBias | null;
  error: string | null;
}

const SIDE = {
  bullish: { word: "Bullish", cls: "border-emerald-500/50 bg-emerald-500/10 text-emerald-400", Icon: ArrowUpRight },
  bearish: { word: "Bearish", cls: "border-red-500/50 bg-red-500/10 text-red-400", Icon: ArrowDownRight },
  neutral: { word: "No bias", cls: "border-border bg-secondary/40 text-muted-foreground", Icon: Minus },
} as const;

const px = (n: number) => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n >= 10 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n.toLocaleString(undefined, { maximumSignificantDigits: 4 }));
const pct = (n: number | null) => (n == null ? "" : `${n >= 0 ? "+" : "−"}${Math.abs(n * 100).toFixed(2)}%`);

function Tile({ m }: { m: BiasMarket }) {
  const b = m.bias;
  if (!b)
    return (
      <div className="rounded-md border border-border/70 p-2.5" data-testid={`bias-${m.coin}`}>
        <p className="text-xs font-semibold">{m.label}</p>
        <p className="mt-1 text-[11px] text-muted-foreground">{m.error ?? "No reading"}</p>
      </div>
    );
  const s = SIDE[b.side];
  return (
    <div className="rounded-md border border-border/70 p-2.5" data-testid={`bias-${m.coin}`} data-side={b.side}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold">
          {m.label} <span className="font-mono text-[10px] font-normal text-muted-foreground">{px(b.levels.price)}</span>{" "}
          <span className={`font-mono text-[10px] font-normal ${b.levels.change == null ? "" : b.levels.change >= 0 ? "text-emerald-400" : "text-red-400"}`}>{pct(b.levels.change)}</span>
        </p>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${s.cls}`}>
          <s.Icon className="h-3 w-3" />
          {s.word}
        </span>
      </div>
      {/* The five votes, each a mark: for, against, or neither. */}
      <div className="mt-1.5 flex items-center gap-1" title={`Score ${b.score > 0 ? "+" : ""}${b.score} of 5`}>
        {b.votes.map((v) => (
          <span key={v.id} className={`h-1.5 flex-1 rounded-full ${v.vote > 0 ? "bg-emerald-500" : v.vote < 0 ? "bg-red-500" : "bg-secondary"}`} title={v.text} />
        ))}
      </div>
      <ul className="mt-1.5 space-y-0.5 text-[11px] leading-snug">
        {b.votes
          .filter((v) => v.vote !== 0)
          .map((v) => (
            <li key={v.id} className="flex gap-1.5">
              <span className={v.vote > 0 ? "text-emerald-400" : "text-red-400"}>{v.vote > 0 ? "+" : "−"}</span>
              <span className="text-foreground/90">{v.text}</span>
            </li>
          ))}
        {b.votes.every((v) => v.vote === 0) && <li className="text-muted-foreground">Nothing leans either way.</li>}
      </ul>
      <p className={`mt-1.5 text-[11px] ${b.today.agrees == null ? "text-muted-foreground" : b.today.agrees ? "text-foreground" : "text-amber-500"}`}>
        {b.today.text}
        {b.today.agrees === false ? ": against the bias so far" : ""}
      </p>
      <p className="mt-1 font-mono text-[10px] text-muted-foreground">
        PDH {px(b.levels.prevHigh)} · PDL {px(b.levels.prevLow)}
        {b.levels.weekOpen != null ? ` · week open ${px(b.levels.weekOpen)}` : ""}
      </p>
    </div>
  );
}

/**
 * The day's bias for the markets the session is traded around: which way
 * the daily candles lean for BTC and ETH, the stock indices and the
 * metals, what each lean rests on, and what price has done with it today.
 */
export function BiasBoard() {
  const q = useQuery<{ at: string; markets: BiasMarket[] }>({ queryKey: ["/api/screener/bias"], staleTime: 5 * 60_000, refetchInterval: 10 * 60_000 });
  if (q.isLoading) return <p className="py-3 text-center text-xs text-muted-foreground">Reading the daily candles…</p>;
  if (!q.data) return <p className="text-xs text-amber-500">The bias could not be read just now.</p>;
  const groups = ["Crypto", "TradFi", "Metals"] as const;
  return (
    <Card className="border-card-border bg-card p-3 sm:p-4" data-testid="bias-board">
      <div className="space-y-3">
        {groups.map((g) => {
          const ms = q.data!.markets.filter((m) => m.group === g);
          if (!ms.length) return null;
          return (
            <div key={g}>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{g}</p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {ms.map((m) => (
                  <Tile key={m.coin} m={m} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[10px] leading-snug text-muted-foreground">
        Read from daily candles (UTC days) by five checks: the trend of the 20- and 50-day averages, how yesterday closed against the day before, where it closed in its range, three days of structure, and the week's open. Two or more the same way is a bias; fewer is none. It is a lean to test setups against, not a signal.
      </p>
    </Card>
  );
}
