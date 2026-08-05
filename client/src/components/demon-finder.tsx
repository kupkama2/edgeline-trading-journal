import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CalendarRange, Flame, Skull, Trophy } from "lucide-react";
import type { MistakeTag, TradeWithTags } from "@shared/schema";
import {
  DEMON_STREAK_CRITICAL,
  DEMON_STREAK_WARNING,
  demonCountsInRange,
  demonStats,
  worstDemonStreak,
  type DemonStat,
} from "@shared/demons";
import { computeMetrics, fmtR } from "@shared/metrics";

/* ------------------------------- hooks -------------------------------- */

export function useDemons(trades: TradeWithTags[], tags: MistakeTag[]) {
  return useMemo(() => {
    const stats = demonStats(trades, tags);
    return { stats, worst: worstDemonStreak(stats) };
  }, [trades, tags]);
}

/* ------------------------------ strike pips ---------------------------- */

function StreakPips({ streak }: { streak: number }) {
  const filled = Math.min(streak, DEMON_STREAK_CRITICAL);
  return (
    <div className="flex shrink-0 items-center gap-[3px]" aria-hidden="true">
      {Array.from({ length: DEMON_STREAK_CRITICAL }).map((_, i) => {
        const on = i < filled;
        const tone = !on
          ? "bg-muted"
          : streak >= DEMON_STREAK_CRITICAL
            ? "bg-destructive"
            : streak >= DEMON_STREAK_WARNING
              ? "bg-amber-500"
              : "bg-primary/70";
        return <span key={i} className={`h-3 w-1.5 rounded-[2px] ${tone}`} />;
      })}
    </div>
  );
}

function DemonRow({ d }: { d: DemonStat }) {
  const tone =
    d.severity === "critical"
      ? "border-destructive/60 bg-destructive/10"
      : d.severity === "warning"
        ? "border-amber-500/40 bg-amber-500/5"
        : "border-border/60 bg-secondary/20";

  return (
    <div
      className={`flex items-center gap-3 rounded-md border px-2.5 py-2 ${tone}`}
      data-testid={`demon-row-${d.id}`}
    >
      <span className="min-w-0 flex-1 truncate text-xs font-medium" title={d.name}>
        {d.name}
        {d.custom && (
          <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">custom</span>
        )}
      </span>

      <StreakPips streak={d.currentStreak} />

      <span
        className="w-8 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground"
        data-testid={`demon-total-${d.id}`}
        title="Lifetime occurrences"
      >
        {d.total}
      </span>

      {d.severity !== "none" ? (
        <Badge
          variant="outline"
          className={`shrink-0 whitespace-nowrap text-[10px] ${
            d.severity === "critical"
              ? "border-destructive/60 text-destructive"
              : "border-amber-500/50 text-amber-500"
          }`}
          data-testid={`demon-streak-${d.id}`}
        >
          {d.currentStreak} in a row
        </Badge>
      ) : (
        <span className="w-[4.5rem] shrink-0" />
      )}
    </div>
  );
}

/* --------------------------- demon finder panel ------------------------ */

