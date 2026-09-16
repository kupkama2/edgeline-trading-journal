import { Card } from "@/components/ui/card";
import { Skull } from "lucide-react";
import { fmtMoney } from "@shared/metrics";
import { tiltByHour, tiltBySource, tiltCost, type BookTotals } from "@shared/tilt";
import type { TradeWithTags } from "@shared/schema";

/**
 * What tilt cost, next to what the plan made.
 *
 * The plan book is what every other card on this page is about. This one
 * is the other book: the trades that should not have been taken, added up
 * on their own, with when they happen and whose idea they were — because
 * "I overtraded yesterday" is a feeling and "tilt cost $1,240 this month,
 * mostly after 14:00, mostly on calls I did not originate" is a rule you
 * can write down.
 *
 * Give it every trade, both books — it does the split itself.
 */
export function TiltCostCard({ trades }: { trades: TradeWithTags[] }) {
  const cost = tiltCost(trades);
  const hours = tiltByHour(trades).sort((a, b) => a.pnl - b.pnl).slice(0, 3);
  const sources = tiltBySource(trades);
  const any = cost.tilt.count > 0 || trades.some((t) => t.tilt);

  return (
    <Card className="border-card-border bg-card p-4" data-testid="card-tilt-cost">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
          <Skull className={`h-4 w-4 ${any ? "text-primary" : "text-muted-foreground"}`} />
          Cost of tilt
        </h2>
        {any ? (
          <p className="text-[11px] text-muted-foreground" data-testid="text-tilt-cost-sentence">
            Tilt {cost.tilt.pnl < 0 ? "cost" : "made"}{" "}
            <Money v={cost.tilt.pnl} /> across {cost.tilt.count}{" "}
            {cost.tilt.count === 1 ? "trade" : "trades"}. The plan alone is{" "}
            <Money v={cost.plan.pnl} /> on {cost.plan.count}.
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground" data-testid="text-tilt-cost-sentence">
            No tilt trades. The plan is the whole book.
          </p>
        )}
      </div>

      {any && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <BookColumn title="Plan" totals={cost.plan} tone="plan" />
          <BookColumn title="Tilt" totals={cost.tilt} tone="tilt" />
        </div>
      )}

      {any && (hours.length > 0 || sources.length > 0) && (
        <div className="mt-3 grid gap-3 border-t border-border/60 pt-3 text-[11px] sm:grid-cols-2">
          {hours.length > 0 && (
            <div data-testid="tilt-by-hour">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">When it happens</p>
              <ul className="mt-1 space-y-0.5">
                {hours.map((h) => (
                  <li key={h.hour} className="flex justify-between font-mono">
                    <span>
                      {String(h.hour).padStart(2, "0")}:00 · {h.count} {h.count === 1 ? "trade" : "trades"}
                    </span>
                    <Money v={h.pnl} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {sources.length > 0 && (
            <div data-testid="tilt-by-source">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Whose idea</p>
              <ul className="mt-1 space-y-0.5">
                {sources.map((s) => (
                  <li key={s.source || "__own__"} className="flex justify-between font-mono">
                    <span>
                      {s.source || "my own"} · {s.count} {s.count === 1 ? "trade" : "trades"}
                    </span>
                    <Money v={s.pnl} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function BookColumn({ title, totals, tone }: { title: string; totals: BookTotals; tone: "plan" | "tilt" }) {
  const winRate = totals.count ? Math.round((100 * totals.wins) / totals.count) : null;
  return (
    <div
      className={`rounded-md border px-3 py-2 ${
        tone === "tilt" ? "border-primary/30 bg-primary/5" : "border-border/60 bg-secondary/20"
      }`}
      data-testid={`tilt-book-${tone}`}
    >
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{title}</p>
      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px]">
        <span className="text-muted-foreground">trades</span>
        <span>{totals.count}</span>
        <span className="text-muted-foreground">net</span>
        <Money v={totals.pnl} />
        <span className="text-muted-foreground">R</span>
        <span>
          {totals.measured ? `${totals.r > 0 ? "+" : ""}${totals.r.toFixed(2)}R` : "—"}
          {totals.measured < totals.count && totals.count > 0 && (
            <span className="text-muted-foreground"> · {totals.count - totals.measured} unmeasured</span>
          )}
        </span>
        <span className="text-muted-foreground">win rate</span>
        <span>{winRate == null ? "—" : `${winRate}%`}</span>
      </div>
    </div>
  );
}

function Money({ v }: { v: number }) {
  return (
    <span className={`font-mono ${v > 0 ? "text-emerald-400" : v < 0 ? "text-primary" : ""}`}>
      {fmtMoney(v)}
    </span>
  );
}
