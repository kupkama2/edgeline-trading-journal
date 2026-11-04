import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { GateQuestions } from "@/components/gate";
import { usePrefs, useSetPrefs } from "@/lib/prefs";
import { useSetTradeGate } from "@/lib/data";
import { computeMetrics } from "@shared/metrics";
import { DEFAULT_GATE_QUESTIONS, gateReport, parseGate, redAnswers, type GateQuestion, type GateRecord, type GateSettings } from "@shared/gate";
import { parseTerminalRef } from "@shared/terminal";
import type { TradeWithTags } from "@shared/schema";

/* ------------------------------ a tracked position, asked after the fact ------------------------------ */

const ASKED_KEY = "edgeline.gate.asked";
const RECENT_MS = 24 * 60 * 60_000;

/**
 * A position the tracker found has already been entered; the gate cannot
 * stand in its way, so it asks after the fact, the moment the trade shows
 * up: a card on the journal, and a notification for a tab in the
 * background. The answers go on the trade like any other gate's.
 */
export function TrackedGateBanner({ trades }: { trades: TradeWithTags[] }) {
  const prefs = usePrefs();
  const update = useSetTradeGate();
  const { toast } = useToast();
  const open = useMemo(() => {
    if (!prefs.gate.tracked) return [];
    const since = Date.now() - RECENT_MS;
    return trades.filter((t) => {
      if (t.gate || (t.status !== "open" && t.status !== "pending")) return false;
      const ref = parseTerminalRef(t.terminal);
      return !!ref?.tracked && new Date(t.entryTime).getTime() > since;
    });
  }, [trades, prefs.gate.tracked]);
  const first = open[0] ?? null;

  // Said once per trade, in the browser's memory, so a reload does not say it again.
  useEffect(() => {
    if (!first) return;
    let asked: number[] = [];
    try {
      asked = JSON.parse(localStorage.getItem(ASKED_KEY) ?? "[]");
    } catch {
      /* ask again, then */
    }
    if (asked.includes(first.id)) return;
    try {
      localStorage.setItem(ASKED_KEY, JSON.stringify([...asked.slice(-50), first.id]));
    } catch {
      /* nothing to remember with */
    }
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification(`New ${first.direction} in ${first.symbol}`, { body: "Answer the pre-trade gate.", tag: `gate-${first.id}` });
      } catch {
        /* a tab that may not */
      }
    }
  }, [first?.id]);

  if (!first) return null;
  const write = async (record: GateRecord) => {
    try {
      await update.mutateAsync({ id: first.id, gate: record });
      const reds = redAnswers(prefs.gate.questions, record);
      toast({
        title: reds.length ? `${first.symbol}: entered against the gate` : `${first.symbol}: gate green`,
        description: reds.length ? `${reds.length} red ${reds.length === 1 ? "answer" : "answers"} on the record.` : "Every answer green, on the record.",
        variant: reds.length ? "destructive" : undefined,
      });
    } catch (err: any) {
      toast({ title: "Not saved", description: String(err?.message ?? err).slice(0, 200), variant: "destructive" });
    }
  };
  return (
    <Card className="border-amber-500/50 bg-card p-4" data-testid="tracked-gate">
      <p className="mb-2 text-[11px] text-amber-500">
        New {first.direction} in {first.symbol} on {first.account}, seen on the venue{open.length > 1 ? ` · ${open.length - 1} more waiting` : ""}.
      </p>
      <GateQuestions
        questions={prefs.gate.questions}
        where="tracked"
        onDone={write}
        onSkip={write}
        title="Was this trade through the gate?"
        blurb="The position is already on. Answer honestly; a red answer goes on the record, not on the trade's way."
        testId="tracked-gate-q"
      />
    </Card>
  );
}

/* ------------------------------ the record, in stats ------------------------------ */

