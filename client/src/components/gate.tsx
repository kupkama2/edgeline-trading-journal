import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { gateLeft, type GateQuestion, type GateRecord } from "@shared/gate";

/**
 * The pre-trade gate, as a card: the questions, Yes/No under each, the
 * count still to answer, Reset. Every answer is green or red the moment it
 * is given, and the whole thing is done only when nothing is left. Shared
 * by the entry card (where it stands in the way), the terminal (before
 * Send) and the journal (after a tracked position appears).
 */
export function GateQuestions({
  questions,
  where,
  onDone,
  onSkip,
  title = "Pre-trade gate",
  blurb = "Six questions before every entry. Any red answer, no trade.",
  testId = "gate",
}: {
  questions: GateQuestion[];
  where: GateRecord["where"];
  /** Every answer green. */
  onDone: (record: GateRecord) => void;
  /** Offered only where a trade can go on without the gate; the record says it was skipped. */
  onSkip?: (record: GateRecord) => void;
  title?: string;
  blurb?: string;
  testId?: string;
}) {
  const [answers, setAnswers] = useState<Record<string, "yes" | "no">>({});
  const left = gateLeft(questions, answers);
  const anyRed = questions.some((q) => answers[q.id] != null && answers[q.id] !== q.good);
  const answer = (q: GateQuestion, a: "yes" | "no") => {
    const next = { ...answers, [q.id]: a };
    setAnswers(next);
    if (gateLeft(questions, next) === 0) onDone({ at: new Date().toISOString(), answers: next, where });
  };
  return (
    <div data-testid={testId}>
      <h3 className="text-lg font-bold tracking-tight">{title}</h3>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{blurb}</p>
      <div className={`mt-2 divide-y divide-border/60 rounded-lg border ${anyRed ? "border-red-500/60" : left === 0 ? "border-emerald-500/60" : "border-border"}`}>
        {questions.map((q) => {
          const a = answers[q.id];
          const tone = (v: "yes" | "no") => (a !== v ? "border-border text-foreground hover:border-primary/40" : v === q.good ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-400" : "border-red-500/60 bg-red-500/15 text-red-400");
          return (
            <div key={q.id} className="px-3 py-2.5" data-testid={`${testId}-q-${q.id}`}>
              <p className="text-[13px] font-semibold leading-snug">{q.text}</p>
              {q.hint && <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{q.hint}</p>}
              <div className="mt-1.5 flex gap-1.5">
                {(["yes", "no"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => answer(q, v)}
                    aria-pressed={a === v}
                    className={`rounded-md border px-3 py-1 text-xs font-medium transition-colors ${tone(v)}`}
                    data-testid={`${testId}-${q.id}-${v}`}
                  >
                    {v === "yes" ? "Yes" : "No"}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11px]">
        <span className={`rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${left === 0 ? "border-emerald-500/60 text-emerald-400" : "border-border text-muted-foreground"}`} data-testid={`${testId}-state`}>
          {left === 0 ? "open" : "shut"}
        </span>
        <span className="text-muted-foreground" data-testid={`${testId}-left`}>
          {left === 0 ? "Every answer green." : `${left} left.`}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {onSkip && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-muted-foreground" onClick={() => onSkip({ at: new Date().toISOString(), answers, skipped: true, where })} data-testid={`${testId}-skip`}>
              Skip (counts as red)
            </Button>
          )}
          <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => setAnswers({})} data-testid={`${testId}-reset`}>
            Reset
          </Button>
        </span>
      </div>
    </div>
  );
}

/** The gate over something: the form stays underneath, blurred, until every answer is green. */
export function GateOverlay(props: Parameters<typeof GateQuestions>[0]) {
  return (
    <div className="absolute inset-0 z-20 flex items-start justify-center overflow-auto rounded-lg bg-background/85 p-3 backdrop-blur-sm" data-testid={`${props.testId ?? "gate"}-overlay`}>
      <Card className="w-full max-w-md border-card-border bg-card p-4 shadow-lg">
        <GateQuestions {...props} />
      </Card>
    </div>
  );
}

/*
 * A green gate for a symbol, remembered for ten minutes in this tab: the
 * terminal's Send asks once, not on every nudge of a resting limit.
 */
const PASS_MS = 10 * 60_000;
const passes = new Map<string, { at: number; record: GateRecord }>();
export function gatePassFor(key: string): GateRecord | null {
  const p = passes.get(key);
  if (!p || Date.now() - p.at > PASS_MS) return null;
  return p.record;
}
export function rememberGatePass(key: string, record: GateRecord): void {
  passes.set(key, { at: Date.now(), record });
}
