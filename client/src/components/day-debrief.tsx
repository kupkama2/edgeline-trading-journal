import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Check, Loader2, MessageSquareText, Skull, Star } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useDailyNotes, useDebrief, useMistakeTags, useSaveDailyNote, useUpdateTrade } from "@/lib/data";
import { failed } from "@/lib/report";
import { gradeLabel } from "@shared/grades";
import { EXIT_REASON_LABELS, fmtMoney, fmtR, computeMetrics } from "@shared/metrics";
import { joinNote } from "@shared/notes";
import { mergeDayNote, type Debrief } from "@shared/debrief";
import type { TradeWithTags } from "@shared/schema";

/**
 * Talk the day through instead of reviewing it trade by trade.
 *
 * Paste or type what happened — the way you would say it to someone — and
 * it is split onto the day's trades: each one you talk about gets your words
 * as its review, with the grades, mistakes and verdict they say; the whole
 * text becomes the day's note, where the weekly read finds the lessons; and
 * any trade from the day you did not mention is named, and stays owed.
 *
 * Shown before it is saved, because the split is a reading: a sentence put
 * on the wrong trade is one glance to catch here and invisible later.
 */
export function DayDebrief({ day, trades }: { day: string; trades: TradeWithTags[] }) {
  const { toast } = useToast();
  const read = useDebrief();
  const update = useUpdateTrade();
  const saveNote = useSaveDailyNote();
  const { data: notes = [] } = useDailyNotes();
  const { data: tags = [] } = useMistakeTags();
  const [text, setText] = useState("");
  const [result, setResult] = useState<Debrief | null>(null);
  const [notesFor, setNotesFor] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);

  const byId = useMemo(() => new Map(trades.map((t) => [t.id, t])), [trades]);
  const tagName = useMemo(() => new Map(tags.map((t) => [t.id, t.name])), [tags]);
  const existingNote = notes.find((n) => n.day === day)?.body ?? "";

  async function readIt() {
    try {
      const r = await read.mutateAsync({ day, text, tradeIds: trades.map((t) => t.id) });
      setResult(r);
      setNotesFor(Object.fromEntries(r.entries.map((e) => [e.tradeId, e.note])));
    } catch (err) {
      failed("Reading the day")(err);
    }
  }

  async function saveAll() {
    if (!result) return;
    setSaving(true);
    let filed = 0;
    try {
      for (const e of result.entries) {
        const t = byId.get(e.tradeId);
        if (!t) continue;
        const note = (notesFor[e.tradeId] ?? e.note).trim();
        if (!note) continue;
        /*
         * The words go onto the trade's one note, and the note is read from
         * there like any other edit of it (shared/note-read.ts): what you set
         * by hand stays, what an earlier read set follows the note.
         */
        await update.mutateAsync({
          id: t.id,
          trade: { notes: joinNote(t.notes, note), reviewedAt: new Date().toISOString() } as any,
        });
        filed++;
      }
      await saveNote.mutateAsync({ day, body: mergeDayNote(existingNote, text) });
      toast({
        title: `Filed onto ${filed} ${filed === 1 ? "trade" : "trades"}`,
        description: result.unmentioned.length
          ? `${result.unmentioned.length} from this day ${result.unmentioned.length === 1 ? "was" : "were"} not mentioned and still need a word.`
          : "Every trade from the day is gone over. The text is the day's note.",
      });
      setResult(null);
      setText("");
    } catch (err) {
      failed(filed ? `Stopped after ${filed}` : "Saving the day")(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="border-card-border bg-card p-4" data-testid="card-day-debrief">
      <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
        <MessageSquareText className="h-4 w-4" />
        Talk it through
      </h2>
      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
        Say what happened today the way you would tell someone — which trades, what went wrong, what
        you would do differently. It is split onto the trades below as their reviews, and kept as the
        day's note for the weekly read.
      </p>

      {!result && (
        <>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            placeholder="Longed BTC and PUMP, lost both. Direction was right but the stops were too tight…"
            className="mt-3 text-xs"
            data-testid="input-day-debrief"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground">
              {trades.length} {trades.length === 1 ? "trade" : "trades"} on this day to match against.
            </span>
            <Button
              size="sm"
              className="h-8 text-[11px]"
              disabled={read.isPending || text.trim().length < 10 || trades.length === 0}
              onClick={readIt}
              data-testid="button-day-debrief-read"
            >
              {read.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              Read it
            </Button>
          </div>
        </>
      )}

      {result && (
        <div className="mt-3 space-y-3" data-testid="day-debrief-result">
          {result.unmentioned.length > 0 && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[11px]" data-testid="day-debrief-unmentioned">
              <p className="flex items-center gap-1.5 font-semibold text-amber-500">
                <AlertTriangle className="h-3.5 w-3.5" />
                Not mentioned: {result.unmentioned.map((id) => byId.get(id)?.symbol ?? `#${id}`).join(", ")}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                These stay owed. Add a line about them above and read it again, or review them one by one below.
              </p>
            </div>
          )}
          {result.unmatched.length > 0 && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[11px]" data-testid="day-debrief-unmatched">
              <p className="font-semibold text-destructive">You mention trades the journal does not have for this day:</p>
              <ul className="mt-0.5 list-disc pl-4 text-muted-foreground">
                {result.unmatched.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </div>
          )}

          {result.entries.map((e) => {
            const t = byId.get(e.tradeId);
            if (!t) return null;
            const m = computeMetrics(t);
            const r = e.read;
            const chips = [
              r.exitReason ? EXIT_REASON_LABELS[r.exitReason as keyof typeof EXIT_REASON_LABELS] ?? r.exitReason : null,
              r.entryGrade ? `entry: ${gradeLabel("entry", r.entryGrade as any)}` : null,
              r.stopGrade ? `stop: ${gradeLabel("stop", r.stopGrade as any)}` : null,
              r.exitGrade ? `exit: ${gradeLabel("exit", r.exitGrade as any)}` : null,
            ].filter(Boolean) as string[];
            return (
              <div key={e.tradeId} className="space-y-1.5 rounded-md border border-card-border p-3" data-testid={`day-debrief-entry-${t.id}`}>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-mono font-semibold">{t.symbol}</span>
                  <span className="text-muted-foreground">{t.direction}</span>
                  {m.actualR != null && <span className="font-mono">{fmtR(m.actualR)}</span>}
                  {m.actualPnL != null && <span className="font-mono text-muted-foreground">{fmtMoney(m.actualPnL)}</span>}
                  {e.verdict === "tilt" && (
                    <Badge variant="outline" className="border-primary/50 text-[10px] text-primary">
                      <Skull className="mr-1 h-3 w-3" /> tilt
                    </Badge>
                  )}
                  {e.verdict === "well" && (
                    <Badge variant="outline" className="border-amber-500/50 text-[10px] text-amber-400">
                      <Star className="mr-1 h-3 w-3" /> traded well
                    </Badge>
                  )}
                </div>
                <Textarea
                  value={notesFor[e.tradeId] ?? e.note}
                  onChange={(ev) => setNotesFor((x) => ({ ...x, [e.tradeId]: ev.target.value }))}
                  rows={3}
                  className="text-xs"
                  data-testid={`input-day-debrief-note-${t.id}`}
                />
                {(chips.length > 0 || r.demonIds.length > 0 || r.highlights.length > 0) && (
                  <div className="flex flex-wrap gap-1">
                    {chips.map((c) => (
                      <Badge key={c} variant="outline" className="text-[10px] text-muted-foreground">
                        {c}
                      </Badge>
                    ))}
                    {r.demonIds.map((id) => (
                      <Badge key={id} variant="outline" className="border-destructive/40 text-[10px] text-destructive">
                        {tagName.get(id) ?? `#${id}`}
                      </Badge>
                    ))}
                    {r.highlights.map((h) => (
                      <Badge key={h} variant="outline" className="border-emerald-500/40 text-[10px] text-emerald-400">
                        {h}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {result.lessons.length > 0 && (
            <div className="text-[11px]" data-testid="day-debrief-lessons">
              <p className="font-semibold">Lessons</p>
              <ul className="list-disc pl-4 text-muted-foreground">
                {result.lessons.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" className="h-8 text-[11px]" onClick={() => setResult(null)}>
              Edit the text
            </Button>
            <Button
              size="sm"
              className="h-8 text-[11px]"
              disabled={saving || result.entries.length === 0}
              onClick={saveAll}
              data-testid="button-day-debrief-save"
            >
              {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1 h-3.5 w-3.5" />}
              File it — {result.entries.length} {result.entries.length === 1 ? "review" : "reviews"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
