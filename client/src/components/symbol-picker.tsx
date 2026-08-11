/**
 * Picking what you traded.
 *
 * Three kinds of answer share one box, in the order they are actually wanted:
 * the instruments already in your log (you trade the same handful daily), then
 * the futures contracts the journal knows how to size, then whatever you type
 * that matches neither — which is assumed to be a crypto asset, because that
 * is what a symbol this journal has never seen almost always is.
 *
 * It stays a text field rather than becoming a dropdown. A dropdown would make
 * the unknown case a second-class citizen behind a "new…" option, and the
 * unknown case is a normal Tuesday: a token listed last week is not an
 * exception to be handled, it is a trade to be logged.
 *
 * Every contract row shows what one holds. That is the line of defence against
 * a wrong multiplier — reading "Micro Bitcoin · 0.1 BTC" before you commit is
 * how a bad table entry gets caught by a human instead of silently mispricing
 * the trade.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { CONTRACTS, type ContractSpec } from "@shared/symbols";
import type { TradeWithTags } from "@shared/schema";

interface Option {
  /** What goes in the field. */
  value: string;
  /** Right-hand detail: the contract's name, or how often you've traded it. */
  detail: string;
  group: "yours" | "contracts";
}

/** Instruments already in the log, most recently traded first. */
function fromHistory(trades: TradeWithTags[]): Option[] {
  const seen = new Map<string, { n: number; last: string }>();
  for (const t of trades) {
    const key = (t.contract || t.symbol || "").trim().toUpperCase();
    if (!key) continue;
    const prev = seen.get(key);
    const last = t.entryTime ?? "";
    if (prev) {
      prev.n += 1;
      if (last > prev.last) prev.last = last;
    } else seen.set(key, { n: 1, last });
  }
  return Array.from(seen.entries())
    .sort((a, b) => b[1].last.localeCompare(a[1].last))
    .map(([value, { n }]) => ({
      value,
      detail: `${n} ${n === 1 ? "trade" : "trades"}`,
      group: "yours" as const,
    }));
}

function contractDetail(c: ContractSpec): string {
  const size = c.unit ? `${c.pointValue} ${c.unit}` : `$${c.pointValue}/pt`;
  return `${c.label} · ${size}`;
}

export function SymbolPicker({
  value,
  onChange,
  trades,
  testId = "input-symbol",
  ...rest
}: {
  value: string;
  onChange: (v: string) => void;
  trades: TradeWithTags[];
  testId?: string;
} & Omit<React.ComponentProps<typeof Input>, "value" | "onChange">) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const all = useMemo<Option[]>(() => {
    const mine = fromHistory(trades);
    const owned = new Set(mine.map((m) => m.value));
    const table = CONTRACTS
      // A contract already in your log is listed above under "yours"; showing
      // it twice would push the useful half of the list off the bottom.
      .filter((c) => !owned.has(c.root))
      .map((c) => ({ value: c.root, detail: contractDetail(c), group: "contracts" as const }));
    return [...mine, ...table];
  }, [trades]);

  const q = value.trim().toUpperCase();
  const matches = useMemo(() => {
    if (!q) return all.slice(0, 8);
    const starts = all.filter((o) => o.value.startsWith(q));
    const contains = all.filter((o) => !o.value.startsWith(q) && o.value.includes(q));
    return [...starts, ...contains].slice(0, 8);
  }, [all, q]);

  /*
   * "This is a new asset" is only worth saying once nothing matches at all.
   * Showing it while the list still has candidates — which "M" does, eight of
   * them — labels every half-typed contract as new and trains you to ignore
   * the one message that matters.
   */
  const isNew = q !== "" && matches.length === 0;

  useEffect(() => setActive(0), [q]);

  // Clicking away commits whatever is typed — the field is the source of
  // truth, and the list is only ever a shortcut into it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <div className="relative" ref={boxRef}>
      <Input
        {...rest}
        value={value}
        onChange={(e) => {
          onChange(e.target.value.toUpperCase());
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open || matches.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => (i + 1) % matches.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => (i - 1 + matches.length) % matches.length);
          } else if (e.key === "Enter") {
            // Only steal Enter when a suggestion is genuinely highlighted;
            // otherwise it belongs to the form.
            if (matches[active] && matches[active].value !== q) {
              e.preventDefault();
              pick(matches[active].value);
            } else setOpen(false);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        autoComplete="off"
        spellCheck={false}
        data-testid={testId}
      />

      {open && (matches.length > 0 || isNew) && (
        <div
          className="absolute z-50 mt-1 w-full min-w-[16rem] overflow-hidden rounded-md border border-border bg-popover shadow-lg"
          data-testid="symbol-suggestions"
        >
          {(["yours", "contracts"] as const).map((group) => {
            const rows = matches.filter((m) => m.group === group);
            if (rows.length === 0) return null;
            return (
              <div key={group}>
                <p className="px-2.5 pb-0.5 pt-1.5 text-[9px] uppercase tracking-wider text-muted-foreground">
                  {group === "yours" ? "Your instruments" : "Futures contracts"}
                </p>
                {rows.map((o) => {
                  const i = matches.indexOf(o);
                  return (
                    <button
                      key={`${group}-${o.value}`}
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pick(o.value)}
                      data-testid={`symbol-option-${o.value}`}
                      className={`flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left transition-colors ${
                        i === active ? "bg-secondary" : ""
                      }`}
                    >
                      <span className="font-mono text-xs font-medium">{o.value}</span>
                      <span className="ml-auto truncate text-[10px] text-muted-foreground">
                        {o.detail}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}

          {isNew && (
            <p
              className="border-t border-border/60 px-2.5 py-1.5 text-[10px] leading-snug text-muted-foreground"
              data-testid="symbol-new-asset"
            >
              <span className="font-mono text-foreground">{q}</span> isn&apos;t a contract we
              know — logging it as a crypto asset, sized in USD.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
