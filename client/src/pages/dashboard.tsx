import { useMemo, useState } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { TrendingUp, Target, Flame, Trophy, CalendarDays } from "lucide-react";
import {
  useTrades,
  useMistakeTags,
  useWeeklyReviews,
  useSubmitWeeklyReview,
} from "@/lib/data";
import { DailyGuardCard } from "@/components/daily-guard";
import { TradeDetailDialog } from "@/components/trade-dialogs";
import { setJumpDay } from "@/lib/jump";
import { useLocation } from "wouter";
import { DemonFinderPanel, WeeklyReviewCard } from "@/components/demon-finder";
import { WeeklyInsightsCard } from "@/components/weekly-insights";
import { StyleSwitcher } from "@/components/style-switcher";
import { ProgressionCard } from "@/components/xp";
import { filterByStyle, useStyleFilter } from "@/lib/style-filter";
import {
  aggregate,
  computeMetrics,
  fmtMoney,
  fmtR,
  mistakeCostLeaderboard,
  EXIT_REASON_LABELS,
  getPrestige,
} from "@shared/metrics";
import type { TradeWithTags } from "@shared/schema";

/* ------------------------------ utilities ------------------------------ */

const C = {
  actual: "hsl(var(--chart-1))",
  potential: "hsl(var(--chart-2))",
  delta: "hsl(var(--chart-3))",
  bad: "hsl(var(--chart-4))",
  alt: "hsl(var(--chart-5))",
  grid: "hsl(var(--border))",
  axis: "hsl(var(--muted-foreground))",
};

const axisProps = {
  stroke: C.axis,
  tick: { fontSize: 10, fill: C.axis },
  tickLine: false,
  axisLine: false,
};

function ChartCard({
  title,
  subtitle,
  icon: Icon,
  children,
  testId,
  className = "",
}: {
  title: string;
  subtitle?: string;
  icon?: any;
  children: React.ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <Card className={`border-card-border bg-card p-4 sm:p-5 ${className}`} data-testid={testId}>
      <div className="mb-3 flex items-start gap-2">
        {Icon && <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-tight tracking-tight">{title}</h3>
          {subtitle && (
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{subtitle}</p>
          )}
        </div>
      </div>
      {children}
    </Card>
  );
}

function ChartTooltip({ active, payload, label, unit }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-popover-border bg-popover/95 px-2.5 py-2 shadow-lg backdrop-blur">
      {label != null && (
        <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
      )}
      {payload.map((p: any) => (
        <p key={p.dataKey ?? p.name} className="font-mono text-[11px]" style={{ color: p.color }}>
          {p.name}:{" "}
          {typeof p.value === "number"
            ? unit === "$"
              ? fmtMoney(p.value)
              : p.value.toFixed(2)
            : p.value}
          {unit && unit !== "$" ? unit : ""}
        </p>
      ))}
    </div>
  );
}

function EmptyChart({ msg }: { msg: string }) {
  return (
    <div className="flex h-[200px] items-center justify-center rounded-md border border-dashed border-border/70 text-center">
      <p className="max-w-[22rem] px-4 text-[11px] leading-snug text-muted-foreground">{msg}</p>
    </div>
  );
}

/* --------------------------- weekly combat gate ------------------------- */

function mondayOf(d: Date) {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  return x.toISOString().slice(0, 10);
}

