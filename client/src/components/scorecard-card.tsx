/**
 * The first thing you see: is the trading working?
 *
 * Four figures and a curve. Win rate never stands alone — it sits beside the
 * payoff that decides whether it means anything — and the curve is cumulative
 * R rather than dollars, so the shape reflects the decisions rather than the
 * size they were taken in.
 *
 * Every figure is a button, because a figure on a homepage is a conclusion and
 * the only honest thing to do with a conclusion is show the working: clicking
 * one lands on the card underneath it, on the right half of Stats, with the
 * card highlighted. The hints under each figure are the arithmetic that
 * produced it — "14 of 22", "$1,240 won ÷ $310 lost" — and nothing else, so
 * there is never a sentence here telling you how to feel about a number.
 *
 * The tone follows the record honestly. A rising curve is emerald and says so;
 * a falling one is not dressed up, because a journal that flatters you during
 * a drawdown is worse than no journal.
 */
import { useMemo } from "react";
import { useLocation } from "wouter";
import { Card } from "@/components/ui/card";
import { TrendingUp } from "lucide-react";
import type { TradeWithTags } from "@shared/schema";
import { scorecard, SCORE_MIN_SAMPLE } from "@shared/scorecard";
import { fmtAmount, fmtMoney, fmtR } from "@shared/metrics";
import { monotonePath } from "@shared/spark";
import { setJumpSection, type JumpSection } from "@/lib/jump";

/**
 * Cumulative-R sparkline. No axes: the shape is the whole message.
 *
 * Monotone-smoothed rather than polylined — see shared/spark.ts for why the
 * usual spline is the wrong one here — with the fill fading out downward so
 * the line stays the thing you read, and the last point marked because "where
 * am I now" is the question the curve is usually being asked.
 */
function Spark({ curve, up }: { curve: number[]; up: boolean }) {
  const W = 300;
  const H = 64;
  const geom = useMemo(() => {
    if (curve.length < 2) return null;
    const lo = Math.min(0, ...curve);
    const hi = Math.max(0, ...curve);
    const span = hi - lo || 1;
    // A little headroom top and bottom so the stroke is never clipped by the
    // viewBox at a new high, which is exactly when you want to see it.
    const pad = 3;
    // The right edge stops short of the viewBox so the "you are here" dot has
    // room to be a circle rather than a half-moon against the card border.
    const right = W - 6;
    const x = (i: number) => (i / (curve.length - 1)) * right;
    const y = (v: number) => pad + (1 - (v - lo) / span) * (H - pad * 2);
    const pts = curve.map((v, i) => ({ x: x(i), y: y(v) }));
    return {
      line: monotonePath(pts),
      zero: y(0),
      last: pts[pts.length - 1],
      right,
    };
  }, [curve]);

  if (!geom) return null;

  const stroke = up ? "stroke-emerald-400" : "stroke-primary";
  const gradId = up ? "spark-up" : "spark-down";

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-16 w-full overflow-visible"
      preserveAspectRatio="none"
      data-testid="score-spark"
      aria-hidden="true"
    >
      <defs>
        {/* objectBoundingBox units keep the fade tied to the plot, not the
            viewport, so it looks the same at every card width. */}
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop
            offset="0%"
            className={up ? "text-emerald-400" : "text-primary"}
            stopColor="currentColor"
            stopOpacity="0.28"
          />
          <stop
            offset="100%"
            className={up ? "text-emerald-400" : "text-primary"}
            stopColor="currentColor"
            stopOpacity="0"
          />
        </linearGradient>
      </defs>

      <path
        d={`${geom.line} L${geom.right},${geom.zero} L0,${geom.zero} Z`}
        fill={`url(#${gradId})`}
        stroke="none"
      />
      {/* Break-even, so a curve above it reads as "ahead" without a label. */}
      <line
        x1={0}
        x2={geom.right}
        y1={geom.zero}
        y2={geom.zero}
        className="stroke-border"
        strokeDasharray="3 4"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={geom.line}
        fill="none"
        className={stroke}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {/* Drawn in a nested svg so the dot stays round under the non-uniform
          scaling that preserveAspectRatio="none" applies to everything else. */}
      <svg
        x={geom.last.x}
        y={geom.last.y}
        overflow="visible"
        width="0"
        height="0"
        viewBox="0 0 1 1"
      >
        <circle r={5} className={up ? "fill-emerald-400/25" : "fill-primary/25"} />
        <circle r={2.5} className={up ? "fill-emerald-400" : "fill-primary"} />
      </svg>
    </svg>
  );
}

