import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { gateLeft, gateUnanswered, signalFrom, type GateQuestion, type GateRecord } from "@shared/gate";

/* Who the last few signals came from, kept in this browser so a name is typed once. */
const SOURCES_KEY = "edgeline.gate.signal-sources";
function recentSources(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SOURCES_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string").slice(0, 6) : [];
  } catch {
    return [];
  }
}
function rememberSource(name: string): void {
  try {
    const rest = recentSources().filter((x) => x.toLowerCase() !== name.toLowerCase());
    localStorage.setItem(SOURCES_KEY, JSON.stringify([name, ...rest].slice(0, 6)));
  } catch {
    /* nothing to remember with */
  }
}

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
  onSignal,
  title = "Pre-trade gate",
  blurb,
  testId = "gate",
  afterTheFact = false,
  compact = false,
}: {
  questions: GateQuestion[];
  where: GateRecord["where"];
  /** Every answer green. */
  onDone: (record: GateRecord) => void;
  /** Offered only where a trade can go on without the gate; the record says it was skipped. */
  onSkip?: (record: GateRecord) => void;
  /**
   * Offered where a trade is being logged: it was someone else's call, so
   * the questions do not apply. One tap, a name, and the record says whose.
   */
  onSignal?: (record: GateRecord) => void;
  title?: string;
  blurb?: string;
  testId?: string;
  /**
   * Asked after the fact: the trade is already on, so a red answer is an
   * answer, not a wall. Every question answered shows a button that puts
   * the answers on the record as they stand; only an all-green set goes
   * through on its own.
   */
  afterTheFact?: boolean;
  /** One line a question, small buttons beside it: for a card on a page, not a gate in the way. */
  compact?: boolean;
}) {
  const [answers, setAnswers] = useState<Record<string, "yes" | "no">>({});
  const [signalOpen, setSignalOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [sources] = useState(recentSources);
  const sendSignal = (raw: string) => {
    const name = signalFrom(raw);
    if (!name || !onSignal) return;
    rememberSource(name);
    onSignal({ at: new Date().toISOString(), answers: {}, where, signal: { from: name } });
  };
  const left = afterTheFact ? gateUnanswered(questions, answers) : gateLeft(questions, answers);
  const reds = questions.filter((q) => answers[q.id] != null && answers[q.id] !== q.good).length;
  const anyRed = reds > 0;
  const record = (a: Record<string, "yes" | "no">) => onDone({ at: new Date().toISOString(), answers: a, where });
  const answer = (q: GateQuestion, a: "yes" | "no") => {
    const next = { ...answers, [q.id]: a };
    setAnswers(next);
    if (gateLeft(questions, next) === 0) record(next);
  };
  const ready = afterTheFact && left === 0 && anyRed;
  const said = blurb ?? `${countWord(questions.length)} before every entry. Any red answer, no trade.`;
  return (
    <div data-testid={testId}>
      <h3 className={compact ? "text-sm font-semibold tracking-tight" : "text-lg font-bold tracking-tight"}>{title}</h3>
      {said && <p className="mt-0.5 text-[11px] text-muted-foreground">{said}</p>}
      {onSignal && (
        <div className="mt-2 rounded-lg border border-sky-500/40 bg-sky-500/5 px-2.5 py-2" data-testid={`${testId}-signal`}>
          {!signalOpen ? (
            <button type="button" onClick={() => setSignalOpen(true)} className="flex w-full items-center justify-between gap-2 text-left text-[12px] font-medium text-sky-400" data-testid={`${testId}-signal-open`}>
              <span>This was from a signal</span>
              <span className="text-[10px] font-normal text-muted-foreground">skips the questions, names the source</span>
            </button>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                sendSignal(from);
              }}
            >
              <label className="text-[11px] text-muted-foreground" htmlFor={`${testId}-signal-from`}>
                Who was the signal from?
              </label>
              <div className="mt-1 flex gap-1.5">
                <Input id={`${testId}-signal-from`} autoFocus value={from} onChange={(e) => setFrom(e.target.value)} maxLength={60} placeholder="a name or a channel" className="h-8 min-w-0 flex-1 text-xs" data-testid={`${testId}-signal-from`} />
                <Button type="submit" size="sm" className="h-8 px-3 text-[11px]" disabled={!signalFrom(from)} data-testid={`${testId}-signal-save`}>
                  Continue
                </Button>
              </div>
              {sources.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {sources.map((name) => (
                    <button key={name} type="button" onClick={() => sendSignal(name)} className="rounded-full border border-border px-2 py-0.5 text-[10px] text-foreground/90 hover:border-sky-500/50" data-testid={`${testId}-signal-recent`}>
                      {name}
                    </button>
                  ))}
                </div>
              )}
            </form>
          )}
        </div>
      )}
      <div className={`mt-2 divide-y divide-border/60 rounded-lg border ${anyRed ? "border-red-500/60" : left === 0 ? "border-emerald-500/60" : "border-border"}`}>
        {questions.map((q) => {
          const a = answers[q.id];
          const tone = (v: "yes" | "no") => (a !== v ? "border-border text-foreground hover:border-primary/40" : v === q.good ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-400" : "border-red-500/60 bg-red-500/15 text-red-400");
          const buttons = (
            <div className={compact ? "flex shrink-0 gap-1" : "mt-1.5 flex gap-1.5"}>
              {(["yes", "no"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => answer(q, v)}
                  aria-pressed={a === v}
                  className={`rounded-md border font-medium transition-colors ${compact ? "min-w-[2.5rem] px-2 py-0.5 text-[11px]" : "px-3 py-1 text-xs"} ${tone(v)}`}
                  data-testid={`${testId}-${q.id}-${v}`}
                >
                  {v === "yes" ? "Yes" : "No"}
                </button>
              ))}
            </div>
          );
          return compact ? (
            <div key={q.id} className="flex items-center justify-between gap-2 px-2.5 py-1.5" data-testid={`${testId}-q-${q.id}`}>
              <p className="min-w-0 text-[12px] leading-snug" title={q.hint}>
                {q.text}
                {q.hint && <span className="block text-[10px] leading-snug text-muted-foreground">{q.hint}</span>}
              </p>
              {buttons}
            </div>
          ) : (
            <div key={q.id} className="px-3 py-2.5" data-testid={`${testId}-q-${q.id}`}>
              <p className="text-[13px] font-semibold leading-snug">{q.text}</p>
              {q.hint && <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{q.hint}</p>}
              {buttons}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
        <span
          className={`rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${left === 0 && !anyRed ? "border-emerald-500/60 text-emerald-400" : ready ? "border-red-500/60 text-red-400" : "border-border text-muted-foreground"}`}
          data-testid={`${testId}-state`}
        >
          {left === 0 && !anyRed ? "open" : ready ? `${reds} red` : "shut"}
        </span>
        <span className="text-muted-foreground" data-testid={`${testId}-left`}>
          {left === 0 && !anyRed ? "Every answer green." : ready ? "Every question answered." : afterTheFact ? `${left} to answer.` : `${left} left.`}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {ready && (
            <Button size="sm" variant="destructive" className="h-7 px-2.5 text-[11px]" onClick={() => record(answers)} data-testid={`${testId}-record`}>
              Put {reds} red on the record
            </Button>
          )}
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

const WORDS = ["No questions", "One question", "Two questions", "Three questions", "Four questions", "Five questions", "Six questions", "Seven questions", "Eight questions", "Nine questions", "Ten questions"];
const countWord = (n: number) => WORDS[n] ?? `${n} questions`;

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
