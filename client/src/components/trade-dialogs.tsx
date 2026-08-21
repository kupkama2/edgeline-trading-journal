/**
 * The trade editor.
 *
 * There used to be two dialogs here — close it, and edit it — stacked over a
 * /trade/:id page that was itself a modal. Closing was never a different act
 * from editing, only a different subset of the same questions with a
 * different button, and two writers for one row is how they drift apart. Both
 * are gone: this renders inside the trade's own surface, and "close this
 * trade" means filling in the exit.
 */
import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { ArrowUpRight, CheckCircle2, Clock3, Loader2, Pencil, Trash2 } from "lucide-react";
import { useAccountSettings, useMistakeTags, useUpdateTrade, useAddTradeImage, archiveDataUrl, parseScreenshot, fileToDownscaledDataUrl } from "@/lib/data";
import { suggestFees } from "@shared/fees";
import { knownHighlights, parseHighlights, serializeHighlights } from "@shared/highlights";
import { AccountPicker, HighlightPicker, SetupTagPicker } from "@/components/trade-pickers";
import { normalizeSetupTags } from "@shared/setups";
import { splitSourceFromTags } from "@shared/sources";
import { useDeleteFill, useStyles, useTrades } from "@/lib/data";
import { styleColor } from "@/lib/style-filter";
import { collapseFills, positionLedger } from "@shared/fills";
import { TradeImageGallery } from "@/components/trade-images";
import { parseExtraTargets, parsePlaybook, type TradeWithTags } from "@shared/schema";
import { computeMetrics, fmtFees, fmtMoney, fmtR, EXIT_REASON_LABELS } from "@shared/metrics";
import { Dropzone, EXIT_REASONS, RationaleTags, TimeField, localNow, num, parseTags, toIso } from "@/components/trade-shared";
import { EMPTY_GRADES, GradePicker, type GradeState } from "@/components/grade-picker";
import {
  TradeOutcomeFields,
  outcomeStage,
  resolveLifecycle,
  type Lifecycle,
} from "@/components/trade-outcome";
import { SymbolPicker } from "@/components/symbol-picker";
import { typedSymbol } from "@shared/symbols";

