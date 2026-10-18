import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CalendarCheck, CalendarClock, Lock } from "lucide-react";
import { useAllTrades } from "@/lib/data";
import { CURRENT, useChapters } from "@/lib/chapters";
import { chapterTrades } from "@shared/chapters";
import { usePrefs } from "@/lib/prefs";
import { store } from "@/lib/scoped-storage";
import { dayKey } from "@shared/review";
import {
  SNOOZE_MS,
  canSnooze,
  debtSentence,
  gateShut,
  owedDayName,
  reviewDebt,
  type ReviewDebt,
  type ReviewMode,
} from "@shared/review-pressure";

/**
 * The review, pushed.
 *
 * The rule is in shared/review-pressure.ts. This is where it is felt:
 *
 *   - a count on the Review tab, on every page, the whole time anything is
 *     owed — so the debt is never out of sight;
 *   - a banner at the top of the journal, amber while it is fresh and red
 *     once it is late;
 *   - and, when you have asked for it in Settings, a gate: the record and
 *     the statistics stay shut until the overdue days are gone over.
 *
 * What the gate never shuts is anything live. Logging a trade, the open
 * positions and their stops stay exactly where they are — a journal that
 * blocked you from recording a trade would get the trade unrecorded, and one
 * that hid an open position would be hiding risk. What it withholds is the
 * thing you come to look at: how the record is doing. That is the leverage,
 * and the price is a minute a trade.
 *
 * There is a way past it, once a day for an hour, for the morning a number
 * is needed in a hurry. It is offered plainly rather than hidden, because a
 * rule with no exit gets switched off, and a switched-off rule pushes nobody.
 */
const SNOOZE_KEY = "edgeline.reviewSnooze";

type Snooze = { day: string; until: number } | null;

