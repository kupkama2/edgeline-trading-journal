import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Crosshair } from "lucide-react";
import { fixedTargetReport, MIN_DECIDED, type Rung } from "@shared/fixed-target";
import { fmtMoney, fmtR } from "@shared/metrics";
import type { TradeWithTags } from "@shared/schema";

/**
 * Is there a take-profit that suits how you trade?
 *
 * Every closed trade replayed with the original stop and a strict target at
 * each rung — 0.5R to 5R — scored on which level the price reached first.
 * See shared/fixed-target.ts for how the order is read off the stored path,
 * and why some trades are counted as undecided rather than guessed.
 */
const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);

function Bar({ value, scale }: { value: number | null; scale: number }) {
  if (value == null) return null;
  const w = Math.min(100, (Math.abs(value) / scale) * 100);
  return (
    <div className="relative h-1.5 w-full rounded bg-muted/40">
      <div
        className={`absolute top-0 h-1.5 rounded ${value >= 0 ? "left-1/2 bg-emerald-500/70" : "right-1/2 bg-red-500/70"}`}
        style={{ width: `${w / 2}%` }}
      />
    </div>
  );
}

export function FixedTargetCard({ trades }: { trades: TradeWithTags[] }) {
  const rep = useMemo(() => fixedTargetReport(trades), [trades]);
  const scale = Math.max(0.25, ...rep.rungs.map((r) => Math.abs(r.expectancy ?? 0)), Math.abs(rep.actual.expectancy ?? 0));

  const sentence = (() => {
    if (!rep.sample) return null;
    const b = rep.best;
    if (!b)
      return `Not enough decided trades to name a best target yet — a rung needs ${MIN_DECIDED} trades it can score, and most of the sample.`;
    const same = b.decided === rep.sample ? `these ${b.decided} trades` : `the ${b.decided} trades it decides`;
    return `Best: a strict ${b.n}R target. It would have made ${fmtR(b.totalR, 1)} (${fmtMoney(b.totalDollars)}) on ${same}, ${fmtR(b.expectancy, 2)} a trade — against ${fmtR(b.actualR, 1)} (${fmtMoney(b.actualDollars)}) you actually made on the same ones.`;
  })();

  const undecided = (r: Rung) => r.open + r.ambiguous;

  return (
    <Card className="border-card-border bg-card p-4" data-testid="card-fixed-target">
      <div className="mb-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <Crosshair className="h-4 w-4 text-muted-foreground" />
          If every trade had one fixed target
        </h2>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          Each closed trade replayed with its original stop and a take-profit at 0.5R, 1R, 1.5R… scored on which the
          price reached first, after fees. Your own exit plays no part. Where the record cannot say which came first,
          the trade is left undecided and the total becomes a range.
        </p>
      </div>

      {rep.sample === 0 ? (
        <p className="py-6 text-center text-[11px] text-muted-foreground" data-testid="fixed-target-empty">
          No closed trades with a stop and a measured price path yet. The path is read from the price feed once a
          trade closes.
        </p>
      ) : (
        <>
          {sentence && (
            <p className="mb-3 text-[12px] leading-snug" data-testid="text-fixed-target-sentence">
              {sentence}
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-[11px]">
              <thead className="text-left text-[10px] text-muted-foreground">
                <tr>
                  <th className="py-1 pr-2 font-normal">Target</th>
                  <th className="py-1 pr-2 font-normal">Hit / stopped</th>
                  <th className="py-1 pr-2 font-normal" title="The win rate this target needs to break even, before fees">
                    Win rate (needs)
                  </th>
                  <th className="py-1 pr-2 text-right font-normal">Total</th>
                  <th className="py-1 pr-2 text-right font-normal">$</th>
                  <th className="w-28 py-1 pr-2 font-normal">Per trade</th>
                  <th className="py-1 text-right font-normal">Undecided</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                <tr className="border-t border-border text-muted-foreground" data-testid="row-fixed-actual">
                  <td className="py-1.5 pr-2 font-sans">As traded</td>
                  <td className="py-1.5 pr-2">{rep.sample} trades</td>
                  <td className="py-1.5 pr-2" />
                  <td className="py-1.5 pr-2 text-right">{fmtR(rep.actual.totalR, 1)}</td>
                  <td className="py-1.5 pr-2 text-right">{fmtMoney(rep.actual.totalDollars)}</td>
                  <td className="py-1.5 pr-2">
                    <div className="flex items-center gap-2">
                      <span className="w-12">{fmtR(rep.actual.expectancy, 2)}</span>
                      <Bar value={rep.actual.expectancy} scale={scale} />
                    </div>
                  </td>
                  <td className="py-1.5 text-right" />
                </tr>
                {rep.rungs.map((r) => {
                  const best = rep.best?.n === r.n;
                  const short = r.winRate != null && r.winRate < r.breakEvenWinRate;
                  return (
                    <tr
                      key={r.n}
                      className={`border-t border-border ${best ? "bg-primary/10" : ""}`}
                      data-testid={`row-fixed-${r.n}`}
                    >
                      <td className="py-1.5 pr-2 font-semibold">
                        {r.n}R{best && <span className="ml-1 font-sans text-[10px] font-normal text-primary">best</span>}
                      </td>
                      <td className="py-1.5 pr-2">
                        {r.wins} / {r.losses}
                      </td>
                      <td className={`py-1.5 pr-2 ${short ? "text-red-400" : ""}`}>
                        {pct(r.winRate)} <span className="text-muted-foreground">({pct(r.breakEvenWinRate)})</span>
                        {/* A rate over the decided trades only: "100%" of four,
                            with ten undecided, must say it is four. */}
                        {undecided(r) > 0 && (
                          <span className="ml-1 font-sans text-[10px] text-muted-foreground">of {r.decided}</span>
                        )}
                      </td>
                      <td className={`py-1.5 pr-2 text-right ${r.totalR >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {fmtR(r.totalR, 1)}
                      </td>
                      <td className="py-1.5 pr-2 text-right">{fmtMoney(r.totalDollars)}</td>
                      <td className="py-1.5 pr-2">
                        <div className="flex items-center gap-2">
                          <span className="w-12">{fmtR(r.expectancy, 2)}</span>
                          <Bar value={r.expectancy} scale={scale} />
                        </div>
                      </td>
                      <td
                        className="py-1.5 text-right text-muted-foreground"
                        title={
                          undecided(r)
                            ? `${r.open} reached neither level in the window, ${r.ambiguous} touched the stop and carried on. If all of them lost: ${fmtR(r.lowR, 1)}; if all paid: ${fmtR(r.highR, 1)}.`
                            : undefined
                        }
                      >
                        {undecided(r) ? `${undecided(r)} · ${fmtR(r.lowR, 1)} to ${fmtR(r.highR, 1)}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rep.excluded > 0 && (
            <p className="mt-2 text-[10px] text-muted-foreground">
              {rep.excluded} closed {rep.excluded === 1 ? "trade" : "trades"} left out — no stop, no price path yet, or
              a scalp.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
