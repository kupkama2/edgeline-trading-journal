import { useState } from "react";
import { ChevronDown, Loader2, Plus, Sparkles, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { readTradeNote, useMistakeTags, useUpdateTrade } from "@/lib/data";
import { failed } from "@/lib/report";
import { GRADES, gradeLabel } from "@shared/grades";
import { EXIT_REASON_LABELS } from "@shared/metrics";
import { EXIT_REASONS } from "@/components/trade-shared";
import { HIGHLIGHT_TAXONOMY, parseHighlights, serializeHighlights } from "@shared/highlights";
import { noteHash, noteNeedsRead, parseNoteRead } from "@shared/note-read";
import type { TradeWithTags } from "@shared/schema";

/**
 * What the trade's one note was read as, each answer one click from being
 * corrected.
 *
 * Nothing on a trade is picked by hand any more; it is read out of the note
 * once the trade is closed (shared/note-read.ts). So this is where a misread
 * is fixed: open a chip, choose the right answer. A correction is yours from
 * then on — the next read of the note leaves it alone — and a chip the read
 * set carries a small mark, so it is always plain which answers are whose.
 */
export function NoteReadChips({ trade, extraHighlights = [] }: { trade: TradeWithTags; extraHighlights?: string[] }) {
  const update = useUpdateTrade();
  const { data: demons = [] } = useMistakeTags();
  const [reading, setReading] = useState(false);
  if (trade.status !== "closed" || trade.scalp) return null;

  const rec = parseNoteRead(trade.noteRead);
  const set = rec?.set;
  const pending = noteNeedsRead(trade);
  const save = (patch: Record<string, unknown>, mistakeTagIds?: number[]) =>
    update.mutate({ id: trade.id, trade: patch as any, mistakeTagIds }, { onError: failed("That change") });

  const fromNote = (field: string, value: unknown) => set != null && (set as any)[field] === value;
  const highlights = parseHighlights(trade.highlights);
  const pool = Array.from(new Set([...HIGHLIGHT_TAXONOMY, ...extraHighlights]));

  async function readAgain() {
    setReading(true);
    try {
      await readTradeNote(trade.id);
    } finally {
      setReading(false);
    }
  }

  const status = !trade.notes?.trim()
    ? "Write the trade's note and it is read into these once saved."
    : reading || pending
      ? "Reading the note…"
      : rec && rec.hash === noteHash(trade.notes ?? "")
        ? `Read from your note ${new Date(rec.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}.`
        : "Not read yet.";

  return (
    <div className="mt-3 space-y-2 border-t border-border/60 pt-3" data-testid="note-read-chips">
      <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
        <Sparkles className="h-3 w-3" />
        <span data-testid="note-read-status">{status}</span>
        <span>Click any answer to correct it — a correction is kept.</span>
        {trade.notes?.trim() && (
          <button
            type="button"
            onClick={() => void readAgain()}
            disabled={reading}
            className="ml-auto inline-flex items-center gap-1 underline decoration-dotted underline-offset-2 hover:text-foreground disabled:opacity-50"
            data-testid="button-note-read-again"
          >
            {reading && <Loader2 className="h-3 w-3 animate-spin" />}
            read again
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Pick
          label="Exit"
          value={trade.exitReason ? EXIT_REASON_LABELS[trade.exitReason] ?? trade.exitReason : null}
          read={fromNote("exitReason", trade.exitReason)}
          options={EXIT_REASONS.map((r) => ({ id: r, label: EXIT_REASON_LABELS[r] ?? r }))}
          onPick={(id) => save({ exitReason: id })}
          testId="chip-note-exit"
        />
        {(["entry", "stop", "exit"] as const).map((axis) => {
          const field = `${axis}Grade` as "entryGrade" | "stopGrade" | "exitGrade";
          if (axis === "exit" && trade.exitReason === "stop") return null;
          const v = trade[field];
          return (
            <Pick
              key={axis}
              label={axis[0].toUpperCase() + axis.slice(1)}
              value={v ? gradeLabel(axis, v) : null}
              read={fromNote(field, v)}
              options={GRADES[axis].map((g) => ({ id: g, label: gradeLabel(axis, g) ?? g }))}
              onPick={(id) => save({ [field]: id })}
              testId={`chip-note-${axis}`}
            />
          );
        })}
        <Pick
          label="Verdict"
          value={trade.tilt ? "Tilt" : trade.wellTraded ? "Traded well" : null}
          read={set?.verdict != null && set.verdict === (trade.tilt ? "tilt" : trade.wellTraded ? "well" : null)}
          options={[
            { id: "well", label: "Traded well" },
            { id: "tilt", label: "Tilt" },
          ]}
          onPick={(id) => save({ wellTraded: id === "well", tilt: id === "tilt" })}
          testId="chip-note-verdict"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5" data-testid="note-read-demons">
        {trade.mistakeTagIds.map((id) => (
          <Tag
            key={id}
            text={demons.find((d) => d.id === id)?.name ?? "?"}
            tone="demon"
            read={set?.demonIds.includes(id) ?? false}
            onRemove={() => save({}, trade.mistakeTagIds.filter((x) => x !== id))}
          />
        ))}
        {highlights.map((h) => (
          <Tag
            key={h}
            text={h}
            tone="good"
            read={set?.highlights?.includes(h) ?? false}
            onRemove={() => save({ highlights: serializeHighlights(highlights.filter((x) => x !== h)) })}
          />
        ))}
        <Adder
          label="demon"
          options={demons.filter((d) => !trade.mistakeTagIds.includes(d.id)).map((d) => ({ id: String(d.id), label: d.name }))}
          onAdd={(id) => save({}, [...trade.mistakeTagIds, Number(id)])}
          testId="button-note-add-demon"
        />
        <Adder
          label="green flag"
          options={pool.filter((h) => !highlights.includes(h)).map((h) => ({ id: h, label: h }))}
          onAdd={(h) => save({ highlights: serializeHighlights([...highlights, h]) })}
          testId="button-note-add-highlight"
        />
      </div>
    </div>
  );
}

function Pick({
  label,
  value,
  read,
  options,
  onPick,
  testId,
}: {
  label: string;
  value: string | null;
  read: boolean;
  options: { id: string; label: string }[];
  onPick: (id: string | null) => void;
  testId: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors hover:border-primary/50 ${
            value ? "border-border text-foreground" : "border-dashed border-border text-muted-foreground"
          }`}
          title={value ? (read ? "Read from your note — click to correct" : "Set by you") : "Not said — click to set"}
          data-testid={testId}
        >
          <span className="text-muted-foreground">{label}</span>
          <span>{value ?? "—"}</span>
          {read && <Sparkles className="h-2.5 w-2.5 text-muted-foreground" />}
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((o) => (
          <DropdownMenuItem key={o.id} onSelect={() => onPick(o.id)} className="text-xs">
            {o.label}
          </DropdownMenuItem>
        ))}
        {value && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onPick(null)} className="text-xs text-muted-foreground">
              Clear
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Tag({ text, tone, read, onRemove }: { text: string; tone: "demon" | "good"; read: boolean; onRemove: () => void }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
        tone === "demon" ? "border-primary/40 text-primary" : "border-emerald-500/40 text-emerald-400"
      }`}
      title={read ? "Read from your note" : "Set by you"}
    >
      {text}
      {read && <Sparkles className="h-2.5 w-2.5 opacity-70" />}
      <button type="button" onClick={onRemove} className="opacity-60 hover:opacity-100" aria-label={`Remove ${text}`}>
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

function Adder({
  label,
  options,
  onAdd,
  testId,
}: {
  label: string;
  options: { id: string; label: string }[];
  onAdd: (id: string) => void;
  testId: string;
}) {
  if (!options.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary/50 hover:text-foreground"
          data-testid={testId}
        >
          <Plus className="h-3 w-3" /> {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        {options.map((o) => (
          <DropdownMenuItem key={o.id} onSelect={() => onAdd(o.id)} className="text-xs">
            {o.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
