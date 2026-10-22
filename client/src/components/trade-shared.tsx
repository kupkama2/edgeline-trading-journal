/**
 * Small pieces every trade surface leans on: number formatting, local-time
 * conversion, rationale-tag parsing, and the screenshot dropzone. Split from
 * the journal page so the entry card, the dialogs and the row lists can share
 * them without importing each other.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { CalendarDays, Camera, ChevronDown, Clock, Loader2, X, type LucideIcon } from "lucide-react";

/* ============================== helpers ============================== */

/**
 * The exit reasons a closing trade can carry, in the order the pickers show —
 * the plan finishing first, then the four ways you ended it yourself.
 *
 * Each one is a fact about what happened. Whether it was the right call is a
 * separate question, asked once by the grade buttons underneath and answered
 * again by arithmetic on Stats. Keeping them apart is the only reason
 * "when I override my target, am I ahead?" is answerable at all.
 */
export const EXIT_REASONS = [
  "target",
  "stop",
  "trailed",
  "breakeven",
  "discretion",
  "invalidated",
  "time",
] as const;

/**
 * Decimals that survive the instrument.
 *
 * Two was fine while everything was NQ and BTC. A 0.0064875 PENGU entry
 * rendered as "0.01" — and so did its stop, and its target, which turned a
 * whole trade into three identical numbers and hid the difference the trade
 * was made of. Precision therefore follows magnitude: the smaller the price,
 * the further past the decimal point the information lives.
 *
 * Chosen so the *distance between two nearby levels* stays visible, which is
 * a stronger requirement than showing the price itself: an entry and a stop
 * four ticks apart must not collapse onto the same string.
 */
function decimalsFor(v: number): number {
  const a = Math.abs(v);
  if (a >= 100) return 2;
  if (a >= 1) return 4;
  if (a >= 0.01) return 5;
  if (a >= 0.0001) return 7;
  return 9;
}

/**
 * Format a number for display. With no explicit precision it adapts to the
 * magnitude (see decimalsFor) and drops trailing zeros, so 21000 reads
 * "21000.00" and 0.0064875 keeps every digit that matters. Passing a
 * precision opts out and pins it — used where a column has to line up.
 */
export const num = (v: number | null | undefined, d?: number) => {
  if (v == null || !isFinite(v)) return "—";
  if (d != null) return v.toFixed(d);
  const s = v.toFixed(decimalsFor(v));
  // Trim the padding an adaptive precision adds, but never the last digit
  // before the point: "0.0065" not "0.0065000", "3" stays "3.00".
  return Math.abs(v) >= 100 ? s : s.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, ".00");
};

/**
 * The instant a mark is FOR, short enough to sit beside a price.
 *
 * Day and time both, because the two cases it has to tell apart are "eleven
 * minutes ago" and "yesterday afternoon", and an hour alone cannot.
 */
export const markWhen = (at: number) =>
  new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit", hourCycle: "h23",
    minute: "2-digit",
  });

export function localNow() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export function toIso(local: string) {
  return local ? new Date(local).toISOString() : new Date().toISOString();
}