export function DemonFinderPanel({
  trades,
  tags,
}: {
  trades: TradeWithTags[];
  tags: MistakeTag[];
}) {
  const { stats, worst } = useDemons(trades, tags);
  const tagged = stats.filter((s) => s.total > 0);
  const untouched = stats.filter((s) => s.total === 0);

  return (
    <Card className="border-card-border bg-card p-4 sm:p-5" data-testid="card-demon-finder">
      <div className="mb-3 flex items-start gap-2">
        <Skull className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-tight tracking-tight">Demon Finder</h3>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            Every named mistake, its running tally, and how many trades in a row it has
            struck. {DEMON_STREAK_CRITICAL} in a row means something is seriously broken.
          </p>
        </div>
      </div>

      {worst && (
        <div
          className={`mb-3 flex items-start gap-2 rounded-md border px-2.5 py-2 ${
            worst.currentStreak >= DEMON_STREAK_CRITICAL
              ? "border-destructive/60 bg-destructive/10"
              : "border-amber-500/40 bg-amber-500/5"
          }`}
          data-testid="banner-demon-streak"
        >
          <AlertTriangle
            className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
              worst.currentStreak >= DEMON_STREAK_CRITICAL ? "text-destructive" : "text-amber-500"
            }`}
          />
          <p
            className={`text-[11px] font-semibold leading-snug ${
              worst.currentStreak >= DEMON_STREAK_CRITICAL ? "text-destructive" : "text-amber-500"
            }`}
          >
            {worst.currentStreak >= DEMON_STREAK_CRITICAL
              ? `${worst.name} — ${worst.currentStreak} trades in a row. This is no longer a slip, it is your method. Stop and rebuild the rule.`
              : `${worst.name} — ${worst.currentStreak} trades in a row. Catch it now, before it reaches ${DEMON_STREAK_CRITICAL}.`}
          </p>
        </div>
      )}

      {tagged.length === 0 ? (
        <div className="flex h-[120px] items-center justify-center rounded-md border border-dashed border-border/70 text-center">
          <p className="max-w-[22rem] px-4 text-[11px] leading-snug text-muted-foreground">
            No demons logged yet. Tag the mistake when you close a trade and the strike
            tracker fills in here.
          </p>
        </div>
      ) : (
        <div className="space-y-1.5" data-testid="demon-list">
          {tagged.map((d) => (
            <DemonRow key={d.id} d={d} />
          ))}
        </div>
      )}

      {untouched.length > 0 && (
        <div className="mt-3 border-t border-border/60 pt-2.5">
          <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            Clean so far
          </p>
          <div className="flex flex-wrap gap-1">
            {untouched.map((d) => (
              <span
                key={d.id}
                className="rounded-full border border-border px-2 py-0.5 text-[10px] leading-tight text-muted-foreground"
                data-testid={`demon-clean-${d.id}`}
              >
                {d.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

/* --------------------------- weekly review card ------------------------ */

function startOfWeekIso(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  return d;
}

/**
 * "Best three, fix one" — celebrate the three best trades of the week and
 * surface exactly ONE demon to eliminate next week. Deliberately never more.
 */
export function WeeklyReviewCard({
  trades,
  tags,
}: {
  trades: TradeWithTags[];
  tags: MistakeTag[];
}) {
  const { from, to, best, focusDemon, closedCount } = useMemo(() => {
    const start = startOfWeekIso();
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    const fromIso = start.toISOString();
    const toIso = end.toISOString();

    const inWeek = trades.filter((t) => {
      if (t.status !== "closed") return false;
      const when = t.exitTime ?? t.entryTime;
      return when >= fromIso && when < toIso;
    });

    const ranked = inWeek
      .map((t) => ({ t, r: computeMetrics(t).actualR ?? 0 }))
      .sort((a, b) => b.r - a.r)
      .slice(0, 3);

    const demons = demonCountsInRange(trades, tags, fromIso, toIso);

    return {
      from: start,
      to: end,
      best: ranked,
      focusDemon: demons[0] ?? null,
      closedCount: inWeek.length,
    };
  }, [trades, tags]);

  const range = `${from.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${new Date(
    to.getTime() - 86400000,
  ).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;

  return (
    <Card className="border-card-border bg-card p-4 sm:p-5" data-testid="card-weekly-review">
      <div className="mb-3 flex items-start gap-2">
        <CalendarRange className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-tight tracking-tight">Weekly review</h3>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            {range} · {closedCount} closed {closedCount === 1 ? "trade" : "trades"} — celebrate
            three, fix one.
          </p>
        </div>
      </div>

      {closedCount === 0 ? (
        <div className="flex h-[120px] items-center justify-center rounded-md border border-dashed border-border/70 text-center">
          <p className="max-w-[22rem] px-4 text-[11px] leading-snug text-muted-foreground">
            Nothing closed this week yet. Your best three trades and the one demon to kill
            will appear here.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-1.5 flex items-center gap-1.5">
            <Trophy className="h-3 w-3 text-emerald-400" />
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Best three by R
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-3" data-testid="weekly-best-trades">
            {best.map(({ t, r }) => (
              <div
                key={t.id}
                className="rounded-md border border-border/60 bg-secondary/20 px-2.5 py-2"
                data-testid={`weekly-best-${t.id}`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-mono text-xs font-semibold">{t.symbol}</span>
                  <span
                    className={`shrink-0 text-[10px] uppercase ${
                      t.direction === "long" ? "text-emerald-400" : "text-primary"
                    }`}
                  >
                    {t.direction}
                  </span>
                </div>
                <p
                  className={`mt-0.5 font-mono text-sm font-bold tabular-nums ${
                    r >= 0 ? "text-emerald-400" : "text-primary"
                  }`}
                >
                  {fmtR(r)}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-3 border-t border-border/60 pt-2.5">
            {focusDemon ? (
              <div
                className="flex items-start gap-2 rounded-md border border-primary/40 bg-primary/5 px-2.5 py-2"
                data-testid="weekly-focus-demon"
              >
                <Flame className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                <p className="text-[11px] font-semibold leading-snug text-primary">
                  Focus for next week: eliminate {focusDemon.name} ({focusDemon.count}{" "}
                  {focusDemon.count === 1 ? "time" : "times"} this week)
                </p>
              </div>
            ) : (
              <p className="text-[11px] leading-snug text-muted-foreground" data-testid="weekly-focus-demon">
                No demons tagged this week — nothing to fix. Keep the discipline.
              </p>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