function WeeklyGate({
  leaderboard,
}: {
  leaderboard: { tagId: number; name: string; cost: number; trades: number }[];
}) {
  const { toast } = useToast();
  const { data: reviews = [] } = useWeeklyReviews();
  const submit = useSubmitWeeklyReview();
  const [plans, setPlans] = useState<Record<number, string>>({});
  const [dismissed, setDismissed] = useState(false);

  const lastWeek = mondayOf(new Date(Date.now() - 7 * 86400000));
  const done = reviews.some((r) => r.weekStart === lastWeek);
  const top3 = leaderboard.slice(0, 3);

  if (done || dismissed || top3.length === 0) return null;

  const allWritten = top3.every((t) => (plans[t.tagId] || "").trim().length > 0);

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-background/98 backdrop-blur"
      data-testid="weekly-review-gate"
    >
      <div className="mx-auto max-w-xl px-4 py-10">
        <div className="mb-6 text-center">
          <Flame className="mx-auto mb-2 h-6 w-6 text-primary" />
          <h1 className="text-xl font-bold tracking-tight">Weekly combat plan</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Week of {lastWeek} — these three habits cost you the most money.
          </p>
          <p className="mt-2 text-[11px] text-primary/90">
            Write a plan for each before you trade this week.
          </p>
        </div>

        <div className="space-y-3">
          {top3.map((t, i) => {
            const { tier } = getPrestige(t.trades);
            return (
              <Card key={t.tagId} className="border-card-border bg-card p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">#{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{t.name}</span>
                  <Badge variant="outline" className={`shrink-0 text-[10px] ${tier.color}`}>
                    {tier.name}
                  </Badge>
                  <span className="shrink-0 font-mono text-xs text-primary">
                    -{fmtMoney(t.cost).replace("+", "")}
                  </span>
                </div>
                <Textarea
                  value={plans[t.tagId] || ""}
                  onChange={(e) => setPlans((p) => ({ ...p, [t.tagId]: e.target.value }))}
                  placeholder="How will you kill this habit this week?"
                  className="min-h-[64px] text-xs"
                  data-testid={`combat-plan-${t.tagId}`}
                />
              </Card>
            );
          })}
        </div>

        <Button
          className="mt-5 h-10 w-full text-xs font-semibold"
          disabled={!allWritten || submit.isPending}
          data-testid="button-submit-weekly"
          onClick={async () => {
            await submit.mutateAsync({
              weekStart: lastWeek,
              plans: JSON.stringify(
                top3.map((t) => ({ tagId: t.tagId, tagName: t.name, plan: plans[t.tagId] })),
              ),
              submittedAt: new Date().toISOString(),
            });
            setDismissed(true);
            toast({ title: "Combat plans locked in", description: "Go execute." });
          }}
        >
          {allWritten ? "Submit & start trading" : `Write all ${top3.length} plans to continue`}
        </Button>
        <button
          className="mt-2 w-full text-center text-[10px] text-muted-foreground hover:text-foreground"
          onClick={() => setDismissed(true)}
          data-testid="button-skip-weekly"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}

/* --------------------------------- page -------------------------------- */

