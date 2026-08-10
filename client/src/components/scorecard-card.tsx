/**
 * The first thing you see: is the trading working?
 *
 * Four figures and a curve. Win rate never stands alone — it sits beside the
 * payoff that decides whether it means anything — and the curve is cumulative
 * R rather than dollars, so the shape reflects the decisions rather than the
 * size they were taken in.
 *
 * The tone follows the record honestly. A rising curve is emerald and says so;
 * a falling one is not dressed up, because a journal that flatters you during
 * a drawdown is worse than no journal.
 */
import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { TrendingUp } from "lucide-react";
import type { TradeWithTags } from "@shared/schema";
import { scorecard, SCORE_MIN_SAMPLE } from "@shared/scorecard";
import { fmtMoney, fmtR } from "@shared/metrics";

/** Cumulative-R sparkline. No axes: the shape is the whole message. */
function Spark({ curve, up }: { curve: number[]; up: boolean }) {
  if (curve.length < 2) return null;
  const W = 300;
  const H = 56;
  const lo = Math.min(0, ...curve);
  const hi = Math.max(0, ...curve);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (curve.length - 1)) * W;
  const y = (v: number) => H - ((v - lo) / span) * H;
  const line = curve.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${W},${y(lo)} L0,${y(lo)} Z`;
  const stroke = up ? "stroke-emerald-400" : "stroke-primary";
  const fill = up ? "fill-emerald-400/10" : "fill-primary/10";
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-14 w-full"
      preserveAspectRatio="none"
      data-testid="score-spark"
    >
      <path d={area} className={fill} stroke="none" />
      <path
        d={line}
        fill="none"
        className={stroke}
        strokeWidth={2}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {/* Break-even, so a curve above it reads as "ahead" without a label. */}
      <line
        x1={0}
        x2={W}
        y1={y(0)}
        y2={y(0)}
        className="stroke-border"
        strokeDasharray="3 4"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Figure({
  label,
  value,
  hint,
  tone,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "good" | "bad";
  testId?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p
        className={`font-mono text-lg font-bold leading-tight ${
          tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-primary" : ""
        }`}
        data-testid={testId}
      >
        {value}
      </p>
      {hint && <p className="truncate text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

const ratio = (v: number) => (isFinite(v) ? v.toFixed(2) : "∞");

export function ScorecardCard({ trades }: { trades: TradeWithTags[] }) {
  const s = useMemo(() => scorecard(trades), [trades]);
  if (s.count === 0) return null;

  const up = s.totalR >= 0;

  return (
    <Card className="border-card-border bg-card p-4 sm:p-5" data-testid="card-scorecard">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div>
          <div className="mb-3 flex items-baseline gap-2">
            <TrendingUp className={`h-4 w-4 ${up ? "text-emerald-400" : "text-primary"}`} />
            <h2 className="text-sm font-semibold tracking-tight">How it's going</h2>
            <span className="ml-auto font-mono text-[11px] text-muted-foreground">
              {s.count} closed
            </span>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-2">
            <Figure
              label="Win rate"
              value={`${Math.round(s.winRate * 100)}%`}
              hint={`payoff ${ratio(s.payoff)}× — the half that decides`}
              testId="score-winrate"
            />
            <Figure
              label="Avg win : loss"
              value={`${ratio(s.payoff)}×`}
              hint={`needs > ${ratio(s.winRate > 0 ? (1 - s.winRate) / s.winRate : 0)}× to break even`}
              testId="score-payoff"
            />
            <Figure
              label="Expectancy"
              value={fmtR(s.expectancyR)}
              hint="per trade, net of fees"
              tone={s.expectancyR >= 0 ? "good" : "bad"}
              testId="score-expectancy"
            />
            <Figure
              label="Profit factor"
              value={ratio(s.profitFactor)}
              hint={`SQN ${s.sqn.toFixed(1)}`}
              tone={s.profitFactor >= 1 ? "good" : "bad"}
              testId="score-profit-factor"
            />
          </div>
        </div>

        <div className="min-w-0">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Cumulative R
            </span>
            <span
              className={`font-mono text-sm font-bold ${up ? "text-emerald-400" : "text-primary"}`}
              data-testid="score-total-r"
            >
              {fmtR(s.totalR)}{" "}
              <span className="text-[11px] font-normal text-muted-foreground">
                {fmtMoney(s.totalPnL)}
              </span>
            </span>
          </div>
          <Spark curve={s.curve} up={up} />

          {/* The grade, and — more usefully — which quarter of it is weakest. */}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono text-xs" data-testid="score-total">
              {s.score != null ? (
                <>
                  <span
                    className={
                      s.score >= 75
                        ? "text-emerald-400"
                        : s.score >= 50
                          ? "text-foreground"
                          : "text-primary"
                    }
                  >
                    {s.score}
                  </span>
                  <span className="text-muted-foreground">/100</span>
                </>
              ) : (
                <span className="text-muted-foreground">
                  score at {SCORE_MIN_SAMPLE} trades
                </span>
              )}
            </span>
            {s.parts.map((p) => (
              <span
                key={p.label}
                className="flex items-center gap-1 text-[10px] text-muted-foreground"
                title={p.hint}
                data-testid={`score-part-${p.label}`}
              >
                {p.label}
                <span className="inline-block h-1 w-8 overflow-hidden rounded-full bg-secondary">
                  <span
                    className={`block h-full ${
                      p.points >= p.max * 0.75
                        ? "bg-emerald-400"
                        : p.points >= p.max * 0.4
                          ? "bg-amber-400"
                          : "bg-primary"
                    }`}
                    style={{ width: `${(p.points / p.max) * 100}%` }}
                  />
                </span>
              </span>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground" data-testid="score-verdict">
            {s.verdict}
          </p>
        </div>
      </div>
    </Card>
  );
}
