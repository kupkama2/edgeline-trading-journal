/**
 * Small pieces every trade surface leans on: number formatting, local-time
 * conversion, rationale-tag parsing, and the screenshot dropzone. Split from
 * the journal page so the entry card, the dialogs and the row lists can share
 * them without importing each other.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Camera, Loader2, X } from "lucide-react";

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

export function localNow() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export function toIso(local: string) {
  return local ? new Date(local).toISOString() : new Date().toISOString();
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
}: {
  label: string;
  hint: string;
  image: string | null;
  busy: boolean;
  onFile: (f: File) => void;
  onClear: () => void;
  testId: string;
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
      className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center transition-colors ${
        over ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-secondary/40"
      }`}
    >
      <Camera className="h-5 w-5 text-muted-foreground" />
      <p className="text-xs font-medium">{label}</p>
      <p className="text-[11px] leading-snug text-muted-foreground">{hint} You can also press Ctrl+V (or Cmd+V) anywhere here to paste from your clipboard.</p>
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