export default function Dashboard() {
  const { data: trades, isLoading } = useTrades();
  const { data: tags = [] } = useMistakeTags();
  const { activeStyleId } = useStyleFilter();
  // A point on the equity curve is one closed trade, and a calendar cell is
  // one day — both are doors into the log rather than pictures of it.
  const [viewing, setViewing] = useState<TradeWithTags | null>(null);
  const [, navigate] = useLocation();
  const all = useMemo(
    () => filterByStyle(trades ?? [], activeStyleId),
    [trades, activeStyleId],
  );
  const closed = useMemo(
    () =>
      all
        .filter((t) => t.status === "closed" && t.exitPrice != null)
        .sort((a, b) => (a.exitTime ?? "").localeCompare(b.exitTime ?? "")),
    [all],
  );

  const stats = useMemo(() => aggregate(all), [all]);
  const tagNames = useMemo(
    () => Object.fromEntries(tags.map((t) => [t.id, t.name])) as Record<number, string>,
    [tags],
  );

  /* Equity curves: actual vs no-management vs cumulative management delta */
  const equity = useMemo(() => {
    let a = 0;
    let p = 0;
    let d = 0;
    let a$ = 0;
    return closed.map((t, i) => {
      const m = computeMetrics(t);
      a += m.actualR ?? 0;
      a$ += m.actualPnL ?? 0;
      p += m.potentialR ?? 0;
      d += m.managementDeltaR ?? 0;
      return {
        i: i + 1,
        // Carried so a click on the curve can find its way back to the row.
        tradeId: t.id,
        label: `#${i + 1} ${t.symbol}`,
        actual: +a.toFixed(3),
        potential: +p.toFixed(3),
        delta: +d.toFixed(3),
        dollars: +a$.toFixed(2),
      };
    });
  }, [closed]);

  const leaderboard = useMemo(
    () => mistakeCostLeaderboard(all, tagNames),
    [all, tagNames],
  );

  /* MFE-capture distribution buckets */
  const capture = useMemo(() => {
    const buckets = [0, 0, 0, 0, 0];
    const labels = ["0–20%", "20–40%", "40–60%", "60–80%", "80–100%"];
    let counted = 0;
    for (const t of closed) {
      const c = computeMetrics(t).captureRatioClipped;
      if (c == null) continue;
      const idx = Math.min(4, Math.floor(c * 5));
      buckets[idx]++;
      counted++;
    }
    return { counted, data: labels.map((l, i) => ({ bucket: l, trades: buckets[i] })) };
  }, [closed]);

  /* Exit-quality breakdown */
  const exitQuality = useMemo(() => {
    const acc: Record<string, { count: number; delta: number }> = {};
    for (const t of closed) {
      const k = t.exitReason ?? "other";
      const m = computeMetrics(t);
      if (!acc[k]) acc[k] = { count: 0, delta: 0 };
      acc[k].count++;
      acc[k].delta += m.managementDeltaR ?? 0;
    }
    return Object.entries(acc)
      .map(([k, v]) => ({
        reason: EXIT_REASON_LABELS[k] ?? k,
        count: v.count,
        delta: +v.delta.toFixed(2),
      }))
      .sort((a, b) => b.count - a.count);
  }, [closed]);

  /* Calendar heatmap: last 12 weeks of daily $ */
  const calendar = useMemo(() => {
    const byDay: Record<string, number> = {};
    for (const t of closed) {
      const day = (t.exitTime ?? "").slice(0, 10);
      if (!day) continue;
      byDay[day] = (byDay[day] ?? 0) + (computeMetrics(t).actualPnL ?? 0);
    }
    const weeks: { day: string; value: number | null }[][] = [];
    const end = new Date();
    end.setHours(12, 0, 0, 0);
    const startMonday = new Date(end);
    startMonday.setDate(startMonday.getDate() - ((startMonday.getDay() + 6) % 7) - 7 * 11);
    for (let w = 0; w < 12; w++) {
      const col: { day: string; value: number | null }[] = [];
      for (let d = 0; d < 7; d++) {
        const cur = new Date(startMonday);
        cur.setDate(startMonday.getDate() + w * 7 + d);
        const key = cur.toISOString().slice(0, 10);
        col.push({ day: key, value: key in byDay ? byDay[key] : null });
      }
      weeks.push(col);
    }
    const maxAbs = Math.max(1, ...Object.values(byDay).map((v) => Math.abs(v)));
    return { weeks, maxAbs };
  }, [closed]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-72 w-full" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  const statStrip = [
    { label: "Win rate", value: `${Math.round(stats.winRate * 100)}%` },
    { label: "Expectancy", value: fmtR(stats.expectancyR) },
    { label: "Avg winner", value: fmtR(stats.avgWinnerR) },
    { label: "Avg loser", value: fmtR(stats.avgLoserR) },
    {
      label: "Profit factor",
      value: isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : "∞",
    },
    { label: "Avg capture", value: `${Math.round(stats.avgCapture * 100)}%` },
    { label: "Net R", value: fmtR(stats.totalR), tone: stats.totalR >= 0 ? "up" : "down" },
    {
      label: "Net P&L",
      value: fmtMoney(stats.totalPnL),
      tone: stats.totalPnL >= 0 ? "up" : "down",
    },
  ];

  return (
    <div className="space-y-6">
      <WeeklyGate leaderboard={leaderboard} />

      <div>
        <h1 className="text-xl font-bold tracking-tight">Dashboard</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {stats.count} closed {stats.count === 1 ? "trade" : "trades"} · what your management is
          actually worth
        </p>
      </div>

      <StyleSwitcher />

      {/* Account-level on purpose: process discipline doesn't reset when you
          switch books, so this card ignores the style filter. */}
      <ProgressionCard />

      <DailyGuardCard trades={all} tags={tags} styleId={activeStyleId} />

      <WeeklyReviewCard trades={all} tags={tags} />

      <WeeklyInsightsCard trades={all} tags={tags} />

      {/* stat strip */}
      <Card className="border-card-border bg-card p-4" data-testid="card-stat-strip">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 lg:grid-cols-8">
          {statStrip.map((s) => (
            <div key={s.label} className="min-w-0">
              <p className="truncate text-[10px] uppercase tracking-wider text-muted-foreground">
                {s.label}
              </p>
              <p
                className={`font-mono text-base font-bold tabular-nums ${
                  (s as any).tone === "up"
                    ? "text-emerald-400"
                    : (s as any).tone === "down"
                      ? "text-primary"
                      : "text-foreground"
                }`}
                data-testid={`stat-${s.label.toLowerCase().replace(/\s+/g, "-")}`}
              >
                {s.value}
              </p>
            </div>
          ))}
        </div>
      </Card>

      {/* equity curves */}
      <ChartCard
        title="Actual vs. no-management equity"
        subtitle="Cumulative R if you managed the trade (green) vs. leaving the original stop and target untouched (blue). Amber is the running R your management added or destroyed."
        icon={TrendingUp}
        testId="chart-equity"
      >
        {equity.length === 0 ? (
          <EmptyChart msg="Close a few trades with an outcome screenshot (or a no-management verdict) and both curves appear here." />
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart
              data={equity}
              margin={{ top: 8, right: 8, bottom: 4, left: -4 }}
              className="cursor-pointer"
              onClick={(e: any) => {
                // Recharts hands back the hovered datum; each point on this
                // curve is one closed trade, so open it.
                const id = e?.activePayload?.[0]?.payload?.tradeId;
                if (id != null) setViewing(closed.find((t) => t.id === id) ?? null);
              }}
            >
              <defs>
                <linearGradient id="gDelta" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.delta} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={C.delta} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={C.grid} strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="i" {...axisProps} />
              <YAxis {...axisProps} width={42} tickFormatter={(v) => `${v}R`} />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: C.grid }} />
              <Area
                type="monotone"
                dataKey="delta"
                name="Δ management"
                stroke={C.delta}
                strokeWidth={1.5}
                fill="url(#gDelta)"
              />
              <Line
                type="monotone"
                dataKey="potential"
                name="No management"
                stroke={C.potential}
                strokeWidth={2}
                strokeDasharray="5 4"
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="actual"
                name="Actual"
                stroke={C.actual}
                strokeWidth={2.4}
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
        {equity.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
            <Legend color={C.actual} label={`Actual ${fmtR(stats.totalR)}`} />
            <Legend
              color={C.potential}
              label={`No management ${fmtR(equity[equity.length - 1].potential)}`}
              dashed
            />
            <Legend color={C.delta} label={`Δ management ${fmtR(stats.totalDeltaR)}`} />
          </div>
        )}
      </ChartCard>

      <DemonFinderPanel trades={all} tags={tags} />

      <div className="grid gap-4 lg:grid-cols-2">
        {/* mistake cost leaderboard */}
        <ChartCard
          title="Mistake-cost leaderboard"
          subtitle="Dollars given back, split evenly across the tags attached to each trade."
          icon={Trophy}
          testId="chart-leaderboard"
        >
          {leaderboard.length === 0 ? (
            <EmptyChart msg="Tag mistakes when you close a trade to see which habit is the most expensive." />
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(180, leaderboard.length * 34)}>
              <BarChart
                data={leaderboard.slice(0, 8)}
                layout="vertical"
                margin={{ top: 0, right: 16, bottom: 0, left: 8 }}
              >
                <CartesianGrid stroke={C.grid} strokeDasharray="2 4" horizontal={false} />
                <XAxis type="number" {...axisProps} tickFormatter={(v) => `$${v}`} />
                <YAxis
                  type="category"
                  dataKey="name"
                  {...axisProps}
                  width={130}
                  tick={{ fontSize: 10, fill: C.axis }}
                />
                <Tooltip content={<ChartTooltip unit="$" />} cursor={{ fill: "hsl(var(--muted))" }} />
                <Bar dataKey="cost" name="Cost" radius={[0, 3, 3, 0]} maxBarSize={18}>
                  {leaderboard.slice(0, 8).map((_, i) => (
                    <Cell key={i} fill={i === 0 ? C.bad : "hsl(var(--chart-4) / 0.55)"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* capture distribution */}
        <ChartCard
          title="MFE capture distribution"
          subtitle="How much of the best available move you actually keep."
          icon={Target}
          testId="chart-capture"
        >
          {capture.counted === 0 ? (
            <EmptyChart msg="Record MFE on closed trades (screenshot or manual) to build this histogram." />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={capture.data} margin={{ top: 8, right: 8, bottom: 0, left: -6 }}>
                <CartesianGrid stroke={C.grid} strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="bucket" {...axisProps} />
                <YAxis {...axisProps} width={30} allowDecimals={false} tickCount={4} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted))" }} />
                <Bar dataKey="trades" name="Trades" radius={[3, 3, 0, 0]} maxBarSize={44}>
                  {capture.data.map((_, i) => (
                    <Cell key={i} fill={`hsl(var(--chart-1) / ${0.35 + i * 0.16})`} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* exit quality */}
        <ChartCard
          title="Exit quality"
          subtitle="Count per exit type, coloured by whether that exit helped (green) or hurt (red) vs. the passive plan."
          testId="chart-exit-quality"
        >
          {exitQuality.length === 0 ? (
            <EmptyChart msg="Close trades with an exit reason to compare which exits serve you." />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={exitQuality} margin={{ top: 8, right: 8, bottom: 0, left: -6 }}>
                <CartesianGrid stroke={C.grid} strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="reason" {...axisProps} interval={0} tick={{ fontSize: 9, fill: C.axis }} />
                <YAxis {...axisProps} width={30} allowDecimals={false} tickCount={4} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted))" }} />
                <Bar dataKey="count" name="Trades" radius={[3, 3, 0, 0]} maxBarSize={44}>
                  {exitQuality.map((d, i) => (
                    <Cell key={i} fill={d.delta >= 0 ? C.actual : C.bad} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* calendar heatmap */}
        <ChartCard
          title="Daily P&L calendar"
          subtitle="Last 12 weeks. Green days made money, red days gave it back."
          icon={CalendarDays}
          testId="chart-calendar"
        >
          <div className="overflow-x-auto pb-1">
            <div className="flex gap-1.5">
              {calendar.weeks.map((week, wi) => (
                <div key={wi} className="flex flex-col gap-1.5">
                  {week.map((cell) => {
                    const v = cell.value;
                    const intensity = v == null ? 0 : Math.min(1, Math.abs(v) / calendar.maxAbs);
                    const bg =
                      v == null
                        ? "hsl(var(--muted) / 0.5)"
                        : v >= 0
                          ? `hsl(var(--chart-1) / ${0.2 + intensity * 0.8})`
                          : `hsl(var(--chart-4) / ${0.2 + intensity * 0.8})`;
                    return (
                      <button
                        type="button"
                        key={cell.day}
                        title={`${cell.day}${v != null ? ` · ${fmtMoney(v)}` : ""}`}
                        data-testid={`cal-${cell.day}`}
                        onClick={() => {
                          setJumpDay(cell.day);
                          navigate("/daily");
                        }}
                        aria-label={`Open ${cell.day}`}
                        className="h-4 w-4 rounded-[3px] transition-transform hover:scale-125 sm:h-5 sm:w-5"
                        style={{ backgroundColor: bg }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>Loss</span>
            <div className="flex gap-0.5">
              {[0.9, 0.55, 0.25].map((o) => (
                <div
                  key={o}
                  className="h-2.5 w-2.5 rounded-[2px]"
                  style={{ backgroundColor: `hsl(var(--chart-4) / ${o})` }}
                />
              ))}
              <div
                className="h-2.5 w-2.5 rounded-[2px]"
                style={{ backgroundColor: "hsl(var(--muted) / 0.5)" }}
              />
              {[0.25, 0.55, 0.9].map((o) => (
                <div
                  key={o}
                  className="h-2.5 w-2.5 rounded-[2px]"
                  style={{ backgroundColor: `hsl(var(--chart-1) / ${o})` }}
                />
              ))}
            </div>
            <span>Profit</span>
          </div>
        </ChartCard>
      </div>

      <TradeDetailDialog trade={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}

function Legend({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap font-mono">
      <span
        className="inline-block h-0.5 w-4 rounded"
        style={{
          backgroundColor: dashed ? "transparent" : color,
          backgroundImage: dashed
            ? `repeating-linear-gradient(90deg, ${color} 0 5px, transparent 5px 9px)`
            : undefined,
        }}
      />
      {label}
    </span>
  );
}
