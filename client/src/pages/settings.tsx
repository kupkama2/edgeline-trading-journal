import { useMemo, useState } from "react";
import { MembersCard } from "@/components/members-card";
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
  useStorageUsage,
  useDeleteStyle,
  useAccountSettings,
  useSaveAccountSettings,
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

/**
 * Fee schedule per account. One row per account name — the names come from
 * the trades themselves plus anything configured before its first trade.
 * Maker = limit orders, taker = market orders, always per side; the mode
 * decides whether the numbers read as % of notional (crypto) or dollars per
 * contract (futures). The Close dialog turns these into one-click fee
 * suggestions.
 */
function AccountFeesRow({
  name,
  existing,
}: {
  name: string;
  existing: { feeMode: string; makerFee: number; takerFee: number } | undefined;
}) {
  const save = useSaveAccountSettings();
  const { toast } = useToast();
  const [mode, setMode] = useState<"percent" | "perContract">(
    existing?.feeMode === "perContract" ? "perContract" : "percent",
  );
  const [maker, setMaker] = useState(existing != null ? String(existing.makerFee) : "");
  const [taker, setTaker] = useState(existing != null ? String(existing.takerFee) : "");
  const dirty =
    (existing?.feeMode ?? "percent") !== mode ||
    String(existing?.makerFee ?? "") !== (maker.trim() === "" ? "" : String(Number(maker))) ||
    String(existing?.takerFee ?? "") !== (taker.trim() === "" ? "" : String(Number(taker)));

  async function persist() {
    const m = Number(maker) || 0;
    const t = Number(taker) || 0;
    await save.mutateAsync({ name, feeMode: mode, makerFee: m, takerFee: t });
    toast({ title: "Fees saved", description: `${name} — schedule updated.` });
  }

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-secondary/20 px-2.5 py-2"
      data-testid={`account-fees-${name}`}
    >
      <span className="min-w-[7rem] text-xs font-medium">{name}</span>
      <div className="flex gap-0.5">
        {(
          [
            { k: "percent", l: "% notional" },
            { k: "perContract", l: "$ / contract" },
          ] as const
        ).map(({ k, l }) => (
          <button
            key={k}
            type="button"
            onClick={() => setMode(k)}
            data-testid={`button-fee-mode-${name}-${k}`}
            className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
              mode === k
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {l}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
        limit
        <Input
          value={maker}
          onChange={(e) => setMaker(e.target.value)}
          inputMode="decimal"
          placeholder="0"
          className="h-7 w-16 font-mono text-[11px]"
          data-testid={`input-maker-${name}`}
        />
      </label>
      <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
        market
        <Input
          value={taker}
          onChange={(e) => setTaker(e.target.value)}
          inputMode="decimal"
          placeholder="0"
          className="h-7 w-16 font-mono text-[11px]"
          data-testid={`input-taker-${name}`}
        />
      </label>
      <span className="text-[10px] text-muted-foreground">per side</span>
      {dirty && (
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-7 px-2 text-[11px]"
          onClick={persist}
          disabled={save.isPending}
          data-testid={`button-save-fees-${name}`}
        >
          <Check className="mr-1 h-3 w-3" />
          Save
        </Button>
      )}
    </div>
  );
}

function AccountFeesCard() {
  const { data: trades = [] } = useTrades();
  const { data: settings = [] } = useAccountSettings();
  const [newName, setNewName] = useState("");
  const [added, setAdded] = useState<string[]>([]);

  const names = useMemo(() => {
    const s = new Set<string>();
    for (const t of trades) if (t.account?.trim()) s.add(t.account.trim());
    for (const cfg of settings) s.add(cfg.name);
    for (const a of added) s.add(a);
    return Array.from(s).sort();
  }, [trades, settings, added]);

  return (
    <Card className="border-card-border bg-card p-4 sm:p-5" data-testid="card-account-fees">
      <h2 className="text-sm font-semibold tracking-tight">Account fees</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Commission per side for each account — limit (maker) and market (taker) orders
        separately. The Close dialog uses these to suggest the fee; you can always
        overtype it per trade.
      </p>
      <div className="mt-3 space-y-2">
        {names.length === 0 && (
          <p className="text-[11px] text-muted-foreground">
            No accounts yet — log a trade with an account, or add one below.
          </p>
        )}
        {names.map((n) => (
          <AccountFeesRow
            key={`${n}:${settings.find((s) => s.name === n)?.id ?? "new"}`}
            name={n}
            existing={settings.find((s) => s.name === n)}
          />
        ))}
        <div className="flex items-center gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="add an account…"
            className="h-8 w-48 text-xs"
            data-testid="input-new-fee-account"
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-8 px-2 text-[11px]"
            disabled={!newName.trim()}
            onClick={() => {
              setAdded((a) => [...a, newName.trim()]);
              setNewName("");
            }}
            data-testid="button-add-fee-account"
          >
            <Plus className="mr-1 h-3 w-3" />
            Add
          </Button>
        </div>
      </div>
    </Card>
  );
}

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
                /* Wraps rather than overflows: the colour swatches and the
                   session-hour pair are each wide enough to push this row off
                   a phone screen if they are forced onto one line. */
                className="flex flex-wrap items-center gap-2 rounded-md border border-border/70 bg-secondary/25 px-3 py-2"
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
                    <span className="min-w-0 flex-1 basis-24 truncate text-sm">{s.name}</span>

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

                    {/* The hours this book trades. Typed as HH:MM; clearing
                        either field removes the window and its warnings. */}
                    <div className="flex shrink-0 items-center gap-1">
                      <input
                        type="time"
                        defaultValue={s.sessionStart ?? ""}
                        onBlur={(e) =>
                          updateStyle.mutate({
                            id: s.id,
                            sessionStart: e.target.value || null,
                          })
                        }
                        className="h-7 rounded border border-border bg-transparent px-1 font-mono text-[10px] text-muted-foreground"
                        title="Session start — entries before this warn"
                        data-testid={`input-session-start-${s.id}`}
                      />
                      <span className="text-[10px] text-muted-foreground">–</span>
                      <input
                        type="time"
                        defaultValue={s.sessionEnd ?? ""}
                        onBlur={(e) =>
                          updateStyle.mutate({
                            id: s.id,
                            sessionEnd: e.target.value || null,
                          })
                        }
                        className="h-7 rounded border border-border bg-transparent px-1 font-mono text-[10px] text-muted-foreground"
                        title="Session end — entries after this warn"
                        data-testid={`input-session-end-${s.id}`}
                      />
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

      <AccountFeesCard />

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

      <StorageCard />

      {/* Owner only; renders nothing for everyone else. */}
      <MembersCard />
    </div>
  );
}

