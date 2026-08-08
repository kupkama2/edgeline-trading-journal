import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Download, EyeOff, Flame, Snowflake, TrendingDown } from "lucide-react";
import { useMistakeTags, useTrades } from "@/lib/data";
import { useStyleScopedTrades } from "@/lib/style-filter";
import { StyleSwitcher } from "@/components/style-switcher";
import { ImportCsvDialog } from "@/components/import-csv";
import { EquityCurve } from "@/components/equity-curve";
import { ExcursionChart } from "@/components/excursion-chart";
import {
  byAccount,
  byHighlight,
  byHour,
  byMistake,
  bySetup,
  bySymbol,
  byWeekday,
  closedTrades,
  type Slice,
} from "@shared/breakdowns";
import { drawdown, streaks } from "@shared/streaks";
import { MIN_SAMPLE, simulate } from "@shared/montecarlo";
import { missedStats } from "@shared/missed";
import { excursions, summariseExcursions } from "@shared/excursion";
import { fmtFees, fmtMoney, fmtR } from "@shared/metrics";

/**
 * Where the number comes from.
 *
 * The dashboard says what your trading is worth; this says which hour, which
 * weekday, which instrument and which setup produced it. Every figure is
 * derived from the trade log at render time — nothing here is stored, so it
 * cannot drift from the journal.
 *
 * Expectancy per trade leads every table rather than total R, because totals
 * reward the bucket you traded most and the question is which bucket is
 * actually better.
 */

