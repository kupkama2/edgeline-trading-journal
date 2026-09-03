import { useEffect, useMemo, useRef, useState } from "react";
import { store } from "@/lib/scoped-storage";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Award, Flame, Sparkles } from "lucide-react";
import { useDailyNotes, useTrades, useWeeklyReviews } from "@/lib/data";
import { computeProgression, type Progression } from "@shared/xp";

/**
 * Progression UI — the deliberately un-Robinhood kind.
 *
 * Nothing here reacts to P&L. The chip, the bar, the toasts and the one burst
 * animation all key off PROCESS events (a rationale written, a week reviewed),
 * because the moment a trading app celebrates outcomes it starts training the
 * user to produce outcomes — which means trading more. Regulators wrote that
 * one up already; we only celebrate the journal.
 */

/** Account-level on purpose: discipline doesn't reset when you switch books. */
export function useProgression(): Progression & { ready: boolean } {
  const trades = useTrades();
  const notes = useDailyNotes();
  const reviews = useWeeklyReviews();
  /*
   * "Ready" means all three queries have answered at least once. Until then
   * the progression is computed over empty arrays and is not a baseline of
   * anything — it is the shape of a journal with nothing in it.
   */
  const ready = trades.isFetched && notes.isFetched && reviews.isFetched;
  return useMemo(
    () => ({
      ...computeProgression(trades.data ?? [], notes.data ?? [], reviews.data ?? []),
      ready,
    }),
    [trades.data, notes.data, reviews.data, ready],
  );
}

/**
 * The toast's line-by-line, with repeats folded.
 *
 * Four trades earning the same +5 is one fact, not four lines of the same
 * text — and the cap of four lines was being spent entirely on copies.
 */
export function itemise(events: { label: string; points: number }[]): string {
  const seen = new Map<string, { points: number; n: number }>();
  for (const e of events) {
    const cur = seen.get(e.label);
    if (cur) cur.n += 1;
    else seen.set(e.label, { points: e.points, n: 1 });
  }
  return Array.from(seen.entries())
    .slice(0, 4)
    .map(([label, { points, n }]) => `${label} +${points}${n > 1 ? ` ×${n}` : ""}`)
    .join(" · ");
}

const SEEN_KEY = "edgeline.xp.seen";

/**
 * Turns XP deltas into feedback at the moment they happen.
 *
 * The last acknowledged total lives in localStorage, so opening the app after
 * a week of entries does not detonate a backlog of toasts — only XP earned
 * while the page is open is celebrated, and the rest is silently absorbed.
 */
export function XpToaster() {
  const p = useProgression();
  const { toast } = useToast();
  const [burst, setBurst] = useState<null | "level" | "clean">(null);
  const prev = useRef<{ ids: Set<string>; level: number } | null>(null);

  useEffect(() => {
    /*
     * Not before the data is in. The first render happens while the queries
     * are still loading, so "the backlog" it absorbed was an empty list — and
     * the moment the trades arrived, every event in the journal was new
     * against it. That fired a level-up toast on every single page load, with
     * a level jump from 1 to wherever the account actually is, and the four
     * lines under it were four copies of whatever event came first.
     */
    if (!p.ready) return;
    const ids = new Set(p.events.map((e) => e.id));
    if (!prev.current) {
      // First render WITH data absorbs the backlog silently — opening the app
      // after a week of entries must not detonate a pile of toasts.
      prev.current = { ids, level: p.level.level };
      store.set(SEEN_KEY, String(p.level.totalXp));
      return;
    }

    // Diffing event IDs rather than totals is what makes the reward
    // INFORMATIONAL (the SDT rule): the toast can say which acts earned,
    // not just how much arrived.
    const fresh = p.events.filter((e) => !prev.current!.ids.has(e.id));
    const lastLevel = prev.current.level;
    prev.current = { ids, level: p.level.level };
    if (!fresh.length) return;

    const gained = fresh.reduce((a, e) => a + e.points, 0);
    const itemised = itemise(fresh);
    const clean = fresh.some((e) => e.id.endsWith(":clean"));

    const fire = (kind: "level" | "clean") => {
      setBurst(kind);
      setTimeout(() => setBurst(null), 1400);
    };

    if (p.level.level > lastLevel) {
      fire("level");
      toast({
        title: `Level ${p.level.level} — ${p.level.title}`,
        description: itemised || "Earned by process, not P&L. Keep writing.",
      });
    } else if (clean) {
      // The one moment that gets its own flourish besides levelling: a close
      // with no demons on it. Not because it won — the toast would fire the
      // same on a stopped-out trade — but because nothing went wrong that
      // you did to yourself.
      fire("clean");
      toast({ title: `Clean close · +${gained} XP`, description: itemised });
    } else {
      toast({ title: `+${gained} XP`, description: itemised });
    }
    store.set(SEEN_KEY, String(p.level.totalXp));
  }, [p.ready, p.events, p.level.totalXp, p.level.level, p.level.title, toast]);

  if (!burst) return null;
  return (
    <div
      className={`xp-burst pointer-events-none fixed inset-0 z-[100] ${
        burst === "clean" ? "xp-burst--clean" : ""
      }`}
      aria-hidden
    >
      {Array.from({ length: burst === "clean" ? 10 : 18 }, (_, i) => (
        <span key={i} style={{ ["--i" as any]: i }} />
      ))}
    </div>
  );
}

