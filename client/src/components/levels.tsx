import {
  ArrowDownRight,
  ArrowUpRight,
  Crosshair,
  Flag,
  LogOut,
  ShieldAlert,
  Target,
} from "lucide-react";
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

export type LevelKind =
  | "entry"
  | "stop"
  | "target"
  | "tp"
  | "exit"
  /* What price DID, as opposed to what you decided. */
  | "mae"
  | "mfe"
  | "ranAfter"
  | "fellAfter";

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
  /*
   * The four facts share the decisions' colours — adverse is red, favourable
   * is green, wherever it happened — because they are answers to the same
   * question in the same units. What separates them is the arrow: a decision
   * is a line you drew, an excursion is a distance price covered.
   */
  mae: { icon: ArrowDownRight, text: "text-red-400/90", dot: "bg-red-400/80", label: "Worst held" },
  mfe: { icon: ArrowUpRight, text: "text-emerald-400/90", dot: "bg-emerald-400/80", label: "Best held" },
  ranAfter: {
    icon: ArrowUpRight,
    text: "text-emerald-400/70",
    dot: "bg-emerald-400/60",
    label: "Ran on to",
  },
  fellAfter: {
    icon: ArrowDownRight,
    text: "text-red-400/70",
    dot: "bg-red-400/60",
    label: "Fell to",
  },
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


/**
 * The axis every graphic here shares: distance from the entry, in your favour.
 *
 * NOT the price. A price axis puts the low number on the left, which for a
 * long happens to mean "the bad end" — and for a short means the opposite, so
 * the same red mark jumps sides depending on which way you were facing. Worse,
 * two stacked bands stop lining up by MEANING: "it fell to 205 after I left"
 * sits to the right of "it dipped to 194 while I held" because 205 is the
 * bigger number, even though one is a smaller loss than the other.
 *
 * Measured from the entry outward, all of that goes away. Zero is where you
 * got in, everything against you is left, everything in your favour is right,
 * and a short reads exactly like a long. Where a stop is known the unit is R,
 * which is what the rest of the journal counts in; without one it is plain
 * distance, which still puts every mark on the correct side.
 */
function favouredAxis(direction: string, entry: number, stop?: number | null) {
  const risk = stop != null && isFinite(stop) ? Math.abs(entry - stop) : null;
  const sign = direction === "short" ? -1 : 1;
  const unit = risk && risk > 0 ? risk : 1;
  return {
    /** Signed: negative against you, positive in your favour. */
    of: (p: number) => (sign * (p - entry)) / unit,
    inR: !!(risk && risk > 0),
  };
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
  direction,
  entry,
  stop,
  target,
  extraTps = [],
  exit,
  className = "",
}: {
  direction: string;
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

  const axis = favouredAxis(direction, entry, stop);
  const ds = marks.map((m) => axis.of(m.price));
  const lo = Math.min(...ds);
  const hi = Math.max(...ds);
  const span = hi - lo;
  // Every level on one price: nothing to draw and nothing to say.
  if (!(span > 0)) return null;
  const at = (p: number) => ((axis.of(p) - lo) / span) * 100;

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


/**
 * How far it went WITH you, and how far it went WITHOUT you.
 *
 * The four excursion fields are the most valuable numbers in the journal and
 * the least legible: four prices in four boxes, and the reader has to do the
 * subtraction, remember which direction is favourable for a short, and hold
 * two ranges in their head to compare them. The comparison IS the insight —
 * "it did most of its work after I left" and "I sat through the whole move and
 * took the middle of it" are different problems with different fixes.
 *
 * So both ranges are drawn on one axis, one above the other, with the
 * favourable end green and the adverse end red on each. Where the stop is
 * known the ends are also priced in R, because "it ran on another 2.4R without
 * me" is a sentence about the trade and "it ran on to 79,604" is a sentence
 * about a number.
 */
export function PathBands({
  direction,
  entry,
  stop,
  exit,
  mae,
  mfe,
  postExitPeak,
  postExitAdverse,
  className = "",
}: {
  direction: string;
  entry?: number | null;
  stop?: number | null;
  exit?: number | null;
  mae?: number | null;
  mfe?: number | null;
  postExitPeak?: number | null;
  postExitAdverse?: number | null;
  className?: string;
}) {
  const ok = (v: unknown): v is number => typeof v === "number" && isFinite(v);
  const held = [mae, mfe].filter(ok);
  const after = [postExitAdverse, postExitPeak].filter(ok);
  if (!ok(entry) || (held.length === 0 && after.length === 0)) return null;

  /*
   * Both bands on ONE axis measured from the entry, which is what makes them
   * comparable at a glance: the adverse ends share a column, the favourable
   * ends share a column, and "further left" means "worse" in both rows rather
   * than "cheaper".
   */
  const axis = favouredAxis(direction, entry, stop);
  const all = [entry, ...held, ...after, ...(ok(exit) ? [exit] : [])].map(axis.of);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = hi - lo;
  if (!(span > 0)) return null;
  const at = (p: number) => ((axis.of(p) - lo) / span) * 100;

  const rTag = (p: number) => {
    if (!axis.inR) return "";
    const r = axis.of(p);
    return ` ${r > 0 ? "+" : ""}${r.toFixed(2)}R`;
  };

  const band = (
    key: string,
    label: string,
    values: number[],
    kinds: { good: LevelKind; bad: LevelKind },
  ) => {
    if (values.length === 0) return null;
    // Best and worst in the trade's own terms, which the axis already knows.
    const good = values.reduce((a, b) => (axis.of(b) > axis.of(a) ? b : a));
    const bad = values.reduce((a, b) => (axis.of(b) < axis.of(a) ? b : a));
    const a = Math.min(at(good), at(bad));
    const b = Math.max(at(good), at(bad));
    return (
      <div className="space-y-1" data-testid={`path-band-${key}`}>
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-[10px] uppercase leading-tight tracking-wider text-muted-foreground">
            {label}
          </span>
          <div className="relative h-4 flex-1">
            <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
            <div
              className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-foreground/25"
              style={{ left: `${a}%`, width: `${Math.max(b - a, 0.5)}%` }}
            />
            {values.length > 1 && (
              <div
                className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${LEVEL[kinds.bad].dot}`}
                style={{ left: `${at(bad)}%` }}
              />
            )}
            <div
              className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${LEVEL[kinds.good].dot}`}
              style={{ left: `${at(good)}%` }}
            />
            {/* Where you got in, for scale: every distance here is measured
                from it, and a band floating on an unmarked axis says nothing
                about which way the trade was going. */}
            <div
              className="absolute top-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2 bg-foreground/50"
              style={{ left: `${at(entry)}%` }}
              title={`Entry ${num(entry)}`}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 pl-[6.5rem] text-[10px]">
          {values.length > 1 && (
            <span className={LEVEL[kinds.bad].text}>
              {LEVEL[kinds.bad].label} <span className="font-mono">{num(bad)}</span>
              <span className="font-mono">{rTag(bad)}</span>
            </span>
          )}
          <span className={LEVEL[kinds.good].text}>
            {LEVEL[kinds.good].label} <span className="font-mono">{num(good)}</span>
            <span className="font-mono">{rTag(good)}</span>
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className={`space-y-2 ${className}`} data-testid="path-bands">
      {band("held", "With you", held, { good: "mfe", bad: "mae" })}
      {band("after", "Without you", after, { good: "ranAfter", bad: "fellAfter" })}
    </div>
  );
}