/**
 * Where the space goes. Screenshots are the only thing in this app that can
 * meaningfully consume a 512 MB free-tier database, so their cost gets a
 * gauge — storage problems should be watched approaching, not discovered.
 */
function StorageCard() {
  const { data } = useStorageUsage();
  if (!data) return null;
  const mb = data.bytes / (1024 * 1024);
  const budgetMb = 512; // Neon free tier
  const pct = Math.min(100, (mb / budgetMb) * 100);
  const avgKb = data.images ? data.bytes / data.images / 1024 : 0;
  return (
    <Card className="border-card-border bg-card p-4 sm:p-5" data-testid="card-storage">
      <h2 className="text-sm font-semibold tracking-tight">Screenshot storage</h2>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        Images are recompressed to review quality before saving (~40–90 KB each) and load only
        when a trade's detail is opened.
      </p>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-secondary/60">
        <div
          className={`h-full rounded-full ${pct > 80 ? "bg-red-500" : pct > 50 ? "bg-amber-500" : "bg-primary"}`}
          style={{ width: `${Math.max(pct, 0.5)}%` }}
        />
      </div>
      <p className="mt-1.5 font-mono text-[11px] text-muted-foreground" data-testid="text-storage">
        {data.images} {data.images === 1 ? "image" : "images"} · {mb.toFixed(1)} MB of ~
        {budgetMb} MB free tier{data.images > 0 && ` · ~${Math.round(avgKb)} KB avg`}
      </p>
    </Card>
  );
}
