import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Ban, ShieldAlert, ShieldCheck, Skull, Timer } from "lucide-react";
import type { MistakeTag, TradeWithTags } from "@shared/schema";
import { useMistakeTags, useStyles, useTrades } from "@/lib/data";
import {
  computeMetrics,
  fmtMoney,
  DAILY_LOSS_ALERT,
  DAILY_LOSS_STOP,
  LOSS_STREAK_LIMIT,
  COOLDOWN_SECONDS,
} from "@shared/metrics";
import { DEMON_GUARDRAIL_STREAK, demonStats, type DemonStat } from "@shared/demons";
import { filterByStyle, styleName } from "@/lib/style-filter";

/* ------------------------- demon guardrail state ------------------------ */

/**
 * The guardrail can be tripped two ways now:
 *   1. the original R / $ loss rules (daily stop, loss streak), and
 *   2. the same demon logged on N consecutive trades (DEMON_GUARDRAIL_STREAK).
 * Both produce the same locked "stop trading" state. The demon lock clears
 * only when the trader explicitly acknowledges it; a longer streak (or a
 * different demon) trips it again, because the ack key includes the streak.
 *
 * Streaks are measured per trading style. A scalping spiral must not lock the
 * swing book, so both the streak and the acknowledgement are keyed by style.
 * Several styles can therefore be locked independently at the same time.
 */
const AckCtx = createContext<{
  acked: Set<string>;
  acknowledge: (key: string) => void;
}>({ acked: new Set(), acknowledge: () => {} });

export function GuardrailProvider({ children }: { children: React.ReactNode }) {
  const [acked, setAcked] = useState<Set<string>>(() => new Set());
  const value = useMemo(
    () => ({
      acked,
      acknowledge: (key: string) => setAcked((prev) => new Set(prev).add(key)),
    }),
    [acked],
  );
  return <AckCtx.Provider value={value}>{children}</AckCtx.Provider>;
}

export interface DemonGuard {
  demon: DemonStat | null;
  /** Which style tripped it — relevant when viewing "All styles". */
  styleId: number | null;
  locked: boolean;
  ackKey: string | null;
  acknowledge: () => void;
}

/**
 * @param styleId the style to guard, or null to report the worst breach across
 * every style (an overview — the per-style locks themselves stay independent).
 */
export function useDemonGuard(
  styleId: number | null,
  tradesIn?: TradeWithTags[],
  tagsIn?: MistakeTag[],
): DemonGuard {
  const { data: fetchedTrades = [] } = useTrades();
  const { data: fetchedTags = [] } = useMistakeTags();
  const allTrades = tradesIn ?? fetchedTrades;
  const tags = tagsIn ?? fetchedTags;
  const { acked, acknowledge } = useContext(AckCtx);

  const breach = useMemo(() => {
    const worstFor = (id: number | null) => {
      const scoped = filterByStyle(allTrades, id);
      const d = demonStats(scoped, tags).find(
        (s) => s.currentStreak >= DEMON_GUARDRAIL_STREAK,
      );
      return d ? { demon: d, styleId: id } : null;
    };

    if (styleId != null) return worstFor(styleId);

    // "All styles" — never pool trades across books; check each independently.
    const ids = Array.from(new Set(allTrades.map((t) => t.styleId)));
    const hits = ids.map(worstFor).filter((h): h is NonNullable<typeof h> => h != null);
    if (!hits.length) return null;
    return hits.reduce((a, b) =>
      b.demon.currentStreak > a.demon.currentStreak ? b : a,
    );
  }, [allTrades, tags, styleId]);

  const ackKey = breach
    ? `${breach.styleId ?? "none"}:${breach.demon.id}:${breach.demon.currentStreak}`
    : null;

  return {
    demon: breach?.demon ?? null,
    styleId: breach?.styleId ?? null,
    locked: ackKey != null && !acked.has(ackKey),
    ackKey,
    acknowledge: () => ackKey && acknowledge(ackKey),
  };
}

function isToday(iso: string | null) {
  if (!iso) return false;
  const d = new Date(iso);
  const n = new Date();
  return (
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate()
  );
}

export function useDailyStats(trades: TradeWithTags[]) {
  return useMemo(() => {
    const today = trades
      .filter((t) => t.status === "closed" && isToday(t.exitTime))
      .sort((a, b) => (a.exitTime! < b.exitTime! ? -1 : 1));

    let wins = 0;
    let losses = 0;
    let pnl = 0;
    for (const t of today) {
      const m = computeMetrics(t);
      pnl += m.actualPnL ?? 0;
      if ((m.actualPnL ?? 0) >= 0) wins++;
      else losses++;
    }

    let streak = 0;
    let streakType: "win" | "loss" | null = null;
    for (let i = today.length - 1; i >= 0; i--) {
      const r = computeMetrics(today[i]).actualPnL ?? 0;
      const type = r >= 0 ? "win" : "loss";
      if (!streakType) {
        streakType = type;
        streak = 1;
      } else if (type === streakType) streak++;
      else break;
    }

    const lastExit = today.length ? today[today.length - 1].exitTime : null;
    return {
      total: today.length,
      wins,
      losses,
      pnl,
      streak,
      streakType,
      lastExit,
      isDailyWarning: pnl <= -DAILY_LOSS_ALERT && pnl > -DAILY_LOSS_STOP,
      isDailyStopHit: pnl <= -DAILY_LOSS_STOP,
      isLossStreakHalt: streakType === "loss" && streak >= LOSS_STREAK_LIMIT,
    };
  }, [trades]);
}