const TABS = [
  { id: "hour", label: "Hour of day" },
  { id: "weekday", label: "Weekday" },
  { id: "symbol", label: "Instrument" },
  { id: "account", label: "Account" },
  { id: "setup", label: "Setup" },
  { id: "mistake", label: "Demon" },
  { id: "highlight", label: "Green flag" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** A bar that reads from a shared zero, so buckets are comparable at a glance. */
function ExpectancyBar({ value, scale }: { value: number; scale: number }) {
  const pct = scale > 0 ? Math.min(100, (Math.abs(value) / scale) * 100) : 0;
  const positive = value >= 0;
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-secondary/60">
      <div
        className={`absolute top-0 h-full ${positive ? "bg-emerald-500/70" : "bg-red-500/70"}`}
        style={{
          width: `${pct / 2}%`,
          left: positive ? "50%" : `${50 - pct / 2}%`,
        }}
      />
      <div className="absolute left-1/2 top-0 h-full w-px bg-border" />
    </div>
  );
}

function SliceTable({ rows, empty }: { rows: Slice[]; empty: string }) {
  // One shared scale across the table, so a tall bar means "better than the
  // others" rather than "widest in its own row".
  const scale = Math.max(...rows.map((r) => Math.abs(r.expectancyR)), 0.5);
  // The fees column only earns its width once something is actually paying it.
  const showFees = rows.some((r) => r.totalFees > 0);

  if (!rows.length) {
    return <p className="py-6 text-center text-[11px] text-muted-foreground">{empty}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-[11px]">
        <thead>
          <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="py-1.5 pr-2 text-left font-medium">Bucket</th>
            <th className="px-2 py-1.5 text-right font-medium">n</th>
            <th className="px-2 py-1.5 text-right font-medium">Win %</th>
            <th className="px-2 py-1.5 text-right font-medium">Exp R</th>
            <th className="px-2 py-1.5 text-right font-medium">Total R</th>
            <th className="px-2 py-1.5 text-right font-medium">
              {showFees ? "Net P&L" : "P&L"}
            </th>
            {showFees && <th className="px-2 py-1.5 text-right font-medium">Fees</th>}
            <th className="w-28 py-1.5 pl-2 text-left font-medium">vs zero</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.key}
              className="border-b border-border/40 last:border-0"
              data-testid={`slice-row-${r.key}`}
            >
              <td className="py-1.5 pr-2 font-medium">{r.label}</td>
              <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">{r.count}</td>
              <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">
                {(r.winRate * 100).toFixed(0)}%
              </td>
              <td
                className={`px-2 py-1.5 text-right font-mono font-semibold ${
                  r.expectancyR >= 0 ? "text-emerald-500" : "text-red-500"
                }`}
              >
                {fmtR(r.expectancyR)}
              </td>
              <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">
                {fmtR(r.totalR)}
              </td>
              <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">
                {fmtMoney(r.totalPnL)}
              </td>
              {showFees && (
                <td
                  className="px-2 py-1.5 text-right font-mono text-muted-foreground/70"
                  data-testid={`slice-fees-${r.key}`}
                >
                  {r.totalFees > 0 ? `−${fmtFees(r.totalFees)}` : "—"}
                </td>
              )}
              <td className="py-1.5 pl-2">
                <ExpectancyBar value={r.expectancyR} scale={scale} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({
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
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p
        className={`font-mono text-sm font-semibold ${
          tone === "good" ? "text-emerald-500" : tone === "bad" ? "text-red-500" : ""
        }`}
        data-testid={testId}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function Analysis() {
  const { data: trades = [], isLoading } = useTrades();
  const { data: tags = [] } = useMistakeTags();
  const scoped = useStyleScopedTrades(trades);
  const [tab, setTab] = useState<TabId>("hour");
  const [importOpen, setImportOpen] = useState(false);
  const [horizon, setHorizon] = useState(100);
  // Streaky mode draws blocks of 4 consecutive trades, so the loss clusters
  // you actually produced survive into the simulation.
  const [blocky, setBlocky] = useState(false);

  const closed = useMemo(() => closedTrades(scoped), [scoped]);
  const dd = useMemo(() => drawdown(scoped), [scoped]);
  const st = useMemo(() => streaks(scoped), [scoped]);
  const sim = useMemo(
    () => simulate(scoped, { horizon, runs: 2000, blockSize: blocky ? 4 : 1 }),
    [scoped, horizon, blocky],
  );
  const missed = useMemo(() => missedStats(scoped), [scoped]);
  const exc = useMemo(() => excursions(scoped), [scoped]);
  const excSummary = useMemo(() => summariseExcursions(exc), [exc]);

  const rows = useMemo(() => {
    switch (tab) {
      case "hour":
        return byHour(scoped);
      case "weekday":
        return byWeekday(scoped);
      case "symbol":
        return bySymbol(scoped);
      case "account":
        return byAccount(scoped);
      case "setup":
        return bySetup(scoped);
      case "mistake":
        return byMistake(scoped, tags);
      case "highlight":
        return byHighlight(scoped);
    }
  }, [tab, scoped, tags]);

  if (isLoading) {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Analysis</h1>
          <p className="text-[11px] text-muted-foreground">
            {closed.length} closed {closed.length === 1 ? "trade" : "trades"} sliced by when, what
            and why.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StyleSwitcher />
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
            onClick={() => setImportOpen(true)}
            data-testid="button-open-csv-import"
          >
            Import CSV
          </Button>
          {/* A plain link, not fetch-and-blob: the browser's own download path
              handles the Content-Disposition header and streams large files. */}
          <a href="/api/export.csv" download>
            <Button size="sm" variant="outline" className="h-7 text-[11px]" data-testid="button-export-csv">
              <Download className="mr-1.5 h-3 w-3" />
              Export CSV
            </Button>
          </a>
        </div>
      </div>

      {/* ---------------------------- the curve ---------------------------- */}
      <Card className="border-card-border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold tracking-tight">Streaks and drawdown</h2>
        {dd.equityR.length >= 2 && (
          <div className="mb-4">
            <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              Equity, cumulative R by day
            </p>
            <EquityCurve points={dd.equityR} />
          </div>
        )}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <Stat
            label="Max drawdown"
            value={`${dd.maxDrawdownR.toFixed(2)}R`}
            hint={
              dd.troughDay
                ? `${dd.troughLengthDays}d to ${dd.troughDay}${dd.recovered ? " · recovered" : " · not recovered"}`
                : "no decline yet"
            }
            tone={dd.maxDrawdownR > 0 ? "bad" : undefined}
            testId="stat-max-drawdown"
          />
          <Stat
            label="Currently"
            value={dd.currentDrawdownR > 0 ? `−${dd.currentDrawdownR.toFixed(2)}R` : "at highs"}
            hint={dd.currentDrawdownR > 0 ? "below your peak" : "no open drawdown"}
            tone={dd.currentDrawdownR > 0 ? "bad" : "good"}
          />
          <Stat
            label="Longest win run"
            value={`${st.longestWin}`}
            hint="consecutive winners"
            tone={st.longestWin > 0 ? "good" : undefined}
          />
          <Stat
            label="Longest loss run"
            value={`${st.longestLoss}`}
            hint="consecutive losers"
            tone={st.longestLoss > 0 ? "bad" : undefined}
          />
          <Stat
            label="Best day"
            value={dd.bestDay ? fmtMoney(dd.bestDay.pnl) : "—"}
            hint={dd.bestDay?.day}
            tone="good"
          />
          <Stat
            label="Worst day"
            value={dd.worstDay ? fmtMoney(dd.worstDay.pnl) : "—"}
            hint={dd.worstDay?.day}
            tone="bad"
          />
        </div>

        {st.current !== 0 && (
          <div className="mt-3 flex items-center gap-1.5 text-[11px]">
            {st.current > 0 ? (
              <Flame className="h-3 w-3 text-emerald-500" />
            ) : (
              <Snowflake className="h-3 w-3 text-red-500" />
            )}
            <span className="text-muted-foreground">
              Right now: {Math.abs(st.current)} {st.current > 0 ? "winner" : "loser"}
              {Math.abs(st.current) === 1 ? "" : "s"} in a row.
            </span>
          </div>
        )}
      </Card>

      {/* ------------------------ MAE / MFE excursion ------------------------ */}
      <Card className="border-card-border bg-card p-4">
        <div className="mb-3">
          <h2 className="text-sm font-semibold tracking-tight">How far each trade travelled</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Best reach and worst dip per trade, with your exit marked. Green above the line you
            didn't keep is give-back; red below is heat the trade took first.
          </p>
        </div>

        {exc.length === 0 ? (
          <p className="py-6 text-center text-[11px] text-muted-foreground" data-testid="excursion-empty">
            No path data yet. Add MAE/MFE when closing a trade — drop the outcome chart or type
            them — and each trade's travel appears here.
          </p>
        ) : (
          <>
            <ExcursionChart rows={exc} />
            {excSummary && (
              <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat
                  label="Avg best reach"
                  value={`${fmtR(excSummary.avgMfeR)}`}
                  hint="how far trades ran"
                  tone="good"
                />
                <Stat
                  label="Avg you kept"
                  value={excSummary.avgCapture != null ? `${Math.round(excSummary.avgCapture * 100)}%` : "—"}
                  hint="of the favourable move"
                  tone={excSummary.avgCapture != null && excSummary.avgCapture < 0.5 ? "bad" : undefined}
                  testId="stat-avg-capture"
                />
                <Stat
                  label="Avg worst dip"
                  value={`${fmtR(excSummary.avgMaeR)}`}
                  hint="heat taken per trade"
                  tone="bad"
                />
                <Stat
                  label="Deepest winner dip"
                  value={`${fmtR(excSummary.deepestWinnerMaeR)}`}
                  hint="how tight is too tight"
                />
              </div>
            )}
            <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
              {excSummary && excSummary.avgCapture != null && excSummary.avgCapture < 0.5
                ? "You're keeping under half of the average move — the edge finds runs the exit gives back. Look at trailing wider or targeting further."
                : "Winners that routinely dip well past your stop distance before working are the sign a tighter stop would cut good trades."}
              {" "}Showing {exc.length} {exc.length === 1 ? "trade" : "trades"} with recorded path.
            </p>
          </>
        )}
      </Card>

      {/* -------------------------- the breakdowns -------------------------- */}
      <Card className="border-card-border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {TABS.map((t) => (
            <Button
              key={t.id}
              size="sm"
              variant={tab === t.id ? "default" : "ghost"}
              className="h-7 text-[11px]"
              onClick={() => setTab(t.id)}
              data-testid={`tab-${t.id}`}
            >
              {t.label}
            </Button>
          ))}
        </div>
        <SliceTable
          rows={rows}
          empty={
            tab === "setup"
              ? "No setups tagged yet — write a rationale when logging and they appear here."
              : tab === "mistake"
                ? "No demons tagged on closed trades yet."
                : tab === "highlight"
                  ? "Nothing marked as done right yet — flag what you nailed when closing a trade."
                  : tab === "account"
                    ? "No accounts recorded yet — pick one when logging a trade and it shows up here."
                    : "No closed trades yet."
          }
        />
        {(tab === "mistake" || tab === "setup" || tab === "highlight") && rows.length > 0 && (
          <p className="mt-2 text-[10px] text-muted-foreground">
            A trade can carry more than one{" "}
            {tab === "mistake" ? "demon" : tab === "highlight" ? "green flag" : "setup"}, so these
            rows overlap and will not sum to your totals.
          </p>
        )}
      </Card>

      {/* --------------------------- monte carlo --------------------------- */}
      <Card className="border-card-border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">If this edge keeps running</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              2,000 simulated runs, resampling your own closed trades. Read the drawdown row, not
              the median.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {[50, 100, 250].map((h) => (
              <Button
                key={h}
                size="sm"
                variant={horizon === h ? "default" : "ghost"}
                className="h-7 text-[11px]"
                onClick={() => setHorizon(h)}
                data-testid={`horizon-${h}`}
              >
                {h}
              </Button>
            ))}
            <span className="mx-1 h-4 w-px bg-border" />
            {/* Independent draws assume results never cluster; streaky mode
                resamples runs of 4 consecutive trades so your actual loss
                clusters survive into the simulation. */}
            {(
              [
                [false, "independent"],
                [true, "streaky"],
              ] as const
            ).map(([mode, label]) => (
              <Button
                key={label}
                size="sm"
                variant={blocky === mode ? "default" : "ghost"}
                className="h-7 text-[11px]"
                onClick={() => setBlocky(mode)}
                title={
                  mode
                    ? "Blocks of 4 consecutive trades — keeps your loss clustering"
                    : "Each trade drawn independently"
                }
                data-testid={`mc-mode-${label}`}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>

        {!sim ? (
          <p className="py-4 text-center text-[11px] text-muted-foreground" data-testid="mc-too-few">
            Needs at least {MIN_SAMPLE} closed trades to say anything honest — you have{" "}
            {closed.length}.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
              {(
                [
                  ["Worst 5%", sim.finalR.p5],
                  ["Lower quartile", sim.finalR.p25],
                  ["Median", sim.finalR.p50],
                  ["Upper quartile", sim.finalR.p75],
                  ["Best 5%", sim.finalR.p95],
                ] as const
              ).map(([label, v]) => (
                <Stat
                  key={label}
                  label={label}
                  value={fmtR(v)}
                  tone={v >= 0 ? "good" : "bad"}
                  testId={`mc-${label.replace(/\s+/g, "-").toLowerCase()}`}
                />
              ))}
            </div>

            <div className="rounded-md border border-border p-2.5">
              <div className="mb-1.5 flex items-center gap-1.5">
                <TrendingDown className="h-3 w-3 text-muted-foreground" />
                <span className="text-[11px] font-semibold">
                  Drawdown you should expect to sit through
                </span>
              </div>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Typical (median)" value={`${sim.maxDrawdownR.p50.toFixed(2)}R`} />
                <Stat label="1 run in 4" value={`${sim.maxDrawdownR.p75.toFixed(2)}R`} />
                <Stat label="1 run in 10" value={`${sim.maxDrawdownR.p90.toFixed(2)}R`} />
                <Stat
                  label="1 run in 20"
                  value={`${sim.maxDrawdownR.p95.toFixed(2)}R`}
                  tone="bad"
                  testId="mc-dd-p95"
                />
              </div>
              <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
                {blocky
                  ? "Streaky mode: blocks of 4 consecutive trades, so the loss runs you actually produced are in these numbers."
                  : "Sampled independently, so clustered losses are not modelled — if your losers come in runs, real drawdowns will be deeper than this. Try streaky mode."}
              </p>
            </div>

            <div className="flex flex-wrap gap-2 text-[11px]">
              <Badge variant="secondary" className="font-mono" data-testid="mc-prob-losing">
                {(sim.probLosing * 100).toFixed(0)}% of runs end below break-even
              </Badge>
              <Badge variant="outline" className="font-mono">
                {(sim.probDrawdown10R * 100).toFixed(0)}% touch −10R
              </Badge>
              <Badge variant="outline" className="font-mono">
                from {sim.sampleSize} trades · {fmtR(sim.expectancyR)} each
              </Badge>
            </div>
          </div>
        )}
      </Card>

      {/* -------------------------- missed trades -------------------------- */}
      {missed.count > 0 && (
        <Card className="border-card-border bg-card p-4" data-testid="card-missed">
          <div className="mb-3 flex items-start gap-2">
            <EyeOff className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold tracking-tight">The ones you didn't take</h2>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {missed.resolved} of {missed.count} resolved. Winners priced at their planned R,
                losers at −1R.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat
              label="Would have won"
              value={`${missed.wouldHaveWon}`}
              hint={`${fmtR(missed.forgoneR)} forgone`}
              tone={missed.wouldHaveWon > 0 ? "bad" : undefined}
            />
            <Stat
              label="Would have lost"
              value={`${missed.wouldHaveLost}`}
              hint={`${missed.avoidedR.toFixed(2)}R avoided`}
              tone={missed.wouldHaveLost > 0 ? "good" : undefined}
            />
            <Stat
              label="Net"
              value={fmtR(missed.netR)}
              hint={missed.netR >= 0 ? "hesitation cost you" : "your filter earned this"}
              tone={missed.netR > 0 ? "bad" : "good"}
              testId="stat-missed-net"
            />
            <Stat
              label="Unresolved"
              value={`${missed.count - missed.resolved}`}
              hint="mark what they did"
            />
          </div>

          {missed.resolved > 0 && (
            <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
              {missed.netR > 0
                ? "Skipped setups would have made money. The trades you talk yourself out of are worth more than the ones you avoid."
                : "Skipped setups would have lost money. Whatever is making you pass is working — the discomfort is the price of a good rule."}
            </p>
          )}
        </Card>
      )}

      <ImportCsvDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}