function readSnooze(): Snooze {
  try {
    const raw = store.get(SNOOZE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v.day === "string" && typeof v.until === "number" ? v : null;
  } catch {
    return null;
  }
}

/** The minute, so a debt that becomes overdue at midnight shows it without a reload. */
function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export interface ReviewPressure {
  mode: ReviewMode;
  debt: ReviewDebt;
  /** The record and the statistics are shut right now. */
  shut: boolean;
  /** An hour's way past the gate is still available today. */
  snoozable: boolean;
  snooze: () => void;
}

export function useReviewPressure(): ReviewPressure {
  // The chapter being written now, whatever chapter a page is showing: the
  // review owed is today's debt, and looking at last quarter on the stats
  // page must neither add last quarter's backlog to it nor hide this week's.
  const { data: all = [] } = useAllTrades();
  const { chapters } = useChapters();
  const trades = useMemo(() => chapterTrades(all, chapters, CURRENT), [all, chapters]);
  const prefs = usePrefs();
  const now = useMinute();
  const [snoozed, setSnoozed] = useState<Snooze>(readSnooze);
  const debt = useMemo(
    () => reviewDebt(trades, now, { gateSince: prefs.reviewEnforcedSince }),
    [trades, now, prefs.reviewEnforcedSince],
  );
  return {
    mode: prefs.reviewMode,
    debt,
    shut: gateShut(prefs.reviewMode, debt, snoozed, now),
    snoozable: canSnooze(snoozed, now),
    snooze: () => {
      const s = { day: dayKey(new Date()), until: Date.now() + SNOOZE_MS };
      store.set(SNOOZE_KEY, JSON.stringify(s));
      setSnoozed(s);
    },
  };
}

/** The count on the Review tab. Red once anything is late, amber while it is only owed. */
export function ReviewTabBadge() {
  const { mode, debt } = useReviewPressure();
  if (mode === "off") return null;
  const n = debt.owed + debt.today.length;
  if (n === 0) return null;
  const tone =
    debt.level === "overdue"
      ? "bg-destructive text-destructive-foreground"
      : debt.level === "owed"
        ? "bg-amber-500 text-black"
        : "bg-secondary text-muted-foreground";
  return (
    <span
      className={`ml-0.5 min-w-4 rounded-full px-1 text-center font-mono text-[9px] font-bold leading-4 ${tone}`}
      title={debtSentence(debt)}
      data-testid="badge-review-debt"
    >
      {n}
    </span>
  );
}

/**
 * The banner at the top of the journal.
 *
 * Absent when nothing is owed and when the gate is showing instead — two
 * messages about one debt is the second one being ignored.
 */
export function ReviewDebtBanner({ pressure }: { pressure: ReviewPressure }) {
  const { mode, debt, shut } = pressure;
  if (mode === "off" || shut || debt.level === "clear") return null;
  const late = debt.level === "overdue";
  const quiet = debt.level === "today";
  const target = debt.next ?? dayKey(new Date());
  const name = debt.days.length ? owedDayName(debt.days[0]) : "today";
  return (
    <Card
      className={`p-3 ${
        late
          ? "border-destructive/60 bg-destructive/10"
          : quiet
            ? "border-border bg-secondary/20"
            : "border-amber-500/40 bg-amber-500/5"
      }`}
      data-testid="card-review-debt"
      data-level={debt.level}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {quiet ? (
          <CalendarCheck className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <CalendarClock className={`h-4 w-4 shrink-0 ${late ? "text-destructive" : "text-amber-500"}`} />
        )}
        <div className="min-w-0 flex-1">
          <p
            className={`text-sm font-semibold tracking-tight ${
              late ? "text-destructive" : quiet ? "text-foreground" : "text-amber-500"
            }`}
            data-testid="text-review-debt"
          >
            {debtSentence(debt)}
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            {quiet
              ? "Tonight, while you still remember why. A minute a trade."
              : late && mode === "enforce" && debt.gate
                ? "These are past the grace. The record and the stats will stay shut until they are gone over."
                : late && mode === "enforce"
                  ? "Late, but from before you switched enforcement on — they lock nothing. Anything from now on will."
                  : late
                  ? "Every day it waits, the reasons get harder to remember and easier to invent."
                  : "Yesterday's, while it is still yesterday."}
          </p>
        </div>
        <Button asChild size="sm" variant={quiet ? "outline" : "default"} className="h-8 shrink-0 text-[11px]">
          <Link href={`/review/day/${target}`} data-testid="link-review-debt">
            Review {name}
          </Link>
        </Button>
      </div>
    </Card>
  );
}

/**
 * The gate, in place of the record.
 *
 * A list of the days that are owed, oldest first, each one click from its
 * review — the work, laid out, rather than a wall with a lock on it.
 */
export function ReviewGate({ pressure, what }: { pressure: ReviewPressure; what: string }) {
  const { debt, snoozable, snooze } = pressure;
  return (
    <Card className="border-destructive/50 bg-destructive/5 p-4 sm:p-5" data-testid="card-review-gate">
      <div className="flex items-start gap-3">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-sm font-semibold tracking-tight">{what} are shut until the review is done</h2>
          <p className="text-[11px] leading-snug text-muted-foreground">
            You asked for this in Settings. {debtSentence(debt)} Go over them and this opens by
            itself. Logging trades and your open positions are not affected.
          </p>
        </div>
      </div>
      <ul className="mt-3 divide-y divide-border/50 rounded-md border border-card-border bg-card">
        {debt.days.map((d) => (
          <li key={d.key}>
            <Link
              href={`/review/day/${d.key}`}
              className="flex items-center gap-3 px-3 py-2 text-xs transition-colors hover:bg-secondary/40"
              data-testid={`gate-day-${d.key}`}
            >
              <span className="font-semibold capitalize">{owedDayName(d)}</span>
              <span className="font-mono text-muted-foreground">{d.key}</span>
              <span className="ml-auto font-mono">
                {d.trades.length} {d.trades.length === 1 ? "trade" : "trades"}
              </span>
              <span className="text-primary">Review →</span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-[10px] text-muted-foreground">
          {snoozable
            ? "Need a number in a hurry? You can look for an hour, once a day."
            : "The hour for today has been used."}
        </span>
        {snoozable && (
          <Button size="sm" variant="ghost" className="h-7 text-[11px] text-muted-foreground" onClick={snooze} data-testid="button-review-snooze">
            Let me look for an hour
          </Button>
        )}
      </div>
    </Card>
  );
}
