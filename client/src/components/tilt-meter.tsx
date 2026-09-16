import { Button } from "@/components/ui/button";
import { Footprints, Skull } from "lucide-react";
import { fmtMoney } from "@shared/metrics";
import { TILT_SEGMENTS, WALK_MINUTES, type TiltMeter as Meter } from "@shared/tilt";
import type { TiltGuard } from "@/components/daily-guard";

/**
 * The day, as a gauge you cannot miss.
 *
 * Five segments. Each tilt trade logged today lights one; a losing streak
 * at the guard's limit lights one more; the daily stop lights them all.
 * Three lit and the entry form turns strict. Five and it locks: the words
 * on the card are "go take a walk", the countdown is the walk, and nothing
 * logs as a plan trade until it has been walked and acknowledged.
 *
 * It sits inside the Today card so that opening the journal answers "how
 * am I doing today" with the number of trades, the losses in a row, and
 * how close the day is to being taken off you — before the form is even
 * in view.
 */
export function TiltMeterBar({ guard, book = "" }: { guard: TiltGuard; book?: string }) {
  const { meter, locked, remainingMs, acked, acknowledge } = guard;
  const m = meter;
  const fill = fillClass(m);
  const walkOver = m.walkEndsAt != null && remainingMs === 0;

  return (
    <div className="mt-3 border-t border-border/60 pt-2.5" data-testid="tilt-meter" data-state={locked ? "locked" : m.state}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex items-center gap-1.5">
          <Skull className={`h-3.5 w-3.5 shrink-0 ${iconClass(m, locked)}`} />
          <span className="text-xs font-semibold tracking-tight">Tilt meter</span>
          <span className={`font-mono text-[10px] uppercase tracking-wider ${iconClass(m, locked)}`} data-testid="text-tilt-state">
            {locked ? "locked" : m.state === "strict" ? "strict" : m.state === "warm" ? "warming" : "calm"}
          </span>
        </div>

        {/* The bar. Big enough to be the first thing on the page. */}
        <div className="flex flex-1 basis-40 items-center gap-1" role="meter" aria-valuemin={0} aria-valuemax={TILT_SEGMENTS} aria-valuenow={m.filled} aria-label="Tilt" data-testid="tilt-bar">
          {Array.from({ length: TILT_SEGMENTS }, (_, i) => (
            <span
              key={i}
              className={`h-3 flex-1 rounded-sm transition-colors ${i < m.filled ? fill : "bg-border/70"}`}
              data-testid={`tilt-segment-${i}`}
              data-lit={i < m.filled}
            />
          ))}
        </div>

        <span className="font-mono text-[11px] text-muted-foreground" data-testid="text-tilt-counts">
          {m.tradesToday} {m.tradesToday === 1 ? "trade" : "trades"} today · {m.tiltToday} tilt ·{" "}
          {m.lossStreak} {m.lossStreak === 1 ? "loss" : "losses"} in a row
        </span>
      </div>

      {m.reasons.length > 0 && (
        <p className="mt-1.5 text-[10px] text-muted-foreground" data-testid="text-tilt-reasons">
          Lit by {m.reasons.map((r) => r.label).join(", ")}.
        </p>
      )}

      {locked ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="banner-tilt-lock">
          <p className="flex items-center gap-2 text-base font-bold tracking-tight text-destructive">
            <Footprints className="h-5 w-5 shrink-0" />
            Go take a walk.
          </p>
          <p className="text-[11px] text-destructive/90">
            {walkOver
              ? "The walk is over. Say so, and the form goes strict instead of locked."
              : `${fmtCountdown(remainingMs)} left. Until then nothing logs as a plan trade — only as tilt.`}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 text-[11px]"
            disabled={!walkOver}
            onClick={acknowledge}
            data-testid="button-tilt-walked"
          >
            {walkOver ? "I took the walk" : `Back in ${fmtCountdown(remainingMs)}`}
          </Button>
        </div>
      ) : m.state === "strict" || (m.state === "locked" && acked) ? (
        <p className="mt-2 text-[11px] font-semibold text-primary" data-testid="text-tilt-strict">
          Strict. The next {book && `${book} `}entry logs as tilt unless you write down why it is in the plan.
        </p>
      ) : null}

      {m.tiltToday > 0 && guard.today && (
        <p className="mt-1.5 text-[11px] text-muted-foreground" data-testid="text-tilt-today">
          In plan today: {guard.today.plan.count} {guard.today.plan.count === 1 ? "trade" : "trades"},{" "}
          <Money v={guard.today.plan.pnl} />. Tilt: {guard.today.tilt.count}{" "}
          {guard.today.tilt.count === 1 ? "trade" : "trades"}, <Money v={guard.today.tilt.pnl} />.
        </p>
      )}
    </div>
  );
}

function Money({ v }: { v: number }) {
  return (
    <span className={`font-mono ${v > 0 ? "text-emerald-400" : v < 0 ? "text-primary" : ""}`}>
      {fmtMoney(v)}
    </span>
  );
}

function fillClass(m: Meter): string {
  return m.state === "locked" ? "bg-destructive" : m.state === "strict" ? "bg-primary" : "bg-amber-500";
}

function iconClass(m: Meter, locked: boolean): string {
  return locked || m.state === "locked"
    ? "text-destructive"
    : m.state === "strict"
      ? "text-primary"
      : m.state === "warm"
        ? "text-amber-500"
        : "text-muted-foreground";
}

/** "27:41" — the walk is minutes, so hours are not worth a third field. */
export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

export { WALK_MINUTES };
