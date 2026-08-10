/**
 * Everything the log adds up to, on one tab.
 *
 * Dashboard and Analysis were two nav items asking the same question from
 * different angles, and the split forced a choice before you knew which half
 * held the answer — so both were visited every time. They are one page now,
 * with a switch between the two halves:
 *
 *   Edge     — what the record is worth: equity, the distribution behind the
 *              expectancy, how far trades travelled, the slices, the
 *              simulation, the trades you skipped.
 *   Habits   — what you did with it: management against the untouched plan,
 *              exit quality, what the demons cost, the XP and the weekly
 *              review.
 *
 * The two halves keep their own files; this is the shell that owns the page
 * title, the book switcher and the switch. Both halves render lazily — only
 * the visible one is mounted, so the heavy charts on the other side cost
 * nothing until asked for.
 */
import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { BarChart3, Repeat } from "lucide-react";
import { StyleSwitcher } from "@/components/style-switcher";
import { useStyleScopedTrades } from "@/lib/style-filter";
import { useTrades } from "@/lib/data";
import { closedTrades } from "@shared/breakdowns";
import Analysis from "@/pages/analysis";
import Dashboard from "@/pages/dashboard";
import { scrollToAnchor, takeJumpSection } from "@/lib/jump";

/**
 * The anchor waiting to be scrolled to, read during the very first render so
 * the half is already correct by the time anything mounts. Module scope rather
 * than state: it must survive the render that consumed it without causing a
 * second one, and it is cleared the moment it is used.
 */
let pendingAnchor: string | null = null;

const HALVES = [
  { id: "edge", label: "Edge", icon: BarChart3 },
  { id: "habits", label: "Habits", icon: Repeat },
] as const;

type Half = (typeof HALVES)[number]["id"];

export default function Stats() {
  // The two old addresses still name a half, and following one has to switch
  // to it even when this page is already mounted — otherwise a bookmark to
  // /analysis silently shows whichever half was last looked at.
  const [onDashboard] = useRoute("/dashboard");
  const [onAnalysis] = useRoute("/analysis");
  // A figure clicked on the homepage names both the half and the card, since
  // neither is recoverable from the URL. Consumed once, on arrival.
  const [half, setHalf] = useState<Half>(() => {
    const jump = takeJumpSection();
    if (jump) {
      pendingAnchor = jump.anchor;
      return jump.half;
    }
    return onDashboard ? "habits" : "edge";
  });
  useEffect(() => {
    if (pendingAnchor) {
      scrollToAnchor(pendingAnchor);
      pendingAnchor = null;
      return;
    }
    if (onDashboard) setHalf("habits");
    else if (onAnalysis) setHalf("edge");
  }, [onDashboard, onAnalysis]);
  const { data: trades = [] } = useTrades();
  const scoped = useStyleScopedTrades(trades);
  const n = closedTrades(scoped).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Stats</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {n} closed {n === 1 ? "trade" : "trades"} —{" "}
            {half === "edge"
              ? "what the record is worth, and where it comes from."
              : "what your management and your habits are doing to it."}
          </p>
        </div>
        <StyleSwitcher />
      </div>

      <div
        className="inline-flex rounded-lg border border-border bg-secondary/30 p-0.5"
        role="tablist"
        aria-label="Which half of the stats"
      >
        {HALVES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={half === id}
            onClick={() => setHalf(id)}
            data-testid={`tab-stats-${id}`}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              half === id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {half === "edge" ? <Analysis embedded /> : <Dashboard embedded />}
    </div>
  );
}
