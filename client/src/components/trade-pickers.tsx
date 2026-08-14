/**
 * Small pickers shared by the entry card and the trade dialogs: which account
 * a trade ran in, whose idea it was, which setup it was, and what went right.
 */
import { useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sparkles } from "lucide-react";
import { HIGHLIGHT_TAXONOMY } from "@shared/highlights";
import { SETUP_TAGS } from "@shared/setups";

const NEW_ACCOUNT = "__new__";
const NO_ACCOUNT = "__none__";

/**
 * Pick an account from the ones already used, or type a new one.
 *
 * A dropdown rather than a free field because the value is an identity: two
 * spellings of "Apex eval" are two accounts in every breakdown, and a picker
 * makes the common case (the account you traded yesterday) one click while
 * still allowing a genuinely new name. Choosing "New account…" swaps in a
 * text box; clearing it drops back to the list.
 */
export function AccountPicker({
  value,
  onChange,
  known,
  testIdPrefix = "account",
  placeholder = "e.g. Apex eval, Binance Futures",
  emptyLabel = "No account",
  newLabel = "+ New account…",
}: {
  value: string;
  onChange: (v: string) => void;
  known: string[];
  testIdPrefix?: string;
  /** Overridden by the source picker, which asks a different question of the
      same shape: one identity, chosen from what you have used before. */
  placeholder?: string;
  emptyLabel?: string;
  newLabel?: string;
}) {
  // Typing mode is sticky while the box is non-empty, so a half-typed name
  // isn't yanked away the moment it matches nothing.
  const [typing, setTyping] = useState(false);
  const inList = value.trim() !== "" && known.includes(value.trim());

  if (typing || (value.trim() !== "" && !inList)) {
    return (
      <div className="flex items-center gap-1.5">
        <Input
          /* Only when the user asked for a new one. Focusing on mount would
             steal the caret at page load, because a remembered account looks
             "unknown" for the one render before the trade list arrives. */
          autoFocus={typing}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="h-9 w-56 text-xs"
          data-testid={`input-${testIdPrefix}`}
        />
        {known.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setTyping(false);
              onChange("");
            }}
            className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
            data-testid={`button-${testIdPrefix}-back`}
          >
            pick existing
          </button>
        )}
      </div>
    );
  }

  return (
    <Select
      value={value.trim() === "" ? NO_ACCOUNT : value}
      onValueChange={(v) => {
        if (v === NEW_ACCOUNT) {
          setTyping(true);
          onChange("");
        } else onChange(v === NO_ACCOUNT ? "" : v);
      }}
    >
      <SelectTrigger className="h-9 w-56 text-xs" data-testid={`select-${testIdPrefix}`}>
        <SelectValue placeholder={emptyLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_ACCOUNT} className="text-xs text-muted-foreground">
          {emptyLabel}
        </SelectItem>
        {known.map((a) => (
          <SelectItem key={a} value={a} className="text-xs" data-testid={`option-${testIdPrefix}-${a}`}>
            {a}
          </SelectItem>
        ))}
        <SelectItem value={NEW_ACCOUNT} className="text-xs text-primary">
          {newLabel}
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

/**
 * Mark what went RIGHT. The counterpart to the demon chips, and deliberately
 * placed next to them at close time — the same minute you name the mistake is
 * the only minute you'll honestly name the thing you nailed.
 */
export function HighlightPicker({
  selected,
  onToggle,
  extra = [],
  testIdPrefix = "highlight",
}: {
  selected: string[];
  onToggle: (name: string) => void;
  /** Custom flags already in use, offered alongside the canonical ones. */
  extra?: string[];
  testIdPrefix?: string;
}) {
  const all = [...HIGHLIGHT_TAXONOMY, ...extra.filter((e) => !HIGHLIGHT_TAXONOMY.includes(e))];
  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Sparkles className="h-3 w-3 text-emerald-400" />
        What went right
      </p>
      <div className="flex flex-wrap gap-1.5">
        {all.map((h) => {
          const on = selected.includes(h);
          return (
            <button
              key={h}
              type="button"
              onClick={() => onToggle(h)}
              aria-pressed={on}
              data-testid={`chip-${testIdPrefix}-${h}`}
              className={`rounded-full border px-2.5 py-1 text-[11px] leading-tight transition-colors ${
                on
                  ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-400"
                  : "border-border text-muted-foreground hover:border-emerald-500/40 hover:text-foreground"
              }`}
            >
              {h}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The handful of setups that are most of the book, as one-tap chips.
 *
 * Sits next to the free-text rationale rather than replacing it: the sentence
 * is how you actually think about a trade, and the chips are how the Setup
 * breakdown gets a sample size worth reading. Tapping one toggles the
 * canonical tag, so the same setup never lands in the table twice under two
 * spellings.
 */
export function SetupTagPicker({
  selected,
  onToggle,
  testIdPrefix = "setup",
}: {
  selected: string[];
  onToggle: (name: string) => void;
  testIdPrefix?: string;
}) {
  const on = (name: string) =>
    selected.some((s) => s.trim().toLowerCase() === name.toLowerCase());

  return (
    <div className="flex flex-wrap gap-1.5" data-testid={`${testIdPrefix}-picker`}>
      {SETUP_TAGS.map((s) => (
        <button
          key={s.name}
          type="button"
          onClick={() => onToggle(s.name)}
          aria-pressed={on(s.name)}
          data-testid={`chip-${testIdPrefix}-${s.name}`}
          className={`rounded-full border px-2.5 py-1 text-[11px] leading-tight transition-colors ${
            on(s.name)
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
          }`}
        >
          {s.name}
          {s.hint && <span className="ml-1 opacity-60">{s.hint}</span>}
        </button>
      ))}
    </div>
  );
}