function Figure({
  label,
  value,
  hint,
  tone,
  testId,
  onClick,
  explains,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "good" | "bad";
  testId?: string;
  onClick?: () => void;
  /** Named in the aria-label, so the click target isn't just a number. */
  explains?: string;
}) {
  const body = (
    <>
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
    </>
  );

  if (!onClick) return <div className="min-w-0">{body}</div>;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label}: ${value}. Show ${explains ?? "where this comes from"}.`}
      data-testid={testId ? `${testId}-link` : undefined}
      className="group -mx-1.5 -my-1 min-w-0 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-secondary/50"
    >
      {body}
      <span className="mt-0.5 block h-px w-6 bg-transparent transition-colors group-hover:bg-primary/60" />
    </button>
  );
}

const ratio = (v: number) => (isFinite(v) ? v.toFixed(2) : "∞");

export function ScorecardCard({ trades }: { trades: TradeWithTags[] }) {
  const s = useMemo(() => scorecard(trades), [trades]);
  const [, navigate] = useLocation();

  if (s.count === 0) return null;

  const up = s.totalR >= 0;

  // Where each figure's working lives. The three R-based figures come out of
  // the same distribution; the dollar ones come out of the equity curve.
  const jump = (section: JumpSection) => () => {
    setJumpSection(section);
    navigate(section.half === "edge" ? "/analysis" : "/dashboard");
  };
  const toDistribution = jump({ half: "edge", anchor: "distribution" });
  const toEquity = jump({ half: "habits", anchor: "equity" });

  // One precision for both halves of the ratio, chosen by the larger.
  const pfDigits: 0 | 2 = Math.max(s.grossWin, s.grossLoss) >= 100 ? 0 : 2;

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
              hint={`${s.wins} of ${s.count}`}
              testId="score-winrate"
              onClick={toDistribution}
              explains="the distribution behind it"
            />
            <Figure
              label="Avg win : loss"
              value={`${ratio(s.payoff)}×`}
              hint={`break-even at ${ratio(s.winRate > 0 ? (1 - s.winRate) / s.winRate : 0)}×`}
              testId="score-payoff"
              onClick={toDistribution}
              explains="the distribution behind it"
            />
            <Figure
              label="Expectancy"
              value={fmtR(s.expectancyR)}
              hint="per trade, net of fees"
              tone={s.expectancyR >= 0 ? "good" : "bad"}
              testId="score-expectancy"
              onClick={toDistribution}
              explains="the distribution behind it"
            />
            <Figure
              label="Profit factor"
              value={ratio(s.profitFactor)}
              hint={`${fmtAmount(s.grossWin, pfDigits)} won ÷ ${fmtAmount(
                s.grossLoss,
                pfDigits,
              )} lost`}
              tone={s.profitFactor >= 1 ? "good" : "bad"}
              testId="score-profit-factor"
              onClick={toEquity}
              explains="the equity curve"
            />
          </div>
        </div>

        <div className="min-w-0">
          <button
            type="button"
            onClick={toEquity}
            className="group block w-full text-left"
            aria-label={`Cumulative R: ${fmtR(s.totalR)}. Show the equity curve.`}
            data-testid="score-total-r-link"
          >
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground transition-colors group-hover:text-foreground">
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
          </button>

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
          <p
            className="mt-1.5 text-[11px] leading-snug text-muted-foreground"
            data-testid="score-verdict"
          >
            {s.verdict}
          </p>
        </div>
      </div>
    </Card>
  );
}
