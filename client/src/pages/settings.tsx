import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  useMistakeTags,
  useCreateTag,
  useUpdateTag,
  useDeleteTag,
  useTrades,
  useStyles,
  useCreateStyle,
  useUpdateStyle,
  useDeleteStyle,
} from "@/lib/data";
import { STYLE_COLOR_NAMES, styleColor } from "@/lib/style-filter";
import {
  DAILY_LOSS_ALERT,
  DAILY_LOSS_STOP,
  LOSS_STREAK_LIMIT,
  COOLDOWN_SECONDS,
  getPrestige,
  fmtMoney,
  mistakeCostLeaderboard,
} from "@shared/metrics";

function StylesCard() {
  const { toast } = useToast();
  const { data: styles = [], isLoading } = useStyles();
  const { data: trades = [] } = useTrades();
  const createStyle = useCreateStyle();
  const updateStyle = useUpdateStyle();
  const deleteStyle = useDeleteStyle();

  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmingId, setConfirmingId] = useState<number | null>(null);

  const counts = useMemo(() => {
    const acc: Record<number, number> = {};
    for (const t of trades) {
      if (t.styleId != null) acc[t.styleId] = (acc[t.styleId] ?? 0) + 1;
    }
    return acc;
  }, [trades]);

  async function add() {
    const name = newName.trim();
    if (!name) return;
    const color = STYLE_COLOR_NAMES[styles.length % STYLE_COLOR_NAMES.length];
    await createStyle.mutateAsync({ name, color, sortOrder: styles.length });
    setNewName("");
    toast({ title: "Style added", description: name });
  }

  return (
    <Card className="border-card-border bg-card p-4 sm:p-5">
      <h2 className="text-sm font-semibold tracking-tight">Trading styles</h2>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        Each style is its own book — stats, demon streaks and the guardrail lock are tracked
        separately, so a losing run in one never halts the other. Deleting a style keeps its
        trades and marks them unassigned.
      </p>

      <div className="mt-4 flex gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder="New style — e.g. NQ scalps…"
          className="h-9 text-sm"
          data-testid="input-new-style"
        />
        <Button
          onClick={add}
          disabled={!newName.trim() || createStyle.isPending}
          className="h-9 shrink-0 gap-1 text-xs"
          data-testid="button-add-style"
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>

      <div className="mt-4 space-y-1.5">
        {isLoading ? (
          <>
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </>
        ) : styles.length === 0 ? (
          <p className="rounded-md border border-dashed border-border/70 px-3 py-4 text-center text-[11px] text-muted-foreground">
            No styles yet. Add one above to start separating your books.
          </p>
        ) : (
          styles.map((s) => {
            const editing = editingId === s.id;
            const c = styleColor(s.color);
            const used = counts[s.id] ?? 0;
            return (
              <div
                key={s.id}
                className="flex items-center gap-2 rounded-md border border-border/70 bg-secondary/25 px-3 py-2"
                data-testid={`row-style-${s.id}`}
              >
                {editing ? (
                  <>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="h-8 text-sm"
                      data-testid={`input-edit-style-${s.id}`}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0 text-emerald-400"
                      onClick={async () => {
                        if (editName.trim())
                          await updateStyle.mutateAsync({ id: s.id, name: editName.trim() });
                        setEditingId(null);
                      }}
                      data-testid={`button-save-style-${s.id}`}
                      aria-label="Save style"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0"
                      onClick={() => setEditingId(null)}
                      aria-label="Cancel"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </>
                ) : (
                  <>
                    <span className={`h-2 w-2 shrink-0 rounded-full ${c.dot}`} />
                    <span className="min-w-0 flex-1 truncate text-sm">{s.name}</span>

                    <div className="flex shrink-0 items-center gap-1">
                      {STYLE_COLOR_NAMES.map((name) => (
                        <button
                          key={name}
                          type="button"
                          aria-label={`Colour ${name}`}
                          onClick={() => updateStyle.mutate({ id: s.id, color: name })}
                          className={`h-3 w-3 rounded-full ${styleColor(name).dot} ${
                            s.color === name
                              ? "ring-2 ring-foreground/60 ring-offset-1 ring-offset-background"
                              : "opacity-40 hover:opacity-100"
                          }`}
                          data-testid={`button-style-color-${s.id}-${name}`}
                        />
                      ))}
                    </div>

                    <span className="w-16 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                      {used} {used === 1 ? "trade" : "trades"}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0 text-muted-foreground"
                      onClick={() => {
                        setEditingId(s.id);
                        setEditName(s.name);
                      }}
                      data-testid={`button-edit-style-${s.id}`}
                      aria-label="Rename style"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    {confirmingId === s.id ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-7 shrink-0 text-[11px]"
                        onClick={async () => {
                          await deleteStyle.mutateAsync(s.id);
                          setConfirmingId(null);
                          toast({
                            title: "Style deleted",
                            description: used
                              ? `${used} ${used === 1 ? "trade is" : "trades are"} now unassigned.`
                              : s.name,
                          });
                        }}
                        data-testid={`button-confirm-delete-style-${s.id}`}
                      >
                        Delete?
                      </Button>
                    ) : (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => setConfirmingId(s.id)}
                        data-testid={`button-delete-style-${s.id}`}
                        aria-label="Delete style"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </>
                )}
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}

export default function Settings() {
  const { toast } = useToast();
  const { data: tags, isLoading } = useMistakeTags();
  const { data: trades = [] } = useTrades();
  const createTag = useCreateTag();
  const updateTag = useUpdateTag();
  const deleteTag = useDeleteTag();

  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");

  const tagNames = useMemo(
    () => Object.fromEntries((tags ?? []).map((t) => [t.id, t.name])) as Record<number, string>,
    [tags],
  );
  const costs = useMemo(
    () =>
      Object.fromEntries(
        mistakeCostLeaderboard(trades, tagNames).map((r) => [r.tagId, r]),
      ),
    [trades, tagNames],
  );

  async function add() {
    const name = newName.trim();
    if (!name) return;
    await createTag.mutateAsync({ name, sortOrder: (tags?.length ?? 0) });
    setNewName("");
    toast({ title: "Tag added", description: name });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Settings</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Your demons (named mistakes) and the risk guardrails that halt trading.
        </p>
      </div>

      <StylesCard />

      <Card className="border-card-border bg-card p-4 sm:p-5">
        <h2 className="text-sm font-semibold tracking-tight">Demons</h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          The fixed nine come from Tom Dante's Demon Finder; add your own below. These are the
          one-tap chips shown when you close a trade. Prestige rises every 10 trades a demon is
          attached to — the more prestige, the more dangerous the habit.
        </p>

        <div className="mt-4 flex gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
            placeholder="New custom demon…"
            className="h-9 text-sm"
            data-testid="input-new-tag"
          />
          <Button
            onClick={add}
            disabled={!newName.trim() || createTag.isPending}
            className="h-9 shrink-0 gap-1 text-xs"
            data-testid="button-add-tag"
          >
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        </div>

        <div className="mt-4 space-y-1.5">
          {isLoading ? (
            <>
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
            </>
          ) : (
            (tags ?? []).map((t) => {
              const c = costs[t.id];
              const { tier } = getPrestige(c?.trades ?? 0);
              const editing = editingId === t.id;
              return (
                <div
                  key={t.id}
                  className="flex items-center gap-2 rounded-md border border-border/70 bg-secondary/25 px-3 py-2"
                  data-testid={`row-tag-${t.id}`}
                >
                  {editing ? (
                    <>
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="h-8 text-sm"
                        data-testid={`input-edit-tag-${t.id}`}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 shrink-0 text-emerald-400"
                        onClick={async () => {
                          if (editName.trim())
                            await updateTag.mutateAsync({ id: t.id, name: editName.trim() });
                          setEditingId(null);
                        }}
                        data-testid={`button-save-tag-${t.id}`}
                        aria-label="Save tag"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 shrink-0"
                        onClick={() => setEditingId(null)}
                        aria-label="Cancel"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate text-sm">{t.name}</span>
                      {c?.trades ? (
                        <Badge variant="outline" className={`shrink-0 text-[10px] ${tier.color}`}>
                          {tier.name}
                        </Badge>
                      ) : null}
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        {c ? `-${fmtMoney(c.cost).replace("+", "")}` : "—"}
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 shrink-0 text-muted-foreground"
                        onClick={() => {
                          setEditingId(t.id);
                          setEditName(t.name);
                        }}
                        data-testid={`button-edit-tag-${t.id}`}
                        aria-label="Edit tag"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => deleteTag.mutate(t.id)}
                        data-testid={`button-delete-tag-${t.id}`}
                        aria-label="Delete tag"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>
      </Card>

      <Card className="border-card-border bg-card p-4 sm:p-5">
        <h2 className="text-sm font-semibold tracking-tight">Risk guardrails</h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Carried over from the old tap-counter, now driven by real closed trades.
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { k: "Daily warning", v: fmtMoney(-DAILY_LOSS_ALERT) },
            { k: "Daily hard stop", v: fmtMoney(-DAILY_LOSS_STOP) },
            { k: "Loss-streak halt", v: `${LOSS_STREAK_LIMIT} in a row` },
            { k: "Forced cooldown", v: `${COOLDOWN_SECONDS}s` },
          ].map((r) => (
            <div key={r.k} className="rounded-md border border-border/60 bg-secondary/25 p-2.5">
              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{r.k}</dt>
              <dd className="mt-0.5 font-mono text-sm font-bold">{r.v}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card className="border-card-border bg-card p-4 sm:p-5">
        <h2 className="text-sm font-semibold tracking-tight">How the metrics work</h2>
        <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <li>
            <span className="text-foreground">Actual R</span> — realised move divided by your
            original risk (entry to initial stop).
          </li>
          <li>
            <span className="text-foreground">No-management R</span> — what the untouched plan
            would have paid: the full target if price hit target first, −1R if it hit the stop
            first.
          </li>
          <li>
            <span className="text-foreground">Δ management</span> — actual minus no-management.
            Negative means intervening cost you money.
          </li>
          <li>
            <span className="text-foreground">Capture</span> — actual R divided by MFE R: how much
            of the best available move you kept.
          </li>
          <li>
            Costs on the leaderboard split each trade's give-back evenly across the mistake tags
            attached to it.
          </li>
        </ul>
      </Card>
    </div>
  );
}
