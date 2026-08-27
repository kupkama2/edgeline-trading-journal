import { useMemo } from "react";
import { useLocation } from "wouter";
import { Card } from "@/components/ui/card";
import { Scale3d } from "lucide-react";
import {
  gapInSigmas,
  sizingReport,
  sizingSentence,
  type SizeBucket,
} from "@shared/sizing-edge";
import { fmtAmount, fmtMoney, fmtR } from "@shared/metrics";
import type { TradeWithTags } from "@shared/schema";

/**
 * Does the size you bet change how well you trade?
 *
 * The question everyone asks is "do I lose money on my small ones?", and the
 * obvious way to answer it — bucket by dollars risked, compare the P&L — is
 * arithmetic wearing a finding's clothes. Of course the big bets moved more
 * money; that is what big means.
 *
 * So every row carries both units, and the gap between them is the subject:
 *
 *   R differs across the rows  → you TRADE differently at different sizes.
 *                                A habit, and fixable.
 *   R is flat, dollars differ  → you BET different amounts. Arithmetic, and
 *                                there is nothing here to fix.
 *
 * The band on each expectancy is not decoration. Ten trades with the ordinary
 * amount of scatter put roughly ±0.9R of uncertainty on their own mean, which
 * is wider than most gaps anyone gets excited about — so a card that showed
 * "+0.8R against +0.2R" without it would be inviting a conclusion the sample
 * cannot support.
 */