export function DailyGuardCard({
  trades,
  tags,
  styleId = null,
}: {
  /** Already scoped to `styleId` by the caller. */
  trades: TradeWithTags[];
  tags?: MistakeTag[];
  styleId?: number | null;
}) {
  const s = useDailyStats(trades);
  const guard = useDemonGuard(styleId, trades, tags);
  const { data: styles = [] } = useStyles();
  const [remaining, setRemaining] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!s.isLossStreakHalt || !s.lastExit) {
      setRemaining(0);
      return;
    }
    const end = new Date(s.lastExit).getTime() + COOLDOWN_SECONDS * 1000;
    const tick = () => setRemaining(Math.max(0, Math.ceil((end - Date.now()) / 1000)));
    tick();
    timer.current = setInterval(tick, 1000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [s.isLossStreakHalt, s.lastExit]);

  const cooling = s.isLossStreakHalt && remaining > 0;
  const tone = s.isDailyStopHit || guard.locked
    ? "border-destructive/60 bg-destructive/10"
    : cooling || s.isLossStreakHalt
      ? "border-primary/40 bg-primary/5"
      : s.isDailyWarning
        ? "border-amber-500/40 bg-amber-500/5"
        : "border-card-border bg-card";

  return (
    <Card className={`p-3.5 sm:p-4 ${tone}`} data-testid="card-daily-guard">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-2">
          {s.isDailyStopHit || guard.locked ? (
            <Ban className="h-4 w-4 text-destructive" />
          ) : s.isDailyWarning || s.isLossStreakHalt ? (
            <ShieldAlert className="h-4 w-4 text-amber-500" />
          ) : (
            <ShieldCheck className="h-4 w-4 text-emerald-500" />
          )}
          <span className="text-xs font-semibold tracking-tight">Today</span>
        </div>

        <Stat label="Trades" value={String(s.total)} />
        <Stat label="W / L" value={`${s.wins} / ${s.losses}`} />
        <Stat
          label="P&L"
          value={fmtMoney(s.pnl)}
          tone={s.pnl > 0 ? "up" : s.pnl < 0 ? "down" : undefined}
          testId="text-daily-pnl"
        />
        <Stat
          label="Streak"
          value={s.streak ? `${s.streak}${s.streakType === "win" ? "W" : "L"}` : "—"}
          tone={s.streakType === "win" ? "up" : s.streakType === "loss" ? "down" : undefined}
        />
        <Stat
          label="Daily stop"
          value={`${fmtMoney(-DAILY_LOSS_STOP)}`}
          tone={s.isDailyStopHit ? "down" : undefined}
        />
      </div>

      {guard.locked && guard.demon && (
        <div
          className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/60 pt-2.5"
          data-testid="banner-demon-guardrail"
        >
          <p className="flex min-w-0 flex-1 items-start gap-1.5 text-[11px] font-semibold text-destructive">
            <Skull className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>
              Stop trading {styleId == null && `${styleName(styles, guard.styleId)} `}— “
              {guard.demon.name}” on {guard.demon.currentStreak} trades in a row. Fix the rule
              before the next entry.
            </span>
          </p>
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 text-[11px]"
            onClick={guard.acknowledge}
            data-testid="button-acknowledge-demon"
          >
            I acknowledge
          </Button>
        </div>
      )}

      {(s.isDailyStopHit || s.isLossStreakHalt || s.isDailyWarning) && (
        <div className="mt-3 border-t border-border/60 pt-2.5">
          {s.isDailyStopHit ? (
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-destructive" data-testid="text-halt">
              <Ban className="h-3.5 w-3.5 shrink-0" />
              Daily loss stop hit — you are done for today. Flatten and walk away.
            </p>
          ) : s.isLossStreakHalt ? (
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-primary" data-testid="text-halt">
              <Timer className="h-3.5 w-3.5 shrink-0" />
              {LOSS_STREAK_LIMIT} losses in a row —{" "}
              {cooling ? `forced break: ${remaining}s left.` : "cooldown complete. Trade carefully."}
            </p>
          ) : (
            <p className="flex items-center gap-1.5 text-[11px] font-medium text-amber-500" data-testid="text-halt">
              <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
              Warning zone — {fmtMoney(-DAILY_LOSS_ALERT)} breached. One more loser ends the day.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function Stat({
  label,
  value,
  tone,
  testId,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
  testId?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p
        data-testid={testId}
        className={`font-mono text-sm font-bold ${
          tone === "up" ? "text-emerald-400" : tone === "down" ? "text-primary" : "text-foreground"
        }`}
      >
        {value}
      </p>
    </div>
  );
}
