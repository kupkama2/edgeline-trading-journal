import { Crosshair, Flag, LogOut, ShieldAlert, Target } from "lucide-react";
import { num } from "@/components/trade-shared";

/**
 * The four decisions, given a shape.
 *
 * Entry, stop, target and exit are the whole trade — everything else in this
 * app is arithmetic on them — and until now they were four identical grey
 * labels over four identical boxes, scattered across a form in the order the
 * schema happened to list them. Nothing said which one was the protection and
 * which was the goal, and nothing showed the one thing a trader actually reads
 * off a plan in a glance: how far the stop is compared to how far the target
 * is.
 *
 * So each level gets a colour and a mark that mean the same thing everywhere
 * — the same red for the stop as the chart draws it with, the same green for
 * the target — and the numbers get a picture underneath them.
 */

export type LevelKind = "entry" | "stop" | "target" | "tp" | "exit";

/**
 * One vocabulary for the whole app. The chart already draws the stop red and
 * the target green; a form that coloured them differently would be teaching
 * two languages for one idea.
 */
export const LEVEL: Record<
  LevelKind,
  { icon: typeof Target; text: string; dot: string; label: string }
> = {
  entry: { icon: Crosshair, text: "text-foreground/70", dot: "bg-foreground/60", label: "Entry" },
  stop: { icon: ShieldAlert, text: "text-red-400", dot: "bg-red-500", label: "Stop" },
  target: { icon: Target, text: "text-emerald-400", dot: "bg-emerald-500", label: "Target" },
  tp: { icon: Flag, text: "text-emerald-400/80", dot: "bg-emerald-500/70", label: "TP" },
  exit: { icon: LogOut, text: "text-sky-400", dot: "bg-sky-400", label: "Exit" },
};

/** The label above a price input: an icon, the word, and room for a control. */
export function LevelLabel({
  kind,
  text,
  children,
}: {
  kind: LevelKind;
  text?: string;
  children?: React.ReactNode;
}) {
  const l = LEVEL[kind];
  const Icon = l.icon;
  return (
    <div className="flex items-center justify-between gap-2">
      <span
        className={`flex items-center gap-1 text-[10px] uppercase tracking-wider ${l.text}`}
        data-testid={`level-label-${kind}`}
      >
        <Icon className="h-3 w-3" />
        {text ?? l.label}
      </span>
      {children}
    </div>
  );
}

interface Mark {
  kind: LevelKind;
  price: number;
  label: string;
}

/**
 * The plan, to scale.
 *
 * A price axis low to high with the levels sitting on it where they actually
 * are, the risk leg painted red and the reward leg green. It reads the same
 * for a short as for a long without a special case, because the legs are drawn
 * from the entry OUTWARDS — entry-to-stop is risk whichever side of the entry
 * the stop happens to be on.
 *
 * The point is proportion. "Stop 79904, target 76518" is two numbers to
 * subtract; a reward leg three times the length of the risk leg is a fact you
 * see before you have finished reading it — and so is a stop that is nearly as
 * far away as the target, which is the plan you want to catch before you take
 * it rather than after.
 */
export function LevelLadder({
  entry,
  stop,
  target,
  extraTps = [],
  exit,
  className = "",
}: {
  entry?: number | null;
  stop?: number | null;
  target?: number | null;
  extraTps?: (number | null | undefined)[];
  exit?: number | null;
  className?: string;
}) {
  const ok = (v: unknown): v is number => typeof v === "number" && isFinite(v);
  if (!ok(entry) || (!ok(stop) && !ok(target))) return null;

  const marks: Mark[] = [{ kind: "entry", price: entry, label: "Entry" }];
  if (ok(stop)) marks.push({ kind: "stop", price: stop, label: "Stop" });
  if (ok(target)) marks.push({ kind: "target", price: target, label: "Target" });
  extraTps.forEach((p, i) => ok(p) && marks.push({ kind: "tp", price: p, label: `TP${i + 2}` }));
  if (ok(exit)) marks.push({ kind: "exit", price: exit, label: "Exit" });

  const prices = marks.map((m) => m.price);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const span = hi - lo;
  // Every level on one price: nothing to draw and nothing to say.
  if (!(span > 0)) return null;
  const at = (p: number) => ((p - lo) / span) * 100;

  const risk = ok(stop) ? Math.abs(entry - stop) : null;
  const reward = ok(target) ? Math.abs(target - entry) : null;
  const rr = risk && reward && risk > 0 ? reward / risk : null;

  /** A leg of the plan, drawn from the entry out to a level. */
  const leg = (to: number, cls: string) => {
    const a = Math.min(at(entry), at(to));
    const b = Math.max(at(entry), at(to));
    return (
      <div
        className={`absolute top-1/2 h-1 -translate-y-1/2 rounded-full ${cls}`}
        style={{ left: `${a}%`, width: `${b - a}%` }}
      />
    );
  };

  return (
    <div className={`space-y-2 ${className}`} data-testid="level-ladder">
      <div className="relative h-6">
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
        {ok(stop) && leg(stop, "bg-red-500/50")}
        {ok(target) && leg(target, "bg-emerald-500/50")}
        {marks.map((m) => (
          <div
            key={`${m.kind}-${m.price}`}
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${at(m.price)}%` }}
            title={`${m.label} ${num(m.price)}`}
            data-testid={`ladder-mark-${m.kind}`}
          >
            <div
              className={`h-2.5 w-2.5 rounded-full ring-2 ring-card ${LEVEL[m.kind].dot}`}
            />
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
        {marks.map((m) => (
          <span key={`${m.kind}-${m.price}-t`} className={`flex items-center gap-1 ${LEVEL[m.kind].text}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${LEVEL[m.kind].dot}`} />
            {m.label} <span className="font-mono text-foreground/80">{num(m.price)}</span>
          </span>
        ))}
        {rr != null && (
          <span className="ml-auto font-mono text-muted-foreground" data-testid="ladder-rr">
            {rr.toFixed(2)}R to target
          </span>
        )}
      </div>
    </div>
  );
}