/** The inverse: an ISO instant as the local wall-clock string a field shows. */
export function toLocalInput(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/**
 * A datetime field with a one-tap "Now".
 *
 * A trade is almost always logged within a minute of it closing, so "now" is
 * the true answer nearly every time — and it is the one value a datetime-local
 * input makes you assemble by hand, four spinners deep, on the phone where
 * this gets used most. The button sits on the label row rather than beside the
 * input so the field itself keeps its full width.
 *
 * Entry time deliberately has no equivalent: on a new trade it already
 * defaults to now, and on an edit it is a past moment you are correcting.
 */
/**
 * The line a field's label sits on.
 *
 * Fixed height, because the inputs under these have to line up and the labels
 * do not agree on one by themselves. A level label carries an icon and comes
 * out at fifteen pixels; a time field carries a Now button and comes out at
 * nineteen; a plain one carries neither and comes out at eleven. Three
 * labels, three heights, and three inputs starting at three different places
 * across one row — which is what a form looks like when it looks broken.
 *
 * Twenty, because the tallest of them has a button in it and a button is the
 * one that cannot be squeezed.
 */
export const LABEL_ROW = "flex h-5 items-center";

/** "14:30" from "1430", "9:5", "14.30" — or null while it is not a time yet. */
export function parseTime24(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})[:.h]?(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * A date and a 24-hour time, as one value in datetime-local's shape
 * ("2026-10-22T14:30").
 *
 * The browser draws a datetime-local box in the computer's locale, and a page
 * cannot ask it for a 24-hour clock — on an English system it is AM/PM, every
 * time. So the date keeps the native picker (which has no clock in it) and
 * the time is typed: "14:30", or "1430" and it is tidied on the way out.
 */
/** "2026-10-19" → "19 Oct 2026": day first, month in words, never ambiguous. */
function fmtDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const ymdOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * A date and a 24-hour time in one box.
 *
 * The browser's own datetime picker follows the OS locale, which means AM/PM
 * and mm/dd/yyyy for a lot of people who think in neither. So the date is a
 * calendar behind a button, written "19 Oct 2026", and the time is typed:
 * 14:30, 1430 and 14.30 all mean the same thing.
 */
export function DateTime24({
  value,
  onChange,
  testId,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  testId: string;
  className?: string;
}) {
  const [date, time] = (value ?? "").split("T");
  const [typing, setTyping] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const shown = typing ?? (time ?? "").slice(0, 5);
  const today = () => localNow().slice(0, 10);
  const bad = typing != null && typing !== "" && !parseTime24(typing);
  const picked = date ? new Date(`${date}T00:00`) : undefined;
  return (
    <div
      className={cn(
        "flex h-8 min-w-0 items-center rounded-md border bg-background transition-colors focus-within:border-ring/50",
        bad ? "border-amber-500/60" : "border-input",
        className,
      )}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-md pl-2 pr-1 text-left font-mono text-xs outline-none hover:bg-secondary/40 focus-visible:bg-secondary/40"
            data-testid={testId}
          >
            <CalendarDays className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className={`truncate ${date ? "" : "text-muted-foreground"}`}>{date ? fmtDay(date) : "Date"}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={picked}
            defaultMonth={picked}
            weekStartsOn={1}
            onSelect={(d) => {
              if (!d) return;
              onChange(`${ymdOf(d)}T${parseTime24(shown) ?? "00:00"}`);
              setOpen(false);
            }}
            initialFocus
          />
          {value && (
            <div className="flex justify-end border-t border-border px-2 py-1.5">
              <button
                type="button"
                onClick={() => {
                  onChange("");
                  setTyping(null);
                  setOpen(false);
                }}
                className="text-[11px] text-muted-foreground hover:text-foreground"
                data-testid={`${testId}-clear`}
              >
                Clear
              </button>
            </div>
          )}
        </PopoverContent>
      </Popover>
      <span className="h-4 w-px shrink-0 bg-border" />
      <input
        value={shown}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^\d:.h]/g, "").slice(0, 5);
          setTyping(raw);
          // "143" is on its way to "1430": a bare number waits for its fourth
          // digit (or for the box to be left) before it counts as a time.
          const t = parseTime24(raw);
          if (t && (raw.length >= 4 || /[:.h]/.test(raw))) onChange(`${date || today()}T${t}`);
        }}
        onBlur={() => {
          const t = typing != null ? parseTime24(typing) : null;
          if (t) onChange(`${date || today()}T${t}`);
          setTyping(null);
        }}
        placeholder="HH:mm"
        inputMode="numeric"
        aria-label="Time, 24-hour"
        className="h-full w-[3.25rem] shrink-0 rounded-r-md bg-transparent px-1.5 text-center font-mono text-xs outline-none placeholder:text-muted-foreground/60"
        data-testid={`${testId}-time`}
      />
    </div>
  );
}

/**
 * Two or three mutually exclusive answers, side by side.
 *
 * The one switch every form in the app uses — direction, size units, the
 * untouched plan — so they all look like the trade-state switch in the
 * editor's header instead of each inventing its own buttons. The chosen
 * option is lifted out of the track; a tone tints it when the answer has a
 * colour of its own (long is green, short is red).
 */
export interface SegmentOption<T extends string> {
  id: T;
  label: ReactNode;
  title?: string;
  /** Text colour of the option while chosen. */
  tone?: string;
  disabled?: boolean;
  testId?: string;
}