export function GateStatsCard({ trades }: { trades: TradeWithTags[] }) {
  const prefs = usePrefs();
  const report = useMemo(
    () => gateReport(prefs.gate.questions, trades.map((t) => ({ gate: t.gate, status: t.status, r: computeMetrics(t).actualR }))),
    [trades, prefs.gate.questions],
  );
  const fmtR = (r: number | null) => (r == null ? "—" : `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`);
  if (report.passed.n + report.failed.n === 0) return null;
  return (
    <Card className="border-card-border bg-card p-4 sm:p-5" data-testid="card-gate-stats">
      <h2 className="text-sm font-semibold">The pre-trade gate</h2>
      <p className="mt-0.5 text-[11px] text-muted-foreground">Trades that went in green against trades that went in red. The number that changes behaviour is the question that goes red most.</p>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="rounded-md bg-secondary/40 p-2.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Through the gate</p>
          <p className="font-mono text-lg text-emerald-400" data-testid="text-gate-passed">{fmtR(report.passed.avgR)}</p>
          <p className="text-[10px] text-muted-foreground">{report.passed.n} {report.passed.n === 1 ? "trade" : "trades"} · average R</p>
        </div>
        <div className="rounded-md bg-secondary/40 p-2.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Against it</p>
          <p className="font-mono text-lg text-red-400" data-testid="text-gate-failed">{fmtR(report.failed.avgR)}</p>
          <p className="text-[10px] text-muted-foreground">{report.failed.n} {report.failed.n === 1 ? "trade" : "trades"} · average R</p>
        </div>
        <div className="rounded-md bg-secondary/40 p-2.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Never asked</p>
          <p className="font-mono text-lg text-muted-foreground">{report.unanswered}</p>
          <p className="text-[10px] text-muted-foreground">closed without a gate</p>
        </div>
      </div>
      {report.red.length > 0 && (
        <ul className="mt-3 space-y-1 text-[11px]" data-testid="list-gate-red">
          {report.red.slice(0, 4).map((r) => (
            <li key={r.id} className="flex items-baseline gap-2">
              <span className="font-mono text-red-400">{r.n}×</span>
              <span className="text-foreground/90">{r.text}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ------------------------------ the questions, in Settings ------------------------------ */

export function GateSettingsCard() {
  const prefs = usePrefs();
  const set = useSetPrefs();
  const { toast } = useToast();
  const [draft, setDraft] = useState<GateSettings | null>(null);
  const g = draft ?? prefs.gate;
  const edit = (next: Partial<GateSettings>) => setDraft({ ...g, ...next });
  const editQ = (i: number, next: Partial<GateQuestion>) => edit({ questions: g.questions.map((q, j) => (j === i ? { ...q, ...next } : q)) });
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || `q${Date.now() % 10000}`;
  const save = async () => {
    if (!draft) return;
    const problem = draft.questions.some((q) => !q.text.trim()) ? "Every question needs its text." : draft.questions.length === 0 ? "Keep at least one question." : null;
    if (problem) return toast({ title: "Not saved", description: problem, variant: "destructive" });
    const ids = new Set<string>();
    const questions = draft.questions.map((q) => {
      let id = q.id || slug(q.text);
      while (ids.has(id)) id = `${id}-2`;
      ids.add(id);
      return { ...q, id, text: q.text.trim(), hint: q.hint?.trim() || undefined };
    });
    try {
      await set.mutateAsync({ gate: { ...draft, questions } });
      setDraft(null);
      toast({ title: "Gate saved", description: `${questions.length} questions · ${[draft.entryCard && "entry card", draft.terminal && "terminal", draft.tracked && "tracked positions"].filter(Boolean).join(", ") || "nowhere"}.` });
    } catch (err: any) {
      toast({ title: "Not saved", description: String(err?.message ?? err).replace(/^\d+:\s*/, "").slice(0, 200), variant: "destructive" });
    }
  };
  const Toggle = ({ k, label, says }: { k: "entryCard" | "terminal" | "tracked"; label: string; says: string }) => (
    <button
      type="button"
      onClick={() => edit({ [k]: !g[k] } as Partial<GateSettings>)}
      className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${g[k] ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-500" : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"}`}
      title={says}
      data-testid={`button-gate-${k}`}
    >
      {label}
    </button>
  );
  return (
    <Card className="border-card-border bg-card p-4 sm:p-5" data-testid="card-gate">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Pre-trade gate</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">The questions before every entry. Any red answer, no trade. Where it stands:</p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Toggle k="entryCard" label="entry card — hard" says="The form stays shut until every answer is green." />
        <Toggle k="terminal" label="terminal Send" says="Send asks once per symbol; a green gate holds ten minutes." />
        <Toggle k="tracked" label="tracked positions" says="A position the tracker finds asks after the fact; red answers go on the record." />
      </div>
      <ol className="mt-3 space-y-2">
        {g.questions.map((q, i) => (
          <li key={i} className="rounded-md border border-border/60 p-2" data-testid={`gate-edit-${i}`}>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="w-4 text-right font-mono text-[10px] text-muted-foreground">{i + 1}</span>
              <Input value={q.text} onChange={(e) => editQ(i, { text: e.target.value })} className="h-7 min-w-[12rem] flex-1 text-xs" data-testid={`input-gate-text-${i}`} />
              <span className="text-[10px] text-muted-foreground">green on</span>
              <button type="button" onClick={() => editQ(i, { good: q.good === "yes" ? "no" : "yes" })} className={`rounded-md border px-2 py-0.5 font-mono text-[10px] ${q.good === "yes" ? "border-emerald-500/50 text-emerald-400" : "border-red-500/50 text-red-400"}`} data-testid={`button-gate-good-${i}`}>
                {q.good === "yes" ? "Yes" : "No"}
              </button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[10px] text-muted-foreground" onClick={() => edit({ questions: g.questions.filter((_, j) => j !== i) })} data-testid={`button-gate-remove-${i}`}>
                remove
              </Button>
            </div>
            <Input value={q.hint ?? ""} onChange={(e) => editQ(i, { hint: e.target.value })} placeholder="a line under it, if the right answer needs saying" className="mt-1 h-7 text-[11px]" data-testid={`input-gate-hint-${i}`} />
          </li>
        ))}
      </ol>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => edit({ questions: [...g.questions, { id: "", text: "", good: "yes" }] })} data-testid="button-gate-add">
          + question
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-muted-foreground" onClick={() => edit({ questions: DEFAULT_GATE_QUESTIONS })} data-testid="button-gate-defaults">
          the six defaults
        </Button>
        {draft && (
          <span className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setDraft(null)} data-testid="button-gate-cancel">
              Cancel
            </Button>
            <Button size="sm" className="h-7 px-3 text-[11px]" onClick={save} disabled={set.isPending} data-testid="button-gate-save">
              Save
            </Button>
          </span>
        )}
      </div>
    </Card>
  );
}

/** A trade's gate, read for a row or a page. */
export function gateOf(t: { gate?: string | null }): GateRecord | null {
  return parseGate(t.gate);
}