export function SizeCard({ trades }: { trades: TradeWithTags[] }) {
  const [, navigate] = useLocation();
  const rep = useMemo(() => sizingReport(trades), [trades]);
  const sentence = sizingSentence(rep);

  const scale = Math.max(
    ...rep.buckets.map((b) => Math.abs(b.expectancy.mean) + (b.expectancy.se ?? 0)),
    0.5,
  );

  return (
    <Card className="border-card-border bg-card p-4" data-testid="card-size">
      <div className="mb-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <Scale3d className="h-4 w-4 text-muted-foreground" />
          Does the size change how you trade?
        </h2>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          Your closed trades split into quarters by what one R cost in dollars. R has the size
          divided out, so it is the only column where the rows are comparable — dollars differing
          across them is what "different size" means, not a finding.
        </p>
      </div>

      {/* flatRisk as well as no buckets: four identical rows is not a
          comparison, and printing one invites a reading of noise. */}
      {rep.buckets.length === 0 || rep.flatRisk ? (
        <p className="text-[11px] leading-snug text-muted-foreground" data-testid="size-empty">
          {sentence ??
            "Nothing to split yet. This needs closed trades with a stop, so there is a 1R to measure the size in."}
        </p>
      ) : (
        <>
          {sentence && (
            <p className="mb-3 text-[11px] leading-snug text-foreground/90" data-testid="size-sentence">
              {sentence}
            </p>
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-[11px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="pb-1 text-left font-normal">Size band</th>
                  <th className="pb-1 text-right font-normal">Trades</th>
                  <th className="pb-1 text-right font-normal">Won</th>
                  <th className="pb-1 text-right font-normal">Per trade, in R</th>
                  <th className="pb-1 text-right font-normal">Per trade, in $</th>
                  <th className="pb-1 text-right font-normal">Total $</th>
                </tr>
              </thead>
              <tbody>
                {rep.buckets.map((b) => (
                  <Row key={b.index} b={b} scale={scale} onOpen={(id) => navigate(`/trade/${id}`)} />
                ))}
              </tbody>
            </table>
          </div>

          {/* The two readings that matter, and neither is the table. */}
          <div className="mt-3 grid gap-2.5 border-t border-border/60 pt-3 sm:grid-cols-2">
            <Verdict rep={rep} />
            <FlatSized rep={rep} onOpen={(id) => navigate(`/trade/${id}`)} />
          </div>

          <Confounds rep={rep} />
        </>
      )}
    </Card>
  );
}

function Row({
  b,
  scale,
  onOpen,
}: {
  b: SizeBucket;
  scale: number;
  onOpen: (id: number) => void;
}) {
  const good = b.expectancy.mean >= 0;
  return (
    <tr className="border-t border-border/40" data-testid={`size-bucket-${b.index}`}>
      <td className="py-1.5 pr-2">
        <button
          type="button"
          onClick={() => onOpen(b.tradeIds[0])}
          className="text-left hover:underline"
          data-testid={`size-bucket-${b.index}-open`}
        >
          <span className="font-medium">{b.label}</span>
          {/* A band whose ends are the same size is one size, not a range —
              "$200–$200" reads as a rendering bug rather than as a quarter of
              trades that all risked the same. Whole dollars, because the cents
              on a bucket label are noise. */}
          <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
            {Math.round(b.riskLo) === Math.round(b.riskHi)
              ? fmtAmount(b.riskLo, 0)
              : `${fmtAmount(b.riskLo, 0)}–${fmtAmount(b.riskHi, 0)}`}
          </span>
        </button>
        {/* The mean with its own noise drawn around it. Two bars whose
            whiskers overlap are two numbers this sample cannot separate,
            which is a thing you can see faster than you can read. */}
        <ErrorBar b={b} scale={scale} />
      </td>
      <td className="py-1.5 text-right font-mono tabular-nums">{b.trades}</td>
      <td className="py-1.5 text-right font-mono tabular-nums">{Math.round(b.winRate * 100)}%</td>
      <td
        className={`py-1.5 text-right font-mono tabular-nums font-semibold ${
          good ? "text-emerald-400" : "text-primary"
        }`}
        data-testid={`size-bucket-${b.index}-r`}
      >
        {fmtR(b.expectancy.mean)}
        {b.expectancy.se != null && (
          <span className="ml-1 font-normal text-[10px] text-muted-foreground">
            ±{b.expectancy.se.toFixed(2)}
          </span>
        )}
      </td>
      <td className="py-1.5 text-right font-mono tabular-nums" data-testid={`size-bucket-${b.index}-pnl`}>
        {fmtMoney(b.expectancyPnL.mean)}
      </td>
      <td
        className={`py-1.5 text-right font-mono tabular-nums ${
          b.totalPnL >= 0 ? "text-emerald-400/80" : "text-primary/80"
        }`}
      >
        {fmtMoney(b.totalPnL)}
      </td>
    </tr>
  );
}

/** Mean ± one standard error, on a shared axis with zero in the middle. */
function ErrorBar({ b, scale }: { b: SizeBucket; scale: number }) {
  const pct = (v: number) => 50 + (v / scale) * 50;
  const lo = Math.max(0, pct(b.expectancy.mean - (b.expectancy.se ?? 0)));
  const hi = Math.min(100, pct(b.expectancy.mean + (b.expectancy.se ?? 0)));
  const good = b.expectancy.mean >= 0;
  return (
    <div className="relative mt-1 h-1.5 w-full max-w-[13rem] rounded-full bg-secondary/50">
      <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
      <div
        className={`absolute inset-y-0 rounded-full ${good ? "bg-emerald-500/50" : "bg-primary/50"}`}
        style={{ left: `${Math.min(lo, hi)}%`, width: `${Math.max(1.5, Math.abs(hi - lo))}%` }}
      />
      <div
        className={`absolute inset-y-[-2px] w-px ${good ? "bg-emerald-400" : "bg-primary"}`}
        style={{ left: `${Math.max(0, Math.min(100, pct(b.expectancy.mean)))}%` }}
      />
    </div>
  );
}

/**
 * Whether the table says anything at all.
 *
 * Written to refuse far more often than it concludes. The two end buckets are
 * compared in R — the only comparison with the size divided out — and the gap
 * is only called a gap once it clears the noise on both means.
 */
function Verdict({ rep }: { rep: ReturnType<typeof sizingReport> }) {
  const small = rep.buckets[0];
  const large = rep.buckets[rep.buckets.length - 1];
  const sig = gapInSigmas(large.expectancy, small.expectancy);
  const real = sig != null && Math.abs(sig) >= 2;

  return (
    <div className="rounded-lg border border-border/60 bg-secondary/20 px-3 py-2" data-testid="size-verdict">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Is it a habit, or just the bet size?
      </p>
      <p className="mt-1 text-[11px] leading-snug">
        {real ? (
          <>
            <span className="font-semibold text-amber-400">A habit.</span> Largest against smallest
            is {fmtR(large.expectancy.mean - small.expectancy.mean)} a trade, which is{" "}
            {Math.abs(sig!).toFixed(1)}× the noise on it. Size is changing how you trade, not just
            how much each trade pays.
          </>
        ) : (
          <>
            <span className="font-semibold">Not shown.</span>{" "}
            {sig == null
              ? "There is not enough scatter inside these buckets to measure a gap against."
              : `The end-to-end gap is only ${Math.abs(sig).toFixed(1)}× its own noise — under 2 is a sample that cannot tell.`}{" "}
            Dollars differing across the rows is what different size means.
          </>
        )}
      </p>
      {rep.rho != null && rep.rhoNoise != null && (
        <p className="mt-1 text-[10px] leading-snug text-muted-foreground" data-testid="size-rho">
          Rank correlation between what a trade risked and what it returned: {rep.rho.toFixed(2)}.
          {Math.abs(rep.rho) < rep.rhoNoise
            ? ` Under ${rep.rhoNoise.toFixed(2)} on ${rep.measured} trades is chance.`
            : ` Above the ${rep.rhoNoise.toFixed(2)} chance level on ${rep.measured} trades.`}
          {/* The two readings can disagree without either being wrong, and
              read side by side they look like a contradiction. The line above
              compares two quarters; this uses every trade and every gradation
              of size between them, so it can see a trend the ends alone
              cannot separate. */}
          {!real && Math.abs(rep.rho) >= rep.rhoNoise
            ? " That is across all of them, at every size — a trend the two end quarters on their own are too small to confirm."
            : ""}
        </p>
      )}
    </div>
  );
}

/**
 * What the sizing decisions themselves were worth.
 *
 * The single most direct answer to "am I losing money by sizing badly",
 * because it holds the trading fixed and varies only the dollars behind it.
 * A trader can have identical R in every bucket — no habit at all — and still
 * be down thousands purely from being small on the winners.
 */
function FlatSized({
  rep,
  onOpen,
}: {
  rep: ReturnType<typeof sizingReport>;
  onOpen: (id: number) => void;
}) {
  const f = rep.flatSized;
  if (!f) return null;
  const cost = f.delta < 0;
  return (
    <div className="rounded-lg border border-border/60 bg-secondary/20 px-3 py-2" data-testid="size-flat">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        What varying the size was worth
      </p>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-[11px]">
        <span className="font-mono text-foreground/80">{fmtMoney(f.actual)}</span>
        <span className="text-[10px] text-muted-foreground">as you sized it</span>
        <span className="text-muted-foreground">vs</span>
        <span className="font-mono text-muted-foreground">{fmtMoney(f.flat)}</span>
        <span className="text-[10px] text-muted-foreground">
          flat at {fmtAmount(f.at)} a trade
        </span>
        <span
          className={`ml-auto font-mono text-xs font-semibold ${
            cost ? "text-primary" : "text-emerald-400"
          }`}
          data-testid="size-flat-delta"
        >
          {fmtMoney(f.delta)}
        </span>
      </div>
      <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
        {cost
          ? `Sizing cost you ${fmtAmount(f.delta)} against betting the same on everything — you were smaller on the trades that worked.`
          : `Sizing earned you ${fmtAmount(f.delta)} over betting the same on everything — you were bigger on the trades that worked.`}{" "}
        Same trades, same R, only the dollars behind each one differ.
      </p>
      {/* One oversized winner can produce a five-figure "sizing edge" on a
          record that sizes at random. Saying so is the difference between a
          claim about a habit and a claim about one bet. */}
      {f.topContributor && f.topContributor.share > 0.4 && (
        <p className="mt-1 text-[10px] leading-snug text-amber-500" data-testid="size-flat-concentrated">
          {Math.round(f.topContributor.share * 100)}% of that comes from a single trade.{" "}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => onOpen(f.topContributor!.id)}
            data-testid="size-flat-open-top"
          >
            Open it
          </button>{" "}
          — one bet going your way is not yet a sizing habit.
        </p>
      )}
    </div>
  );
}

/**
 * What else, besides size, differs across these buckets.
 *
 * A size split is only about size if size is the only thing changing across
 * it, and on a real journal it usually is not. Two confounds are common
 * enough to be tested rather than mentioned in prose:
 *
 *   Time. Traders size up as the account grows, so the smallest quarter
 *   quietly becomes last year and the largest becomes this month. The card
 *   would then be comparing early-you against recent-you and calling the
 *   difference a size effect.
 *
 *   Instrument. If the small trades are one symbol and the big ones another,
 *   the finding is about what you trade, not how much.
 *
 * Neither invalidates the table. Both change what it means, and silence about
 * them is what turns a reading into a wrong conclusion. Rendered only when
 * something actually fired, so a clean split stays clean.
 */
function Confounds({ rep }: { rep: ReturnType<typeof sizingReport> }) {
  const c = rep.confounds;
  if (!c) return null;
  const grew = c.lateRisk > c.earlyRisk;
  const notes: React.ReactNode[] = [];

  if (c.driftsWithTime) {
    /* When the typical trade has NOT moved but the average has, the drift is
       entirely in the tails — which is a sharper finding than "you sized up",
       and saying only the average would leave it looking like across-the-board
       growth. */
    const tailsOnly =
      Math.abs(c.lateTypical - c.earlyTypical) <
      0.15 * Math.max(c.earlyTypical, c.lateTypical, 1);
    notes.push(
      <>
        <span className="font-medium">
          {grew ? "Your bigger trades are the recent ones." : "Your bigger trades are the old ones."}
        </span>{" "}
        The older half of your record averages {fmtAmount(c.earlyRisk, 0)} a trade and the newer
        half {fmtAmount(c.lateRisk, 0)}
        {tailsOnly
          ? `, though the typical trade is about ${fmtAmount(c.earlyTypical, 0)} in both — the change is all in the outsized ones`
          : ""}
        . So the bands above are partly {grew ? "then against now" : "now against then"}: some of
        any gap is you getting better or worse, not you being big or small.
      </>,
    );
  }
  if (c.differentInstruments) {
    const first = c.dominant[0];
    const last = c.dominant[c.dominant.length - 1];
    notes.push(
      <>
        <span className="font-medium">Different instruments.</span> The smallest quarter is{" "}
        {Math.round(first.share * 100)}% {first.symbol} and the largest is{" "}
        {Math.round(last.share * 100)}% {last.symbol} — a difference between those two markets
        would show up here looking exactly like a size effect.
      </>,
    );
  }
  if (notes.length === 0) return null;

  return (
    <div
      className="mt-2.5 space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2"
      data-testid="size-confounds"
    >
      <p className="text-[10px] uppercase tracking-wider text-amber-500">
        What else could explain it
      </p>
      {notes.map((n, i) => (
        <p key={i} className="text-[10px] leading-snug text-muted-foreground">
          {n}
        </p>
      ))}
    </div>
  );
}