const SEG = {
  md: { track: "flex h-8 w-full", item: "flex-1 gap-1 px-2 text-xs font-medium" },
  sm: { track: "inline-flex h-7", item: "gap-1 px-2 text-[11px]" },
  xs: { track: "inline-flex", item: "px-1.5 text-[9px] uppercase leading-4 tracking-wider" },
} as const;

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  className = "",
  ariaLabel,
  testId,
}: {
  value: T | null;
  onChange: (v: T) => void;
  options: readonly SegmentOption<T>[];
  size?: keyof typeof SEG;
  className?: string;
  ariaLabel?: string;
  testId?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(SEG[size].track, "min-w-0 items-stretch gap-0.5 rounded-md border border-border/60 bg-secondary/40 p-0.5", className)}
      data-testid={testId}
    >
      {options.map((o) => {
        const on = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            disabled={o.disabled}
            title={o.title}
            aria-pressed={on}
            onClick={() => !o.disabled && onChange(o.id)}
            data-testid={o.testId}
            className={`flex min-w-0 items-center justify-center whitespace-nowrap rounded-[5px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring/50 ${SEG[size].item} ${
              o.disabled
                ? "cursor-not-allowed text-muted-foreground/30"
                : on
                  ? `bg-background shadow-sm ${o.tone ?? "text-foreground"}`
                  : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function TimeField({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testId: string;
}) {
  return (
    <div className="space-y-1">
      <div className={`${LABEL_ROW} justify-between gap-2`}>
        <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </label>
        <button
          type="button"
          onClick={() => onChange(localNow())}
          data-testid={`${testId}-now`}
          className="flex items-center gap-1 rounded px-1 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Clock className="h-2.5 w-2.5" />
          Now
        </button>
      </div>
      <DateTime24 value={value} onChange={onChange} testId={testId} />
    </div>
  );
}

export function parseTags(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export function RationaleTags({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span
          key={tag}
          className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] leading-tight text-emerald-400"
        >
          {tag}
        </span>
      ))}
    </div>
  );
}

/* ========================= screenshot dropzone ======================== */

export function Dropzone({
  label,
  hint,
  image,
  busy,
  onFile,
  onClear,
  testId,
  compact = false,
}: {
  label: string;
  hint: string;
  image: string | null;
  busy: boolean;
  onFile: (f: File) => void;
  onClear: () => void;
  testId: string;
  /** One line rather than a panel: for a form where the screenshot is optional. */
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);

  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (image || busy) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      let file: File | null = null;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          file = items[i].getAsFile();
          break;
        }
      }
      if (!file) return;
      // If a dialog is open, only the dropzone inside it should claim the paste.
      const openDialog = document.querySelector('[role="dialog"]');
      if (openDialog && containerRef.current && !openDialog.contains(containerRef.current)) {
        return;
      }
      e.preventDefault();
      onFile(file);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [image, busy, onFile]);

  if (image) {
    return (
      <div ref={containerRef} className="relative overflow-hidden rounded-lg border border-border/70">
        <img src={image} alt={label} className="max-h-52 w-full object-contain bg-black/30" />
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-background/75 text-xs font-medium">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            Reading chart…
          </div>
        )}
        <div className="absolute right-2 top-2">
          <Button
            type="button"
            size="icon"
            variant="secondary"
            className="h-7 w-7"
            onClick={onClear}
            data-testid={`${testId}-clear`}
            aria-label="Remove screenshot"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      onPaste={(e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.startsWith("image/")) {
            const f = items[i].getAsFile();
            if (f) {
              e.preventDefault();
              onFile(f);
            }
            break;
          }
        }
      }}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
      }}
      data-testid={testId}
      className={
        compact
          ? `flex cursor-pointer items-center gap-2 rounded-md border border-dashed px-3 py-2 text-left transition-colors ${
              over ? "border-primary bg-primary/5" : "border-border/70 hover:border-primary/50 hover:bg-secondary/40"
            }`
          : `flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center transition-colors ${
              over ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-secondary/40"
            }`
      }
    >
      <Camera className={compact ? "h-4 w-4 shrink-0 text-muted-foreground" : "h-5 w-5 text-muted-foreground"} />
      {compact ? (
        <p className="min-w-0 truncate text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">{label}</span> · {hint} Or paste with Ctrl+V.
        </p>
      ) : (
        <>
          <p className="text-xs font-medium">{label}</p>
          <p className="text-[11px] leading-snug text-muted-foreground">{hint} You can also press Ctrl+V (or Cmd+V) anywhere here to paste from your clipboard.</p>
        </>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        data-testid={`${testId}-input`}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/**
 * A titled band across a form — as a tile, not a rule.
 *
 * A trade write-up is four different questions wearing the same clothes — what
 * you planned, how it ended, what price actually did, and what you make of it
 * — and a single unbroken column of inputs makes them all look like one long
 * chore. The headings are there so you know which question you are answering
 * and can stop when that question is done.
 *
 * A heading alone was not enough. The editor is a very tall form, and a thin
 * rule between runs of identical grey inputs still scrolls past as one
 * undifferentiated column: the eye has nothing to grab. So each question is a
 * box with its own edge and its own colour — the exit sky, the way the exit
 * level is drawn everywhere else in the app; what price did amber; your read
 * violet — and you can tell at a glance which part of the write-up is on
 * screen without reading a word.
 *
 * Collapsing exists for the same reason and matters more: a form you have to
 * scroll for a minute to reach the save button of is a form you stop filling
 * in. A closed tile is never an empty one — it says what is inside it — so
 * folding a section away hides its inputs, not its contents.
 */
export type SectionTone = "plan" | "exit" | "path" | "read" | "extra";

/* The colour lives in the icon now, and the icon is the only colour a
   section carries: four tinted boxes stacked up read as four forms, and a
   write-up is one. */
const TONE: Record<SectionTone, string> = {
  plan: "text-foreground/60",
  exit: "text-sky-400",
  path: "text-amber-400",
  read: "text-violet-400",
  extra: "text-muted-foreground",
};

export function FormSection({
  icon: Icon,
  title,
  hint,
  children,
  testId,
  tone = "plan",
  collapsible = false,
  defaultOpen = true,
  /** Shown in the header in place of the hint while folded away. */
  summary,
  /** Controls that belong to the section but stay reachable while it is shut. */
  aside,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  /** Optional: a heading can also just introduce the run of fields below it. */
  children?: React.ReactNode;
  testId?: string;
  tone?: SectionTone;
  collapsible?: boolean;
  defaultOpen?: boolean;
  summary?: React.ReactNode;
  aside?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const shut = collapsible && !open;

  /*
   * A label, not a card. The sections used to be boxes with tinted header
   * bars and a hint line each, which is most of why a write-up ran to a
   * screen and a half: the chrome around six numbers was taller than the
   * numbers. Now a section is a small coloured label over its fields, with a
   * hairline above it; the hint is the label's tooltip, and a folded section
   * still says what is inside it.
   */
  const heading = (
    <>
      <Icon className={`h-3.5 w-3.5 shrink-0 ${TONE[tone]}`} />
      <span className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</span>
      {/* The summary is a convenience; on a phone the row is for the title and its buttons. */}
      {shut && (summary ?? hint) && (
        <span className="hidden min-w-0 truncate text-[10px] text-muted-foreground/80 sm:inline">{summary ?? hint}</span>
      )}
    </>
  );

  return (
    <section
      className="border-t border-border/50 pt-3 first:border-t-0 first:pt-0"
      data-testid={testId}
      data-open={collapsible ? (open ? "true" : "false") : undefined}
      title={hint}
    >
      <div className="flex min-h-[22px] items-center gap-x-2">
        {collapsible ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            data-testid={testId ? `${testId}-toggle` : undefined}
            className="flex min-w-0 flex-1 items-center gap-x-2 text-left"
          >
            {heading}
            <ChevronDown
              className={`ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
                open ? "rotate-180" : ""
              }`}
            />
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-x-2">{heading}</div>
        )}
        {aside && <div className="flex shrink-0 items-center gap-1.5">{aside}</div>}
      </div>
      {children && !shut && <div className="mt-2 space-y-2.5">{children}</div>}
    </section>
  );
}