/** The header chip: level in a progress ring. Quiet until hovered. */
export function XpChip() {
  const p = useProgression();
  const deg = Math.round(p.level.progress * 360);
  return (
    <div
      className="flex h-8 w-8 items-center justify-center rounded-full"
      style={{
        background: `conic-gradient(hsl(var(--primary)) ${deg}deg, hsl(var(--secondary)) ${deg}deg)`,
      }}
      title={`Level ${p.level.level} · ${p.level.title} — ${p.level.into}/${p.level.span} XP${
        p.streak.days > 0 ? ` · ${p.streak.days}-day discipline streak` : ""
      }`}
      data-testid="chip-xp"
    >
      <div className="flex h-6 w-6 items-center justify-center rounded-full bg-background font-mono text-[10px] font-bold">
        {p.level.level}
      </div>
    </div>
  );
}

/** The dashboard card: level, streak, and what actually earns XP. */
export function ProgressionCard() {
  const p = useProgression();
  return (
    <Card className="border-card-border bg-card p-4" data-testid="card-progression">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 font-mono text-lg font-bold text-primary">
            {p.level.level}
          </div>
          <div>
            <p className="text-sm font-semibold tracking-tight" data-testid="text-level-title">
              {p.level.title}
            </p>
            <p className="font-mono text-[10px] text-muted-foreground">
              {p.level.into} / {p.level.span} XP to level {p.level.level + 1}
            </p>
          </div>
        </div>

        <div className="min-w-32 flex-1">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary/60">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-700"
              style={{ width: `${Math.max(2, p.level.progress * 100)}%` }}
            />
          </div>
        </div>

        <div
          className="flex items-center gap-1.5"
          title="Consecutive journaled trading days. Days you didn't trade don't break it; trading silently does."
          data-testid="text-streak"
        >
          <Flame
            className={`h-4 w-4 ${p.streak.days > 0 ? "text-amber-500" : "text-muted-foreground/40"}`}
          />
          <span className="font-mono text-sm font-semibold">{p.streak.days}</span>
          <span className="text-[10px] text-muted-foreground">
            day{p.streak.days === 1 ? "" : "s"}
            {p.streak.days > 0 && !p.streak.todayDone && " · today still open"}
          </span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {p.achievements.map((a) => (
          <span
            key={a.id}
            title={a.desc}
            data-testid={`badge-ach-${a.id}`}
            className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${
              a.earned
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "border-border text-muted-foreground/50"
            }`}
          >
            <Award className={`h-2.5 w-2.5 ${a.earned ? "text-primary" : ""}`} />
            {a.name}
          </span>
        ))}
      </div>

      <p className="mt-2.5 flex items-start gap-1.5 text-[10px] leading-snug text-muted-foreground">
        <Sparkles className="mt-px h-3 w-3 shrink-0" />
        XP is paid for process — rationale written, levels set, days reviewed. Never for P&L,
        and never for trading more. A losing trade journaled well earns exactly what a winner
        does.
      </p>
    </Card>
  );
}
