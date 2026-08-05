import { useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Ban, ShieldAlert, ShieldCheck, Timer } from "lucide-react";
import type { TradeWithTags } from "@shared/schema";
import {
  computeMetrics,
  fmtMoney,
  DAILY_LOSS_ALERT,
  DAILY_LOSS_STOP,
  LOSS_STREAK_LIMIT,
  COOLDOWN_SECONDS,
} from "@shared/metrics";

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

export function DailyGuardCard({ trades }: { trades: TradeWithTags[] }) {
  const s = useDailyStats(trades);
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
  const tone = s.isDailyStopHit
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
          {s.isDailyStopHit ? (
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
