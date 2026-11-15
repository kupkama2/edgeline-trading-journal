import { useState } from "react";
import { AlertTriangle, Pencil, Plus, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { fmtAmount } from "@shared/metrics";
import { useAddTyped, useRemoveTyped, useSaveTyped, useTypedPositions, useTypedValue, type TypedPosition } from "@/lib/sigil";

const amount = (s: string) => {
  const v = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(v) && v > 0 ? v : null;
};
const said = (err: any) => String(err?.message ?? err).replace(/^\d{3}:\s*/, "").replace(/^\{"message":"(.*)"\}$/, "$1");
const daysSince = (date: string) => Math.floor((Date.now() - Date.parse(`${date}T00:00:00Z`)) / 86400_000);
const pct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}%`;
const tone = (n: number) => (Math.abs(n) < 0.005 ? "text-muted-foreground" : n > 0 ? "text-emerald-400" : "text-red-400");

/** The latest typed value of a position; null before the first. */
export const latestOf = (p: TypedPosition) => p.values[p.values.length - 1] ?? null;

function Row({ p }: { p: TypedPosition }) {
  const setValue = useTypedValue();
  const save = useSaveTyped();
  const remove = useRemoveTyped();
  const { toast } = useToast();
  const [value, setValueText] = useState("");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [entry, setEntry] = useState(p.entryUsd == null ? "" : String(p.entryUsd));
  const last = latestOf(p);
  const before = p.values[p.values.length - 2] ?? null;
  const age = last ? daysSince(last.date) : null;
  const since = last && p.entryUsd ? last.valueUsd - p.entryUsd : null;
  const fail = (err: unknown) => toast({ title: "Not saved", description: said(err), variant: "destructive" });
  const onValue = (e: React.FormEvent) => {
    e.preventDefault();
    const v = amount(value);
    if (v == null) return;
    setValue.mutate({ id: p.id, valueUsd: v }, { onSuccess: () => setValueText(""), onError: fail });
  };
  return (
    <li className="py-2" data-testid={`typed-${p.id}`}>
      {editing ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            save.mutate({ id: p.id, name: name.trim(), entryUsd: amount(entry) }, { onSuccess: () => setEditing(false), onError: fail });
          }}
        >
          <Input className="h-8 w-44 text-xs" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
          <Input className="h-8 w-32 font-mono text-xs" inputMode="decimal" value={entry} onChange={(e) => setEntry(e.target.value)} placeholder="Entry, USD" />
          <Button size="sm" type="submit" className="h-8">
            Save
          </Button>
          <Button size="sm" type="button" variant="ghost" className="h-8" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button size="sm" type="button" variant="ghost" className="ml-auto h-8 text-muted-foreground hover:text-red-400" title="Remove this position and its values" onClick={() => window.confirm(`Remove ${p.name} and every value typed for it?`) && remove.mutate(p.id, { onError: fail })}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </form>
      ) : (
        <div className="flex flex-wrap items-end gap-x-5 gap-y-1.5">
          <div className="min-w-32">
            <p className="flex items-center gap-1 text-xs font-semibold">
              {p.name}
              <button type="button" className="rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground" title="Rename, or change the entry" onClick={() => setEditing(true)} data-testid={`typed-edit-${p.id}`}>
                <Pencil className="h-2.5 w-2.5" />
              </button>
            </p>
            <p className="font-mono text-lg font-bold leading-tight" data-testid={`typed-value-${p.id}`}>
              {last ? fmtAmount(last.valueUsd, 0) : "—"}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Since entry</p>
            <p className={`font-mono text-sm font-semibold ${since == null ? "text-muted-foreground" : tone(since)}`} data-testid={`typed-since-${p.id}`}>
              {since == null ? (p.entryUsd ? "—" : "set an entry") : `${since >= 0 ? "+" : "−"}${fmtAmount(Math.abs(since), 0)} (${pct((last!.valueUsd / p.entryUsd! - 1) * 100)})`}
            </p>
            {p.entryUsd != null && <p className="font-mono text-[10px] text-muted-foreground">in at {fmtAmount(p.entryUsd, 0)}</p>}
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Last typed</p>
            <p className="font-mono text-[11px]">
              {last ? last.date : "never"}
              {before && last && <span className={`ml-1.5 ${tone(last.valueUsd - before.valueUsd)}`}>{pct((last.valueUsd / before.valueUsd - 1) * 100)} on {before.date.slice(5)}</span>}
            </p>
            {/* Typed by hand, so it is only as fresh as the last time: the age is always in view. */}
            {age != null && age > 0 && (
              <p className={`text-[10px] ${age > 8 ? "inline-flex items-center gap-1 font-semibold uppercase text-amber-500" : "text-muted-foreground"}`} data-testid={`typed-stale-${p.id}`}>
                {age > 8 && <AlertTriangle className="h-3 w-3" />}
                {age} {age === 1 ? "day" : "days"} old
              </p>
            )}
          </div>
          <form className="ml-auto flex items-center gap-1.5" onSubmit={onValue}>
            <Input className="h-8 w-32 font-mono text-xs" inputMode="decimal" placeholder="Value today, USD" value={value} onChange={(e) => setValueText(e.target.value)} data-testid={`typed-input-${p.id}`} />
            <Button size="sm" type="submit" className="h-8" disabled={amount(value) == null || setValue.isPending} data-testid={`typed-save-${p.id}`}>
              Update
            </Button>
          </form>
        </div>
      )}
    </li>
  );
}

/**
 * Positions kept by hand: a stake whose value comes as one number, weekly
 * or whenever. Each has a name and what went in; the value is typed when
 * it is known, and typing again on the same day corrects it.
 */
export function TypedPositions({ group = null, blurb, suggest = "", testId = "typed-positions" }: { group?: "sigil" | null; blurb?: string; suggest?: string; testId?: string }) {
  const { data: all = [] } = useTypedPositions();
  const list = all.filter((p) => (p.group ?? null) === group);
  const add = useAddTyped();
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(suggest);
  const [entry, setEntry] = useState("");
  return (
    <Card className="border-card-border bg-card p-3 sm:p-4" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 text-[11px] text-muted-foreground">{blurb ?? "A name, what went in, and a value you type when you have one. Counted in the total above."}</p>
        {!adding && (
          <button type="button" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => setAdding(true)} data-testid="typed-add">
            <Plus className="h-3 w-3" /> {group === "sigil" && list.length === 0 ? `Add ${suggest || "a position"}` : "Add a position"}
          </button>
        )}
      </div>
      {list.length === 0 && !adding && group == null && <p className="mt-1 text-xs text-muted-foreground">Nothing here yet. Add a stake you get one number for (a fund share, an angel investment), then type its value when you have it.</p>}
      {list.length > 0 && (
        <ul className="divide-y divide-border/40">
          {list.map((p) => (
            <Row key={p.id} p={p} />
          ))}
        </ul>
      )}
      {adding && (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            add.mutate({ name: name.trim(), entryUsd: amount(entry), group }, { onSuccess: () => (setAdding(false), setName(suggest), setEntry("")), onError: (err) => toast({ title: "Not added", description: said(err), variant: "destructive" }) });
          }}
        >
          <Input autoFocus className="h-8 w-44 text-xs" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} data-testid="typed-new-name" />
          <Input className="h-8 w-32 font-mono text-xs" inputMode="decimal" placeholder="Entry, USD" value={entry} onChange={(e) => setEntry(e.target.value)} data-testid="typed-new-entry" />
          <Button size="sm" type="submit" className="h-8" disabled={!name.trim() || add.isPending} data-testid="typed-new-save">
            Add
          </Button>
          <Button size="sm" type="button" variant="ghost" className="h-8" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </form>
      )}
    </Card>
  );
}
