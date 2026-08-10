/**
 * Nine buttons that turn a feeling into a statistic.
 *
 * The whole design constraint is that this gets filled in at the moment the
 * trade closes, when the chart is still up and the adrenaline hasn't gone —
 * which is the only moment you actually remember whether you chased the entry.
 * So: three rows, three taps, no text fields, no required answers, and tapping
 * the same button again clears it. A grading scheme that takes a minute is a
 * grading scheme with no data in it a month later.
 *
 * Selected "right" reads emerald and selected misses read amber, so a fully
 * graded trade shows its own shape at a glance without anyone reading a word.
 */
import { AXIS_LABELS, GRADE_META, gradeLabel, type Axis } from "@shared/grades";

export interface GradeState {
  entry: string | null;
  stop: string | null;
  exit: string | null;
}

export const EMPTY_GRADES: GradeState = { entry: null, stop: null, exit: null };

const AXES: Axis[] = ["entry", "stop", "exit"];

function Row({
  axis,
  value,
  onPick,
  testPrefix,
}: {
  axis: Axis;
  value: string | null;
  onPick: (grade: string | null) => void;
  testPrefix: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-[11px] text-muted-foreground">
        {AXIS_LABELS[axis]}
      </span>
      <div className="flex min-w-0 flex-1 gap-1">
        {GRADE_META[axis].map((g) => {
          const on = value === g.grade;
          return (
            <button
              key={g.grade}
              type="button"
              title={g.hint}
              aria-pressed={on}
              onClick={() => onPick(on ? null : g.grade)}
              data-testid={`${testPrefix}-${axis}-${g.grade}`}
              className={`min-w-0 flex-1 truncate rounded-md border px-2 py-1.5 text-[11px] transition-colors ${
                on
                  ? g.tone === "good"
                    ? "border-emerald-500/60 bg-emerald-500/15 font-medium text-emerald-400"
                    : "border-amber-500/60 bg-amber-500/15 font-medium text-amber-400"
                  : "border-border/70 text-muted-foreground hover:border-border hover:text-foreground"
              }`}
            >
              {g.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function GradePicker({
  value,
  onChange,
  testPrefix = "grade",
}: {
  value: GradeState;
  onChange: (next: GradeState) => void;
  testPrefix?: string;
}) {
  return (
    <div data-testid={`section-${testPrefix}`}>
      <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        How well did you execute?{" "}
        <span className="normal-case tracking-normal">
          (optional — this is what the take-profit stats are built from)
        </span>
      </p>
      <div className="space-y-1.5">
        {AXES.map((axis) => (
          <Row
            key={axis}
            axis={axis}
            value={value[axis]}
            onPick={(g) => onChange({ ...value, [axis]: g })}
            testPrefix={testPrefix}
          />
        ))}
      </div>
    </div>
  );
}

/** Read-only rendering of whatever was graded. Renders nothing when nothing was. */
export function GradeBadges({
  entry,
  stop,
  exit,
  className = "",
}: {
  entry?: string | null;
  stop?: string | null;
  exit?: string | null;
  className?: string;
}) {
  const items = ([["entry", entry], ["stop", stop], ["exit", exit]] as const)
    .map(([axis, grade]) => ({
      axis: axis as Axis,
      grade,
      label: gradeLabel(axis as Axis, grade),
      tone: GRADE_META[axis as Axis].find((g) => g.grade === grade)?.tone,
    }))
    .filter((i) => i.label != null);

  if (items.length === 0) return null;

  return (
    <div className={`flex flex-wrap gap-1 ${className}`} data-testid="grade-badges">
      {items.map((i) => (
        <span
          key={i.axis}
          data-testid={`grade-badge-${i.axis}`}
          className={`rounded-full border px-2 py-0.5 text-[10px] leading-tight ${
            i.tone === "good"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
              : "border-amber-500/40 bg-amber-500/10 text-amber-400"
          }`}
        >
          {AXIS_LABELS[i.axis]}: {i.label}
        </span>
      ))}
    </div>
  );
}