/** An ISO instant as the local wall-clock string a datetime-local shows. */
function toLocalInput(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/**
 * Editing a trade, as a panel rather than a window.
 *
 * This used to be a dialog stacked on top of the trade overlay, which is why
 * viewing and editing felt like two different places: you were two modals
 * deep, looking at the same trade twice. Now the overlay swaps its read-only
 * body for this and you stay exactly where you were.
 *
 * Closing a trade is not a separate flow either — it is editing one and
 * filling in the exit. That is all "closing" ever was; the second dialog only
 * existed to ask a subset of these questions with a different button on the
 * bottom, and having two writers for one row is how they drift apart.
 */
export function TradeEditor({
  trade,
  onClose,
}: {
  trade: TradeWithTags | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { data: tags = [] } = useMistakeTags();
  const updateTrade = useUpdateTrade();

  const [f, setF] = useState<Record<string, string>>({});
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [exitReason, setExitReason] = useState<string | null>(null);
  const [nmo, setNmo] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<number[]>([]);
  // Scale-out levels beyond TP1 — editable strings, serialized on save.
  const [extraTps, setExtraTps] = useState<string[]>([]);
  const [highlights, setHighlights] = useState<string[]>([]);
  const [grades, setGrades] = useState<GradeState>(EMPTY_GRADES);
  const [account, setAccount] = useState("");
  // Which book the trade belongs to. Mutable after the fact on purpose: a
  // trade often turns out to belong to a different style than the one that
  // was active when it was logged, and without this the only fix was to
  // delete it and re-enter it.
  const [styleId, setStyleId] = useState<number | null>(null);
  // Contracts vs USD notional. Editable because it is the one field that
  // silently changes what every other number MEANS — a 3,000 logged as
  // contracts instead of dollars misprices the whole trade — and until now it
  // could only be set at entry.
  const [sizeUnit, setSizeUnit] = useState<"base" | "quote">("base");
  const { data: styles = [] } = useStyles();
  const { data: allTrades = [] } = useTrades();
  const deleteFill = useDeleteFill();
  const [merging, setMerging] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);

  // What the trade would look like as a single round trip. Null when there is
  // nothing to fold (no fills, or it hasn't been closed yet).
  const merged = useMemo(() => (trade ? collapseFills(trade) : null), [trade]);

  /**
   * Fold the scaling away: write the averaged round trip, then drop the fills.
   * Two clicks, because it destroys the fill history and the first click is
   * where the consequence is spelled out. The trade is written BEFORE the
   * fills are removed, so a failure midway leaves a trade that still adds up
   * rather than one whose exit no longer accounts for its partials.
   */
  async function mergeIntoOneExit() {
    if (!trade || !merged) return;
    if (!confirmMerge) {
      setConfirmMerge(true);
      return;
    }
    setMerging(true);
    try {
      await updateTrade.mutateAsync({
        id: trade.id,
        trade: {
          size: merged.size,
          entryPrice: merged.entryPrice,
          exitPrice: merged.exitPrice,
        },
        mistakeTagIds: selectedTags,
      });
      for (const fl of trade.fills) await deleteFill.mutateAsync(fl.id);
      setF((prev) => ({
        ...prev,
        size: String(merged.size),
        entryPrice: String(merged.entryPrice),
        exitPrice: String(merged.exitPrice),
      }));
      toast({
        title: "Merged into one exit",
        description: `Now ${num(merged.size)} @ ${num(merged.entryPrice)} → ${num(merged.exitPrice)}. Same P&L.`,
      });
    } catch (err: any) {
      toast({
        title: "Couldn't merge",
        description: String(err?.message ?? err).slice(0, 160),
        variant: "destructive",
      });
    } finally {
      setMerging(false);
      setConfirmMerge(false);
    }
  }
  const knownAccounts = useMemo(() => {
    const s = new Set<string>();
    for (const t of allTrades) if (t.account?.trim()) s.add(t.account.trim());
    return Array.from(s).sort();
  }, [allTrades]);
  const knownSources = useMemo(() => {
    const s = new Set<string>();
    for (const t of allTrades) if (t.source?.trim()) s.add(t.source.trim());
    return Array.from(s).sort();
  }, [allTrades]);
  const [source, setSource] = useState("");
  /**
   * Where this trade is in its life. Explicit rather than inferred, because
   * every step is editable: an order that never filled goes back to pending, a
   * trade closed by mistake goes back to open.
   */
  const [lifecycle, setLifecycle] = useState<Lifecycle>("open");

  useEffect(() => {
    if (!trade) return;
    setF({
      // The contract as written when there was one — see typedSymbol. Showing
      // the rollup here is what made editing an MBTZ6 trade save it as "BTC".
      symbol: typedSymbol(trade),
      size: String(trade.size),
      entryPrice: String(trade.entryPrice),
      // Pending trades have no stop/target yet — String(null) would put the
      // literal text "null" in the field for the user to delete by hand.
      initialStop: trade.initialStop != null ? String(trade.initialStop) : "",
      initialTarget: trade.initialTarget != null ? String(trade.initialTarget) : "",
      entryTime: toLocalInput(trade.entryTime),
      exitPrice: trade.exitPrice != null ? String(trade.exitPrice) : "",
      exitTime: toLocalInput(trade.exitTime),
      mae: trade.mae != null ? String(trade.mae) : "",
      mfe: trade.mfe != null ? String(trade.mfe) : "",
      postExitPeak: trade.postExitPeak != null ? String(trade.postExitPeak) : "",
      postExitAdverse: trade.postExitAdverse != null ? String(trade.postExitAdverse) : "",
      rationale: trade.rationale ?? "",
      rationaleTags: parseTags(trade.rationaleTags).join(", "),
      notes: trade.notes ?? "",
      account: trade.account ?? "",
      fees: trade.fees != null ? String(trade.fees) : "",
    });
    setDirection(trade.direction === "short" ? "short" : "long");
    setExitReason(trade.exitReason ?? null);
    setNmo(trade.noManagementOutcome ?? null);
    setSelectedTags(trade.mistakeTagIds);
    setExtraTps(parseExtraTargets(trade.extraTargets).map(String));
    setHighlights(parseHighlights(trade.highlights));
    setGrades({
      entry: trade.entryGrade ?? null,
      stop: trade.stopGrade ?? null,
      exit: trade.exitGrade ?? null,
    });
    setAccount(trade.account ?? "");
    setSource(trade.source ?? "");
    setStyleId(trade.styleId ?? null);
    setSizeUnit(trade.sizeUnit === "quote" ? "quote" : "base");
    setLifecycle(
      trade.status === "pending" ? "pending" : trade.status === "closed" ? "closed" : "open",
    );
  }, [trade]);

  /*
   * Typing an exit price IS closing the trade, so the picker follows — you
   * should not have to say it twice. One-way on purpose: it never drags a
   * trade back OFF closed, so clearing the field to correct a typo does not
   * reopen a finished trade underneath you.
   */
  useEffect(() => {
    if (outcomeStage(f.exitPrice ?? "", null).priced) {
      setLifecycle((cur) => (cur === "closed" ? cur : "closed"));
    }
  }, [f.exitPrice]);

  const set = (k: string) => (e: { target: { value: string } }) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  const numOrNull = (v: string) => (v.trim() === "" || !isFinite(Number(v)) ? null : Number(v));

  const previewMetrics = useMemo(() => {
    if (!trade) return null;
    const entryPrice = numOrNull(f.entryPrice ?? "");
    const initialStop = numOrNull(f.initialStop ?? "");
    if (entryPrice == null || initialStop == null) return null;
    return computeMetrics({
      ...trade,
      direction,
      size: numOrNull(f.size ?? "") ?? trade.size,
      sizeUnit,
      entryPrice,
      initialStop,
      initialTarget: numOrNull(f.initialTarget ?? "") ?? trade.initialTarget,
      exitPrice: numOrNull(f.exitPrice ?? ""),
      mae: numOrNull(f.mae ?? ""),
      mfe: numOrNull(f.mfe ?? ""),
      noManagementOutcome: nmo,
      // Without this the preview kept the SAVED fee while you edited the
      // field, so correcting a commission left the R below it unmoved.
      fees: numOrNull(f.fees ?? ""),
    } as any);
  }, [trade, f, direction, nmo]);

  async function save() {
    if (!trade) return;
    const entryPrice = numOrNull(f.entryPrice);
    const initialStop = numOrNull(f.initialStop);
    const initialTarget = numOrNull(f.initialTarget);
    const size = numOrNull(f.size);
    // A pending trade is only a resting order, so it may be saved with just an
    // entry — that is the whole point of importing one before it fills. Stop
    // and target become mandatory when it goes live.
    const isPending = trade.status === "pending";
    if (!f.symbol?.trim() || entryPrice == null || size == null) {
      toast({ title: "Symbol, size and entry are required", variant: "destructive" });
      return;
    }
    if (!isPending && (initialStop == null || initialTarget == null)) {
      toast({ title: "A live trade needs a stop and a target", variant: "destructive" });
      return;
    }
    // The picked lifecycle and the exit price must agree before anything is
    // written; see resolveLifecycle for why neither contradiction is allowed.
    const resolution = resolveLifecycle(lifecycle, f.exitPrice ?? "");
    if ("error" in resolution) {
      toast({ title: resolution.error, variant: "destructive" });
      return;
    }
    const resolved = resolution;
    // Same promotion as the entry card: a source name typed into the tag
    // field moves to the source column rather than becoming a fake setup.
    const promoted = splitSourceFromTags(
      normalizeSetupTags(f.rationaleTags.split(",")),
      knownSources,
      source.trim() || null,
    );
    const rTags = promoted.tags;

    try {
    await updateTrade.mutateAsync({
      id: trade.id,
      trade: {
        symbol: f.symbol.trim().toUpperCase(),
        direction,
        size,
        entryPrice,
        sizeUnit,
        initialStop,
        initialTarget,
        entryTime: f.entryTime ? toIso(f.entryTime) : trade.entryTime,
        extraTargets: (() => {
          const xs = extraTps.map(Number).filter((x) => isFinite(x) && x > 0);
          return xs.length ? JSON.stringify(xs) : null;
        })(),
        status: resolved.status,
        exitPrice: numOrNull(f.exitPrice),
        exitTime: f.exitTime ? toIso(f.exitTime) : null,
        exitReason: (exitReason as any) ?? null,
        mae: numOrNull(f.mae),
        mfe: numOrNull(f.mfe),
        postExitPeak: numOrNull(f.postExitPeak ?? ""),
        postExitAdverse: numOrNull(f.postExitAdverse ?? ""),
        noManagementOutcome: (nmo as any) ?? null,
        rationale: f.rationale.trim() || null,
        rationaleTags: rTags.length ? JSON.stringify(rTags) : null,
        notes: f.notes.trim() || null,
        account: account.trim() || null,
        source: promoted.source,
        styleId,
        fees: numOrNull(f.fees ?? ""),
        highlights: serializeHighlights(highlights),
        entryGrade: grades.entry as any,
        stopGrade: grades.stop as any,
        exitGrade: grades.exit as any,
      },
      mistakeTagIds: selectedTags,
    });
    toast({ title: "Trade updated", description: `${f.symbol.toUpperCase()} corrected.` });
    onClose();
    } catch (err: any) {
      /*
       * A save that fails must say so, and must NOT close.
       *
       * Without this the promise rejected into nothing: no toast, no close,
       * the editor sitting there looking saved. A cold start, an expired
       * session or a rejected field all presented as success, and the work
       * was gone the next time the trade was opened. The panel stays put so
       * nothing typed is lost — pressing save again is the whole retry.
       */
      toast({
        title: "Not saved — nothing was changed",
        description: `${String(err?.message ?? err).slice(0, 140)} · your edits are still here, press Save to try again.`,
        variant: "destructive",
      });
    }
  }

  const field = (
    key: string,
    label: string,
    type: "number" | "text" | "datetime-local" = "number",
  ) => (
    <div className="space-y-1">
      <label className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</label>
      <Input
        type={type}
        step={type === "number" ? "any" : undefined}
        inputMode={type === "number" ? "decimal" : undefined}
        value={f[key] ?? ""}
        onChange={set(key)}
        className={`h-9 ${type === "datetime-local" ? "font-mono text-xs" : "font-mono text-sm"}`}
        data-testid={`input-edit-${key}`}
      />
    </div>
  );

  return (
    <div className="space-y-4" data-testid="panel-trade-editor">
      <div>
        <div className="flex items-center gap-2 text-base font-semibold">
          <Pencil className="h-4 w-4 text-muted-foreground" />
          Edit {trade ? typedSymbol(trade) : ""}
        </div>

        {trade && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="min-w-0 space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Symbol
                </label>
                <SymbolPicker
                  value={f.symbol ?? ""}
                  onChange={(v) => setF((p) => ({ ...p, symbol: v }))}
                  trades={allTrades}
                  testId="input-edit-symbol"
                  className="h-9 font-mono text-sm"
                />
              </div>
              <div className="min-w-0 space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Direction
                </label>
                <div className="flex gap-1.5">
                  {(["long", "short"] as const).map((d) => (
                    <Button
                      key={d}
                      type="button"
                      size="sm"
                      variant={direction === d ? "default" : "outline"}
                      className={`h-9 min-w-0 flex-1 gap-1 px-1.5 text-xs capitalize ${
                        direction === d && d === "long"
                          ? "bg-emerald-600 text-white hover:bg-emerald-600/90"
                          : ""
                      }`}
                      onClick={() => setDirection(d)}
                      data-testid={`button-edit-direction-${d}`}
                    >
                      {d}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Size
                  </label>
                  <div className="flex gap-0.5">
                    {(["base", "quote"] as const).map((u) => {
                      // A futures contract has no notional sizing; offering it
                      // there produces a real but meaningless 1R.
                      const disabled = u === "quote" && (trade.pointValue ?? 1) !== 1;
                      return (
                        <button
                          key={u}
                          type="button"
                          disabled={disabled}
                          title={disabled ? "Futures are sized in contracts" : undefined}
                          onClick={() => !disabled && setSizeUnit(u)}
                          data-testid={`button-edit-size-unit-${u}`}
                          aria-pressed={sizeUnit === u}
                          className={`rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider transition-colors ${
                            disabled
                              ? "cursor-not-allowed text-muted-foreground/30"
                              : sizeUnit === u
                                ? "bg-primary/15 text-primary"
                                : "text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {u === "base" ? "units" : "usd"}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <Input
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={f.size ?? ""}
                  onChange={set("size")}
                  className="h-9 font-mono text-sm"
                  data-testid="input-edit-size"
                />
              </div>
              {field("entryPrice", "Entry")}
              {field("initialStop", "Stop")}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {extraTps.length > 0 ? "TP1" : "Target"}
                  </label>
                  {extraTps.length < 3 && (
                    <button
                      type="button"
                      onClick={() => setExtraTps((x) => [...x, ""])}
                      title="Add another take-profit level"
                      data-testid="button-edit-add-tp"
                      className="rounded px-1 text-[11px] leading-none text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                    >
                      +
                    </button>
                  )}
                </div>
                <Input
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={f.initialTarget ?? ""}
                  onChange={set("initialTarget")}
                  className="h-9 font-mono text-sm"
                  data-testid="input-edit-initialTarget"
                />
              </div>
              {extraTps.map((tp, i) => (
                <div key={i} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      TP{i + 2}
                    </label>
                    <button
                      type="button"
                      onClick={() => setExtraTps((x) => x.filter((_, j) => j !== i))}
                      title="Remove this level"
                      data-testid={`button-edit-remove-tp-${i}`}
                      className="rounded px-1 text-[11px] leading-none text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      ×
                    </button>
                  </div>
                  <Input
                    type="number"
                    step="any"
                    inputMode="decimal"
                    value={tp}
                    onChange={(e) =>
                      setExtraTps((x) => x.map((v, j) => (j === i ? e.target.value : v)))
                    }
                    className="h-9 font-mono text-sm"
                    data-testid={`input-edit-extra-tp-${i}`}
                  />
                </div>
              ))}
              {field("entryTime", "Entry time", "datetime-local")}
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Account
                </label>
                <AccountPicker
                  value={account}
                  onChange={setAccount}
                  known={knownAccounts}
                  testIdPrefix="edit-account"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Source
                </label>
                <AccountPicker
                  value={source}
                  onChange={setSource}
                  known={knownSources}
                  testIdPrefix="edit-source"
                  placeholder="e.g. Daniel, Severin, CBS, UB"
                  emptyLabel="My own idea"
                  newLabel="+ New source…"
                />
              </div>
              {styles.length > 0 && (
                <div className="col-span-2 space-y-1" data-testid="section-edit-style">
                  <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Style
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {styles.map((s) => {
                      const on = s.id === styleId;
                      const c = styleColor(s.color);
                      return (
                        <button
                          key={s.id}
                          type="button"
                          /* Tapping the active one clears it: a trade can
                             legitimately belong to no book. */
                          onClick={() => setStyleId(on ? null : s.id)}
                          aria-pressed={on}
                          data-testid={`chip-edit-style-${s.id}`}
                          className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] leading-tight transition-colors ${
                            on
                              ? c.chip
                              : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                          }`}
                        >
                          <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
                          {s.name}
                        </button>
                      );
                    })}
                    {styleId != null && (
                      <button
                        type="button"
                        onClick={() => setStyleId(null)}
                        className="rounded-full border border-border px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                        data-testid="button-edit-style-clear"
                      >
                        unassigned
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Where the trade is in its life, editable at every step.
                The entry card asks this when logging; nothing asked it again
                afterwards, so an order that never filled could not be walked
                back and a trade closed by mistake could not be reopened. The
                three states are the whole life of a trade: waiting for a
                fill, live, done. */}
            <div data-testid="section-edit-lifecycle">
              <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                State
              </p>
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    { id: "pending", label: "Waiting to fill", icon: Clock3 },
                    { id: "open", label: "Open", icon: ArrowUpRight },
                    { id: "closed", label: "Closed", icon: CheckCircle2 },
                  ] as const
                ).map(({ id, label, icon: Icon }) => (
                  <Button
                    key={id}
                    type="button"
                    size="sm"
                    variant={lifecycle === id ? "default" : "outline"}
                    className="h-7 gap-1.5 px-2 text-[11px]"
                    onClick={() => setLifecycle(id)}
                    data-testid={`button-edit-lifecycle-${id}`}
                    aria-pressed={lifecycle === id}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </Button>
                ))}
              </div>
              {lifecycle === "closed" && !outcomeStage(f.exitPrice ?? "", null).priced && (
                <p className="mt-1.5 text-[11px] text-amber-500" data-testid="text-edit-needs-exit">
                  Fill in the exit price below to close it.
                </p>
              )}
              {lifecycle !== "closed" && outcomeStage(f.exitPrice ?? "", null).priced && (
                <p className="mt-1.5 text-[11px] text-amber-500" data-testid="text-edit-has-exit">
                  There is an exit price below — clear it to put this back to{" "}
                  {lifecycle === "pending" ? "waiting" : "open"}.
                </p>
              )}
            </div>

            {/* The same questions the entry card asks when logging a
                completed trade — one component, so an open trade is never
                asked to grade an exit it has not had. */}
            <TradeOutcomeFields
              exitPrice={f.exitPrice ?? ""}
              setExitPrice={(v: string) => setF((p) => ({ ...p, exitPrice: v }))}
              exitTime={f.exitTime ?? ""}
              setExitTime={(v: string) => setF((p) => ({ ...p, exitTime: v }))}
              exitReason={exitReason}
              setExitReason={setExitReason}
              mae={f.mae ?? ""}
              setMae={(v: string) => setF((p) => ({ ...p, mae: v }))}
              mfe={f.mfe ?? ""}
              setMfe={(v: string) => setF((p) => ({ ...p, mfe: v }))}
              postExitPeak={f.postExitPeak ?? ""}
              setPostExitPeak={(v: string) => setF((p) => ({ ...p, postExitPeak: v }))}
              postExitAdverse={f.postExitAdverse ?? ""}
              setPostExitAdverse={(v: string) => setF((p) => ({ ...p, postExitAdverse: v }))}
              nmo={nmo}
              setNmo={setNmo}
              fees={f.fees ?? ""}
              setFees={(v: string) => setF((p) => ({ ...p, fees: v }))}
              grades={grades}
              setGrades={setGrades}
              demons={tags}
              demonIds={selectedTags}
              setDemonIds={setSelectedTags}
              highlights={highlights}
              setHighlights={setHighlights}
              extraHighlights={knownHighlights(allTrades)}
              testPrefix="edit"
              timing={{
                direction,
                entryPrice: numOrNull(f.entryPrice ?? ""),
                initialStop: numOrNull(f.initialStop ?? ""),
              }}
            />

            {/* Scaling belongs in the edit dialog too: the trade view can show
                and remove fills, but this is where a trade gets corrected, and
                "I logged partials I would rather not keep" is a correction. */}
            {trade.fills.length > 0 && (
              <div data-testid="section-edit-fills">
                <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Partials and adds
                </p>
                <ul className="space-y-1">
                  {[...trade.fills]
                    .sort((a, b) => a.time.localeCompare(b.time))
                    .map((fl) => (
                      <li
                        key={fl.id}
                        className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5 text-xs"
                        data-testid={`edit-fill-${fl.id}`}
                      >
                        <Badge
                          variant="outline"
                          className={`shrink-0 text-[10px] font-normal ${
                            fl.kind === "add"
                              ? "border-sky-500/40 text-sky-400"
                              : "border-emerald-500/40 text-emerald-400"
                          }`}
                        >
                          {fl.kind === "add" ? "added" : "took"}
                        </Badge>
                        <span className="font-mono">
                          {num(fl.size)}
                          {trade.sizeUnit === "quote" ? " USD" : ""} @ {num(fl.price)}
                        </span>
                        <span className="truncate text-[11px] text-muted-foreground">
                          {new Date(fl.time).toLocaleString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="ml-auto h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => deleteFill.mutate(fl.id)}
                          disabled={deleteFill.isPending}
                          aria-label="Remove this fill"
                          data-testid={`button-edit-delete-fill-${fl.id}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </li>
                    ))}
                </ul>

                {merged && (
                  <div className="mt-2 rounded-md border border-border/60 bg-secondary/20 p-2.5">
                    <p className="text-[11px] leading-snug text-muted-foreground">
                      Log it as one round trip instead:{" "}
                      <span className="font-mono text-foreground">
                        {num(merged.size)}
                        {trade.sizeUnit === "quote" ? " USD" : ""} @ {num(merged.entryPrice)}{" "}
                        &rarr; {num(merged.exitPrice)}
                      </span>
                      . The P&amp;L is identical to the cent &mdash; only the story of how it
                      got there is dropped.
                      {trade.fills.some((fl) => fl.kind === "add") && (
                        <span className="text-amber-500">
                          {" "}
                          This trade was added to, so folding the adds into the entry rebases 1R
                          onto the larger position: R will change.
                        </span>
                      )}
                    </p>
                    <Button
                      type="button"
                      variant={confirmMerge ? "destructive" : "outline"}
                      size="sm"
                      className="mt-2 h-7 text-[11px]"
                      disabled={merging}
                      onClick={mergeIntoOneExit}
                      data-testid="button-merge-fills"
                    >
                      {merging && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                      {confirmMerge ? "Merge and delete the fills?" : "Merge into one exit"}
                    </Button>
                  </div>
                )}
              </div>
            )}


            {/* Fees explained where they're typed, since they change the R. */}

            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Rationale
              </label>
              <Input
                value={f.rationale ?? ""}
                onChange={set("rationale")}
                className="h-9 text-sm"
                data-testid="input-edit-rationale"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Rationale tags (comma separated)
              </label>
              <Input
                value={f.rationaleTags ?? ""}
                onChange={set("rationaleTags")}
                placeholder="VAH Rejection, Fib Retest"
                className="h-9 text-sm"
                data-testid="input-edit-rationale-tags"
              />
              {/* Same chips as the entry card, writing into the same list — a
                  setup you can tap when logging must be tappable when
                  correcting, or the correction path quietly re-introduces the
                  spellings the chips exist to prevent. */}
              <SetupTagPicker
                selected={(f.rationaleTags ?? "").split(",").map((x) => x.trim()).filter(Boolean)}
                onToggle={(name) =>
                  setF((p) => {
                    const cur = (p.rationaleTags ?? "")
                      .split(",")
                      .map((x) => x.trim())
                      .filter(Boolean);
                    const has = cur.some((x) => x.toLowerCase() === name.toLowerCase());
                    const next = has
                      ? cur.filter((x) => x.toLowerCase() !== name.toLowerCase())
                      : [...cur, name];
                    return { ...p, rationaleTags: next.join(", ") };
                  })
                }
                testIdPrefix="edit-setup"
              />
            </div>

            <Textarea
              value={f.notes ?? ""}
              onChange={set("notes")}
              placeholder="Notes"
              className="min-h-[60px] text-xs"
              data-testid="input-edit-notes"
            />

            {previewMetrics && (
              <div
                className="grid grid-cols-2 gap-2 rounded-md border border-border/60 bg-secondary/30 p-2.5 text-center font-mono text-xs sm:grid-cols-4"
                data-testid="edit-preview-metrics"
              >
                {/* P&L leads. R is this journal's unit, but the broker's
                    statement is in dollars, and the fastest way to know a
                    trade was logged correctly is that this figure matches the
                    one on the exchange. */}
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {previewMetrics.fees > 0 ? "Net P&L" : "P&L"}
                  </p>
                  <p
                    className={`text-sm font-semibold ${
                      (previewMetrics.actualPnL ?? 0) >= 0 ? "text-emerald-400" : "text-primary"
                    }`}
                    data-testid="edit-preview-pnl"
                  >
                    {previewMetrics.actualPnL != null ? fmtMoney(previewMetrics.actualPnL) : "—"}
                  </p>
                  {previewMetrics.fees > 0 && (
                    <p className="text-[10px] text-muted-foreground">
                      {fmtMoney(previewMetrics.grossPnL)} gross
                    </p>
                  )}
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Actual</p>
                  <p
                    className={
                      (previewMetrics.actualR ?? 0) >= 0 ? "text-emerald-400" : "text-primary"
                    }
                  >
                    {fmtR(previewMetrics.actualR)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">No-mgmt</p>
                  <p>{fmtR(previewMetrics.potentialR)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Capture</p>
                  <p>
                    {previewMetrics.captureRatioClipped != null
                      ? `${Math.round(previewMetrics.captureRatioClipped * 100)}%`
                      : "—"}
                  </p>
                </div>
              </div>
            )}

            {/* Attach here too, not only from the read-only detail view: Edit
                is where you reach to change a trade, and a screenshot added to
                a trade closed weeks ago is a change like any other. Images save
                on their own, so they survive whether or not "Save changes" is
                pressed. */}
            <div className="border-t border-border/60 pt-3">
              <TradeImageGallery tradeId={trade.id} />
            </div>

            <div className="flex gap-2">
              <Button
                variant="outline"
                className="h-10 text-xs font-semibold"
                onClick={onClose}
                data-testid="button-edit-cancel"
              >
                Cancel
              </Button>
              <Button
                className="h-10 flex-1 text-xs font-semibold"
                onClick={save}
                disabled={updateTrade.isPending}
                data-testid="button-edit-save"
              >
                {updateTrade.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Save changes
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

